-- 卡片「進到這個人卡冊」的時間，跟「這張卡被抽出來」的時間分開記。
--
-- 為什麼要分：卡冊本來排序用 won_at，而 won_at 是抽出這張卡的那一刻。
-- 庫內轉移（市場買卡、接受出價）只改 owner 不改 won_at，於是買到的卡
-- 帶著賣家當初抽到的時間進到買家的卡冊 —— 排序上落在「幾天前」，
-- 卡冊超過一頁時它直接不在第一頁上，使用者的感受就是「我買的卡沒進卡冊」。
--
-- 為什麼不是直接把 won_at 改成現在：won_at 還有別的讀者，
-- 公開的「最近開出」動態（routes/public.ts）就是照 won_at 排的。
-- 過戶時改 won_at 會讓一張買來的卡出現在「剛剛有人抽到」的動態裡 —— 那是假的。
-- 抽出來的時間是事實，不該被交易改寫；「我什麼時候拿到的」是另一件事，另開一欄。
alter table prizes add column if not exists acquired_at bigint;
-- 既有資料沒有過戶紀錄可考，只能以抽出時間為準（第一手持有者的兩個時間本來就相同）
update prizes set acquired_at = won_at where acquired_at is null;
alter table prizes alter column acquired_at set not null;

-- 索引欄位順序與方向必須跟 order by 逐字對應，否則規劃器用不到它（見 013）
create index if not exists prizes_user_acquired
  on prizes (user_id, acquired_at desc, id desc);
create index if not exists prizes_user_status_acquired
  on prizes (user_id, status, acquired_at desc, id desc);

-- 卡冊不再照 won_at 排，這兩條就沒有查詢會走了。留著只是讓每次寫入都多維護一份
drop index if exists prizes_user_won;
drop index if exists prizes_user_status_won;
