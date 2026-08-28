-- 024：客服工單。一個佇列處理所有需要人介入的事
--
-- ── 為什麼需要 ──────────────────────────────────────────────────────
-- 平台現在有三種「要人介入」的事，各自長在不同地方：
--   訂單爭議  orders.status = 'disputed' + /v1/admin/disputes
--   賣家審核  seller_verifications + /v1/admin/verifications
--   其他      **沒有地方可以講**
--
-- 第三類正在變成問題。023 之後「一個鑑定編號全站只能登記一次」是資料庫
-- 層的硬約束，被擋下來的人會看到「如果這張卡是你的而且已經不在別處，
-- 請聯絡客服」—— 而客服沒有任何工具可以處理。站外轉手（在蝦皮買到一張
-- 已經登記過的卡）是完全合法的情況，防線越嚴，被誤擋的人越需要一條出路。
--
-- ── 設計上最重要的一條：工單是前門，不是新的金流 ─────────────────────
-- 訂單爭議會**實際移動點數**（判給買家或賣家），賣家審核會**改開池權限**。
-- 那兩條的邏輯已經寫好、測過、在跑。工單**不重寫它們** ——
-- 它提供的是「對話 + 一個統一的佇列」，裁決動作仍然呼叫既有的那套。
--
-- 所以這張表刻意**不存任何金額、不存任何裁決結果的權威狀態**。
-- 誰拿到錢的事實在 orders 與 points_ledger，賣家能不能開池的事實在
-- sellers.tier。工單只記「這件事處理完了沒有、當時的理由是什麼」。
-- 這樣就算工單這一層整個拆掉，錢跟權限都還是對的。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 完整退版（無損）：
--     drop table if exists ticket_messages;
--     drop table if exists tickets;
-- 既有的表一列都沒被動過 —— 這支只新增，沒有任何 alter 或 update。

create table if not exists tickets (
  id          text primary key,
  /* 誰開的。客服自己代開時也記真正的當事人，不是客服自己 ——
     這一欄決定誰看得到這張單。 */
  user_id     text not null references users(id),

  /* 類型決定「解決」的意思是什麼，以及下面哪一個關聯欄位有值。
     takeover     站外轉手接管：想把一個已登記的鑑定編號轉到自己名下
     order-dispute 訂單爭議：由 /v1/orders/:id/dispute 自動開單
     seller-doc    賣家審核：由送件自動開單
     card-issue    卡片有問題（受損、與描述不符、收到的不是那張）
     account       帳號問題
     other         其他 */
  kind        text not null
              check (kind in ('takeover','order-dispute','seller-doc','card-issue','account','other')),

  status      text not null default 'open'
              check (status in ('open','pending-user','resolved','rejected')),

  subject     text not null,

  /* 關聯。哪一個有值取決於 kind，全部允許 null ——
     用一張表配可空的外鍵，而不是每種類型一張表：客服要的是「一個佇列」，
     那正是這次的需求。代價是這幾欄大多數時候是 null，可以接受。 */
  order_id    text references orders(id),
  prize_id    text references prizes(id),
  seller_id   text references users(id),

  /* 接管專用：申請人想接管哪一個編號。
     刻意存**正規化過的值**（upper(btrim) / nullif），跟 prizes.grader /
     cert_no 同一套規則 —— 不然客服查「這個編號有沒有人申請過」會漏掉
     大小寫或空白不同的那幾筆。 */
  grader      text,
  cert_no     text,

  /* 目前由誰負責。null = 還沒有人認領。
     不做指派流程，只是讓兩個客服不會同時處理同一張單。 */
  assignee_id text references users(id),

  created_at  bigint not null,
  updated_at  bigint not null,
  closed_at   bigint,
  closed_by   text references users(id),
  /* 結案理由。**一定要填**（應用層強制）—— 沒有理由的裁決事後無法覆核，
     而這張表裡的每一筆都是有人被拒絕或被通過的紀錄。 */
  resolution  text
);

create index if not exists tickets_user on tickets(user_id, created_at desc);
-- 客服的主佇列：待處理的排前面，舊的排前面（先進先出，不讓人被無限期跳過）
create index if not exists tickets_queue on tickets(status, created_at)
  where status in ('open','pending-user');
-- 「這個編號有沒有人申請過接管」
create index if not exists tickets_cert on tickets(grader, cert_no)
  where cert_no is not null;
create index if not exists tickets_order on tickets(order_id) where order_id is not null;

-- 一張訂單同時只能有一張未結案的爭議單；賣家同時只能有一件待審。
-- 應用層的檢查擋不住併發（001_init.sql:44 那條教訓）。
create unique index if not exists tickets_order_live
  on tickets(order_id) where order_id is not null and status in ('open','pending-user');

create table if not exists ticket_messages (
  id          bigserial primary key,
  ticket_id   text not null references tickets(id) on delete cascade,
  author_id   text not null references users(id),
  body        text not null,
  /* 附件走既有的 files 表（/v1/files/presign 的 ticket-doc 用途）。
     **不收外部網址** —— 理由跟出貨憑證那條一樣（security-audit L-3）：
     外部連結的內容隨時可以換掉，爭議裁決時看到的未必是提交當下的東西。 */
  file_ids    text[] not null default '{}',
  /* 這則是不是客服講的。存下來而不是每次 join users 查 role：
     客服的權限可能事後被收回，但「當時這句話是客服說的」是歷史事實。 */
  is_staff    boolean not null default false,
  created_at  bigint not null
);

create index if not exists ticket_messages_ticket on ticket_messages(ticket_id, id);

comment on table tickets is
  '客服工單。**這張表沒有任何金額，也不是任何裁決結果的權威來源** —— '
  '誰拿到錢在 orders 與 points_ledger，賣家能不能開池在 sellers.tier。'
  '工單提供的是對話與統一佇列，裁決動作仍然呼叫既有的那套邏輯。'
  '整層拆掉的話錢跟權限都還是對的。';
