-- 帳號綁定：讓同一個人可以用多種方式登入同一個帳號。
--
-- oauth_states 加 user_id：走 LINE 授權時如果已經登入，
-- 回來要「綁到這個既有帳號」而不是「建一個新帳號」。
-- 這個意圖必須在導去 LINE 之前就記下來，回來才知道是綁定還是登入——
-- callback 只拿得到 state，沒有其他上下文。
alter table oauth_states add column if not exists user_id text references users(id);
