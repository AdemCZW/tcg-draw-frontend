-- 018：把「回收價」從賣家自填市值 × 比率，換成賣家直接宣告的買回金額
--
-- 為什麼要換（docs/HANDOFF.md 4.1 標為最大結構性風險）：
-- refPrice 是賣家自己填的、沒有任何外部依據，而回收價、還元率、市場折扣
-- 全部從它算出來 —— 賣家填高，所有數字一起說謊。
--
-- 換成「宣告買回價」之後，那個數字是**他有義務履行的金額**：玩家一按接受，
-- 錢就從他自己那個池的保留額出去。設太高自己賠、設太低沒人抽，
-- 自我修正，不需要任何外部價格資料。refPrice 從此只是顯示。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 這支遷移**只新增欄位、不刪任何東西、不改任何既有欄位的值**
-- （唯一的 UPDATE 只寫進新欄位 pools.commit_version）。
--
-- 完整退版（無損）：
--     alter table pool_prizes drop column if exists buyback;
--     alter table pools       drop column if exists commit_version,
--                             drop column if exists floor_ratio;
--
-- 退版之後所有既有的池照舊運作：它們的 commit_hash、manifest_hash、
-- return_ratio、recycle_rate 一個位元都沒有被動過。

-- ---------- 每個獎品一個宣告買回價 ----------

-- 上下限見 shared/pool-settlement.ts（BUYBACK_MIN / BUYBACK_MAX）。
-- 下限 10 擋掉「填 0」——「買回價 0」是掛著買回的招牌卻什麼都不買。
-- 上限一千萬是荒謬值防線（手滑多打幾個零），不是經濟門檻；
-- 真正的經濟門檻是整池的 Σ(買回價) 必須低於票收，那道閘在建池 API 上。
--
-- 允許 null：既有的池沒有宣告過買回價，見下方「既有的池怎麼辦」。
alter table pool_prizes add column if not exists buyback bigint
  check (buyback is null or (buyback >= 10 and buyback <= 10000000));

-- ---------- commit 的版本 ----------
--
-- manifestString 用 `|` join，尾端多一個 buyback 欄位會讓**每一行**都變 ——
-- 既有的池用新程式重算出來的 manifest 對不上它們存著的 commit，而那些 commit
-- 已經對外公布過，不能事後改。所以序列化必須版本化（見 shared/fairness.ts）。
--
-- 為什麼存欄位、不「依序嘗試 v2 再試 v3」：
-- 依序嘗試等於讓驗算端接受「任何一版算得過就好」，一個作弊的伺服器
-- 可以挑對自己有利的那一版送出，驗算端會替它背書。
-- 「用哪一套規則序列化」本身就是承諾的一部分，必須由池事先宣告、只有一個答案。
--
--   1  commit = SHA256(server_seed)                         最早的池
--   2  commit = SHA256(seed ‖ hash(manifest 十欄))           011 之後的池
--   3  commit = SHA256(seed ‖ hash(manifest 十一欄含 buyback))  這支之後的新池
alter table pools add column if not exists commit_version smallint;

-- 回填既有的池。判斷依據就是 011 當初留下的那一條：manifest_hash 是 null 就是 v1。
-- 這個 UPDATE 只寫新欄位，既有欄位一個都沒動，所以退版把欄位 drop 掉就還原了。
update pools set commit_version = case when manifest_hash is null then 1 else 2 end
 where commit_version is null;

-- ---------- 保底回饋率 ----------
--
-- **不重用 pools.return_ratio。** 那一欄存的是舊制的還元率 ——
-- Σ(賣家標示的市值) ÷ 票收，也就是「賣家說這池值多少」。
-- 新的保底回饋率是 Σ(宣告買回價) ÷ 票收，也就是「賣家最少要付出多少」。
-- 兩個數字意義不同，塞進同一欄會讓買家在同一個標籤下看到兩種東西，
-- 而且沒有任何辦法事後分辨哪一列是哪一種。舊池留著舊數字、標示它是舊數字，
-- 比把它改寫成一個算不出來的新數字誠實。
alter table pools add column if not exists floor_ratio numeric(6,2);

-- ---------- pools.recycle_rate 廢除 ----------
--
-- 這一欄是 017 加的「賣家設定的回收比率」，回收金額 = refPrice × 這個比率。
-- 程式碼已經完全不再讀它。**故意不 drop**：drop 會把既有池的設定值永久刪掉，
-- 那是不可逆的，而留著一個沒人讀的欄位沒有任何成本。
-- 真的要清乾淨時再單獨開一支遷移。
comment on column pools.recycle_rate is
  '已廢除（018）。回收金額改讀 pool_prizes.buyback，程式碼不再讀這一欄。保留只為了退版與稽核。';

-- ── 既有的池怎麼辦 ─────────────────────────────────────────────────
--
-- 決定：**保持 v2、不能回收、不給預設值。**
--
-- 為什麼不給預設值（例如照舊的 recycle_rate × refPrice 回填一個 buyback）：
-- 買回價是一筆**賣家有義務履行的債**，錢從他的保留額出。系統替他宣告一個
-- 他從來沒有同意過的金額，等於平台單方面替賣家簽了約。
-- 而且要填的話只能拿 refPrice 來算 —— 那正是這支遷移要拆掉的那個地基。
--
-- 為什麼不改成 v3：它們的 commit 已經公布過。改版本號會讓驗算端用 v3 的規則
-- 重算，而那些池的 manifest 沒有 buyback 欄位，重算的 commit 必然對不上，
-- 於是一批誠實的舊池會突然全部顯示「被竄改」。
--
-- 後果：舊池抽到的卡不能回收，前端顯示「這個池沒有宣告買回價」。
-- 這不是新的損失 —— 017 之後舊制的卡本來就回收不了（它們沒有保留額可以付，
-- 見 017 的說明）。正式環境現有的 12 個池全部落在這個分類裡。
