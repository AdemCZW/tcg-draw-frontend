-- deal 排序的索引跟排序鍵對齊。
--
-- ── 為什麼 ───────────────────────────────────────────────────────────
--
-- 013 建的 listings_live_deal 索引的是**舊的**排序鍵：
--
--   coalesce((price - nullif(ref,0)) / nullif(ref,0), 0)
--
-- 後來排序鍵換成 routes/public.ts 的 DEAL_KEY（多了 refPrice 的正規表示式
-- 守衛、下界夾在 DEAL_FLOOR、離群與無基準退到 NO_BASIS 哨兵）。運算式索引
-- 必須跟 order by 的運算式**逐字對得起來**才用得到，換了鍵之後它就再也
-- 接不上了 —— 但它還在，而且每 insert 一筆掛單都要把那個運算式算一遍。
-- 也就是說：只剩寫入成本，沒有任何讀取好處。
--
-- 本機實測（20,005 筆 live 掛單，deal 排序第一頁 limit 21）：
--   換之前：Seq Scan on listings → top-N heapsort，52.0 ms / 631 buffers
--           （listings_live_deal 一次都沒被拿來排序）
--   換之後：Index Scan using listings_live_deal_key，0.45 ms / 23 buffers
--           （沒有 Sort 節點）
--
-- ── 為什麼是「換」不是「drop」──────────────────────────────────────
--
-- 判準是 deal 排序實際上怎麼查：
--   order by DEAL_KEY asc, id asc，翻頁靠 (DEAL_KEY, id) > (游標) 的列比較，
--   全部限定 status = 'live'。
-- 這正好就是 (DEAL_KEY, id) where status='live' 這條索引的形狀 —— 它不是
-- 「留著比較安全」，它是唯一能讓這個查詢不整表重排的東西。而且游標分頁
-- 讓代價會重複發生：不換的話，使用者每往下捲一頁，整張 live 表就重排一次。
-- 寫入成本方面「換」跟現況相同（一樣是每筆算一個 numeric 運算式），
-- 所以相對於今天，換是純賺；drop 才是拿掉一個能用的東西換一點寫入。
--
-- ── 索引運算式必須跟 public.ts 的 DEAL_KEY 同步 ─────────────────────
--
-- ⚠️ 下面的 -0.7 / 999999 / 1000000 對應 public.ts 的 DEAL_FLOOR、
--    NO_BASIS - 1、NO_BASIS，小數點也一樣寫成 [.]（在那支是 tagged template，
--    `\.` 會被 JS 吃掉，見該處註解；這裡是 .sql，兩種寫法都對，但要對得起來）。
--    **改了那三個常數或那段運算式，這條索引就會安靜地失效**——
--    查詢結果不會錯，只會退回整表重排。要調的話兩邊一起改。
--
-- 另外：public.ts 送進去的是 `$n::text::numeric` 參數，只有 custom plan
-- （參數摺成常數）才對得上這條索引。實測不成問題 —— generic plan 是
-- Seq Scan + Sort，成本遠高於 custom plan，Postgres 的成本比較不會切過去
-- （連跑 12 次，耗時穩定在 1 ms 上下）。
--
-- ── 為什麼不用 CREATE INDEX CONCURRENTLY ────────────────────────────
--
-- src/migrate.ts 把每一支遷移包在一個交易裡，而 CONCURRENTLY 不能在交易
-- 內執行（75dcd3e 實測過）。前提是：這張表目前只有數百列，而遷移跑在
-- `npm run migrate && npm start` 的第一段 —— 服務還沒開始收連線，
-- 這段時間的表鎖擋不到任何使用者。表長到需要線上重建索引的那一天，
-- 要嘛拆掉 migrate.ts 的交易包裝，要嘛手動在資料庫上跑，不要在這裡硬塞。

drop index if exists listings_live_deal;

create index if not exists listings_live_deal_key
  on listings (
    (coalesce(
       case when ((price - (case when card->>'refPrice' ~ '^[0-9]+([.][0-9]+)?$'
                                 then nullif((card->>'refPrice')::numeric, 0) end))
                / (case when card->>'refPrice' ~ '^[0-9]+([.][0-9]+)?$'
                        then nullif((card->>'refPrice')::numeric, 0) end)) >= (-0.7)::numeric
            then least(((price - (case when card->>'refPrice' ~ '^[0-9]+([.][0-9]+)?$'
                                       then nullif((card->>'refPrice')::numeric, 0) end))
                      / (case when card->>'refPrice' ~ '^[0-9]+([.][0-9]+)?$'
                              then nullif((card->>'refPrice')::numeric, 0) end)), (999999)::numeric) end,
       (1000000)::numeric)),
    id
  )
  where status = 'live';

-- ⚠️ 順手記一件被拿掉的事：舊索引裡的 `(card->>'refPrice')::numeric` 沒有
--    正規表示式守衛，所以 refPrice 是 "待估" 這種髒值時，**insert 當下就會**
--    因為建索引失敗而回 22P02 —— 那是一道沒人設計過的擋牆，只是剛好在。
--    新的運算式有守衛，那道牆就沒了。真正該擋的地方是寫入路徑：
--    上架走 routes/public.ts、卡冊走 routes/cardbook.ts，兩邊的 zod schema
--    都把 refPrice 收成 z.number().int().nonnegative()，髒值進不來。
--    這裡寫下來是為了讓下一個放寬寫入驗證的人知道，這條防線已經不在了。
