-- 022：票金已結算、實體卡還沒交的出貨義務（audit-backend-2 的 F-5）
--
-- ── 要補的洞 ────────────────────────────────────────────────────────
-- 寄存確認期（14 天）滿了之後，結算會自動 released：票金放給賣家，
-- 理由是「卡還在保管庫代表買家目前不要求實體交付」。
--
-- 但買家之後仍然可以申請出貨，而那條路完全沒有接上：
--   markShipRequested 的條件是 `status = 'held'`，released 的不動 ——
--   於是出貨單進了佇列，卻沒有任何時鐘。
--   賣家標不了出貨（他的端點只收 awaiting_ship，回 409）、
--   逾期不記違約、也不會退款。
--
-- shared/pool-settlement.ts 的註解宣稱「賣家的出貨義務不會消失
-- （不出貨照樣記違約）」—— 那個機制在這支遷移之前不存在。
--
-- ── 為什麼不是「把狀態改回 awaiting_ship」──────────────────────────
-- awaiting_ship 在 RESERVED_STATUSES 裡，改回去等於把已經釋放的票金
-- **重新算成保留額**。那筆錢已經依規則放給賣家、他可能已經花掉了，
-- 事後再把它凍起來是平台單方面追回。
--
-- 所以這裡走另一條線：狀態留在 released，只掛一個出貨期限
-- （沿用既有的 ship_due_at 欄位），逾期的手段只有違約紀錄，**不退款**。
-- 判斷邏輯在 shared/pool-settlement.ts 的 physicalShipOverdue()。
--
-- ── 為什麼需要新欄位 ────────────────────────────────────────────────
-- 違約次數是 `default_count + 1`，沒有任何冪等保護（不像分錄有 ledger_once）。
-- 逾期掃描會被每一個讀清單的請求觸發，沒有「已經記過了」的標記的話，
-- 同一筆逾期會在賣家每次上線時再記一次，幾分鐘就能把他記到停權。
--
-- 用 closed_by 代打不行：那一欄記的是**票金**怎麼結束的（'vault-accept'），
-- 覆寫掉就查不出這筆錢當初為什麼放。兩件事分開記。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 完整退版（無損）：
--     drop index if exists settlements_ship_owed;
--     alter table pool_settlements drop column if exists ship_default_at;
-- 退版後既有資料一列都沒被動過。

alter table pool_settlements add column if not exists ship_default_at bigint;

comment on column pool_settlements.ship_default_at is
  '「票金已結算、賣家逾期還沒交出實體卡」的違約已於此時記錄過（毫秒）。'
  'null = 還沒記。這一欄唯一的用途是冪等 —— 逾期掃描每次讀清單都會跑，'
  '沒有它同一筆逾期會被重複記到賣家停權。'
  '跟 closed_by 不同：closed_by 記的是**票金**怎麼結束的，不能拿來代打。';

-- 掃描要找的是「released、掛著出貨期限、還沒出貨、還沒記過違約」。
-- 部分索引把範圍縮到真正還欠著貨的那幾列 —— 絕大多數 released 的結算
-- 根本沒有 ship_due_at（買家從來沒申請出貨），不該每次掃描都掃過它們。
create index if not exists settlements_ship_owed
  on pool_settlements(ship_due_at)
  where status = 'released' and ship_due_at is not null
    and shipped_at is null and ship_default_at is null;
