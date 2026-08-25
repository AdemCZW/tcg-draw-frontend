-- 019：把卡片變體綁進公平性承諾（manifest v4）
--
-- ── 要補的洞 ────────────────────────────────────────────────────────
-- v3 為止，manifest 認得的卡片身分是
--     name | setCode | cardNo | grader | grade | certNo
-- 也就是說「同一組卡號的兩個版本」在承諾裡是**同一個東西**。
-- 實測 SV2a-025（ピカチュウ）：普卡 cardmarket 低價 €0.02，
-- 同一組卡號的マスターボールミラー €369 —— 差約 18,000 倍。
-- 於是賣家可以在開賣後把大師球鏡面換成普卡，籤序不變、manifest 逐字不變、
-- 驗算回 {"ok":true}。那是「開賣後偷換卡」這條路最後一道還沒堵上的縫。
--
-- ── 這支遷移為什麼幾乎沒有 DDL ──────────────────────────────────────
-- 變體識別碼存在 pool_prizes.card 這個 jsonb 裡（欄位名 variantId），
-- 跟 name / setCode / certNo 同一個地方 —— 它就是卡片身分的一部分，
-- 不該自己另開一欄。jsonb 不需要 schema 變更，所以這裡只做兩件事：
--   1. 把 commit_version 的合法值釘住
--   2. 把 v4 的意義寫進資料庫的註解，讓看 schema 的人不必回頭翻程式碼
--
-- ── 既有的池 ────────────────────────────────────────────────────────
-- **一列都不動。** 沒有任何 UPDATE 碰到 pools 或 pool_prizes 的既有資料。
-- 舊池的 commit_version 留在 1 / 2 / 3，驗算端照它們宣告的版本重算，
-- 而 manifestString 的 v2 / v3 分支逐字沒有改（v4 只在尾端追加一欄）——
-- 所以舊池算出來的 manifest 字串跟這次改動之前完全相同。
--
-- 為什麼不把舊池改成 v4：它們的 commit 已經對外公布過。改版本號會讓驗算端
-- 用 v4 的規則重算，而那些池的獎品沒有 variantId，重算的 commit 必然對不上，
-- 於是一批誠實的舊池會突然全部顯示「被竄改」。這跟 018 的判斷是同一個。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 完整退版（無損）：
--     alter table pools drop constraint if exists pools_commit_version_known;
-- 退版後既有的池一個位元都沒被動過。

-- ---------- commit 版本的合法範圍 ----------
--
-- 為什麼要這道 check：commit_version 是驗算端唯一的「用哪套規則重算」的依據。
-- 寫進一個程式碼不認得的版本號（打錯、或未來某支遷移寫壞），那個池就變成
-- **永遠驗不了**的池 —— 而它在畫面上仍然掛著「可驗證」的標章。
-- 那比開不出來更糟：驗算頁面會拋錯，而使用者只會讀成「這個平台在唬人」。
--
--   1  commit = SHA256(server_seed)                              最早的池
--   2  commit = SHA256(seed ‖ hash(manifest 十欄))                011 之後
--   3  + buyback（賣家宣告的買回價）                              018 之後
--   4  + variantId（卡片變體）                                    這支之後的新池
--
-- 加新版本時要記得放寬這道 check —— 那是刻意的摩擦：升 manifest 版本
-- 一定要有人回來讀一次上面那段「既有的池怎麼辦」。
alter table pools drop constraint if exists pools_commit_version_known;
alter table pools add constraint pools_commit_version_known
  check (commit_version is null or commit_version between 1 and 4);

comment on column pools.commit_version is
  'manifest 序列化版本（1/2/3/4）。驗算端照這個值重算，**不依序嘗試** —— '
  '依序嘗試等於接受「任何一版算得過就好」，作弊的伺服器可以挑對自己有利的那一版。'
  '4 起 manifest 尾端含 variantId（卡片變體），見 shared/fairness.ts。';

comment on column pool_prizes.card is
  '獎品的卡片身分（jsonb）。會進 manifest 的鍵：name / setCode / cardNo / '
  'grader / grade / certNo / refPrice，v4 起再加 variantId（卡片變體，'
  '同卡號不同版本實測差約 18,000 倍，不綁進承諾就換得掉）。'
  'image 與其餘欄位刻意不進承諾：換一張圖是誠實的維護，不該看起來像作弊。';
