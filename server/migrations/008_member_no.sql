-- 008：會員編號
--
-- 為什麼要做：原本對外的識別碼是 users.handle，產生方式是
-- 'VD-' + randomBytes(2)，只有 4 個十六進位字元＝65,536 種，而且是 unique 欄位。
-- 生日悖論下大約 300 個會員就有五成機率撞號，而兩條註冊路徑都沒有重試：
--   * LINE 註冊：撞到就在交易裡拋錯 → 500，那個人永遠註冊不了
--   * Email 註冊：catch 把所有唯一鍵衝突都當成 email 重複，會回
--     「這個 Email 已經註冊過」—— 對方的 email 根本沒被註冊過，而且無解
--
-- 這裡改成從序列產生，結構上不可能撞號，也不需要重試邏輯。

create sequence if not exists member_seq start 1;

alter table users add column if not exists member_no text;
create unique index if not exists users_member_no on users(member_no) where member_no is not null;

/*
 * 序號 → 會員編號。
 *
 * 三個設計決定：
 *
 * 1. 不直接用流水號。「VD-7」會讓人知道你只有七個會員，而競爭對手只要
 *    每週註冊兩次就能量出你的成長速度。這裡先過一層可逆的乘法擾亂
 *    （模 2^25 下乘上一個奇數是雙射），輸出看起來隨機但仍然一對一，
 *    所以不會撞號、也不必重試。
 *
 * 2. 用 Crockford Base32 的字母表，拿掉 I / L / O / U ——
 *    會員編號會被念出來、被客服打進後台、被手寫在包裹上，
 *    0 跟 O、1 跟 I 分不清楚的代價是查不到人。
 *
 * 3. 最後一碼是檢查碼，用位置加權和（不是單純加總 —— 單純加總抓不到
 *    前後顛倒，而顛倒正是人工輸入最常見的錯法）。客服打錯時當場就知道，
 *    而不是查不到之後去懷疑資料庫。
 */
create or replace function member_no_of(n bigint) returns text as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  m        constant bigint := 33554432;      -- 32^5，五碼的容量（約 3,350 萬）
  k        constant bigint := 1916191;       -- 與 2^25 互質（奇數）→ 乘法是雙射
  c        constant bigint := 7654321;       -- 偏移，讓第一號不是 k 本身
  v        bigint;
  out      text := '';
  d        int;
  chk      int := 0;
  i        int;
begin
  v := ((n % m) * k + c) % m;
  -- 由高位往低位取五碼
  for i in reverse 4..0 loop
    d := ((v >> (i * 5)) & 31)::int;
    out := out || substr(alphabet, d + 1, 1);
    -- 位置加權：權重不同，前後兩碼對調就會算出不一樣的檢查碼
    chk := chk + d * (5 - i);
  end loop;
  return 'VD-' || out || substr(alphabet, (chk % 32) + 1, 1);
end;
$$ language plpgsql immutable;

/* 既有會員補號。依 created_at 排序只是為了讓補號結果可重現，
   編號本身不帶順序意義（見上面的擾亂說明）。 */
update users u set member_no = member_no_of(nextval('member_seq'))
from (select id from users where member_no is null order by created_at, id) s
where u.id = s.id;
