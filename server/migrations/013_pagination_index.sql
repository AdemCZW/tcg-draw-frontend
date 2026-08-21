-- 游標分頁要走得動的索引。
--
-- 卡冊、公開卡冊、市場掛單改成分批載入之後，每一次捲到底都會打一次
-- 「(排序鍵) < (游標)」的範圍查詢。沒有對應的索引時 Postgres 只能整表掃過
-- 再排序 —— 資料還少的時候看不出來，但這幾張表是只增不減的，
-- 而且分頁把「一次全排」變成「每捲一頁排一次」，缺索引的代價會被放大。
--
-- 索引的欄位順序與方向必須跟 order by 逐字對應，否則規劃器用不到它。

-- 卡冊：order by won_at desc, id desc（可再加 status 過濾）
create index if not exists prizes_user_won
  on prizes (user_id, won_at desc, id desc);

-- 狀態分頁（寄存中／已出貨…）走這條：狀態擺在時間之前，才選得出等值前綴
create index if not exists prizes_user_status_won
  on prizes (user_id, status, won_at desc, id desc);

-- 公開卡冊：order by (賞別序), -won_at, id。
-- 賞別序與 -won_at 都是運算式，必須建成運算式索引，直接對 tier / won_at
-- 建索引是接不上的。where 條件跟查詢一致，做成部分索引省一半空間。
create index if not exists prizes_cardbook_cursor
  on prizes (
    user_id,
    (case tier when 'LAST' then 0 when 'A' then 1 when 'B' then 2 when 'C' then 3 else 4 end),
    ((-won_at)),
    id
  )
  where status in ('stashed', 'listed');

-- 市場：四種排序各自的游標鍵。全部只看 status = 'live'，做成部分索引。
create index if not exists listings_live_new
  on listings (listed_at desc, id desc) where status = 'live';
create index if not exists listings_live_price
  on listings (price, id) where status = 'live';

-- 「低於市值」排序的鍵是一個比值，同樣得建成運算式索引。
-- coalesce/nullif 都是 immutable，可以進索引。
create index if not exists listings_live_deal
  on listings (
    (coalesce((price - nullif((card->>'refPrice')::numeric, 0))
              / nullif((card->>'refPrice')::numeric, 0), 0)),
    id
  )
  where status = 'live';
