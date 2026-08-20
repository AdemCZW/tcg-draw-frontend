# shared —— 前後端共用的交易規則

這個資料夾的檔案**後端會直接吃**。所以裡面不能有：

- Vue、Pinia，或任何前端框架
- `@/` 路徑別名（資料夾內一律用相對路徑）
- `window` / `localStorage` / `document`

| 檔案 | 內容 |
|---|---|
| `domain.ts` | 交易領域型別：`CardItem` / `Listing` / `Order` / `OrderStatus` |
| `escrow.ts` | 狀態機規則：時限常數、`applyDeadlines()`、`actionsFor()`、保證金級距 |
| `contract.ts` | API 端點、請求／回應型別、錯誤碼 |

## 為什麼要共用

規則寫兩遍就會有兩份真相。把驗收期從 7 天改成 5 天卻只改了一邊時，
**沒有任何東西會報錯** —— 前端顯示「剩 5 天」，後端第 7 天才放款。
這種錯不會噴例外，只會讓錢在錯的時間離開錯的人。

伺服器仍然是唯一權威，前端那份只負責顯示。共用程式碼消滅的是「規則漂移」，
不是「前端可以自己決定」。

## 後端怎麼用

Railway + TypeScript。把這個資料夾用 npm workspace 或 git submodule 接進後端，
或者最簡單：後端 repo 放同一個 monorepo 底下。

```ts
import { applyDeadlines, actionsFor, depositFor, looksLikeTracking } from '../shared/escrow'
import type { Order } from '../shared/domain'
```

### 伺服器必須自己做的三件事

1. **時限補算。** 讀取訂單時先跑 `applyDeadlines(order, Date.now())`，
   有變化就寫回並結算點數。另外掛一個 cron 定期掃，避免沒人讀的訂單永遠不結案。

2. **真正的單號查驗。** `looksLikeTracking()` 只擋格式，擋不掉「填別人的舊單號」。
   伺服器要打物流商 API 確認單號存在、交寄時間晚於訂單成立，且沒被其他訂單用過。

3. **交易邊界。** 「檢查掛單還在 → 凍結點數 → 改掛單狀態 → 建立訂單」
   必須在同一個 Postgres transaction 裡，而且掛單那筆要 `SELECT ... FOR UPDATE`。
   否則兩個人同時買同一張卡時，兩邊都會成立。

### 點數不要存 balance 欄位

只存帳本（`points_ledger`），餘額用 `SUM(delta)` 推算，`locked` 用進行中訂單的
貨款總和推算。存一個 balance 欄位就會有「餘額跟帳本對不起來」的一天 ——
前端這邊已經踩過一次：訂單顯示已鎖點、託管中卻是 0。

## 端點與狀態轉換的對應

| 端點 | 轉換 | 誰能呼叫 |
|---|---|---|
| `POST /orders` | → `escrowed` | 買家 |
| `POST /orders/:id/ship` | `escrowed` → `shipped` | 賣家 |
| `POST /orders/:id/confirm` | `delivered` → `completed` | 買家 |
| `POST /orders/:id/dispute` | `delivered` → `disputed` | 買家（須附影片） |
| `POST /admin/disputes/:id/resolve` | `disputed` → `completed`/`refunded` | 管理員（要填理由、寫稽核） |
| 無 | `escrowed` → `cancelled`（逾 72h） | 伺服器 |
| 無 | `shipped` → `refunded`（逾 14 天） | 伺服器 |
| 無 | `delivered` → `completed`（逾 7 天） | 伺服器 |

`shipped → delivered` 由物流回報觸發，不是使用者按的。

完整規格見網站的 `/trade-protection`。
