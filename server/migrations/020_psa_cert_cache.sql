-- 020：PSA 鑑定編號查證結果的快取
--
-- ── 為什麼要快取（不是效能，是配額） ──────────────────────────────
-- PSA 的免費層是「每天 100 次」，超過回 429。而一張鑑定卡的身分**一輩子
-- 不會變**（同一個 cert 編號永遠對應同一張實體卡、同一個分數），所以正確
-- 的做法是「查到就存起來，之後永遠讀快取」—— 一張卡一輩子只花一次配額。
-- 這跟 src/lib/psa.ts 註解裡「上架時抓一次圖」是同一個理由，只是這裡存的
-- 是查證結果（分數、卡號、pop）而不是圖片。
--
-- ── 只快取「成功查到」的結果 ──────────────────────────────────────
-- not_found / invalid_format / api_unavailable 都**不寫**進這張表：
--   - not_found（查無此卡）今天查不到不代表明天查不到（PSA 可能還沒建檔），
--     把它快取起來會讓一張稍後才入庫的真卡永遠被判成假卡。
--   - api_unavailable（403 / 500 / 429）是我方或 PSA 的暫時狀態，
--     快取它等於把暫時故障變成永久錯誤。
-- 因此「這張表有這個編號」 ⇔ 「這個編號在 PSA 查證成功過」，讀取端可以
-- 直接把命中當成 ok，不必再存一個狀態欄位。
--
-- ── 可逆性 ────────────────────────────────────────────────────────
-- 這支只新增一張獨立的表，不碰任何既有資料。完整退版（無損）：
--     drop table if exists psa_certs;

create table if not exists psa_certs (
  -- PSA 的 cert 編號。就是使用者查證時輸入的字串，做過 trim
  cert_number       text primary key,

  -- PublicPSACert 的關鍵欄位，攤平出來讓查詢/顯示不必每次去 parse raw。
  -- 全部允許 null：PSA 對不同年代的卡回傳的欄位並不齊全，缺欄位是常態不是錯誤。
  subject           text,        -- 卡面主體（英文，例：CHARIZARD）
  brand             text,        -- 系列/品牌
  year              text,        -- 年份（PSA 回字串，不強轉數字）
  card_number       text,        -- 卡號 —— 開池驗證時就是拿這一欄跟賣家挑的卡對
  variety           text,        -- 版本/變體描述
  card_grade        text,        -- 分數（例：GEM MT 10 / MINT 9）
  grade_description text,
  total_population  bigint,      -- 同規格總 pop
  population_higher bigint,      -- 分數更高的張數

  -- 這張殼在 PSA 的狀態（PublicPSACert.ItemStatus）
  item_status       text,

  -- 完整 PublicPSACert 原封不動存一份。之後若要多讀幾欄（PSA 有 24 欄），
  -- 不必回頭再花一次配額；也是稽核「當初 PSA 到底回了什麼」的憑據。
  raw               jsonb not null,

  -- 查證時間（epoch ms，跟全站其他時間戳一致，不用 timestamptz）。
  -- 保留它是為了日後想「超過 N 個月重新查一次」時有依據 —— 目前不重查。
  checked_at        bigint not null
);

comment on table psa_certs is
  'PSA cert 查證結果的快取。只存查證成功的編號（見 020 遷移的說明）：'
  '有這一列 ⇔ 這個編號在 PSA 查證成功過。配額每天 100 次，一張卡一輩子查一次。';
