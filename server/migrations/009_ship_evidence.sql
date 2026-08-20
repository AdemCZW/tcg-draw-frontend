-- 009：出貨憑證
--
-- 兩個欄位補上一段本來是斷的鏈：
--
-- 1. carrier —— 單號要能驗證，得先知道是哪一家的單號。原本 ship 端點只收
--    tracking，用一條 /^[A-Za-z0-9-]{8,24}$/ 什麼都放行，連 ABCD1234 都算合法。
--    知道物流商之後，中華郵政那種有公開檢查碼規格的就驗得起來
--    （見 shared/escrow.ts 的 validateTracking）。
--    也記下「這筆是用哪一家的規則驗的」——選「其他」代表沒驗過，平台看得出來。
--
-- 2. ship_photos —— 原本 ShipBody 有收 photoUrls 而且標成必填、還寫著
--    「需含可辨識的鑑定編號」，但端點只解構出 tracking，照片直接丟掉。
--    也就是說平台要求賣家拍照存證，然後把存證扔了。爭議發生時什麼都沒有。

alter table orders add column if not exists carrier     text;
alter table orders add column if not exists ship_photos jsonb;
