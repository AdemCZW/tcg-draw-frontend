/**
 * 啟動預檢：鑑定編號的唯一性。
 *
 * ── 這支要做什麼 ────────────────────────────────────────────────────
 * 目標是讓「同一張實體卡不能同時登記兩次」成為資料庫層的保證：
 *
 *     create unique index prizes_cert_alive
 *       on prizes(grader, cert_no) where cert_no is not null;
 *
 * 但這條索引**只有在既有資料沒有重複時才建得起來**。有一組重複，
 * Postgres 就直接報錯。所以這支先唯讀掃描，乾淨才建。
 *
 * ── 為什麼是啟動預檢，不是 migration ────────────────────────────────
 * migration 跑一次就被記進 schema_migrations，之後永遠不再跑。
 * 把這件事寫成 migration 只有兩種結局，兩種都不能接受：
 *
 *   a) 遇到髒資料就報錯 → 遷移失敗 → Railway 的啟動指令是
 *      `npm run migrate && npm run seed && npm start`，前面一段失敗
 *      後面就不會跑 → **整個網站起不來**。為了一條防禦性的索引
 *      讓服務下線，代價和收益完全不成比例。
 *
 *   b) 遇到髒資料就跳過建索引 → 這一次被記成「已套用」，
 *      **之後永遠不會再建**。使用者把髒資料清乾淨了也沒用，
 *      要再寫一支新的 migration 才行。
 *
 * 真正的原因是：這條索引能不能建，**取決於資料狀態，而資料狀態會變**。
 * 「只跑一次」和「取決於會變的東西」在定義上就互斥。所以它需要每次
 * 啟動都重新評估一次 —— 那正是 migration 做不到的事。
 *
 * 這樣做的好處是自癒：使用者從 Railway 的日誌看到有幾組髒資料，
 * 手動清完之後**下一次部署就自動把索引建起來**，不用再改任何一行程式碼。
 *
 * ── 絕對不能做的事 ──────────────────────────────────────────────────
 * 1. 不能讓伺服器起不來。任何錯誤都吞掉印 log —— 這是一道預檢，
 *    不是啟動的必要條件。沒有這條索引，系統的行為和今天一模一樣。
 * 2. **不印出任何實際的鑑定編號**。編號是敏感值（拿著它可以去 PSA
 *    官網查到卡的一切），而 Railway 的日誌是給人看的、會留存、
 *    也可能被截圖分享。這裡只印統計數字。要看是哪幾個編號，
 *    用 scripts/scan-certs.ts 對著資料庫查，那支的輸出不會進日誌。
 */
import { sql } from './db.js'

/** 要建的那條索引的名字。日誌和存在性檢查共用，不要各寫一次字串。 */
const INDEX_NAME = 'prizes_cert_alive'

/**
 * advisory lock 的鍵。
 *
 * 為什麼需要它：Railway 可能同時跑好幾份實例（滾動部署時新舊並存），
 * 兩份同時 `create unique index` 會互相卡住 —— 而且不是乾淨地卡住，
 * CREATE INDEX 要 ACCESS EXCLUSIVE 鎖，兩邊會排隊等對方。
 * 先搶 advisory lock，搶不到的那份直接跳過（另一份正在做同一件事，
 * 做完索引就在了，這份下次啟動會看到它已存在）。
 *
 * 用 hashtext 從名字算出鍵，而不是寫一個魔術數字 —— 魔術數字會跟
 * 別人的 advisory lock 撞號，而撞號的症狀是「偶爾莫名其妙跳過」，
 * 幾乎不可能被查出來。
 */
const LOCK_KEY_SQL = `hashtext('vaultdraw:preflight:${INDEX_NAME}')::bigint`

type Dupes = {
  /** 有幾「組」重複（幾個不同的編號被用了不只一次） */
  groups: number
  /** 那些組合計佔了幾列 */
  rows: number
  /** 有編號但沒有 grader 的列數。不擋建索引，但是保證的破口，見下方說明 */
  noGrader: number
}

const n = (v: unknown) => Number(v ?? 0)

/**
 * 掃描。只下 SELECT，不 UPDATE、不 INSERT、不 DDL。
 *
 * ── 正規化 ──────────────────────────────────────────────────────────
 * grader 要 upper(btrim(...))、certNo 要 nullif(btrim(...), '')。
 * 這兩道不是潔癖：
 *   - '  '（全空白）不是一個編號。不 trim 的話，兩張根本沒填編號的卡
 *     會被判成同一張；反過來 ' 12345678' 和 '12345678' 會被判成兩張
 *     不同的卡，唯一性直接失效。
 *   - 'PSA' 和 'psa' 不 upper 就是兩個值 —— 同一張卡換個大小寫
 *     就能再登記一次，等於這條索引白建。
 *
 * prizes 在 migration 021 已經有正規化過的 grader / cert_no 兩個欄位；
 * pool_prizes 和 listings 沒有，要從 card jsonb 現算。
 *
 * ── 為什麼一律排除 grader is null ───────────────────────────────────
 * 唯一鍵是 (grader, cert_no)，而 Postgres 的唯一索引預設 NULLS DISTINCT：
 * 兩列 (null, '12345678') **不會**被索引擋下來。所以把它們算成重複
 * 是假警報，而假警報在這裡的後果特別嚴重 —— 它會讓索引永遠建不起來，
 * 自癒也就永遠不會發生。它們是保證的破口，另外用 noGrader 回報。
 *
 * ── 成本 ────────────────────────────────────────────────────────────
 * 三個聚合查詢，各掃一次表就結束（group by + having，沒有 join 放大、
 * 沒有相關子查詢）。資料量現在是幾百列的等級，冷啟動感覺不出來；
 * 就算之後長大，這支是在開始接受連線**之後**才跑的（見 index.ts），
 * 不佔啟動時間。另外用 statement_timeout 兜底，免得任何意外
 * 讓一條連線永遠掛在那。
 */
async function scan(): Promise<{ prizes: Dupes; poolPrizes: Dupes; listings: Dupes }> {
  return await sql.begin(async tx => {
    /* 預檢不值得為它等太久。set local 只在這個交易內有效，不污染連線池。 */
    await tx`set local statement_timeout = '15s'`

    /* ---------- prizes ----------
       這張表是唯一真正會擋住 DDL 的 —— 索引就是建在它上面。
       所以這裡的條件必須跟索引的述詞對齊：不篩 status。
       索引是 `where cert_no is not null`，沒有 status 條件，
       所以已回收、已退款的歷史列一樣會進索引、一樣會擋住建立。

       用 coalesce(欄位, 從 card 現算) 而不是只看欄位：021 只回填了
       當時已存在的列，**之後新抽出來的卡沒有任何程式碼會寫這兩個欄位**
       （021 自己的註解就這麼寫）。只看欄位的話，這些新列的編號在掃描
       眼中不存在，於是「乾淨 → 建索引」，等到 023 回填欄位的那一刻
       才撞上唯一性 → 遷移失敗 → 部署掛掉。那正是這支要避免的事。
       掃 card 是嚴格更保守的做法：多擋的那些本來就是真的一卡多賣。

       欄位本身也再正規化一次，即使 021 回填時已經正規化過。原因：
       索引比對的是欄位的**原值**，所以 ('PSA','12345678') 和
       ('psa',' 12345678') 對索引來說是兩張不同的卡 —— 索引建得起來，
       但那兩列其實是同一張實體卡。這裡多做一次正規化，就是為了讓這種
       「索引擋不住的重複」也被回報出來。
       方向上是安全的：正規化只會把更多列併成同一組，所以
       「掃描認為乾淨」必然蘊含「索引建得起來」，不會反過來。 */
    const [prizes] = await tx`
      with eff as (
        select coalesce(nullif(upper(btrim(grader)),  ''),
                        nullif(upper(btrim(card->>'grader')), '')) as g,
               coalesce(nullif(btrim(cert_no), ''),
                        nullif(btrim(card->>'certNo'), ''))        as c
          from prizes
      ), dup as (
        select count(*) as n from eff
         where c is not null and g is not null
         group by g, c having count(*) > 1
      )
      select (select count(*)             from dup)                             as groups,
             (select coalesce(sum(n), 0)  from dup)                             as rows,
             (select count(*) from eff where c is not null and g is null)       as no_grader
    `

    /* ---------- pool_prizes ----------
       只看還可能再賣出去的池（draft / committed / open）。
       sold_out 之後每一籤都已經變成一列 prizes，再算一次是同一份髒資料
       數兩遍 —— 使用者看到「兩張表都有問題」會以為要清兩個地方。

       用 sum(total) 不是 count(*)：一列 pool_prizes 帶 total = 15
       的意思是「同一個鑑定編號開了 15 支籤」，那 15 個得主會拿到
       15 列共用同一個編號的 prizes。正式環境就發生過這件事
       （seed.ts 繞過建池 API 直接寫 DB）。用 count(*) 看，這種列
       永遠是「1」，永遠不會被抓到 —— 而它恰恰是最嚴重的那種。 */
    const [poolPrizes] = await tx`
      with eff as (
        select nullif(upper(btrim(pp.card->>'grader')), '') as g,
               nullif(btrim(pp.card->>'certNo'), '')        as c,
               pp.total                                     as total
          from pool_prizes pp
          join pools p on p.id = pp.pool_id
         where p.status in ('draft', 'committed', 'open')
      ), dup as (
        select coalesce(sum(total), 0) as n from eff
         where c is not null and g is not null
         group by g, c having coalesce(sum(total), 0) > 1
      )
      select (select count(*)            from dup)                            as groups,
             (select coalesce(sum(n), 0) from dup)                            as rows,
             (select count(*) from eff where c is not null and g is null)     as no_grader
    `

    /* ---------- listings ----------
       只看 status = 'live'。已售出的掛單同一個編號本來就會出現很多次
       —— 一張卡在站內轉手三次就是三列 sold，那是正常的交易歷史，
       不是一卡多賣。把它算成髒資料，索引就再也建不起來了。

       這張表已經有 listings_cert_live 擋著，而且 migration 038 之後
       它的唯一鍵跟這裡（也跟 prizes_cert_alive）**是同一個** ——
       (grader, cert_no)，只是多了 status='live' 的述詞。038 之前它是
       unique(cert_no)：少了 grader，PSA 與 BGS 的同號卡會被誤擋（U-2）。
       兩側對齊之後仍然要掃它，理由剩下兩個：市場的述詞只管 live，
       跨越 sold／delisted 的重複它管不到；以及萬一哪天索引被刪掉
       要有人發現。

       這裡的 grader 現算 nullif(upper(btrim(card->>'grader')), '')，
       跟 038 那個產生欄位是同一個運算式（那一欄就是它 stored 起來的）。
       刻意不直接讀 listings.grader：預檢是在啟動時跑的，萬一有人
       沒跑遷移就啟動，讀一個不存在的欄位會讓整支預檢連 prizes 那條
       索引一起放棄。現算的版本在新舊 schema 上都跑得起來。 */
    const [listings] = await tx`
      with eff as (
        select nullif(upper(btrim(card->>'grader')), '') as g,
               nullif(btrim(cert_no), '')                as c
          from listings
         where status = 'live'
      ), dup as (
        select count(*) as n from eff
         where c is not null and g is not null
         group by g, c having count(*) > 1
      )
      select (select count(*)            from dup)                            as groups,
             (select coalesce(sum(n), 0) from dup)                            as rows,
             (select count(*) from eff where c is not null and g is null)     as no_grader
    `

    /* 聚合查詢一定回一列，但型別上是 Row | undefined —— 用 ?? {} 收掉，
       n() 對 undefined 回 0，正好是「沒查到就當作沒有重複」。 */
    const shape = (r: Record<string, unknown> | undefined): Dupes => {
      const v = r ?? {}
      return { groups: n(v.groups), rows: n(v.rows), noGrader: n(v.no_grader) }
    }

    return { prizes: shape(prizes), poolPrizes: shape(poolPrizes), listings: shape(listings) }
  })
}

/**
 * 建索引。
 *
 * `if not exists` + advisory lock + try/catch，三層都要：
 *   - advisory lock 讓同時啟動的多份實例只有一份真的下 DDL；
 *   - `if not exists` 處理「上一份剛好在我們檢查完之後建好」的空窗；
 *   - try/catch 處理剩下所有情況（權限不足、資料在掃描與建立之間
 *     又髒掉、連線斷）。任何一種都只是「這次沒建成」，下次啟動再說。
 */
async function createIndex(): Promise<'created' | 'busy' | 'failed'> {
  return await sql.begin(async tx => {
    await tx`set local statement_timeout = '60s'`
    /* xact 版的 advisory lock：交易結束自動釋放，不需要 finally，
       也不會因為連線池把鎖留在別人的連線上。try 版拿不到就回 false，
       不等 —— 等於「另一份實例正在做」，不是錯誤。 */
    const got = await tx.unsafe<{ got: boolean }[]>(
      `select pg_try_advisory_xact_lock(${LOCK_KEY_SQL}) as got`
    )
    if (got[0]?.got !== true) return 'busy' as const

    await tx.unsafe(
      `create unique index if not exists ${INDEX_NAME}
         on prizes(grader, cert_no) where cert_no is not null`
    )
    return 'created' as const
  }).catch(e => {
    console.error('[preflight] 建立唯一索引失敗（不影響伺服器運作）:', e)
    return 'failed' as const
  })
}

/**
 * 進入點。**永遠不 reject**，呼叫端不需要 catch。
 */
export async function certUniquenessPreflight(): Promise<void> {
  const log = (s: string) => console.log(`[preflight] ${s}`)
  try {
    const found = await sql<{ exists: boolean }[]>`
      select to_regclass(${'public.' + INDEX_NAME}) is not null as exists
    `
    const exists = found[0]?.exists === true

    const d = await scan()
    const dirty = [
      ['prizes', d.prizes] as const,
      ['pool_prizes', d.poolPrizes] as const,
      ['listings', d.listings] as const
    ].filter(([, v]) => v.groups > 0)
    const noGrader = d.prizes.noGrader + d.poolPrizes.noGrader + d.listings.noGrader

    if (dirty.length > 0) {
      /* 只印統計。**不印編號**，理由見檔頭。 */
      const total = dirty.reduce((a, [, v]) => a + v.groups, 0)
      log('⚠ 鑑定編號有重複，唯一索引這次不建。')
      log(`   共 ${total} 組編號被重複使用，分布如下（不列出編號本身，那是敏感資料）：`)
      for (const [table, v] of dirty) {
        log(`     ${table.padEnd(11)} ${v.groups} 組，合計 ${v.rows} 列`)
      }
      log('   意思是：這幾組編號各自對應同一張實體卡，但系統裡登記了不只一次。')
      log('   要做的事：用 server/scripts/scan-certs.ts 對資料庫查出是哪幾個編號')
      log('             （那支只下 SELECT，輸出不會進這份日誌），人工判斷哪一列才是真的，')
      log('             把多餘的處理掉。清乾淨之後**下一次部署會自動把索引建起來**，')
      log('             不用改任何程式碼。')
      if (exists) {
        log(`   注意：${INDEX_NAME} 目前已經存在，但上面的重複仍在 —— 表示重複發生在`)
        log('         索引管不到的地方（grader 為空、或還沒寫進欄位的 card jsonb）。')
      }
    } else if (exists) {
      log(`唯一索引 ${INDEX_NAME} 已存在，鑑定編號沒有重複。`)
    } else {
      const r = await createIndex()
      if (r === 'created') {
        log(`鑑定編號沒有重複，已建立唯一索引 ${INDEX_NAME}`)
        log('   從現在起「同一個鑑定編號登記兩次」由資料庫擋下，不再只靠應用層檢查。')
      } else if (r === 'busy') {
        log('另一個實例正在建立唯一索引，這次跳過（下次啟動會確認結果）。')
      }
      // 'failed' 已經在 createIndex 裡印過錯誤了
    }

    if (noGrader > 0) {
      /* 不擋建索引（NULLS DISTINCT，索引本來就管不到這些列），
         但要講出來 —— 它是這條保證的破口，而且是靜默的破口。 */
      log(`附註：有 ${noGrader} 列有鑑定編號卻沒有鑑定公司(grader)。`)
      log('      唯一鍵是 (grader, cert_no)，grader 為空的列不受索引保護（null 不等於 null），')
      log('      也就是說這些卡目前仍然可以被登記第二次。')
      log('      市場那側（listings_cert_live，migration 038）用的是同一個鍵，破口也一樣 ——')
      log('      兩側現在至少會給出同一個答案。新進來的資料不會再有這種列：')
      log('      routes/cardbook.ts 的 GRADER_REQUIRED 擋住「有編號沒有鑑定公司」的登記。')
    }
  } catch (e) {
    /* 這裡是最後一道：預檢再怎麼失敗都不能影響伺服器。
       沒有這條索引，系統的行為就跟今天一模一樣。 */
    console.error('[preflight] 鑑定編號預檢失敗，略過（不影響伺服器運作）:', e)
  }
}
