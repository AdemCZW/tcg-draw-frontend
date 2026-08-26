# 後端整合正確性體檢（第二輪）

日期：2026-08-26
範圍：結算（migration 017/018）、賣家宣告買回價 v4、賣家出貨端點、示範池換世代 ——
**這幾個新東西彼此之間、以及跟既有路徑（市場、出貨佇列、逾期掃描）之間的縫**。
`docs/security-audit.md` 與 `docs/pool-modes-audit.md` 已報過的不重覆。

驗證環境：本機 PostgreSQL `vaultdraw_test`、`DEV_LOGIN=1`、`localhost:8080`。
每一條有「重現」的都是**真的跑過**，輸出原樣貼上；沒跑過的標「未驗證」。
腳本在 session scratchpad（`t1.mjs` ~ `t8.mjs`），跑完已把測試庫還原成乾淨的 migrate + seed。
本輪**只稽核沒有修改任何程式碼**（沒有一條符合「正在造成損失」的動手門檻 —— 平台還沒上線）。

> 稽核期間有另一支 agent 同時在改 `server/src/psa.ts` 與 `routes/pools.ts`（PSA 驗證），
> 本文所有結論以當時的 HEAD（671ee6f）為準，煙霧測試 278 項在含該改動的工作樹上仍全綠。

---

## 摘要

| 嚴重度 | 項目 |
|---|---|
| **Critical** | F-1 held 期間把卡在庫內轉賣，新主人按回收 —— **點數付給前一個主人**，新主人卡沒了、一毛拿不到，回應還跟他說「points: 72」 |
| **Critical** | F-2 同一條縫的出貨版：轉手後新主人申請出貨、賣家逾期 —— **票金退給前一個主人**（他早就把卡賣掉收過一次錢），新主人的卡變 `refunded`、什麼都沒拿到 |
| **High** | F-3 賣家走 `/v1/seller/settlements/:id/ship` 出貨後，`prizes.status` 與 `shipments` 都不動 —— 買家不確認收貨的話，鑑賞期滿錢放了，**卡永遠卡在 `ship_requested`**，上架、回收、確認全部 409，而且確認的錯誤訊息是假的（「賣家還沒出貨」） |
| **High** | F-4 逾期退款後，出貨佇列那張單還停在 `requested`；後台把它標 `shipped` 會**把已退款的卡復活成 `shipped`** —— 買家退款照拿、卡照樣上架再賣一次 |
| **Medium** | F-5 寄存確認期滿（vault-accept）釋放之後買家才申請出貨 —— 出貨單進了佇列但**沒有任何時鐘**：賣家標不了出貨（409）、逾期不記違約、不會退款。註解宣稱「出貨義務不會消失（不出貨照樣記違約）」，機制不存在 |
| **Medium** | F-6 `sweepSettlements(tx, userId)` 只掃 `buyer_id/seller_id = userId` —— 卡轉手後新主人讀自己的卡冊**永遠掃不到**那筆結算（buyer_id 還是舊主人），狀態只在舊主人或賣家上線時才補算 |
| **Low** | F-7 vault-accept 釋放後卡仍是 `stashed`、卡冊照樣顯示買回價，按回收卻回「這張卡的結算狀態已經改變」—— 對買家來說是一個看得到按不到的承諾，訊息也沒講原因（14 天期滿） |
| **Low（僅測試環境）** | F-8 `dev-login` 給一個「已存在但 id 不是 `u-<handle>`」的 handle（例如 `vaultdraw`），會發出一張**不存在的使用者**（`u-vaultdraw`）的合法 token |
| Info | F-9 `/v1/prizes/ship` 允許把**不同賣家**池裡的卡合併成一張出貨單；後台標 shipped 會一次替所有賣家的結算開鑑賞期 |

F-1 / F-2 / F-6 是同一個病根：**`pool_settlements` 綁的是抽卡當下的買家，而卡的所有權會動**。
庫內轉移（市場 vault 掛單、接受出價）只改 `prizes.user_id`，結算列的 `buyer_id` 不跟着走，
而回收、出貨申請、退款都是「拿 prize_id 找結算列」—— 動作是新主人發起的，錢卻照結算列走向舊主人。

---

## Critical

### F-1 held 期間轉賣，新主人回收 —— 錢給了舊主人

`routes/prizes.ts` 的 recycle 檢查 `prizes.user_id = me`（新主人過得了），
但 `acceptRecycle()`（`pool-settlement.ts`）付錢付給 `s.buyerId` —— 結算列上那個舊主人。
上架端（`routes/public.ts` POST /listings）只要求 `status = 'stashed'`，**不看有沒有進行中的結算**，
所以這條路完全走得通。

重現（`t1.mjs`，A=u-buyer 抽卡、上架 vault 500 點，B=u-mallory2 買走後按回收，買回價 72）：

```
回收前 A: {"points":1000300,...}   回收前 B: {"points":99500,...}
B 回收結果: {"points":72,"buyback":72,"wallet":{"points":99500,...}}   ← 回應說付了 72，錢包沒動
回收後 A: {"points":1000372,...}
A 的分錄: [{"delta":"72","reason":"pool-recycle-in","ref_id":"st-d-mt9x39b1-6710f7-1"}, ...]
```

B 花 500 買的卡被標成 `recycled`（消失）、拿到 0 點；A 賣了 500 又白拿 72。
回應物件甚至把 `points: 72` 回給 B，錢包欄位卻自打嘴巴。
接受出價（`social.ts` trade-offers accept）走同一種過戶，同樣中招（同 code path，未另測）。

**修法方向（擇一，都要想清楚）**：
- 過戶時一併把結算列的 `buyer_id` 換成新主人（回收、退款、確認收貨就自然跟人走）；或
- 有 `held/awaiting_ship/shipped` 結算的卡不准上架／不准被出價接受（把承諾跟卡綁死在原主人身上，14 天 vault-accept 後解禁）。
前者對「買回承諾是對抽卡的人還是對持卡的人」要先做產品決定。

### F-2 轉賣後申請出貨、賣家逾期 —— 退款退給舊主人

同根不同枝：B 買到卡申請出貨（`markShipRequested` 拿 prize_id 把結算翻成 `awaiting_ship`），
賣家逾期，`refund()` 把 `s.amount + s.fee` 退給 `s.buyerId` = A。

重現（`t2.mjs` + `t2b.mjs`）：

```
B 買到 pz-d-mt9x3va8-e2052f-5 → B 申請出貨 → rewind 73h → A 讀卡冊觸發 sweep
A: 1000972 -> 1001372（+400，兩筆 pool-refund 各 200）   B: 98500（不變）
B 的 refunded 卡: ["pz-d-mt9x3va8-e2052f-5","pz-d-mt9x3phm-158d59-2"]
```

B 付 500 買卡 → 卡變 `refunded`、0 補償；A 收兩次錢。賣家 `default_count` 有正確 +1。
注意 sweep 還得等 A 或賣家上線才跑（F-6）—— B 自己看不到任何進度。

---

## High

### F-3 賣家出貨端點不同步 `prizes` 與 `shipments`，買家不確認就把卡鎖死

`sellers.ts` 的 `POST /settlements/:id/ship` 只呼叫 `markShipped()`（改 `pool_settlements`）。
`prizes.status` 停在 `ship_requested`、`shipments` 那列停在 `requested`。
買家按確認收貨會把 prize 補成 `shipped`（`prizes.ts` /confirm），但**不按**的話：
鑑賞期滿 `release()` 放款、也不動 prize —— 卡就永遠是 `ship_requested`。

重現（`t4.mjs` + `t4b.mjs`）：

```
賣家出貨: {"ok":true}
7 天後結算: released inspect-timeout
卡片狀態: ship_requested  settle_status: released
上架: {"error":"WRONG_STATE","message":"這張卡目前不能上架"}
confirm: {"error":"WRONG_STATE","message":"賣家還沒出貨，不能確認收貨"}   ← 賣家明明出了
recycle: {"error":"WRONG_STATE","message":"只有保管中的卡可以回收"}
shipments 表: sh-4eba31da98 | requested   ← 後台佇列還以為沒人出過貨
```

實體卡在買家手上，系統裡那張卡卻不能上架、不能回收、不能確認，**沒有任何端點救得回來**
（比較：後台 `admin/shipments/:id/status` 那條路有把 prizes 補成 shipped —— 兩條路對同一件事實做的事不一樣）。
修法：`markShipped` 成功時同步 `prizes`（或至少在 release 時收尾），並把對應的 shipments 列標掉。

### F-4 退款後的殭屍出貨單：後台一按，退了款的卡復活

`refund()` 把 prize 標成 `refunded`，但那張 `shipments` 單還在佇列裡 `requested`。
後台照 SOP 處理佇列把它標 `shipped` 時，`admin.ts` 無條件
`update prizes set status='shipped' where id = any(prize_ids)` —— 把 `refunded` 蓋掉。
`markShipped` 對已 refunded 的結算不動（守住了錢），**但卡活過來了**，而 `shipped` 是可上架狀態。

重現（`t8.mjs`）：

```
退款後卡片狀態: refunded
佇列裡的出貨單: sh-07b4d85e38 requested
後台標 shipped: {"ok":true}
之後卡片狀態: shipped
上架: {"listing":{"id":"l-7401aecf3a", ...}}   ← 拿了全額退款的卡成功上架
drift: 0（帳本恆等式沒破 —— 破的是「一張卡只存在一份」）
```

買家退款照拿、卡再賣一次；賣家背了違約還丟了卡的歸屬。
修法：refund 時把關聯的 shipments 標成取消（或後台更新 prizes 時排除 `refunded/recycled`）。

---

## Medium

### F-5 vault-accept 之後的出貨申請是三不管地帶

`shared/pool-settlement.ts` 註解說「之後買家仍然可以申請出貨，賣家的出貨義務不會消失
（不出貨照樣記違約），只是那筆錢不再扣着」。前半句成立，後半句**沒有任何機制**：
`markShipRequested` 只翻 `status='held'` 的列（released 的翻不動），
於是沒有 `ship_due_at`、沒有逾期退款（錢已放，也不該退）、沒有 default_count、
賣家端點 409、唯一出口是後台佇列 —— 而佇列沒有時鐘。

重現（`t3.mjs`）：

```
14 天後結算狀態: released closed_by: vault-accept
申請出貨: {"shipmentId":"sh-5377d83abc"}
申請後結算狀態: released ship_due_at: null
賣家標出貨: {"error":"WRONG_STATE","message":"這筆目前不是等待出貨的狀態"}
shipments: sh-5377d83abc | requested   ← 永遠 requested，除非後台手動處理
```

要嘛把違約時鐘搬到 `shipments`（讓它有自己的期限與罰則），要嘛在文件與 UI 上誠實說
「14 天後的出貨申請由平台人工排程，不再有 72 小時保證」。現在是規則書寫了一條沒人執行的法。

### F-6 sweep 的使用者範圍在轉手後失效

`sweepSettlements(tx, userId)` 的條件是 `seller_id = userId or buyer_id = userId`。
卡轉手後新主人讀 `/v1/prizes` 觸發的 sweep 掃不到那筆結算（buyer_id 是舊主人），
時限狀態只在舊主人／賣家上線或五分鐘全域掃描時前進。t2 實測：B 讀卡冊後退款沒發生，
換 A 讀才發生。修 F-1/F-2（buyer_id 跟人走）會一併修好這條。

---

## Low

- **F-7** vault-accept 釋放後（卡仍 `stashed`），卡冊 API 照樣回 `buyback: 72`，按回收卻回
  「這張卡的結算狀態已經改變，不能回收」（`t5.mjs` 實測）。使用者看到的是一個標了價卻按不動的按鈕，
  訊息也沒說「14 天寄存確認期已過」。建議：settle_status 已結束時前端不顯示回收價，錯誤訊息講明原因。
- **F-8（僅 DEV_LOGIN 環境）** `auth.ts` 的 `ensureUser` 用 `id = 'u-' + handle.toLowerCase()`，
  insert `on conflict (handle) do nothing` 之後**不查**實際的 id 就回傳。
  `dev-login handle=vaultdraw`（種子裡 u-official 的 handle）→ 拿到 `u-vaultdraw` 這個不存在的
  使用者的 token（實測 `/v1/seller/me` 回 null）。正式環境沒有這條路，但煙霧測試若照 handle 借身分會踩到。
- **F-9（Info）** `/v1/prizes/ship` 允許一張出貨單混多個賣家的卡；後台標 shipped 會替單上所有
  prize 呼叫 `markShipped` —— 不同賣家的鑑賞期被同一個動作啟動。現況後台是平台自己按的，可接受，
  但賣家自行出貨的世界裡這張「單」的單位就是錯的（一單應該一賣家）。

---

## 檢查過沒問題

以下都實際跑過（`t1`~`t8` 與 278 項煙霧測試全綠），列出來是為了下一輪不用重查：

- **對帳恆等式**：抽卡、回收、逾期退款、vault 買賣、admin 發點、逾期釋放、以及整套煙霧測試
  （含託管訂單、接受出價、爭議裁決）跑完後 `GET /v1/admin/reconcile` 的 `drift` 全程為 **0**。
  每一組分錄借貸成對（`byReason` 逐項核過：draw −4050 ↔ pool-ticket +4050、
  pool-recycle-in/out ±144、pool-refund +400 ↔ pool-ticket-refund −400、vault-buy/sell ±1500）。
- **違約門檻**：逾期退款每次正確 `default_count + 1`；count=2 開池成功、count=3 回
  `SELLER_SUSPENDED`（邊界 `>= 3`，`t7b.mjs` 實測）。整條鏈（退款 → 計數 → 擋開池）真的通。
- **買回價 v4 與舊世代**：v2 池（`p-promo-1-g2`）抽到的卡按回收，正確回
  `NO_OFFER「這個池沒有宣告買回價 —— 它是買回制上線之前開的池」`；示範池換世代用世代字尾
  判斷收攤（`retireStalePools`），刻意保留的 v2 池不會被誤殺，也不會被誤發買回承諾。
- **池到期與結算脫鉤**：`expire-pool` 後再抽正確回 `POOL_EXPIRED`（到期判斷在 `FOR UPDATE`
  交易內，跟關池搶同一把鎖，不靠背景掃描）；**到期後 held 的卡照樣回收成功**，錢從保留額出。
- **保留額推導**：混合狀態（held 2 / refunded 3 / released 2）的賣家，`walletOf` 的
  `reserved = 1400` 恰等於 held 之和；released/refunded 正確不計；`points` 與帳本 SUM 一致。
- **越權**：`GET /v1/seller/settlements` 只回 `seller_id = me`；拿別人的結算 id 打 ship 回 404；
  結算列 join 出的買家欄位只有 `buyer_name`、`buyer_member_no`，**沒有收件地址**（地址在 shipments，沒被帶出）。
- **狀態機非法轉移**：released → confirm 409、released → recycle 409（訊息見 F-7）、
  非 awaiting_ship → 賣家 ship 409、refunded 的卡 → recycle 409（「只有保管中的卡可以回收」）、
  重複退款被 `returning` 守住（`refund()` 影響 0 列就不寫分錄）。
- **commit v2/v3/v4 迴歸**：煙霧測試涵蓋（偷換卡、偷改買回價、偷換變體都驗得出；v2 池逐字不變）。

### 未驗證（只做了程式碼推理，沒有實跑併發）

- **四條收尾路徑兩兩併發**：回收 vs 出貨申請都先鎖 `prizes` 那列、退款 vs 賣家出貨都先鎖
  結算列，狀態守衛（`where status = ...` + `returning`）讓輸的那邊乾淨退出 —— 推理上安全。
  但 sweep 的鎖序是「結算列 → prizes」、回收是「prizes → 結算列」，理論上可互相死鎖
  （Postgres 會挑一邊 abort，不會壞資料，但那個請求會 500）。未實測。
- **`SELLER_UNFUNDED`**：單張買回價超過保留額、賣家可動用又不足的拒絕路徑，未實測。

---

## 最該先修的三條

1. **F-1 + F-2（同一刀）：結算跟人走，或有結算的卡不准轉手。**
   這是唯一「使用者正常操作就會賠錢」的縫 —— 買市場上的卡、按一個平台自己畫的回收按鈕，
   卡消失、錢給別人。上線前必修。順帶修好 F-6。
2. **F-4：refund 時把殭屍出貨單收掉（或後台更新排除 refunded/recycled）。**
   一次後台誤按就是「退款 + 卡復活再賣」的實體複製，而後台照佇列做事是正常 SOP，不是誤用。
3. **F-3：賣家出貨要同步 `prizes` 與 `shipments`。**
   不修的話每一個「賣家出了貨、買家懶得按確認」的正常案例都會生出一張永久鎖死的卡，
   客服量會隨成交量線性長。

（F-5 建議跟着 F-3 一起想清楚：出貨佇列到底誰負責、有沒有時鐘 —— 兩條是同一張表的兩個沒人管的角落。）
