-- 賣家列表批次統計與游標分頁需要的索引（open-issues A-3）
--
-- 這支只加索引，不改任何欄位或約束 —— 退版無損（drop index 即可），
-- 也不需要跟程式碼同時上線：沒有這些索引程式一樣正確，只是慢。
--
-- ── prizes(pool_id) ──
-- prizes 原本只有 user_id / cert / 卡冊游標那幾條索引，**沒有一條是 pool_id**。
-- 賣家統計的「大獎命中數」與「近期獎項」都是從池反查獎品
-- （prizes pz join pools p on p.id = pz.pool_id），沒有這條就是每位賣家
-- 一次全表掃描 —— 批次化把查詢條數降下來了，但每一條掃的量沒變。
-- 只索引 pool_id 不是 null 的列：021 之後 pool_id 可為 null（自己入庫的卡），
-- 那些列永遠不會被這條路徑找，放進索引只是佔空間。
create index if not exists prizes_pool
  on prizes(pool_id) where pool_id is not null;

-- ── sellers(joined_at, id) ──
-- 列表改成游標分頁之後，排序鍵是 (joined_at asc, id asc)，
-- 游標比較寫成 row value `(joined_at, id) > (?, ?)`，
-- 索引的欄位順序必須跟它逐字對應才走得到 range scan。
-- 賣家表現在很小，這條的價值是「賣家變多時不必回頭改」而不是今天的速度。
create index if not exists sellers_joined
  on sellers(joined_at, id);
