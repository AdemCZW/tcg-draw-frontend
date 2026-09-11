-- 監控報告抓到的兩件事，程式碼那一半在同一個 commit 修掉，這支補資料那一半。
--
-- ── 1. zombie-shipment ──────────────────────────────────────────────
-- 賣家逾期未出貨 → refund() 把卡標成 refunded、錢退給買家，
-- 但**沒有碰出貨單**。買家先前申請的那張單就一直停在 requested，
-- 後台出貨佇列裡永遠有一件不存在的待辦。
-- 現在 refund() 會把卡從單上拿掉（pool-settlement.ts），單空了就取消 ——
-- 出貨單原本沒有「取消」這個狀態，這裡加上。
--
-- ── 2. listing-prize-desync（pz-l-seed-3 / pz-l-seed-5）─────────────
-- 種子程式替 vault 示範掛單補建卡片時一律寫 'listed'，不管那筆掛單
-- 是不是早就被買走或下架。卡於是被鎖在 listed：delist 只收 live 掛單，
-- 上架、開池也都不收 listed。seed.ts 已經改成掛單不是 live 就不補卡。
--
-- ── 完整退版 ────────────────────────────────────────────────────────
-- 狀態約束可以退（先把 cancelled 的單處理掉才加得回去）：
--     alter table shipments drop constraint shipments_status_check;
--     alter table shipments add constraint shipments_status_check
--       check (status in ('requested', 'packed', 'shipped', 'delivered'));
-- 下面兩段資料修復**不可逆**（被拿掉的卡 id 沒有另外存），但被拿掉的
-- 都是已經退款／回收的卡，它們的完整紀錄在 pool_settlements 與通知裡。

-- ---------- 出貨單可以被取消 ----------
-- 約束名稱用查的，不寫死：002 是欄位上的行內 check，名字是 Postgres 自動取的。
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'shipments'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table shipments drop constraint %I', c.conname);
  end loop;
end $$;

alter table shipments add constraint shipments_status_check
  check (status in ('requested', 'packed', 'shipped', 'delivered', 'cancelled'));

comment on column shipments.status is
  'requested → packed → shipped → delivered。cancelled = 單上的卡全部退款／回收了，'
  '由系統取消（pool-settlement.ts 的 refund()），沒有東西可寄。';

-- ---------- 修復既有的殭屍出貨單 ----------
-- 規則跟 refund() 裡那句 UPDATE 一樣：拿掉已退款／回收的卡之後，
-- 空了就取消、剩下的全寄出了就算寄出、否則維持待處理。
-- 只動 requested，理由同 refund()：packed 以後是人已經在處理的單。
with fixed as (
  select sh.id,
         coalesce(
           array_agg(u.pid order by u.ord)
             filter (where p.status is null or p.status not in ('refunded', 'recycled')),
           '{}'::text[]
         ) as keep
    from shipments sh
    cross join lateral unnest(sh.prize_ids) with ordinality as u(pid, ord)
    left join prizes p on p.id = u.pid
   where sh.status = 'requested'
   group by sh.id
  having bool_or(p.status in ('refunded', 'recycled'))
)
update shipments sh
   set prize_ids = f.keep,
       status = case
         when cardinality(f.keep) = 0 then 'cancelled'
         when not exists (select 1 from prizes p where p.id = any(f.keep) and p.status <> 'shipped') then 'shipped'
         else sh.status
       end,
       shipped_at = case
         when cardinality(f.keep) > 0
          and not exists (select 1 from prizes p where p.id = any(f.keep) and p.status <> 'shipped')
         then coalesce(sh.shipped_at, (extract(epoch from now()) * 1000)::bigint)
         else sh.shipped_at
       end
  from fixed f
 where f.id = sh.id;

-- ---------- 修復被鎖在 listed 的示範卡 ----------
-- 條件跟 monitor.ts 的 checkListingPrizeSync 第二段一致（沒有 live 掛單、
-- 也沒有還開著的訂單），再加上 origin = 'seed' —— 只修種子造成的那一種。
-- 真人的卡如果也長這樣，那是另一個 bug，要人看過再決定，不在這裡順手改。
-- 還原成 stashed：這兩筆都是 vault 掛單，delist 對 vault 的還原也是 stashed。
update prizes pz
   set status = 'stashed'
 where pz.origin = 'seed'
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
