-- 010：掛單可以下架
--
-- listings.status 原本只有 ('live', 'sold') —— 沒有「賣家自己收回」這個狀態，
-- 所以上架之後只能等人買，賣家改變主意（想留著、想自己出貨、定價錯了）
-- 都沒有出路。卡也跟著卡在 prizes.status = 'listed'，不能出貨也不能回收。
--
-- 加 'delisted'。它跟 'sold' 一樣不是 'live'，所以兩條
-- where status='live' 的唯一索引會自動放行，同一張卡下架後可以重新上架。

alter table listings drop constraint if exists listings_status_check;
alter table listings add constraint listings_status_check
  check (status in ('live', 'sold', 'delisted'));
