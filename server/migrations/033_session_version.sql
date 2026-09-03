/*
 * A-1 第一階段：JWT 撤銷（session_version）。
 *
 * 為什麼要這一欄：JWT 是自我驗證的，簽出去之後伺服器沒有任何辦法收回。
 * 原本 token 固定 30 天有效，驗證只看簽名與到期 —— token 一旦外流，
 * 使用者就算改了密碼，對方在 30 天內還是進得來。
 *
 * 作法：每張 token 帶上簽發當下的 session_version，requireAuth 驗完簽名後
 * 再跟 DB 這一欄比對。要踢掉所有已簽發的 token，只要把這一欄 +1。
 * 這比 blacklist 便宜：blacklist 要保存所有還沒過期的 token（30 天），
 * 而這裡每個使用者只要一個整數。
 *
 * default 0 是刻意的：遷移前簽出去的 token 沒有版本欄位，驗證時一律視為第 0 版，
 * 因此**不會把現有使用者全部踢掉**。遷移不是資安事件，不該順手造成全站重登；
 * 真的懷疑外流時，一句 `update users set session_version = session_version + 1`
 * 就能立刻讓全站的 token 失效 —— 撤銷能力有了，才是這一段的重點。
 */
alter table users add column if not exists session_version integer not null default 0;
