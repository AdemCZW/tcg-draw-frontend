-- 登入速率限制。
--
-- 沒有這層的話，密碼長度是唯一的防線——攻擊者可以無限次嘗試，
-- 8 碼密碼在沒有次數限制下是可以慢慢猜出來的。
--
-- 用 Postgres 不用 Redis：目前沒有任何其他功能需要 Redis，
-- 為了一張計數表多養一個服務不划算。登入不是熱路徑，多一次查詢可以接受。
create table if not exists login_attempts (
  key       text primary key,          -- 'ip:1.2.3.4' 或 'email:foo@bar.com'
  attempts  int not null default 0,
  first_at  timestamptz not null default now()
);
-- 清理過期紀錄用
create index if not exists login_attempts_first on login_attempts(first_at);
