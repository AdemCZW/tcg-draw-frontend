-- 核心：帳號、賣家、池與籤位、抽選、獎品、檔案。
-- 設計見 DESIGN.md。三條線：點數永不提現、只存帳本不存餘額、籤序開賣前決定。

-- ---------- 帳號 ----------
alter table users add column if not exists email         text unique;
alter table users add column if not exists password_hash text;
alter table users add column if not exists role          text not null default 'user'
  check (role in ('user', 'admin'));

-- 第三方登入（LINE / Google）之後接，先把位置留好
create table if not exists auth_identities (
  user_id       text not null references users(id),
  provider      text not null,
  provider_uid  text not null,
  created_at    timestamptz not null default now(),
  primary key (provider, provider_uid)
);

-- 帳本的參照從 order_id 泛化成 ref_id：儲值、抽選、回收都要能對回來源
alter table points_ledger rename column order_id to ref_id;
drop index if exists ledger_once;
create unique index if not exists ledger_once
  on points_ledger(ref_id, user_id, reason) where ref_id is not null;

create table if not exists topups (
  id            text primary key,
  user_id       text not null references users(id),
  amount_twd    bigint not null check (amount_twd > 0),
  points        bigint not null check (points > 0),
  provider      text not null,
  provider_ref  text,
  status        text not null default 'pending'
                check (status in ('pending', 'paid', 'failed', 'refunded')),
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create unique index if not exists topups_provider_ref on topups(provider, provider_ref)
  where provider_ref is not null;

-- ---------- 檔案 ----------
-- 只存 R2 的 object key。瀏覽器用 presigned URL 直傳，位元組不經過這台伺服器。
create table if not exists files (
  id          text primary key,
  owner_id    text not null references users(id),
  purpose     text not null
              check (purpose in ('pool-cover', 'ship-photo', 'unbox-video', 'seller-doc', 'avatar')),
  key         text not null unique,
  mime        text not null,
  bytes       bigint not null,
  created_at  timestamptz not null default now(),
  -- 保存期限（見 DESIGN.md 第 4 節）。null = 隨實體
  expires_at  timestamptz
);

-- ---------- 賣家 ----------
create table if not exists sellers (
  id              text primary key references users(id),
  handle          text unique not null,
  name            text not null,
  origin          text not null check (origin in ('official', 'merchant', 'personal')),
  tier            text not null default 'pending'
                  check (tier in ('pending', 'verified', 'trusted')),
  bio             text not null default '',
  avatar_file_id  text references files(id),
  joined_at       timestamptz not null default now()
);

create table if not exists seller_verifications (
  id           bigserial primary key,
  seller_id    text not null references sellers(id),
  doc_file_id  text not null references files(id),
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected')),
  note         text,
  reviewed_by  text references users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------- 池 ----------
create table if not exists pools (
  id                  text primary key,
  seller_id           text not null references sellers(id),
  mode                text not null
                      check (mode in ('classic', 'shitei', 'muteki', 'streak', 'auction')),
  title               text not null,
  cover_file_id       text references files(id),
  ticket_price        bigint not null check (ticket_price > 0),
  total_tickets       int not null check (total_tickets > 0),
  status              text not null default 'draft'
                      check (status in ('draft', 'committed', 'open', 'sold_out', 'revealed', 'cancelled')),
  -- 公平抽選。server_seed 在 revealed 之前絕對不能從任何端點流出。
  server_seed         text,
  commit_hash         text,
  client_seed_source  text,
  client_seed         text,
  -- 模式參數
  shitei_tier         text,
  auction_seats       int,
  created_at          timestamptz not null default now(),
  opened_at           timestamptz,
  revealed_at         timestamptz
);
create index if not exists pools_seller on pools(seller_id);
create index if not exists pools_status on pools(status);

create table if not exists pool_prizes (
  id        text primary key,
  pool_id   text not null references pools(id),
  tier      text not null check (tier in ('A', 'B', 'C', 'D', 'LAST', 'BUST')),
  card      jsonb not null,
  total     int not null check (total >= 0)
);
create index if not exists pool_prizes_pool on pool_prizes(pool_id);

-- 籤位。開池時依籤序一次寫滿；抽選就是搶佔一列。
-- 這張表就是併發防線：兩人同時選 78 號，UPDATE ... WHERE taken_by IS NULL 只會讓一個人成功。
create table if not exists pool_seats (
  pool_id    text not null references pools(id),
  seat       int not null,
  prize_id   text not null references pool_prizes(id),
  taken_by   text references users(id),
  taken_at   bigint,
  draw_id    text,
  primary key (pool_id, seat)
);
create index if not exists pool_seats_free on pool_seats(pool_id) where taken_by is null;

create table if not exists draws (
  id          text primary key,
  pool_id     text not null references pools(id),
  user_id     text not null references users(id),
  seats       int[] not null,
  cost        bigint not null,
  -- streak 的收手 / 競標的得標也會產生 draw，這裡記來源
  source      text not null default 'draw' check (source in ('draw', 'streak', 'auction', 'bonus')),
  created_at  bigint not null
);
create index if not exists draws_user on draws(user_id);
create index if not exists draws_pool on draws(pool_id);

create table if not exists streak_runs (
  id           text primary key,
  pool_id      text not null references pools(id),
  user_id      text not null references users(id),
  entry_cost   bigint not null,
  status       text not null default 'live' check (status in ('live', 'banked', 'busted')),
  drawn_seats  int[] not null default '{}',
  held_value   bigint not null default 0,
  created_at   bigint not null,
  closed_at    bigint
);
create index if not exists streak_user_live on streak_runs(user_id) where status = 'live';

create table if not exists auction_lots (
  id         text primary key,
  pool_id    text not null references pools(id),
  seat       int not null,
  start_bid  bigint not null,
  ends_at    bigint not null,
  status     text not null default 'live' check (status in ('live', 'ended')),
  winner_id  text references users(id),
  unique (pool_id, seat)
);

-- 出價會凍結點數（跟託管一樣的模型）。is_top 只有一筆為真；被超過即解凍。
create table if not exists bids (
  id          bigserial primary key,
  lot_id      text not null references auction_lots(id),
  user_id     text not null references users(id),
  amount      bigint not null,
  is_top      boolean not null default true,
  created_at  bigint not null
);
create unique index if not exists bids_one_top on bids(lot_id) where is_top;
create index if not exists bids_user_top on bids(user_id) where is_top;

-- ---------- 獎品（使用者名下的卡） ----------
create table if not exists prizes (
  id                text primary key,
  user_id           text not null references users(id),
  pool_id           text not null references pools(id),
  seat              int,
  draw_id           text references draws(id),
  card              jsonb not null,
  tier              text not null,
  status            text not null default 'stashed'
                    check (status in ('stashed', 'listed', 'ship_requested', 'shipped', 'recycled')),
  won_at            bigint not null,
  -- 保管到期。到期怎麼處理是政策問題（DESIGN.md 第 9 節），目前只通知不動
  stash_expires_at  bigint not null
);
create index if not exists prizes_user on prizes(user_id);

create table if not exists shipments (
  id          text primary key,
  user_id     text not null references users(id),
  prize_ids   text[] not null,
  address     jsonb not null,
  status      text not null default 'requested'
              check (status in ('requested', 'packed', 'shipped', 'delivered')),
  tracking    text,
  created_at  bigint not null,
  shipped_at  bigint
);

-- listings 接回獎品：庫內轉移成交時要改 prizes.user_id
alter table listings add column if not exists prize_id text references prizes(id);
create unique index if not exists listings_prize_live on listings(prize_id)
  where status = 'live' and prize_id is not null;
