-- 030: Public card-front photos for catalog-missing cards.
-- A self-entered card can be shown in cardbooks, pools, and listings only when
-- its owner uploaded a front photo through the controlled files service.
--
-- 冪等：drop + add 同一條約束，重跑是安全的 no-op 結果（同 026）。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 退版（只有在沒有任何 purpose='card-front' 的列時才收得回去，同 026）：
--     alter table files drop constraint files_purpose_check;
--     alter table files add constraint files_purpose_check
--       check (purpose in ('pool-cover','ship-photo','unbox-video','seller-doc','avatar','ticket-doc'));
--
-- ⚠️ 已經有 card-front 的列時，上面第二句會直接失敗（既有列違反新約束）。
--    要退版就得先處理那些列 —— 而刪掉它們等於刪掉使用者上傳的卡面照，
--    那些照片正是目錄外的自建卡唯一的圖像來源，刪了卡片在卡冊、池與
--    market 上會變成無圖。所以退版前要先確認：
--        select count(*) from files where purpose = 'card-front';
--    不是 0 就不要退，改成往前修。
--
-- 退版窗口只到「第一張卡面照上傳」為止 —— 同 021 的窗口邏輯，
-- 這一條要寫進上線 runbook。

alter table files drop constraint if exists files_purpose_check;
alter table files add constraint files_purpose_check
  check (purpose in ('pool-cover','ship-photo','unbox-video','seller-doc','avatar','ticket-doc','card-front'));
