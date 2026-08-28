# 客服工單：API 合約

**這份是給平行施工用的契約。** 後端照這份實作，兩支前端照這份接。
任何一方要改形狀，改這份文件並講一聲，不要各自猜。

資料表見 `server/migrations/024_tickets.sql`（已建立）。

最後更新：2026-08-27

---

## 一、最重要的一條設計原則

**工單是前門，不是新的金流。**

訂單爭議會實際移動點數、賣家審核會改開池權限。那兩條的邏輯已經寫好、
測過、在跑（`/v1/admin/disputes/:id/resolve`、`/v1/admin/verifications/:id/review`）。

工單**不重寫它們**。工單提供的是「對話 + 統一佇列」；裁決時仍然呼叫既有的那套。

具體來說：
- `tickets` 表沒有任何金額欄位
- 解決一張 `order-dispute` 單 → 內部呼叫既有的爭議裁決邏輯
- 解決一張 `seller-doc` 單 → 內部呼叫既有的審核邏輯
- 工單自己的 `status` 只記「處理完了沒有」，不是權威狀態

**驗收標準：把 tickets 兩張表 drop 掉，錢跟權限都還是對的。**

---

## 二、型別

```ts
type TicketKind =
  | 'takeover'       // 站外轉手接管：想把已登記的鑑定編號轉到自己名下
  | 'order-dispute'  // 訂單爭議（自動開單）
  | 'seller-doc'     // 賣家審核（自動開單）
  | 'card-issue'     // 卡片有問題
  | 'account'        // 帳號問題
  | 'other'

type TicketStatus =
  | 'open'          // 等客服處理
  | 'pending-user'  // 客服問了問題，等使用者回覆
  | 'resolved'      // 結案，申請通過／問題解決
  | 'rejected'      // 結案，申請駁回

interface TicketSummary {
  id: string
  kind: TicketKind
  status: TicketStatus
  subject: string
  createdAt: number
  updatedAt: number
  /** 最後一則訊息的前 80 字，佇列上直接看得到進度 */
  lastMessage: string | null
  /** 有沒有對方還沒看過的新訊息（各自視角不同） */
  unread: boolean
  messageCount: number
}

interface TicketDetail extends TicketSummary {
  userId: string
  userName: string
  /** 依 kind 而定，其餘為 null */
  orderId: string | null
  prizeId: string | null
  sellerId: string | null
  grader: string | null
  certNo: string | null
  assigneeId: string | null
  assigneeName: string | null
  closedAt: number | null
  resolution: string | null
  messages: TicketMessage[]
  /** 接管單專用：那個編號目前登記在誰名下（客服視角才有值） */
  certHolder?: { userId: string; userName: string; memberNo: string } | null
}

interface TicketMessage {
  id: number
  authorId: string
  authorName: string
  isStaff: boolean
  body: string
  /** 檔案 id，前端用 GET /v1/files/:id 取。私有用途，只有當事人與管理員讀得到 */
  fileIds: string[]
  createdAt: number
}
```

---

## 三、使用者端

掛在 `/v1/tickets`，全部 `requireAuth`。

### `POST /v1/tickets` — 開單

```jsonc
{
  "kind": "takeover",          // 不接受 'order-dispute' / 'seller-doc'（那兩種只能由系統自動開）
  "subject": "接管 PSA #12345678",
  "body": "我在蝦皮買到這張卡，賣家是……",
  "fileIds": ["f-0123456789ab"],  // 選填，最多 5 個，格式 /^f-[0-9a-f]{12}$/
  // kind 相關的欄位，只有對應的 kind 會讀
  "certNo": "12345678",        // takeover 必填
  "grader": "PSA",             // takeover 必填
  "prizeId": "pz-xxx"          // card-issue 選填
}
```

回 `201 { ticket: TicketDetail }`。

驗證要點：
- `subject` 1–60 字，`body` 1–2000 字
- `fileIds` 每一個都要**驗持有人與用途**（`purpose = 'ticket-doc'`），比照 `orders.ts` 出貨照那段。格式對但不是你的檔案 → 400
- **`kind: 'takeover'` 的額外檢查**：那個編號必須真的已經登記給**別人**了。沒登記過（他其實可以直接上傳）或本來就登記在他自己名下 → 400 並講清楚
- 同一個人對同一個 `(grader, cert_no)` 同時只能有一張未結案的接管單 → 409
- 開單要通知客服端（`notify` kind `'system'`，收件人是 admin；沒有 admin 群發機制的話這條先略過並在註解說明）

### `GET /v1/tickets?status=&limit=&cursor=` — 我的單

回 `{ items: TicketSummary[], nextCursor: string | null }`。游標分頁比照 `pagination.ts` 既有做法。

### `GET /v1/tickets/:id` — 單一張（含訊息串）

回 `{ ticket: TicketDetail }`。**只有開單人自己讀得到**（管理員走 admin 那條）。
`certHolder` 在這條**一律不回** —— 那是別人的身分，不該讓申請人看到。

### `POST /v1/tickets/:id/messages` — 回覆

```jsonc
{ "body": "補充照片如下", "fileIds": ["f-..."] }
```

回 `{ message: TicketMessage }`。

- 已結案（`resolved` / `rejected`）的單**不能再回覆** → 409，訊息要建議他開新單
- 使用者回覆會把 `pending-user` 推回 `open`（球回到客服手上）
- 更新 `tickets.updated_at`

---

## 四、客服端

掛在 `/v1/admin/tickets`，走既有的 `requireAdmin`。

### `GET /v1/admin/tickets?status=&kind=&limit=&cursor=`

預設回待處理的（`open` + `pending-user`），舊的排前面。
回 `{ items: TicketSummary[], nextCursor }`，`TicketSummary` 額外帶 `userName`、`userMemberNo`。

### `GET /v1/admin/tickets/:id`

回 `{ ticket: TicketDetail }`，**含 `certHolder`**（接管單要看得到目前登記人是誰）。

### `POST /v1/admin/tickets/:id/claim`

認領。設 `assignee_id = me`。已被別人認領 → 409。

### `POST /v1/admin/tickets/:id/messages`

同使用者端，但 `is_staff = true`，而且會把狀態推成 `pending-user`。
要通知開單人。

### `POST /v1/admin/tickets/:id/resolve`

```jsonc
{ "outcome": "resolved" | "rejected", "resolution": "……" }  // resolution 必填，1–500 字
```

**這裡是整個設計的關鍵。依 `kind` 決定要順帶做什麼：**

| kind | `outcome: resolved` 時要做的事 |
|---|---|
| `takeover` | 把 `prizes` 那一列的 `user_id` 與 `custodian_id` 一起改成申請人。**兩個都要改** —— 站外轉手是唯一「擁有權與實體同時易主」的路徑（見 inventory-first-plan 第四節）。狀態設成 `in_book` |
| `order-dispute` | 呼叫**既有的**爭議裁決邏輯（`orders.ts` 的 `act()` + `resolve-buyer`／`resolve-seller`）。`resolve` body 要多收一個 `disputeTo: 'buyer' \| 'seller'` |
| `seller-doc` | 呼叫**既有的**審核邏輯（`seller_verifications` 那段） |
| 其餘 | 只結案，不做別的 |

`outcome: rejected` 一律只結案，不做任何動作。

全部要寫 `admin_actions` 稽核（比照既有的 `audit()`）。

---

## 五、自動開單（把現有兩條併進來）

**不改既有端點的行為，只在它們成功之後補開一張單。**

| 觸發點 | 開什麼單 |
|---|---|
| `POST /v1/orders/:id/dispute` 成功後 | `kind: 'order-dispute'`，`order_id` 帶上，`subject` = 「訂單爭議：<卡名>」，第一則訊息 = 買家填的 reason + 他附的影片 |
| 賣家送審文件成功後 | `kind: 'seller-doc'`，`seller_id` 帶上，第一則訊息附 `doc_file_id` |

開單失敗**不能讓主流程失敗** —— 用 `notifyMany` 那種「失敗只記 log」的寫法。
爭議本身已經成立了，工單開不出來是我們的問題，不該讓使用者的申訴消失。

既有的 `/v1/admin/disputes`、`/v1/admin/verifications` **兩條端點保留不動**
（它們是驗過的，而且工單那層萬一有問題還有退路）。

---

## 六、檔案上傳

`server/src/routes/files.ts` 的 `PURPOSES` 要加一個：

```ts
'ticket-doc': { mimes: ['image/jpeg','image/png','image/webp','application/pdf'], maxBytes: 15 * MB, public: false }
```

`public: false` → 只有檔案擁有者或管理員讀得到（既有的 `files.get('/:id')` 已經這樣做）。

> 已知限制：爭議雙方互相看不到對方的附件，只有管理員看得到。這是既有行為
> （`files.ts` 那段註解有寫），不在這次範圍。

---

## 七、前端

### 使用者端

新路由 `/support`（我的問題）與 `/support/:id`。

- 列表：狀態徽章、主旨、最後一則訊息、時間
- 詳情：訊息串（客服／我的左右分邊）、回覆框、附件上傳
- 開新單：選類型 → 填主旨與說明 → 附檔
- **接管的入口要接在被擋的地方**：建池時撞到 `CERT_ALREADY_LISTED`（409）
  的錯誤訊息旁邊給一個「申請接管」按鈕，帶著那個編號跳到開單頁

附件上傳**沿用 `src/lib/uploads.ts`**（出貨照那支寫的通用 composable），
`purpose` 傳 `'ticket-doc'`。**不要重寫一套。**

### 客服端

新路由 `/admin/tickets` 與 `/admin/tickets/:id`，掛進既有的 `ConsoleShell`
子路由（比照 `console-shipments` 那幾條的寫法）。

- 佇列：類型、狀態、開單人、等多久了、認領人
- 詳情：訊息串、回覆、結案（要填理由）、接管單額外顯示「目前登記人」

---

## 八、共同限制

- 手機 UI **不可以有 emoji**
- grid/flex 子元素 `min-width: 0`，格線 `minmax(0, 1fr)`
- 顏色走 `src/styles/tokens.css`
- 新 class 避開 `base.css` 那串 `pointer-events: none` 的名字
- 觸控目標 44px
- 繁體中文註解，解釋**為什麼**
- 錯誤訊息不透上游細節（security-audit L-4）
- 金額欄位有上界（`server/src/limits.ts`）
