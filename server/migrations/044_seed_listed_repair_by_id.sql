-- 補 042 漏掉的那兩張：pz-l-seed-3 / pz-l-seed-5。
--
-- ── 042 為什麼沒修到 ────────────────────────────────────────────────
-- 042 用 origin = 'seed' 圈範圍，但這兩列是在 021 加上 origin 欄位**之前**
-- 就由舊版種子建好的，而 021 把當時所有既有的卡一律回填成 'draw'
-- （021_inventory_first.sql：「現有的 prizes 全部來自抽卡」）。
-- 所以它們在資料庫裡是 origin = 'draw'，042 的條件圈不到。
-- 部署後 monitor 的 listing-prize-desync 仍然回報這兩筆，就是這個原因。
--
-- ── 這一次怎麼圈 ────────────────────────────────────────────────────
-- 改用種子的 id 慣例：seed.ts 替 vault 示範掛單補的卡一律是 'pz-' || 掛單 id，
-- 掛單 id 是 l-seed-N。真人抽到或上傳的卡不會是這個前綴。
-- 其餘條件跟 042（也就是 monitor.ts 的 checkListingPrizeSync 第二段）逐字相同：
-- 沒有 live 掛單、也沒有還開著的訂單，才還原。
-- 還原成 stashed：這兩筆都是 vault 掛單，delist 對 vault 的還原也是 stashed。
--
-- 不可逆，但只影響示範資料；重跑安全（第二次跑時 status 已經不是 listed）。

update prizes pz
   set status = 'stashed'
 where pz.id like 'pz-l-seed-%'
   and pz.status = 'listed'
   and not exists (
     select 1 from listings l
      where l.prize_id = pz.id
        and (
          l.status = 'live'
          or (l.status = 'sold' and exists (
                select 1 from orders o
                 where o.listing_id = l.id
                   and o.status in ('escrowed', 'shipped', 'delivered', 'disputed')
              ))
        )
   );
