-- 038：市場的唯一鍵補上 grader（open-issues.md 的 U-2）
--
-- ── 病灶 ────────────────────────────────────────────────────────────
-- 001_init.sql:46 的 listings_cert_live 是 unique(cert_no) where status='live'。
-- 編號本身**不是**一張卡的身分，發證單位＋編號才是：
-- PSA #12345678 與 BGS #12345678 是兩張完全不同的實體卡。
--
-- 現在第二個人拿 BGS 那張去上架會被擋，而且他做的事完全正當、
-- 也沒有任何自救的路（他改不了 BGS 印在殼上的號碼）。
-- 實測改前的症狀比文件寫的更糟：不是「被告知編號已被使用」，
-- 而是 500 Internal Server Error（見 routes/public.ts 那一段的說明）。
--
-- 021_inventory_first.sql:78 的註解自己就寫著這件事（「唯一鍵一定要含
-- grader」），也就是說這是已知、寫下來、只是還沒改的缺口。
--
-- ── 為什麼一定要跟卡冊那側一致 ──────────────────────────────────────
-- prizes 那側的 prizes_cert_alive（preflight.ts 啟動時建）**早就是**
-- unique(grader, cert_no)。兩側不一致本身就是問題：「這張卡是不是
-- 已經被登記／上架了」這一個判斷，在系統的兩個地方有兩種答案。
-- 這支讓市場那側跟卡冊那側講同一句話。

-- ---------- grader 拉成欄位 ----------
--
-- grader 現在只住在 listings.card jsonb 裡，唯一索引沒東西可以吃。
-- 三種做法裡選了「產生欄位」：
--
--   a) 普通欄位 + 每條寫入路自己填 —— 021 的教訓就是這個：
--      加了欄位卻沒有任何程式碼在新增時寫它，於是新資料全是 null，
--      索引只保護得到舊列（pools-service.ts:289 的註解）。
--      listings 有四條寫入路（市場上架、seed、兩支迴歸測試的直寫），
--      「每一條都要記得填」遲早會漏掉一條，而漏掉的症狀是靜默的。
--   b) 運算式索引 —— 建得起來，但這一欄之後 preflight／monitor 都要讀，
--      查得到的欄位比每次現算的運算式好用。
--   c) **產生欄位**（選這個）：值由 card jsonb 算出來，物理上不可能
--      跟 card 不一致，也不可能有人忘記填。
--
-- 正規化跟 021 的回填、抽卡寫入（pools-service.ts）、卡冊登記
-- （routes/cardbook.ts）**同一套**：upper(btrim(...)) 加 nullif(..., '')。
-- 不 upper 的話 'PSA' 與 'psa' 是兩個值，同一張卡換個大小寫就能再上架
-- 一次，索引等於白建；不 trim 的話 ' 12345678' 與 '12345678' 同理。
-- card jsonb 裡的原值不動 —— 顯示照賣家填的，索引照正規化的。
--
-- 加一欄 stored 產生欄位會重寫整張表並拿 ACCESS EXCLUSIVE 鎖。
-- listings 是一張只有數百列的表，重寫是毫秒級；而且遷移是在
-- `npm run migrate && npm start`（railway.json）的第一段跑，
-- 那時這個版本的服務還沒開始接受連線。
alter table listings add column if not exists grader text
  generated always as (nullif(upper(btrim(card->>'grader')), '')) stored;

-- ---------- 換索引 ----------
--
-- ⚠️ **不能用 CREATE INDEX CONCURRENTLY。** migrate.ts 把每一支遷移
-- 包在一個 sql.begin 交易裡（「跑到一半失敗不會留下半套結構」），
-- 而 CONCURRENTLY 不能在交易區塊裡跑 —— 寫下去正式部署會當場失敗
-- （25001 CREATE INDEX CONCURRENTLY cannot run inside a transaction block）。
-- 就算能用也沒有意義：上面那個 add column 已經拿了 ACCESS EXCLUSIVE
-- 並重寫整張表，索引再怎麼併發建也躲不掉同一把鎖。
--
-- 舊索引先 drop 再建新的，兩件事在同一個交易裡 —— 中間沒有任何一刻
-- 是「防線消失」被別的連線看得到的（DDL 在 Postgres 裡是交易性的）。
--
-- 這條新索引**不可能建不起來**：舊的 unique(cert_no) 保證同一個編號
-- 最多只有一筆 live，新的鍵多加一欄只會讓更多列被視為不同。
-- 放寬的方向天生安全，所以這支不需要像 preflight.ts 那樣先掃描再建。
drop index if exists listings_cert_live;

create unique index if not exists listings_cert_live
  on listings(grader, cert_no)
  where status = 'live' and cert_no is not null;

-- ── grader 是 null 的列怎麼辦 ────────────────────────────────────────
--
-- 照 preflight.ts 現在對 prizes 的做法，**不另外發明一套**：
-- Postgres 的唯一索引預設 NULLS DISTINCT，(null, '12345678') 兩列
-- 彼此不相等，所以 grader 為空的列不受這條索引保護。這是已知的破口，
-- preflight.ts 會把它的列數印出來（「有 N 列有鑑定編號卻沒有鑑定公司」）。
--
-- 為什麼不用 NULLS NOT DISTINCT 把它補起來：那會讓「兩張都沒填鑑定公司、
-- 但編號剛好相同」的卡互相誤擋 —— 正是這支要修的那種誤擋，只是換個位置。
-- 沒填鑑定公司的編號本來就不構成一張卡的身分，該做的是不要讓它進來：
-- routes/cardbook.ts 已經用 GRADER_REQUIRED 擋住「有編號沒有鑑定公司」的
-- 登記，而市場的卡一律來自卡冊。
--
-- 裸卡（grader 與 cert_no 都是 null）整條不適用：索引的述詞是
-- `cert_no is not null`，裸卡根本不進索引，所以大量上架不會互相誤擋。
-- 擋住同一張實體裸卡被重複上架的是**結構**不是索引 —— 一列卡只有一個
-- status，上架之後是 'listed'，而 'listed' 不在可上架的狀態裡（U-3／A-4）。
