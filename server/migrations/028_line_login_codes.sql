-- 028：LINE OAuth callback 不再把 JWT 放進 URL。
--
-- callback 只回傳一把隨機、一次性、五分鐘有效的交換碼；前端再 POST 回來換 JWT。
-- 資料庫只存 SHA-256 雜湊，避免資料庫內容本身成為可直接登入的憑證。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 完整退版（無損）：
--     drop index if exists oauth_login_codes_expires;
--     drop table if exists oauth_login_codes;
-- 既有的表一列都沒被動過，users 只是被外鍵參照，退版不影響它。
--
-- ⚠️ 退版**必須連同 routes/line.ts 一起退回舊的 callback**。
--    只退資料庫的話，callback 會在 insert 交換碼時撞 42P01（表不存在），
--    LINE 登入整條掛掉 —— 而且是在使用者已經跑完 LINE 授權之後才掛，
--    他會停在一個沒有退路的畫面。程式先退、資料庫再退。
--
-- 退版窗口沒有期限：這張表裡的列全部是五分鐘內過期的短命憑證，
-- 丟掉最多讓當下正在登入的人重按一次。沒有任何長期資料存在這裡。

create table if not exists oauth_login_codes (
  code_hash  text primary key,
  user_id    text not null references users(id),
  expires_at timestamptz not null
);

create index if not exists oauth_login_codes_expires on oauth_login_codes(expires_at);