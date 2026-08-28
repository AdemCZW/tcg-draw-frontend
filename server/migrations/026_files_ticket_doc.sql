-- 026：files.purpose 放行 ticket-doc（把執行期補丁升級成遷移）
--
-- ── 來由 ────────────────────────────────────────────────────────────
-- 客服工單的附件走 /v1/files/presign 的 ticket-doc 用途（合約第六節），
-- 但 002_core.sql 給 files.purpose 的 CHECK 白名單沒有這一項 ——
-- 實測 insert 'ticket-doc' 直接撞 23514，presign 會變 500，
-- 附件整條是死的。
--
-- 工單施工時 migrations/ 是禁區，所以先做成開機時的執行期補丁
-- （tickets.ts 曾有 ticketDocPurposePatch()，比照 preflight 的作法）。
-- 補丁能動，但約束的內容應該住在遷移裡：看 schema 的人要能在
-- migrations/ 找到「為什麼白名單長這樣」的全部歷史，
-- 而不是還要知道去某支 .ts 裡找一段開機程式。
-- 這支落地的同一個 commit 已把那段補丁刪掉。
--
-- 冪等：補丁跑過的環境約束已經含 ticket-doc，drop + add 一樣的內容
-- 是安全的 no-op 結果；沒跑過的環境（乾淨庫照序 migrate）在這裡放行。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 退版（只有在沒有任何 purpose='ticket-doc' 的列時才收得回去）：
--     alter table files drop constraint files_purpose_check;
--     alter table files add constraint files_purpose_check
--       check (purpose in ('pool-cover','ship-photo','unbox-video','seller-doc','avatar'));

alter table files drop constraint if exists files_purpose_check;
alter table files add constraint files_purpose_check
  check (purpose in ('pool-cover','ship-photo','unbox-video','seller-doc','avatar','ticket-doc'));
