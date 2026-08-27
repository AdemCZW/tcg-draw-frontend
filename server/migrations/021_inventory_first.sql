-- 021：卡冊優先（inventory-first）第一步 —— 把「一張實體卡」變成系統裡的一列
--
-- 完整的設計與四支遷移的分工見 docs/inventory-first-plan.md。
--
-- ── 這支要解決什麼 ──────────────────────────────────────────────────
-- prizes 現在的語意是「從池裡抽出來的卡」：pool_id 是 NOT NULL，
-- 而且全站只有一個入口會產生它（pools-service.ts:247 的 insert）。
-- 所以賣家手上的實體卡在系統裡**不存在**，直到有人抽中它為止。
--
-- 後果是同一張實體卡可以同時是三個池的 pool_prizes 各一列 —— 資料庫
-- 完全不擋，因為那三列彼此不知道對方存在（各自帶一份自由填寫的 card jsonb）。
--
-- ── 這支**不**做什麼 ────────────────────────────────────────────────
-- 不建唯一索引（022）、不改抽卡流程（023）、不做接管（024）。
-- 這支純粹是把欄位加好、回填、放寬 check。跑完之後系統行為**一模一樣**：
-- 沒有任何程式碼會寫入新欄位，也沒有任何一列會進入新的 status。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 完整退版（無損，只要還沒有任何列用到新 status）：
--     alter table prizes drop column if exists custodian_id,
--                        drop column if exists origin,
--                        drop column if exists grader,
--                        drop column if exists cert_no;
--     alter table prizes alter column pool_id set not null;   -- 見下方警告
--     drop index if exists prizes_custodian;
--     drop index if exists prizes_cert_lookup;
--     alter table prizes drop constraint if exists prizes_status_check;
--     alter table prizes add constraint prizes_status_check
--       check (status in ('stashed','listed','ship_requested','shipped','recycled','refunded'));
--
-- ⚠️ `alter column pool_id set not null` 只有在**還沒有任何 pool_id 為 null
--    的列**時做得到。也就是說退版窗口只到「第一張上傳卡進系統」為止。
--    這一條要寫進上線 runbook。


-- ---------- 實體卡在誰手上 ----------
--
-- 為什麼需要這一欄：擁有權和實體持有在這個系統裡從頭到尾是兩件事。
-- 玩家抽到卡、卡進他的卡冊，但**實體卡還在賣家抽屜裡**；他把卡掛上市場
-- 賣給第三個人，實體卡仍然在原賣家那，由原賣家寄給新買家。
-- 一張卡可以在站內轉手好幾次而實體從未移動。
--
-- 現在不需要這一欄，是因為它推導得出來：
--     status = 'shipped' → 已經寄到 user_id 手上
--     其他               → 在 pools.seller_id 手上（走 pool_id join）
-- 而推導成立的前提是 **pool_id 是 NOT NULL**。這支遷移把那個前提拿掉，
-- 所以推導必須換成一個真的欄位。
--
-- routes/public.ts:276 的 `delivery = status==='stashed' ? 'vault' : 'ship'`
-- 就是這個推導的具體樣子 —— 它一直在問「實體卡在誰手上」，只是用 status 代打。
--
-- **不新增 owner_id。** prizes.user_id 已經就是擁有權，而且已經會跟著
-- 交易移轉（routes/orders.ts:102、routes/social.ts:268、orders-service.ts:97
-- 三處都是 update prizes set user_id = ...）。多開一欄等於讓「誰擁有這張卡」
-- 有兩個來源，而這是一個算錢的系統 —— 兩個來源遲早漂移，漂移的那天
-- 沒有任何辦法判斷哪一邊才是對的。
alter table prizes add column if not exists custodian_id text references users(id);

-- ---------- 這一列是怎麼來的 ----------
--
-- 'draw'   抽卡產生（現況唯一的來源）
-- 'upload' 賣家自己上傳進卡冊（023 之後才會出現）
-- 'seed'   種子資料
--
-- 為什麼要這一欄而不是用「pool_id is null」判斷：pool_id 為 null 之後
-- 還會有第二種意思 —— 「本來從池裡抽的，但那個池已經清掉了」。
-- 來源是一個歷史事實，不該從一個會變的欄位反推。
alter table prizes add column if not exists origin text
  check (origin is null or origin in ('draw', 'upload', 'seed'));

-- ---------- 鑑定資訊拉成欄位 ----------
--
-- grader / certNo 現在住在 card jsonb 裡。022 要建的唯一索引是
-- unique(grader, cert_no)，而 jsonb 運算式索引雖然建得起來，
-- 每次 insert 都要重算運算式、錯誤訊息也只會吐出一長串運算式，
-- 對「這個編號已經被登記過」這種要顯示給使用者看的約束很不友善。
--
-- **唯一鍵一定要含 grader。** 現有的 listings_cert_live 是 unique(cert_no)，
-- 沒有 grader —— PSA #12345678 和 BGS #12345678 是兩張完全不同的卡，
-- 現在的索引會把第二個人誤擋掉。八位數編號的鑑定公司不只 PSA，
-- 撞號是遲早的事。022 會一起修那一條。
--
-- 這支只建普通索引（查詢用），唯一索引留給 022 —— 因為建唯一索引之前
-- 必須先跑 scripts/scan-certs.ts 確認既有資料沒有重複，
-- 有重複的話索引根本建不起來，而那些重複本身就是已經發生的一卡多賣。
alter table prizes add column if not exists grader  text;
alter table prizes add column if not exists cert_no text;

-- ---------- pool_id 改成可以是 null ----------
--
-- 這是整個改造的第一個閘門：不拿掉這條 NOT NULL，一張卡就不可能
-- 「先存在於卡冊，之後才進池」。
--
-- null 的意思是「這一列不是從某個池抽出來的」。搭配 origin 才有完整語意。
alter table prizes alter column pool_id drop not null;

-- ---------- 兩個新的卡片狀態 ----------
--
-- in_book  閒置在卡冊：可以上架、可以進池、可以刪
-- in_pool  押在某個池裡：不能上架、不能刪、不能再進另一個池
--
-- 為什麼 in_pool 要是一個 status 而不是「有沒有出現在 pool_prizes」：
-- 「不能同時進兩個池」必須是**結構保證**，不是查詢時的檢查。
-- 一列卡只有一個 status，物理上不可能同時 in_pool 兩次。
-- 應用層的檢查擋不住併發（這條教訓已經寫在 001_init.sql:44）。
--
-- 這也是裸卡唯一的防線 —— 裸卡沒有鑑定編號，022 的唯一索引蓋不到它，
-- 但結構保證蓋得到。
--
-- 既有的六個狀態一個都沒動，所以跑完這支之後行為完全不變。
alter table prizes drop constraint if exists prizes_status_check;
alter table prizes add constraint prizes_status_check
  check (status in ('stashed','listed','ship_requested','shipped','recycled','refunded',
                    'in_book','in_pool'));

-- ---------- 回填 ----------
--
-- 全部是「把已經隱含的事實寫下來」，沒有任何一列被賦予它沒有發生過的事。

-- origin：現有的 prizes 全部來自抽卡（pools-service.ts:247 是唯一入口，
-- seed.ts:644 也是掛在池底下）。
update prizes set origin = 'draw' where origin is null;

-- custodian：就是上面那個推導的結果。
--   已出貨 → 實體在擁有者手上
--   其他   → 實體還在開池賣家那
--
-- pools.seller_id 參照 sellers(id)，而 sellers.id 本身又是 users(id)
-- （002_core.sql:57 `id text primary key references users(id)`），
-- 所以那個值直接就是一個 users(id)，不需要再 join sellers 轉一手。
update prizes pz
   set custodian_id = pz.user_id
 where custodian_id is null and pz.status = 'shipped';

update prizes pz
   set custodian_id = p.seller_id
  from pools p
 where pz.custodian_id is null and pz.pool_id = p.id;

-- 鑑定資訊：從 card jsonb 拉出來，**正規化之後**才寫進欄位。
--
-- 三道處理，每一道都是被實測打出來的：
--
-- 1 btrim —— 只做 nullif(x, '') 擋得掉空字串，擋不掉 '  '（全空白）。
--   實測 certNo = '  ' 會原樣存進欄位，於是 022 的唯一索引
--   （where cert_no is not null）會把**兩張根本沒有編號的卡**判成同一張。
--   反過來 ' 12345678' 和 '12345678' 會被判成兩張不同的卡，唯一性直接失效。
--
-- 2 nullif —— trim 完剩空字串就是「沒有編號」，不是「編號是空字串」。
--
-- 3 upper(grader) —— 唯一鍵是 (grader, cert_no)。'PSA' 與 'psa' 不正規化
--   就是兩個不同的值，同一張卡換個大小寫就能再登記一次。
--   **只正規化這一欄，card jsonb 裡的原值不動** —— 顯示要照賣家填的，
--   索引要照正規化的。這兩件事本來就該分開。
update prizes
   set grader  = nullif(upper(btrim(card->>'grader')), ''),
       cert_no = nullif(btrim(card->>'certNo'), '')
 where grader is null and cert_no is null;

-- ---------- 索引 ----------

-- 賣家要看「我保管中的卡」（出貨頁、上池挑卡）。
create index if not exists prizes_custodian on prizes(custodian_id)
  where custodian_id is not null;

-- 編號查詢。**這裡刻意不建唯一索引** —— 見上面 grader/cert_no 的說明。
create index if not exists prizes_cert_lookup on prizes(grader, cert_no)
  where cert_no is not null;

-- ---------- 欄位說明留在資料庫裡 ----------
--
-- 這幾條是給「只看 schema、沒讀這支遷移」的人看的。
-- 尤其 custodian_id 跟 user_id 的差別，光看欄位名猜不出來。

comment on column prizes.user_id is
  '擁有權。會隨站內交易移轉（市場成交、贈送、賣回、退款）。'
  '結算與回收一律讀這一欄的**當下值**，不要用 pool_settlements.buyer_id —— '
  '那是抽卡當下的快照，卡轉手之後就過期了（F-1〜F-6）。';

comment on column prizes.custodian_id is
  '實體卡在誰手上。**只有兩件事會改它：出貨簽收、站外轉手接管。**'
  '站內交易一律不碰這一欄 —— 卡在平台內轉手好幾次，實體可以從未離開原賣家。'
  '能不能上架/進池的判準：custodian 還是原賣家，且 status = in_book。';

comment on column prizes.origin is
  'draw = 抽卡產生；upload = 賣家上傳進卡冊；seed = 種子資料。'
  '不要用 pool_id is null 反推來源 —— null 還有第二種意思（池被清掉了）。';

comment on column prizes.pool_id is
  '從哪個池抽出來的。null = 不是抽來的（見 origin）。'
  '021 之前這一欄是 NOT NULL，那正是「卡不能先於池存在」的結構障礙。';
