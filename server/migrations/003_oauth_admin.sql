-- OAuth 的 state 要跨實例、跨部署存活，放資料庫
create table if not exists oauth_states (
  state       text primary key,
  nonce       text not null,
  provider    text not null,
  created_at  timestamptz not null default now()
);
-- 過期的 state 定期清（callback 也會順手刪用過的）
create index if not exists oauth_states_created on oauth_states(created_at);

-- 後台每個動作都留一筆：誰、對誰、做了什麼、為什麼。
-- 發點數這種事沒有稽核紀錄，出事時你連自己都說不清。
create table if not exists admin_actions (
  id          bigserial primary key,
  admin_id    text not null references users(id),
  action      text not null,
  target      text,
  payload     jsonb,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists admin_actions_admin on admin_actions(admin_id, created_at);
