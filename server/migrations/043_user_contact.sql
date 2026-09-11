-- 對外聯絡方式從 sellers 搬到 users。
--
-- ── 為什麼 ──────────────────────────────────────────────────────────
-- 041 把「上架前必須留聯絡方式」的欄位放在 sellers。但會上架的不只賣家：
-- 一般玩家把抽到的卡轉賣到市場，他從來沒申請過賣家，sellers 裡沒有他那一列。
-- 結果 NEED_CONTACT 永遠擋住他，而他也沒有任何地方可以填 ——
-- 賣家設定頁要先有賣家身分。等於一般玩家完全不能轉賣。
--
-- 產品決定（使用者選的）：一般玩家在上架頁直接填，不必先申請賣家。
-- 所以這一欄屬於「會上架的人」，也就是 users。
--
-- ── 跟 users.phone 的關係 ──────────────────────────────────────────
-- 同一張表，但意義相反：phone 是寄件用的個資，從不對外；
-- contact_value 是本人主動填、知道會被有訂單關係的買家看到的對外資訊。
-- 刻意不共用欄位，理由同 041。
--
-- sellers.contact_kind / contact_value 先留著不刪：舊版伺服器在滾動部署
-- 期間還會讀它。賣家那支 PUT 會兩邊一起寫，確認沒有讀取端之後再寫一支刪掉。
--
-- ── 完整退版 ────────────────────────────────────────────────────────
--     alter table users drop column if exists contact_kind;
--     alter table users drop column if exists contact_value;

alter table users add column if not exists contact_kind text
  check (contact_kind is null or contact_kind in ('phone', 'line', 'other'));
alter table users add column if not exists contact_value text;

-- 已經在賣家設定填過的，搬過來。不覆蓋 users 上已有的值（重跑安全）。
update users u
   set contact_kind = s.contact_kind, contact_value = s.contact_value
  from sellers s
 where s.id = u.id
   and s.contact_value is not null and btrim(s.contact_value) <> ''
   and (u.contact_value is null or btrim(u.contact_value) = '');

comment on column users.contact_kind is
  '對外聯絡方式的種類（phone/line/other）。上架前必填，見 routes/public.ts 的 NEED_CONTACT。';
comment on column users.contact_value is
  '對外聯絡方式本身。**會揭露給有訂單關係的買家**。跟 users.phone（寄件用個資、不對外）是兩回事。';
