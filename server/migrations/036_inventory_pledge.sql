-- 036：裸卡也走卡冊優先 —— 每個獎品可以指名它押的是卡冊裡哪一張實體卡（A-4）
--
-- 完整設計見 docs/inventory-first-plan.md；這一支是 023 的續集。
--
-- ── 023 留下的洞 ────────────────────────────────────────────────────
-- 023 只替**帶鑑定編號**的獎品在 prizes 開一列並轉成 in_pool，理由是
-- 「唯一索引的述詞是 where cert_no is not null，替沒有編號的卡開列一點
-- 保護都沒有多」。那句話對 prizes_cert_alive 而言是對的，但它漏掉了
-- inventory-first 真正的防線 —— **不是索引，是結構**：
-- 一列卡只有一個 status，物理上不可能同時 in_pool 兩次
-- （inventory-first-plan.md 5.4）。
--
-- 於是裸卡完全沒有防線。實測（改動前，本機乾淨庫）：
--   同一張裸卡連續開五個池 → 五次全部 HTTP 200，
--   賣家卡冊裡 status = 'in_pool' 的列數是 **0**。
-- 十五個籤位對外承諾同一張實體卡，資料庫一聲都不吭。
--
-- ── 這一支做什麼 ────────────────────────────────────────────────────
-- 結構上其實只差一條約束：`pool_prizes.card_id` 這一欄 023 已經加了，
-- 缺的是「一列 pool_prizes 只指得到一張卡，所以它只能開一籤」這件事
-- 有沒有被寫下來。程式端（routes/pools.ts 的 PrizeIn refine）擋了，
-- 但那是應用層 —— 資料庫要有自己的一份。
--
-- ── total > 1 的語意去哪裡了 ────────────────────────────────────────
-- 沒有消失，換了位置。以前「同一款卡開 10 籤」是**一列** pool_prizes 的
-- total = 10；卡冊優先之下是**十列** pool_prizes，各自押著十張不同的
-- 實體卡（各自 total = 1）。這是 A-4 的核心要求的直接後果：
-- 「裸卡要開 10 籤，就必須先入庫 10 張卡」。
--
-- 沒有 card_id 的獎品（舊池、以及還沒指名卡冊列的新獎品）**不受影響**，
-- total 照樣可以 > 1 —— 約束寫成 `card_id is null or total = 1`
-- 就是為了讓既有的池一列都不必動。

-- ── 一列 pool_prizes 指到一張卡，就只能開一籤 ───────────────────────
--
-- 為什麼用 NOT VALID：這支要能在**已經有既有池**的庫上跑過。
-- 本機種子庫實測 `select count(*) from pool_prizes where card_id is not null
-- and total <> 1` 是 0（023 之後只有帶編號的獎品會拿到 card_id，
-- 而那些被 pools.ts 的 refine 限成 total <= 1），所以正式環境**預期**
-- 也是 0 —— 但「預期」不是「證明」，而這支遷移不能因為正式資料庫裡
-- 有一列我們沒看過的資料就整支倒下、把後面的遷移一起擋住。
-- NOT VALID 的語意正好是我們要的：**既有列不檢查，新寫入一律檢查。**
alter table pool_prizes drop constraint if exists pool_prizes_card_one_seat;
alter table pool_prizes add constraint pool_prizes_card_one_seat
  check (card_id is null or total = 1) not valid;

-- 然後**試著**驗證既有資料。過得了就把 NOT VALID 拿掉（約束從此是全稱的），
-- 過不了就照實留在 NOT VALID 並印出有幾列 —— 那幾列是已經發生的一卡多籤，
-- 要人工處理，不是這支遷移該偷偷改掉的東西。
do $$
declare bad bigint;
begin
  begin
    alter table pool_prizes validate constraint pool_prizes_card_one_seat;
    raise notice '[036] pool_prizes_card_one_seat 已驗證通過（既有資料沒有一卡多籤）';
  exception when others then
    select count(*) into bad from pool_prizes where card_id is not null and total <> 1;
    raise warning '[036] 既有資料有 % 列「一張卡開多籤」，約束維持 NOT VALID（只擋新寫入）。'
      '那幾列是已經發生的一卡多籤，要人工處理：'
      'select id, pool_id, card_id, total from pool_prizes where card_id is not null and total <> 1;', bad;
  end;
end $$;

-- ── 押在池裡的卡一定知道自己押在哪個池 ──────────────────────────────
--
-- 解押（pools-service.ts 的 releasePledgedCards）是
-- `where pool_id = $pool and status = 'in_pool'` —— 一列 in_pool 但
-- pool_id 是 null 的卡**永遠不會被解押回 in_book**：那張實體卡的編號
-- 被永久佔住，賣家再也不能拿它開池或上架，而且站上沒有任何端點救得回來
-- （monitor.ts 的 cert-unprotected／in_pool 檢查會看到它，但只是看到）。
--
-- 同樣用 NOT VALID + 試驗證：本機種子庫實測是 0 列違反，但正式庫沒看過。
alter table prizes drop constraint if exists prizes_in_pool_has_pool;
alter table prizes add constraint prizes_in_pool_has_pool
  check (status <> 'in_pool' or pool_id is not null) not valid;

do $$
declare bad bigint;
begin
  begin
    alter table prizes validate constraint prizes_in_pool_has_pool;
    raise notice '[036] prizes_in_pool_has_pool 已驗證通過';
  exception when others then
    select count(*) into bad from prizes where status = 'in_pool' and pool_id is null;
    raise warning '[036] 有 % 列卡是 in_pool 但沒有 pool_id，永遠解押不回來，約束維持 NOT VALID。'
      'select id, user_id from prizes where status = ''in_pool'' and pool_id is null;', bad;
  end;
end $$;

-- ── 既有資料：**刻意不回填** ────────────────────────────────────────
--
-- 這是這支遷移最重要的一段，因為它決定的是「不做什麼」。
--
-- 想回填的是「舊池裡那些沒有 card_id 的獎品，替它們補上卡冊那一列」。
-- 做不到，而且不該做，理由跟 032／034 那兩支用的是同一把尺
-- （「這一列的值在物理上可不可能被證明」）：
--
--   1 **那些卡在系統裡不存在。**沒有 card_id 的獎品從來沒有產生過 prizes
--     列（舊制是抽中時才 insert）。要回填就得**憑空建立**卡片列，
--     而那等於系統代替賣家宣告「這張實體卡確實存在、確實在你手上」——
--     那正是這整套機制唯一不能自我宣告的一件事（U-6，解不了）。
--
--   2 **回填會把已經發生的一卡多池洗白。**同一張裸卡現在可能已經被宣告在
--     三個池裡（那正是這支要修的漏洞）。替每一個宣告各開一列卡，
--     資料庫從此相信賣家有三張；不開列則保持「我們不知道」。
--     不知道是事實，三張是謊。
--
--   3 **裸卡沒有任何可比對的鍵。**帶編號的卡至少有 (grader, cert_no)
--     可以判斷兩個宣告是不是同一張；裸卡連這個都沒有，
--     任何「合併」或「分開」都是猜的。
--
-- 所以既有的池**繼續走舊路徑**（card_id is null → 抽中時才 insert prizes），
-- 新舊兩條路並存到所有舊池結清為止 —— 判斷依據一律是
-- `pool_prizes.card_id is null`，不要用日期或 pool id 反推
-- （判準必須是資料本身帶著的，見 023 的 comment）。
--
-- 救不回來的照實說：**2026-09-03 之前建立的池，裡面的裸卡獎品有沒有
-- 一卡多池，事後查不出來，也沒有辦法補救。** 唯一能做的是把新的擋住。

-- ── 欄位說明更新（023 的版本只講帶編號的卡）──────────────────────
comment on column pool_prizes.card_id is
  '這個獎品押的是卡冊裡哪一列實體卡（prizes.id）。'
  '建池時把那一列鎖住、確認是賣家自己的 in_book，然後轉成 in_pool —— '
  '「同一張卡不能同時進兩個池」因此是**結構保證**（一列卡只有一個 status），'
  '不是查詢時的檢查，裸卡也蓋得到（A-4）。帶鑑定編號的卡另外還有 '
  'prizes_cert_alive 這條唯一索引當第二道。'
  'null = 舊池、或呼叫端沒有指名卡冊列的獎品（那些沒有任何防線，'
  '是 2026-09 這一輪已知還開著的缺口）。'
  '**判斷走哪條路一律看這一欄，不要用日期或 pool id 反推。**';

-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 完整退版（無損，這支沒有任何 UPDATE / INSERT）：
--     alter table pool_prizes drop constraint if exists pool_prizes_card_one_seat;
--     alter table prizes      drop constraint if exists prizes_in_pool_has_pool;
-- 退版之後 023 的 card_id 欄位仍然在，程式端照樣運作 —— 少的只是
-- 資料庫這一層的複核。
