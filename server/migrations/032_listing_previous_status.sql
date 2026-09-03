-- 032：掛單記住卡上架前的狀態，下架時精確還原（A-5）
--
-- ── 病灶 ────────────────────────────────────────────────────────────
-- 下架（routes/public.ts 的 /listings/:id/delist）原本用 delivery 反推
-- 卡上架前是什麼狀態：
--     const back = l.delivery === 'vault' ? 'stashed' : 'shipped'
-- 但 delivery 是**多對一**的投影 —— 上架端把兩種完全不同的來源
-- （'shipped'：平台寄到手上的；'in_book'：自己登記進卡冊、或池結束解押
-- 回來的）都判成 delivery = 'ship'，因為對「怎麼交付」而言它們一樣：
-- 卡在持有人自己手上，賣掉就得自己寄。
--
-- 資訊在那一刻就被丟掉了，下架時再也推不回來，於是反推一律回 'shipped'：
--     in_book → 上架 → 下架 → shipped
-- 而建池只接受 in_book（routes/pools.ts 的押記重用分支只認 in_book，
-- 其他狀態一律 CARD_BUSY），開池挑選器也只列 in_book/stashed。
-- 結果是**卡明明一直在使用者手上，卻永遠不能再拿去開池**，
-- 而且整條路上沒有任何一個錯誤訊息 —— 每一步都「成功」了。
-- 站上沒有任何端點能把它救回來（改狀態的路徑全都有各自的前提條件）。
--
-- ── 修法：把丟掉的資訊存下來，不要更聰明地反推 ──────────────────────
-- 加一欄 previous_status，上架時抄下 prizes.status 當時的值，
-- 下架時原樣還原。這是唯一不會再被「未來又多一種可上架狀態」打破的做法：
-- 反推法每多一個來源狀態就多錯一種，而抄下來的值不需要知道有幾種。
--
-- 欄位可以是 null，有兩種來源，兩種都得能跑：
--   1 這支遷移之前建立的舊掛單（下面的回填只救得回一部分，見後述）
--   2 沒有 prize_id 的掛單（早期種子資料）—— 本來就沒有卡要還原
-- 程式端對 null 保留原本的 delivery 反推當退路（見 public.ts 的說明），
-- 那條退路是「已知會在 ship 上猜錯」的舊行為，只是沒有更好的資訊了。

alter table listings add column if not exists previous_status text;

-- ── 回填一：還活著的掛單 ────────────────────────────────────────────
--
-- vault 的掛單可以百分之百確定：上架端只有 status = 'stashed' 會被判成
-- delivery = 'vault'，沒有第二個來源。
update listings set previous_status = 'stashed'
 where status = 'live' and delivery = 'vault' and previous_status is null;

-- ship 的掛單本質上是 'shipped' 與 'in_book' 兩種來源的混合，事後分不出來
-- —— 除非那一列的 'shipped' 在物理上**不可能發生過**。判準：
--
--   pool_id is null  卡從來沒進過任何池。平台的出貨流程（stashed →
--                    ship_requested → shipped）只發生在池裡抽出來的獎品上，
--                    而建池押記的重用分支是就地把同一列改成 pool_id = 池,
--                    status = 'in_pool'，池結束解押（releasePledgedCards）
--                    也不清掉 pool_id。所以 pool_id 一旦寫上就永遠留著：
--                    pool_id is null ⇒ 這張卡沒經過平台出貨。
--
--   沒有 completed 的訂單  另一條合法通往 'shipped' 的路是市場成交：
--                    orders-service.ts 的 releasePrize() 在訂單完成時把卡
--                    過戶給買家並標成 'shipped'（實體真的寄出去了）。
--                    這一種是真的 shipped，不能動。
--
-- 兩個條件都成立時，這一列的 'shipped' 只可能是上架前就已經是 shipped
-- （不可能，見上）或……根本不是 shipped 而是 in_book。所以填 'in_book'。
-- 條件不成立的列**維持 null**：寧可讓它走舊的退路（可能猜錯），
-- 也不要在這裡猜一個我們證明不了的值 —— 猜錯的方向會是把一張真的
-- 已出貨的卡說成 in_book，那會讓它被拿去開池，比原本的 bug 更糟。
update listings l set previous_status = 'in_book'
 where l.status = 'live' and l.delivery = 'ship' and l.previous_status is null
   and exists (
     select 1 from prizes p where p.id = l.prize_id and p.pool_id is null
   )
   and not exists (
     select 1 from orders o join listings l2 on l2.id = o.listing_id
      where l2.prize_id = l.prize_id and o.status = 'completed'
   );

-- ── 回填二：已經被錯轉成 shipped 的卡 ───────────────────────────────
--
-- 這是「救不救得回來」的那一半。分得出來的只有同一個可證明性條件下的列：
-- 卡現在是 'shipped'、從沒進過池（pool_id is null）、有過一筆 delivery='ship'
-- 的**下架**掛單、而且它的掛單從來沒有一筆訂單完成過。
-- 這種列通往 'shipped' 的合法路徑一條都不存在，只剩下架反推那一條，
-- 所以它必然是被錯轉的，還原成 in_book 是還原事實而不是猜測。
--
-- 分不出來的：卡進過池（pool_id 非 null）的那些。那些列的 'shipped' 有
-- 完全合法的來源（在池裡被抽走 → 得主申請出貨 → 已出貨），資料上沒有任何
-- 欄位能區分「本來就 shipped」與「上架前是 in_book」。**那一批救不回來**，
-- 只能靠人工個案處理，這支遷移刻意不碰它們。
--
-- 退款／取消的訂單（orders-service.ts 的 releasePrize 把卡退回賣家時也一律
-- 寫 'shipped'）是同一類資訊遺失，但那在另一支檔案，不在這一輪的範圍；
-- 上面的 not exists 只排除 completed，所以退款回來的列會被這裡一起救到 ——
-- 那是對的：退款代表卡從頭到尾沒離開賣家，它上架前是什麼就該回到什麼。
update prizes p set status = 'in_book'
 where p.status = 'shipped'
   and p.pool_id is null
   and exists (
     select 1 from listings l
      where l.prize_id = p.id and l.status = 'delisted' and l.delivery = 'ship'
   )
   and not exists (
     select 1 from orders o join listings l on l.id = o.listing_id
      where l.prize_id = p.id and o.status = 'completed'
   );

-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 結構退版無損：alter table listings drop column previous_status;
-- 資料回填不可逆（也不該逆）：回填二改的是被 bug 弄錯的狀態，
-- 退回去等於把卡再鎖一次。
