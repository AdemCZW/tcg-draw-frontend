-- 賣家的聯絡方式，以及「包裹被退回來了」這件事。
--
-- ── 為什麼要這兩欄 ──────────────────────────────────────────────────
-- 買家沒去超商取貨，包裹退回賣家手上。現行規則對這種情況的處理是：
-- 出貨後 14 天視同送達、再 7 天自動放款，於是**賣家同時拿到卡跟錢**，
-- 而買家什麼都沒有（shared/escrow.ts 的 applyDeadlines）。
--
-- 那個「視同送達」的方向本身是對的，它防的是「買家收到了卻裝死」。
-- 但它分不出另一種沉默：買家根本沒去領。兩種在系統眼裡都是「買家沒動作」。
--
-- 產品上的決定（使用者定的）是：**交付與否交給買賣雙方自己談**，
-- 平台不介入、不改結案規則、點數照常釋放。但要讓那個決定真的可行，
-- 缺兩個東西，這支補上：
--
--   1. 買家聯絡得到賣家。現在是單向的 —— 賣家看得到買家的姓名電話地址
--      （出貨必要），買家只看得到賣家的名字與統計，沒有任何聯絡管道，
--      站上也沒有私訊。「自己去談」在買家那一側根本開不了口。
--   2. 平台知道這件事發生過。現在只有賣家知道包裹退回來了，
--      訂單上顯示「已完成」，買家連該找誰、為什麼要找都不知道。
--
-- ── 完整退版（無損）────────────────────────────────────────────────
--     alter table sellers drop column if exists contact_kind;
--     alter table sellers drop column if exists contact_value;
--     alter table orders  drop column if exists returned_at;
-- 既有的列一筆都沒被改動 —— 這支只新增欄位，沒有 update。

-- ---------- 賣家聯絡方式 ----------
-- 分成 kind + value 兩欄而不是一個自由字串：前端要據 kind 決定怎麼呈現
-- （電話可以撥、LINE ID 只能複製），塞在同一欄的話那個判斷會變成猜字串。
-- 'other' 保留給之後可能加的管道，不要為了新增一種就改 check。
alter table sellers add column if not exists contact_kind text
  check (contact_kind is null or contact_kind in ('phone', 'line', 'other'));
-- 長度上限 64：LINE ID 上限 20，手機 10，留餘裕給 'other'。
-- 不設 not null —— 既有賣家還沒填，強制的話這支 migration 會擋住部署。
-- 「沒填就不能上架」是應用層的閘（routes/public.ts），不是欄位約束：
-- 欄位約束擋不住「先填再刪」，而且會讓既有賣家連登入都出錯。
alter table sellers add column if not exists contact_value text;

-- ---------- 訂單：包裹退回來了 ----------
-- 刻意**不加新的 order status**。狀態機是結案規則的來源，動它就等於
-- 改結案規則，而產品決定是「結案規則不變、點數照常釋放」。
-- 這一欄只是一個事實標記：時間戳有值 = 賣家回報過退件。
-- 它不參與 applyDeadlines 的任何判斷。
alter table orders add column if not exists returned_at bigint;

comment on column sellers.contact_kind is
  '賣家聯絡方式的種類（phone/line/other）。上架前必填，見 routes/public.ts 的 NEED_CONTACT。';
comment on column sellers.contact_value is
  '聯絡方式本身。**會揭露給有訂單關係的買家**，所以它是賣家自願提供的對外資訊，不是個資欄位。';
comment on column orders.returned_at is
  '賣家回報「包裹被退回」的時間。不改變訂單狀態、不影響結案時限 —— '
  '它的作用是讓買家知道發生了什麼事、並在訂單上留下「還沒交付」的紀錄。';
