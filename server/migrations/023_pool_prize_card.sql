-- 023：把池裡的獎品接到卡冊那一列（卡冊優先的第二步）
--
-- ── 要補的洞（open-issues U-1 / U-4 / U-5）──────────────────────────
-- 同一個鑑定編號現在可以同時放進三個不同的池，資料庫一聲都不吭。
-- 全站唯一的防線 listings_cert_live 只管市場掛單，池那邊完全沒蓋。
--
-- ── 為什麼不需要新的唯一索引 ────────────────────────────────────────
-- 021 已經在 prizes 上放了 prizes_cert_alive（unique(grader, cert_no)
-- where cert_no is not null），而且已經在正式環境生效、實測擋得住。
-- 所以這支要做的不是「再加一條約束」，是**讓池裡的卡也走進那張表** ——
-- 建池時就替每一張帶編號的獎品在 prizes 開一列（賣家名下、狀態 in_pool），
-- 唯一性就自動由既有的索引保證，不必發明第二套規則。
--
-- 這也是為什麼欄位加在 pool_prizes 而不是反過來：卡是實體、是主體，
-- 池只是「這張卡現在被押在哪裡」。
--
-- ── 範圍：這一支只做帶鑑定編號的獎品 ────────────────────────────────
-- **沒有編號的卡（裸卡、普卡）維持舊路徑**（抽中時才 insert prizes）。
-- 理由是成本與收益不成比例：
--   收益 —— 唯一索引的述詞是 `where cert_no is not null`，沒有編號的卡
--           本來就蓋不到，替它們開列**一點保護都沒有多**。
--   成本 —— 沒有編號的獎品可以 total > 1（一個 250 籤的池常常是幾張普卡
--           各開幾十籤），一張卡一列的話建池當下就要寫進幾百列，
--           而且其中絕大多數永遠不會被抽走。
-- 完整的卡冊優先（每一張卡都先進卡冊）是後續的事，見
-- docs/inventory-first-plan.md。這一支只堵住真正在漏的那個洞。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 完整退版（無損）：
--     alter table pool_prizes drop column if exists card_id;
-- 既有資料一列都沒被動過（這支沒有任何 UPDATE）。
-- 退版之後帶編號的獎品會退回舊路徑，程式碼靠 `card_id is null` 判斷，
-- 所以新舊兩條路本來就並存 —— 見下方說明。

alter table pool_prizes add column if not exists card_id text references prizes(id);

comment on column pool_prizes.card_id is
  '這個獎品對應到卡冊裡的哪一列（prizes.id）。'
  '建池時替帶鑑定編號的獎品建立，狀態 in_pool、掛在賣家名下 —— '
  '唯一性因此由既有的 prizes_cert_alive 索引保證，不需要第二套規則。'
  'null = 舊制或沒有鑑定編號的獎品，抽中時才 insert 一列 prizes。'
  '**判斷走哪條路一律看這一欄，不要用日期或 pool id 反推** —— '
  '判準必須是資料本身帶著的。';

-- 回庫掃描要找「這個池裡還押著、沒被抽走的卡」。
create index if not exists pool_prizes_card on pool_prizes(card_id)
  where card_id is not null;
