-- 007：卡冊公開分享、交易邀約、站內通知
--
-- 三件事放同一支遷移，是因為它們是同一條使用者動線：
-- 把卡冊分享出去 → 別人看到想要 → 提出交易 → 我收到通知。
-- 拆成三支的話中間任一支沒跑到，動線就是斷的。

/* ---- 卡冊公開 ----
   預設 false：卡冊裡有鑑定編號和持有數量，等於財力揭露，
   要公開必須是持有人自己按的，不能靠預設值幫他決定。 */
alter table users add column if not exists cardbook_public boolean not null default false;

/* 分享用的短代號。不用 user_id 當網址是刻意的：
   user_id 會出現在後台、訂單、爭議紀錄裡，把它變成公開網址等於
   讓任何人都能拿它去猜其他端點。slug 是獨立的、可以撤銷重發的。 */
alter table users add column if not exists share_slug text;
create unique index if not exists users_share_slug on users(share_slug) where share_slug is not null;

/* ---- 交易邀約 ----
   對「別人卡冊裡的卡」出價。跟 listings 的差別是方向：
   listings 是持有人主動掛出來賣，這是想要的人主動去問。

   成立時走的是既有的「庫內轉移」語意（見 orders.ts 的 delivery === 'vault'）：
   卡片本來就在平台保管庫，過戶只是改 owner + 記兩筆帳，
   不需要託管、不需要物流、沒有中間狀態。不另外發明一套結算。 */
create table if not exists trade_offers (
  id            text primary key,
  prize_id      text not null references prizes(id),
  from_user     text not null references users(id),
  to_user       text not null references users(id),
  points        int  not null check (points > 0),
  message       text not null default '',
  status        text not null default 'pending'
                check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at    bigint not null,
  responded_at  bigint
);
create index if not exists trade_offers_inbox on trade_offers(to_user, status, created_at desc);
create index if not exists trade_offers_outbox on trade_offers(from_user, status, created_at desc);

/* 同一個人對同一張卡只能有一個待回應的邀約。
   沒有這條約束，連點送出就會在對方的通知裡塞出十筆一樣的東西。 */
create unique index if not exists trade_offers_one_open
  on trade_offers(prize_id, from_user) where status = 'pending';

/* ---- 通知 ---- */
create table if not exists notifications (
  id          bigserial primary key,
  user_id     text not null references users(id),
  kind        text not null
              check (kind in ('draw', 'trade-offer', 'trade-result', 'listing-sold',
                              'order', 'shipment', 'system')),
  title       text not null,
  body        text not null default '',
  -- 前端路由字串。點通知要能跳到現場，不然使用者知道發生事情卻找不到在哪
  link        text,
  ref_id      text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_inbox on notifications(user_id, id desc);
create index if not exists notifications_unread on notifications(user_id) where read_at is null;

/* 同一件事只通知一次。寫入端會重試（結算是 idempotent 的），
   沒有這條約束，重試一次就多一則一樣的通知。 */
create unique index if not exists notifications_once
  on notifications(user_id, kind, ref_id) where ref_id is not null;
