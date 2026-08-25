-- 抽卡池的結算。補上 docs/pool-modes-audit.md 的 C-2：
-- 票金只有借方沒有貸方 —— 賣家一毛都收不到，點數每抽一次就蒸發一次。
--
-- 設計的三個前提（改動之前先讀 server/src/money.ts 開頭）：
--
--  1 不新增任何「可以直接改的餘額欄位」。保留額跟餘額一樣是**推導**的：
--    保留額 = SUM(pool_settlements.amount) where status in ('held','awaiting_ship','shipped')。
--    這張表存的是每一筆交易的事實與狀態，不是一個總額。
--
--  2 一張卡一列，不是一個池一列。賣家的現金流不該綁在「這個池會不會抽完」上。
--
--  3 releases / refunds / recycle 各自對應明確的分錄，借貸永遠成對，
--    全站 SUM(points_ledger.delta) 恆等於實際發行量（儲值 + 平台發放）。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 這支遷移**只新增**：一張新表、pools 的三個欄位、sellers 的一個欄位，
-- 以及把 'refunded' 加進 prizes.status 的 check。沒有刪任何欄位、
-- 沒有搬任何既有資料列的值。
--
-- 完整退版（在還沒有任何新抽卡進來之前是無損的）：
--     drop table if exists pool_settlements;
--     alter table pools   drop column if exists expires_at,
--                         drop column if exists recycle_rate,
--                         drop column if exists platform_fee_rate;
--     alter table sellers drop column if exists default_count;
--     -- prizes 的 check 收回去只有在沒有任何 status='refunded' 的列時才做得到
--     alter table prizes drop constraint if exists prizes_status_check;
--     alter table prizes add constraint prizes_status_check
--       check (status in ('stashed','listed','ship_requested','shipped','recycled'));
--
-- ⚠️ 正式資料：**既有的 draws 不回填 pool_settlements，也不補任何分錄。**
-- 回填等於憑空貸記賣家一筆從來沒有存在過的收入 —— 那些點數當初是被銷毀的，
-- 現在補一筆貸方就是真的印鈔票。既有的抽卡就讓它停在「已銷毀」的歷史事實上，
-- 對帳時它會表現為「發行量 − 目前總量 = 舊制銷毀量」，是查得出來的一個常數。
-- 新制只對這支遷移之後的抽卡生效。

-- ---------- 池：到期日、回收報價、抽成 ----------

-- 到期就關池、停止販售，未售出籤位的卡回到賣家手上（那些籤從來沒有產生過
-- prizes 列，所以「回到賣家手上」不需要任何搬移動作，只是不再賣）。
-- 允許 null：既有的池沒有到期日，null 表示不到期，行為跟今天一樣。
alter table pools add column if not exists expires_at bigint;

-- 賣家設定的回收報價比率（市場價的 5–7 成，見 shared/pool-settlement.ts）。
-- null = 這個池不提供回收。舊池都是 null —— 舊制的平台回收已經整組移除，
-- 舊池的卡因此不能回收，這是刻意的：那些池沒有保留額可以付。
alter table pools add column if not exists recycle_rate numeric(4,3)
  check (recycle_rate is null or (recycle_rate >= 0.5 and recycle_rate <= 0.7));

-- 建池當下的平台抽成。**存在池上而不是讀全站常數**：票已經賣出去之後
-- 才調整抽成，等於片面改約。舊池補 0，跟它們實際發生的事一致（沒有抽成）。
alter table pools add column if not exists platform_fee_rate numeric(4,3) not null default 0;

-- ---------- 賣家：違約次數 ----------

-- 逾期未出貨一次加一。超過 shared/pool-settlement.ts 的門檻就不能再開池。
-- 沒有保證金，所以這是唯一擋得住連續違約的手段。
alter table sellers add column if not exists default_count int not null default 0;

-- ---------- 結算 ----------

create table if not exists pool_settlements (
  id            text primary key,
  pool_id       text not null references pools(id),
  seller_id     text not null references users(id),
  buyer_id      text not null references users(id),
  draw_id       text not null references draws(id),
  seat          int  not null,
  -- 買家卡冊裡的那一列。回收要把它標掉，出貨要跟著它走
  prize_id      text not null references prizes(id),
  -- 賣家該收的（票價 − 抽成）與平台抽成。兩者相加必須等於票價
  amount        bigint not null check (amount >= 0),
  fee           bigint not null check (fee >= 0),
  -- 賣家自抽自池。不禁止（錢從自己流到自己，沒有新點數被創造），
  -- 但**不計入公開的進度顯示** —— 否則賣家可以刷「剩 3/50」騙真人跟進。
  self_draw     boolean not null default false,
  status        text not null default 'held'
                check (status in ('held','awaiting_ship','shipped','released','refunded','recycled')),
  created_at    bigint not null,
  ship_due_at   bigint,
  shipped_at    bigint,
  closed_at     bigint,
  closed_by     text check (closed_by in
                  ('buyer-confirm','inspect-timeout','vault-accept','ship-timeout','recycle')),
  -- 一個籤位只能結算一次。這是防重複入帳的最後一道（第一道是 ledger_once）
  unique (pool_id, seat)
);

-- 保留額的查詢：where seller_id = ? and status in (...)。走這條部分索引，
-- 不用掃整張表 —— 這個查詢每次算錢包都會跑一次
create index if not exists settlements_seller_open on pool_settlements(seller_id)
  where status in ('held','awaiting_ship','shipped');
create index if not exists settlements_buyer on pool_settlements(buyer_id);
create index if not exists settlements_prize on pool_settlements(prize_id);
-- 逾期掃描：只掃還沒結束的
create index if not exists settlements_open on pool_settlements(status)
  where status in ('held','awaiting_ship','shipped');

-- ---------- 卡片狀態多一個「已退還賣家」 ----------
-- 逾期未出貨退款之後，那張卡不在買家名下了，但它也不是「回收」——
-- 回收是買家主動接受報價，退款是賣家違約。兩件事的責任歸屬不同，
-- 混成同一個狀態會讓後台看不出賣家的履約紀錄。
alter table prizes drop constraint if exists prizes_status_check;
alter table prizes add constraint prizes_status_check
  check (status in ('stashed','listed','ship_requested','shipped','recycled','refunded'));
