-- 冪等鍵要綁使用者：主鍵從 (key) 改成 (user_id, key)。
--
-- 為什麼：001 把 key 單獨當主鍵，於是「這把鍵用過沒有」是全站共用的問題。
-- 鍵是呼叫端自己產生的字串，而 routes/pools.ts 與 routes/orders.ts 查重複時
-- 只比 key、不比人 —— 拿到（或猜到）別人的鍵重放一次，回傳的就是那個人的
-- 抽卡紀錄或整張訂單（含卡片鑑定編號、買賣雙方身分、成交價）。
-- 這是純粹的授權缺失：資料的可見性不該靠對方的字串猜不到。
--
-- 主鍵換成複合鍵之後，「別人的鍵」對你等於沒用過，會走正常建立流程；
-- 而「同一個人重放同一把鍵」還是照舊回原本那筆，冪等的正常用途不受影響。
-- 兩個人剛好用同一把鍵也不再互相擋到（以前後到的那個會撞主鍵）。
--
-- 既有資料不需要回填：user_id 從 001 起就是 not null，
-- 而 key 原本是主鍵、全表唯一，所以 (user_id, key) 一定不會有重複。
alter table idempotency drop constraint if exists idempotency_pkey;
alter table idempotency add primary key (user_id, key);
