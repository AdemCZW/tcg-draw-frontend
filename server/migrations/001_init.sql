-- VaultDraw 初始結構
--
-- 兩個貫穿全表的設計決定：
--   1 點數只存帳本，不存 balance 欄位。餘額一律 SUM(delta) 推算。
--     存餘額就會有「餘額跟帳本對不起來」的一天，而且對帳時你不知道該信哪個。
--   2 凍結金額也不存，用「進行中訂單」推算。同樣的理由。

create table if not exists users (
  id          text primary key,
  handle      text unique not null,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- 點數帳本。只能追加，不能改也不能刪。
create table if not exists points_ledger (
  id          bigserial primary key,
  user_id     text not null references users(id),
  delta       bigint not null,
  reason      text not null,
  order_id    text,
  created_at  timestamptz not null default now()
);
create index if not exists ledger_user on points_ledger(user_id);

-- 同一張訂單的同一種結算只能寫一次。
-- 掃描逾期訂單可能同時被多個請求觸發，沒有這條約束就會重複入帳。
create unique index if not exists ledger_once
  on points_ledger(order_id, user_id, reason)
  where order_id is not null;

create table if not exists listings (
  id           text primary key,
  card         jsonb not null,
  price        bigint not null check (price > 0),
  seller_id    text not null references users(id),
  seller_name  text not null,
  delivery     text not null check (delivery in ('vault', 'ship')),
  status       text not null default 'live' check (status in ('live', 'sold')),
  cert_no      text,
  listed_at    timestamptz not null default now()
);

-- 一卡多賣的防線：同一個鑑定編號同時只能有一筆有效掛單。
-- 這是資料庫層的約束，不是應用層的檢查 —— 應用層的檢查擋不住併發。
create unique index if not exists listings_cert_live
  on listings(cert_no) where status = 'live' and cert_no is not null;

create table if not exists orders (
  id                 text primary key,
  listing_id         text not null references listings(id),
  card               jsonb not null,
  price              bigint not null,
  deposit            bigint not null,
  buyer_id           text not null references users(id),
  buyer_name         text not null,
  seller_id          text not null references users(id),
  seller_name        text not null,
  status             text not null,
  -- 時間一律存毫秒整數，跟前端的 escrow.ts same units。
  -- 混用 timestamptz 跟 epoch 遲早會有人算錯時區。
  created_at         bigint not null,
  shipped_at         bigint,
  delivered_at       bigint,
  settled_at         bigint,
  tracking           text,
  disputed_at        bigint,
  dispute_reason     text,
  has_unboxing_video boolean,
  closed_by          text
);
create index if not exists orders_buyer on orders(buyer_id);
create index if not exists orders_seller on orders(seller_id);
create index if not exists orders_open on orders(status)
  where status in ('escrowed', 'shipped', 'delivered', 'disputed');

-- 同一組物流單號不得用在兩張訂單
create unique index if not exists orders_tracking_uniq
  on orders(tracking) where tracking is not null;

-- 重複送出的防線：同一把 key 只會成立一張訂單
create table if not exists idempotency (
  key        text primary key,
  user_id    text not null,
  order_id   text not null,
  created_at timestamptz not null default now()
);
