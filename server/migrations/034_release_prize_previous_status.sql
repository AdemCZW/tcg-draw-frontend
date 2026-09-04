-- 034：退款／取消的訂單結案時，卡要回到上架前的狀態（A-7）
--
-- ── 病灶 ────────────────────────────────────────────────────────────
-- orders-service.ts 的 releasePrize() 原本三種結案結局共用一行：
--     update prizes set user_id = <owner>, custodian_id = <owner>, status = 'shipped'
-- completed 那條是對的（卡真的寄到買家手上了）。
-- refunded / cancelled 那兩條是**資訊遺失**：交易沒成、卡從頭到尾在賣家
-- 的抽屜裡，卻被寫成「已寄出」。而建池只收 in_book（routes/pools.ts 的
-- 押記重用分支，其餘一律 CARD_BUSY），所以一張 in_book 的卡只要
--     上架 → 有人下單 → 賣家逾期未出貨（系統自動取消退款）
-- 就永遠不能再拿去開池了 —— 而且全程沒有任何錯誤訊息，每一步都「成功」。
--
-- 這是 032（A-5）的同一類病：用一個可以合法發生的狀態，蓋掉一個我們其實
-- 還留著的事實。程式端的修法也一樣 —— 讀 032 加的 listings.previous_status，
-- 不要從 delivery 或 order.status 反推。這支遷移只處理**已經發生的資料**。
--
-- ── 這支只做兩件回填，而且兩件用的是 032 的同一把尺 ──────────────────
-- 032 的判準是「這一列的 'shipped' 在物理上可不可能合法發生」。
-- pool_id is null 的卡不可能經過平台出貨流程（stashed → ship_requested →
-- shipped 只發生在池裡抽出來的獎品上，而 pool_id 一旦寫上就永遠留著）；
-- 排掉 completed 訂單之後，市場成交過戶那條也沒了。剩下的 'shipped'
-- 只可能是被 bug 寫進去的。站外接管（tickets.ts）與卡冊登記
-- （routes/cardbook.ts）寫的都是 'in_book'，不是 'shipped'，所以沒有第三條路。

-- ── 回填一：還在跑的訂單，先把 previous_status 補起來 ────────────────
--
-- 032 的回填只掃 status = 'live' 的掛單。成交的掛單（status = 'sold'）
-- 一列都沒補到 —— 但**進行中的**那些訂單將來還會走到 releasePrize()，
-- 補得起來就不必在結案時退回那條保守的老路。
--
-- 條件跟 032 回填一的 ship 那半完全一樣，只是掛單狀態換成 'sold'：
-- 卡現在停在 'listed'（那是託管期間的鎖，證明這一列確實被這筆掛單鎖著）、
-- 從沒進過池、而且沒有任何一筆完成的訂單。這種卡上架前不可能是 'shipped'，
-- 只可能是 'in_book'。條件不成立的維持 null，結案時走保守的 'shipped'。
update listings l set previous_status = 'in_book'
 where l.status = 'sold' and l.delivery = 'ship' and l.previous_status is null
   and exists (
     select 1 from prizes p
      where p.id = l.prize_id and p.pool_id is null and p.status = 'listed'
   )
   and not exists (
     select 1 from orders o join listings l2 on l2.id = o.listing_id
      where l2.prize_id = l.prize_id and o.status = 'completed'
   );

-- ── 回填二：已經被錯寫成 shipped 的卡 ───────────────────────────────
--
-- 分得出來的只有一種：這張卡有過一筆「**賣家從來沒按過出貨**就結案」的訂單。
--     o.shipped_at is null  這是關鍵條件，不是順手加的。
--         逾期未出貨自動取消（closed_by = 'ship-timeout'）走的是 escrowed →
--         cancelled，shipped_at 永遠是 null ⇒ 卡確定沒離開賣家。
--         爭議判買家（refunded）則相反：爭議只開得起來於 shipped / delivered
--         （escrow.ts 的 actionsFor），賣家已經按過出貨，實體卡**可能**
--         已經在買家手上。那一批的 'shipped' 有完全合法的來源，
--         資料上也沒有任何欄位分得出卡在誰手上（沒有簽收回報、沒串物流），
--         所以**刻意不救**。
-- 加上 032 的那兩把尺（pool_id is null、沒有 completed 訂單），
-- 這一列通往 'shipped' 的合法路徑一條都不存在，只剩 releasePrize() 那個
-- bug —— 所以寫回 'in_book' 是還原事實，不是猜測。
--
-- 卡還在賣家名下也要確認（p.user_id = l.seller_id）：卡如果已經被站外接管
-- 過走了，這一列就不是我們在講的那張卡的故事了（而且接管本來就會寫 in_book）。
update prizes p set status = 'in_book'
 where p.status = 'shipped'
   and p.pool_id is null
   and exists (
     select 1 from orders o join listings l on l.id = o.listing_id
      where l.prize_id = p.id
        and l.delivery = 'ship'
        and l.seller_id = p.user_id
        and o.status in ('refunded', 'cancelled')
        and o.shipped_at is null
   )
   and not exists (
     select 1 from orders o2 join listings l2 on l2.id = o2.listing_id
      where l2.prize_id = p.id and o2.status = 'completed'
   );
--
-- ── 救不回來的，照實說 ──────────────────────────────────────────────
--   1 pool_id 非 null 的卡：它們的 'shipped' 有完全合法的來源
--     （在池裡被抽走 → 得主申請出貨 → 已出貨），沒有任何欄位分得出
--     「本來就 shipped」與「上架前是 in_book」。沒有 prize 狀態異動的稽核表，
--     這件事就是無解的，只能人工個案處理。032 也是同一個結論。
--   2 爭議判買家（refunded 且 shipped_at 有值）的那一批：見回填二的說明。
--     這一批**即使修好程式之後也不會被還原** —— 那是刻意的方向，
--     跟 032 一樣：猜錯成 in_book 會讓一張可能真的寄出去的卡被拿去開池，
--     抽到的人拿不到卡，比不能開池嚴重得多。
--
-- ── 可逆性 ──────────────────────────────────────────────────────────
-- 這支沒有結構變更（previous_status 是 032 加的），退版不用做任何事。
-- 資料回填不可逆（也不該逆）：改的是被 bug 弄錯的狀態，退回去等於把卡再鎖一次。
