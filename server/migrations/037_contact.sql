-- 037：公開客服信箱（不需要登入的聯絡表單）
--
-- ── 為什麼需要 ──────────────────────────────────────────────────────
-- 024 的工單系統很完整，但 routes/tickets.ts 第一行就是
-- `tickets.use('*', requireAuth)` —— 它服務的是「已經進得來的人」。
--
-- 而最需要聯絡平台的人，往往正是進不來的那些：
--   · 忘記密碼的人。平台刻意不做忘記密碼流程（產品決定），所以那個人
--     在系統裡**沒有任何一條路**可以講話 —— 進不去所以開不了工單，
--     開不了工單所以沒有人能幫他把密碼救回來。這是一個封閉迴圈。
--   · 還沒註冊、想先問清楚再決定要不要用的人。
--   · 檢舉的人、宣稱某張卡是他的人、消保單位、律師。
--
-- 而且「客服聯絡方式」是法規要求要對外揭露的東西（零售業等網路交易
-- 定型化契約應記載事項），條款頁的那一欄目前還是 ⟨待填⟩。這張表是
-- 那件事的一半答案：在信箱補齊之前，至少有一條真的送得到的路。
--
-- ── 為什麼是新的一張表，不是併進 tickets ────────────────────────────
-- 併進去的好處很明顯：客服只看一個佇列（024 的後台已經做好了）。
-- 但 024 的每一列都以 `user_id text not null references users(id)` 為軸心：
--   · 那一欄決定「誰看得到這張單」（routes/tickets.ts 用它過濾）
--   · loadTicket / 後台佇列都是 `join users u on u.id = t.user_id`，**內連接**
-- 沒有登入的人身上沒有這個值。要併進去只有兩條路，兩條都比開新表貴：
--   (a) 把 user_id 改成可空 —— 那要動一張正在跑的表，而且上面那幾個
--       內連接會**靜默地**把匿名列整批濾掉：後台看不到，也不會報錯。
--       「客服看不到那一筆」正是這個功能唯一不能出的錯。
--   (b) 造一個共用的假使用者當人頭 —— 等於在 users 裡放一列不是人的資料，
--       而 tickets.user_id 的語意（「這張單屬於誰」）從此有一個例外。
-- 所以這裡開新表。代價老實寫在這裡：**客服要看兩個地方**。
-- 後台側欄因此多一項「聯絡訊息」，並且跟工單一樣掛未處理數字 ——
-- 讓「還有一個地方要看」這件事在畫面上是看得見的，而不是靠記得。
--
-- ── 這張表刻意不做的事 ──────────────────────────────────────────────
-- · **不收附件。** 附件要走 files/R2，而那條路的每一支都要登入（持有人
--   驗證是靠 user_id 做的）。給匿名的人一條上傳路徑，等於開一個免費、
--   不記名的檔案空間；而且個資保存期限那條（見隱私權政策第四節）目前
--   對上傳檔案還是 ⟨待填⟩，不該再多一種來源。要附圖的人可以先寄信，
--   或註冊後走工單。
-- · **不做對話串。** 沒有登入就沒有「回到這一頁看回覆」的身分，做了也沒人讀得到。
--   回覆實際發生在 email（見下面 email 欄的說明）。
-- · **不存原始 IP。** 只存加鹽雜湊，理由見 ip_hash 欄。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 完整退版（無損）：drop table if exists contact_messages;
-- 既有的表一列都沒被動過 —— 這支只新增，沒有任何 alter 或 update。

create table if not exists contact_messages (
  id          text primary key,

  /* 主題。決定客服怎麼分流，也決定表單上顯示哪一段說明。
     login 排第一個不是隨便排的：它是這張表存在的主要理由。 */
  topic       text not null
              check (topic in ('login','account','order','report','privacy','other')),

  /* 怎麼稱呼你。不叫 real_name —— 我們不需要、也不該要求匿名者的本名，
     這一欄只是為了讓客服回信時有個稱呼。 */
  name        text not null,

  /* **唯一的回覆管道。**
     這個平台沒有任何寄信服務（env.ts 裡沒有 SMTP／SendGrid／SES 之類的
     設定，程式碼裡也沒有任何寄信的路徑），所以「回覆」不會由系統發生，
     而是客服自己用平台的信箱回這個地址。表單上必須把這件事講出來，
     不能讓人以為站上會跳通知等他回來看 —— 他多半連帳號都沒有。 */
  email       text not null,

  body        text not null,

  /* 已登入的人送出時記下他的帳號。**允許 null，而且 null 是常態。**
     有值的時候客服就有脈絡（可以直接開他的會員檔案），不必再問一次
     「請問你的會員編號是」。這裡用外鍵而不是存一份名字快照：
     這張表不是交易紀錄，沒有「當時叫什麼名字」要保存的需求。 */
  user_id     text references users(id),

  /* 限流與濫用調查用。**存雜湊不存原始 IP**：
     這張表是全站唯一會收到「沒有帳號的人」的個資的地方，而原始 IP 本身
     就是個資。雜湊帶站台密鑰當胡椒（見 routes/contact.ts 的 hashIp），
     所以它只能拿來比對「是不是同一個來源」，沒辦法反查回位址。
     可空：取不到來源時（clientIp 回 'unknown'）照樣要收得下這一筆 ——
     擋住一個真的需要幫忙的人，比多收一筆垃圾嚴重。 */
  ip_hash     text,

  /* 內容指紋（主題＋email＋內文的雜湊）。**只給「連按兩下送出」去重用**，
     不是身分識別：手機上送出後網路一卡，第一個反應就是再按一次，
     而客服佇列上兩則一模一樣的訊息只會浪費一次人工。
     工單那條走 idempotency-key，這裡不能 —— 那需要呼叫端會存 key，
     而這張表單的使用者可能連 localStorage 都沒有（無痕、剛裝的瀏覽器）。
     跟 ip_hash 一樣可空：取不到來源時就不去重（寧可多一列，不要少一列）。 */
  fingerprint text,

  /* new = 還沒有人處理。這張表沒有狀態機，只有「處理完了沒有」——
     沒有登入的對象沒辦法回話，所以沒有 pending-user 這種中間狀態。 */
  status      text not null default 'new' check (status in ('new','handled')),
  handled_at  bigint,
  handled_by  text references users(id),
  /* 處理了什麼。跟工單的 resolution 同一條紀律：沒有理由的處理事後無法覆核。 */
  handled_note text,

  created_at  bigint not null
);

-- 客服的主佇列：未處理的、舊的排前面（先進先出，跟 024 的 tickets_queue 同一個理由：
-- 照新的排前面的話，一則沒有人想碰的訊息會被每一則新訊息擠下去）
create index if not exists contact_queue on contact_messages(status, created_at)
  where status = 'new';
-- 全部列表（含已處理）的排序
create index if not exists contact_recent on contact_messages(created_at desc);
-- 限流：同一個來源 24 小時內送了幾則（routes/contact.ts 的日配額）
create index if not exists contact_ip on contact_messages(ip_hash, created_at desc)
  where ip_hash is not null;
-- 連按兩下的去重查詢（同來源、同內容、五分鐘內）
create index if not exists contact_dup on contact_messages(ip_hash, fingerprint, created_at desc)
  where ip_hash is not null and fingerprint is not null;
-- 已登入者送的訊息：客服從會員檔案往回查時用得到
create index if not exists contact_user on contact_messages(user_id, created_at desc)
  where user_id is not null;

comment on table contact_messages is
  '公開的客服聯絡訊息（不需要登入）。**跟 tickets 是兩張表**：024 的每一列都以'
  'user_id not null 為軸心，而這張表的對象多半沒有帳號（忘記密碼的人正是最需要'
  '這條路的人）。這張表不存金額、不改任何權限，整張 drop 掉不影響任何既有功能。'
  '回覆不由系統發生 —— 平台沒有寄信服務，客服自己用 email 回。';
