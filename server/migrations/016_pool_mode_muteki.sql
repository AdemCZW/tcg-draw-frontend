-- 玩法收斂成一種，而且改叫它實際跑的那一套。
--
-- 為什麼改名：pools-service.ts 的 draw() 從頭到尾沒有讀過 pools.mode。
-- 它的行為是「最後賞就是籤池裡的一張普通獎品，抽走最後一籤沒有任何加送」——
-- 那是無敵賞（muteki）的定義，不是經典賞（classic）的。
-- 但每一個池都標著 classic，前端的玩法徽章照著寫「抽走最後一籤額外獲得最後賞」，
-- 而那條規則後端一行都沒有。對付費玩家而言那是不實陳述。
--
-- 為什麼是改名而不是補實作：補「最後賞給誰」牽涉到「誰算最後一籤」的機制設計
-- （LAST 要不要佔籤位、併發下誰是最後一個、未售完就收攤怎麼算），
-- 那是還沒決定的產品問題。在決定之前，讓標示等於實際的唯一辦法就是改標示。
--
-- 為什麼把 check 收成只剩一種：002 的 check 允許五種 mode，但 API 只收一種，
-- 抽卡邏輯一種都不讀。兩層的說法不一致，中間的落差是真的能踩的：
-- 直接 update pools set mode='shitei' 就能造出一個「徽章寫指定賞、
-- 實際照普通池發獎」的池，而公開 API 會原樣把 shitei 吐給前端渲染。
-- 約束是文件，讓它跟程式說同一句話；哪個玩法真的做好了再放寬那一個。
--
-- 順序不能反：check 是欄位上的約束，收緊之後 classic 就寫不進去了，
-- 所以必須「先鬆綁 → 搬資料 → 再收緊」。反過來會在 add constraint 那一步
-- 因為既有 14 筆 classic 而整支遷移失敗（migrate.ts 把每支包在交易裡，
-- 失敗會整個回滾，不會留下半套，但也就永遠過不去）。
--
-- 可逆性：這一步只改 pools.mode 這一個欄位的字面值，沒有刪任何欄位或資料列。
-- 要退回去就是反著做一次：
--     alter table pools drop constraint pools_mode_check;
--     update pools set mode = 'classic' where mode = 'muteki';
--     alter table pools add constraint pools_mode_check
--       check (mode in ('classic','shitei','muteki','streak','auction'));
-- 之所以能無損還原，是因為今天全站的池「都是」classic（正式環境 14 個，
-- 一個 muteki 都沒有），classic → muteki 是一對一的滿射，沒有兩種來源混進同一個值。
-- 這個前提在往後就不成立了 —— 之後開的池本來就是 muteki，
-- 屆時把它們一律退回 classic 反而會製造出新的假標示。所以退版只在這支遷移
-- 剛上線、還沒有新池進來的那段窗口內是安全的。

-- 1. 先鬆綁，才搬得動資料
alter table pools drop constraint if exists pools_mode_check;

-- 2. 既有資料先就位。全部都是 classic，而 classic 實際跑的就是 muteki
update pools set mode = 'muteki' where mode = 'classic';

-- 3. 再收緊。只留唯一一個「後端真的有實作」的玩法
alter table pools add constraint pools_mode_check check (mode in ('muteki'));
