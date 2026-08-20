-- 會員基本資料。
--
-- 只收「平台真的會用到」的欄位，不做那種一長串卻沒人看的問卷：
--   display_name  站上顯示的名稱（LINE 帶回來的暱稱可以改）
--   real_name     出貨用的收件人。跟 display_name 分開——
--                 使用者不會想讓別人在市場上看到本名
--   phone         物流聯絡用
--   address_*     預設收件地址。出貨申請時帶入，不用每次重打
--   birthday      未滿 18 需監護人同意（見頁尾條款），這是那條的依據
--
-- 全部允許空值：註冊當下不該逼人填完，要出貨時再要求補齊即可。
alter table users add column if not exists display_name  text;
alter table users add column if not exists real_name      text;
alter table users add column if not exists phone          text;
alter table users add column if not exists address_zip    text;
alter table users add column if not exists address_city   text;
alter table users add column if not exists address_line1  text;
alter table users add column if not exists birthday       date;
alter table users add column if not exists profile_updated_at timestamptz;
