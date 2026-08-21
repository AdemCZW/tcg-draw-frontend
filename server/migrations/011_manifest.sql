-- 011：把獎品內容綁進承諾
--
-- v1 的 commit 是 SHA256(server_seed) —— 只涵蓋種子，不涵蓋獎品是什麼。
-- 後果：改「某個獎項有幾張」籤序會變、驗算抓得到；但改「第 3 個獎項是哪張卡」
-- 籤序不變，**驗算照樣回 ok**。也就是開賣後把噴火龍換成同賞別的廉價卡，
-- 平台宣稱的可驗證性抓不到 —— 這正是「銷售中途調整」那條攻擊。
--
-- v2 改成 commit = SHA256(server_seed_bytes ‖ manifest_hash_bytes)。
-- manifest 是排序後的獎品清單（見 shared/fairness.ts 的 manifestString）。
--
-- 既有的池留在 v1：它們的 commit 已經對外公布過，不能事後改。
-- manifest_hash 是 null 就代表 v1，驗算端據此判斷該用哪一套。

alter table pools add column if not exists manifest_hash text;
