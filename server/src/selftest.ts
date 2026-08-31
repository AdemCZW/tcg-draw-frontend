/**
 * 不需要資料庫的自我檢查。
 *
 * 這支存在的理由很具體：共用模組（src/shared/，本地是 sync-shared 複製過來的那份）原本是給瀏覽器用的，
 * 最大的風險是它偷偷相依了某個前端的東西，而那件事要等後端跑起來才會發現。
 * 這支在 Node 裡直接 import 並執行規則，把那個風險提前暴露。
 *
 * 需要資料庫的部分（交易邊界、併發、帳本）不在這裡 —— 那要真的連 Postgres。
 */
import { applyDeadlines, actionsFor, depositFor, looksLikeTracking, DAY, HOUR } from './shared/escrow.js'
import { cardNumbersAgree } from './card-cert.js'
import type { Order } from './shared/domain.js'

const base: Order = {
  id: 'o1', listingId: 'l1', card: {} as Order['card'], price: 1000, deposit: 100,
  buyerId: 'b', buyerName: 'B', sellerId: 's', sellerName: 'S',
  status: 'escrowed', createdAt: 0
}
let pass = 0, fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.error(`  FAIL ${name}`) }
}

console.log('shared/escrow 在 Node 環境的行為：')
check('72h 未出貨 → cancelled',
  applyDeadlines(base, 73 * HOUR).status === 'cancelled')
check('71h 還沒到期，維持 escrowed',
  applyDeadlines(base, 71 * HOUR).status === 'escrowed')
/* 出貨後買家一直沒有回應 → **視同送達**，不是視同未送達。
   反過來的話，任何買家都可以收到卡之後什麼都不按、等 14 天拿回全額退款，
   卡跟錢都在他手上 —— 沉默不該是白拿一張卡的手段。 */
check('出貨後 15 天買家沒回應 → 視同送達（delivered），不是退款',
  applyDeadlines({ ...base, status: 'shipped', shippedAt: 0 }, 15 * DAY).status === 'delivered')
check('出貨後 13 天還在等送達',
  applyDeadlines({ ...base, status: 'shipped', shippedAt: 0 }, 13 * DAY).status === 'shipped')
/* 視同送達之後驗收期才開始算，而且起點是**時限那一刻**不是掃描跑到的那一刻 ——
   時限用時間戳推導，補算跟即時算必須得到同一個答案。
   所以沉默的買家最終走完 14 + 7 = 21 天到 completed。 */
check('視同送達之後接著跑完驗收期 → completed（總長 21 天）', (() => {
  const deemed = applyDeadlines({ ...base, status: 'shipped', shippedAt: 0 }, 15 * DAY)
  return deemed.deliveredAt === 14 * DAY &&
    applyDeadlines(deemed, 22 * DAY).status === 'completed'
})())
check('送達後 8 天 → 自動放款 completed',
  applyDeadlines({ ...base, status: 'delivered', deliveredAt: 0 }, 8 * DAY).status === 'completed')
check('送達後 6 天仍在驗收期',
  applyDeadlines({ ...base, status: 'delivered', deliveredAt: 0 }, 6 * DAY).status === 'delivered')
check('爭議逾期不自動裁決（人要判）',
  applyDeadlines({ ...base, status: 'disputed', disputedAt: 0 }, 30 * DAY).status === 'disputed')
check('escrowed 時只有賣家能出貨',
  actionsFor(base, 'seller').includes('ship') && actionsFor(base, 'buyer').length === 0)
check('delivered 時買家可確認或申訴',
  actionsFor({ ...base, status: 'delivered' }, 'buyer').length === 2)
/* 買家在 shipped 就要按得到。delivered 只有平台標得動（未來的物流 webhook
   落點，那個 webhook 還沒接）—— 只認 delivered 的話真實流程裡買家永遠
   按不到確認收貨，賣家寄了卡卻只能等時限把訂單判掉。 */
check('shipped 時買家就能確認或申訴（不必等 delivered）',
  actionsFor({ ...base, status: 'shipped' }, 'buyer').length === 2)
check('shipped 時賣家沒有可做的動作',
  actionsFor({ ...base, status: 'shipped' }, 'seller').length === 0)
check('新賣家保證金 10%', depositFor(1000, 0) === 100)
check('老賣家保證金 2%', depositFor(1000, 100) === 20)
check('保證金有絕對上限', depositFor(10_000_000, 0) === 5000)
check('壞單號擋下', !looksLikeTracking('BAD'))
check('正常單號放行', looksLikeTracking('ABC12345678'))

/* ---------------- 公平抽選 ---------------- */
import { commitOf, seatSequence, verifyReveal, commitV2, manifestHashOf, hexToBytes, bytesToHex } from './shared/fairness.js'

console.log('\nshared/fairness：')
const seed = 'a'.repeat(64)
const seed2 = 'b'.repeat(64)
const prizes = [
  { prizeId: 'LAST', total: 1 }, { prizeId: 'A', total: 2 },
  { prizeId: 'B', total: 5 }, { prizeId: 'C', total: 12 }, { prizeId: 'D', total: 80 }
]
const N = 100

const commit = await commitOf(seed)
check('commit 是 64 位 hex', /^[0-9a-f]{64}$/.test(commit))
check('hex 來回一致', bytesToHex(hexToBytes(seed)) === seed)

const s1 = await seatSequence(seed, 'drand:12345', prizes)
const s1again = await seatSequence(seed, 'drand:12345', prizes)
check('籤序長度 = 總籤數', s1.length === N)
check('同樣輸入 → 同樣籤序（決定性）', s1.join() === s1again.join())

const counts = s1.reduce<Record<string, number>>((m, p) => ((m[p] = (m[p] ?? 0) + 1), m), {})
check('籤序是原清單的排列（每個獎的數量沒變）',
  prizes.every(p => counts[p.prizeId] === p.total))

const s2 = await seatSequence(seed2, 'drand:12345', prizes)
const s3 = await seatSequence(seed, 'drand:12346', prizes)
check('server_seed 不同 → 籤序不同', s1.join() !== s2.join())
check('client_seed 不同 → 籤序不同', s1.join() !== s3.join())

const shuffled = [...prizes].reverse()
const s4 = await seatSequence(seed, 'drand:12345', shuffled)
check('獎品傳入順序不影響結果', s1.join() === s4.join())

check('正確的 reveal 通過驗證',
  (await verifyReveal({ serverSeed: seed, commitHash: commit, clientSeed: 'drand:12345', prizes, publishedSequence: s1 })).ok)
check('換過 seed 的 reveal 被抓到',
  !(await verifyReveal({ serverSeed: seed2, commitHash: commit, clientSeed: 'drand:12345', prizes, publishedSequence: s1 })).ok)
const tampered = [...s1]; tampered[0] = tampered[0] === 'D' ? 'LAST' : 'D'
check('竄改一個籤位被抓到',
  !(await verifyReveal({ serverSeed: seed, commitHash: commit, clientSeed: 'drand:12345', prizes, publishedSequence: tampered })).ok)

/* ---- v2：獎品內容也在承諾裡 ----
   v1 的 commit 只涵蓋種子，所以改「第 3 個獎項是哪張卡」籤序不變、
   驗算照樣回 ok —— 開賣後把噴火龍換成同賞別的廉價卡抓不到。
   下面這幾條就是釘住「現在抓得到了」。 */
const manifest = [
  { prizeId: 'LAST', tier: 'LAST', total: 1, name: '噴火龍 ex UR', setCode: 'SV4a', cardNo: '349', grader: 'PSA', grade: 10, certNo: '84120033', refPrice: 43680 },
  { prizeId: 'A', tier: 'A', total: 2, name: '奇樹 SAR', setCode: 'SV4a', cardNo: '350', grader: 'PSA', grade: 10, certNo: null, refPrice: 26320 },
  { prizeId: 'D', tier: 'D', total: 7, name: '謎擬Ｑ SAR', setCode: 'SV4a', cardNo: '341', grader: 'RAW', grade: null, certNo: null, refPrice: 380 }
]
const mPrizes = manifest.map(m => ({ prizeId: m.prizeId, total: m.total }))
const mSeq = await seatSequence(seed, 'drand:v2', mPrizes)
const mHash = await manifestHashOf(manifest)
const commit2 = await commitV2(seed, mHash)
const baseV2 = {
  serverSeed: seed, commitHash: commit2, clientSeed: 'drand:v2',
  prizes: mPrizes, publishedSequence: mSeq, manifest
}

check('v2：正確的 reveal 通過驗證', (await verifyReveal(baseV2)).ok)
check('v2：回報的版本是 2', (await verifyReveal(baseV2)).version === 2)
check('v1：沒帶 manifest 時回報版本 1',
  (await verifyReveal({ ...baseV2, commitHash: commit, manifest: undefined })).version === 1)

/* 這一條是整個 v2 的目的：籤序一個字都沒動，只換掉一張卡的身分 */
const swapped = manifest.map(m => m.prizeId === 'LAST' ? { ...m, name: '謎擬Ｑ SAR', refPrice: 380 } : m)
const rSwapped = await verifyReveal({ ...baseV2, manifest: swapped })
check('v2：偷換獎品的卡名與價值被抓到（籤序完全沒動）', !rSwapped.ok)

const certSwapped = manifest.map(m => m.prizeId === 'LAST' ? { ...m, certNo: '99999999' } : m)
check('v2：偷換鑑定編號被抓到',
  !(await verifyReveal({ ...baseV2, manifest: certSwapped })).ok)

const tierSwapped = manifest.map(m => m.prizeId === 'D' ? { ...m, tier: 'A' } : m)
check('v2：偷改賞別被抓到',
  !(await verifyReveal({ ...baseV2, manifest: tierSwapped })).ok)

/* 清單與籤序用的張數必須對得起來 —— 否則伺服器可以兩邊各說各話 */
const countMismatch = manifest.map(m => m.prizeId === 'A' ? { ...m, total: 3 } : m)
const rCount = await verifyReveal({ ...baseV2, manifest: countMismatch })
check('v2：清單張數跟籤序用的不一致被抓到', !rCount.ok)
check('v2：而且講得出是哪一項', (rCount.reason ?? '').includes('奇樹'))

check('v2：manifest 的排序不影響雜湊',
  (await manifestHashOf([...manifest].reverse())) === mHash)
check('v2：換過 seed 一樣被抓到',
  !(await verifyReveal({ ...baseV2, serverSeed: seed2 })).ok)

/* ---- v3：買回價也在承諾裡 ----
   買回價是整份清單裡唯一一個「賣家有義務履行的金額」（錢從他的保留額出）。
   把它綁進 commit 之後，開賣後偷偷調低它會跟偷換卡一樣被抓到。
   序列化只在尾端**追加**一欄，所以 v2 的池逐字不變 —— 下面第一條就是釘住這件事。 */
const manifest3 = manifest.map(m => ({
  ...m, buyback: m.prizeId === 'LAST' ? 26000 : m.prizeId === 'A' ? 15000 : 200
}))
const mHash3 = await manifestHashOf(manifest3, 3)
const commit3 = await commitV2(seed, mHash3)
const baseV3 = {
  serverSeed: seed, commitHash: commit3, clientSeed: 'drand:v2',
  prizes: mPrizes, publishedSequence: mSeq, manifest: manifest3,
  manifestVersion: 3 as const
}

/* 這一條是版本化的全部意義：同一份程式碼算 v2 的池，結果跟加 buyback 欄位
   之前一模一樣。不成立的話所有既有的池會集體變成「被竄改」。 */
check('v3：帶了 buyback 但用 v2 序列化時，雜湊跟沒有這個欄位時完全相同',
  (await manifestHashOf(manifest3, 2)) === mHash)
check('v3：v2 跟 v3 的雜湊不一樣（買回價真的進了承諾）', mHash3 !== mHash)

check('v3：正確的 reveal 通過驗證', (await verifyReveal(baseV3)).ok)
check('v3：回報的版本是 3', (await verifyReveal(baseV3)).version === 3)
check('v2 的舊池在 v3 上線之後仍然驗得過', (await verifyReveal(baseV2)).ok)

/* 開賣後偷改買回價 —— 籤序一個字都沒動、卡也沒換，只把承諾的金額調低 */
const cheaper = manifest3.map(m => m.prizeId === 'LAST' ? { ...m, buyback: 10 } : m)
check('v3：開賣後偷改買回價被抓到（籤序與卡片完全沒動）',
  !(await verifyReveal({ ...baseV3, manifest: cheaper })).ok)

/* 版本必須是池宣告的，不能「哪個版本算得過就算哪個」——
   否則一個作弊的伺服器可以挑對自己有利的那一版送出，驗算端替它背書。 */
check('v3：拿 v3 的清單謊報成 v2 驗不過',
  !(await verifyReveal({ ...baseV3, manifestVersion: 2 })).ok)
check('v2：拿 v2 的清單謊報成 v3 驗不過',
  !(await verifyReveal({ ...baseV2, manifestVersion: 3 })).ok)

// 分布粗檢：跑 400 個不同 seed，LAST 落在每個位置的次數應該接近均勻。
// 這不是嚴格統計檢定，只是抓「明顯偏向某一端」這種實作錯誤（例如取餘數偏差、迴圈方向寫錯）。
const small = [{ prizeId: 'LAST', total: 1 }, { prizeId: 'D', total: 9 }]
const hist = new Array(10).fill(0)
for (let i = 0; i < 400; i++) {
  const sq = await seatSequence(await (async () => {
    const b = new Uint8Array(32); b[0] = i & 255; b[1] = i >> 8; return bytesToHex(b)
  })(), 'x', small)
  hist[sq.indexOf('LAST')]++
}
const [mn, mx] = [Math.min(...hist), Math.max(...hist)]
check(`LAST 位置分布沒有明顯偏斜（每格期望 40，實際 ${mn}–${mx}）`, mn >= 20 && mx <= 65)


/* ------------------------------------------------------------------
   卡號比對（card-cert.ts）

   為什麼值得一組單元測試：這條規則決定「開池／登記鑑定卡時要不要
   攔下來問人」，而它攔錯的代價是**一條走不完的路** —— 舊版把
   "331" 與 "331/190" 判成不同的卡，於是每一張日版鑑定卡都要人手動
   確認一次。一個幾乎每次都跳的確認框等於沒有確認框。
   這一組把「該過的要過、該擋的要擋」兩邊都釘住。
------------------------------------------------------------------ */
console.log('\ncard-cert 的卡號比對：')
/* 這一條是修的那個 bug 本身：PSA 對日版卡通常只給流水號，
   我們的目錄給的是卡面印的「編號/總數」。 */
check('PSA 的裸號 331 對得上目錄的 331/190（分母是總數，不是編號的一部分）',
  cardNumbersAgree('331', '331/190'))
check('反過來也一樣（PSA 給 331/190、目錄給 331）',
  cardNumbersAgree('331/190', '331'))
check('兩邊都寫了總數而且相同 → 對得上', cardNumbersAgree('331/190', '331/190'))
check('編號不同就是不同的卡 → 擋', !cardNumbersAgree('332', '331/190'))
check('編號相同但總數不同（不同套的同號卡）→ 擋', !cardNumbersAgree('331/190', '331/191'))
check('前導零只是寫法（PSA 常寫 025）', cardNumbersAgree('025', '25/190'))
check('空白、破折號、井號都只是寫法', cardNumbersAgree(' #025 ', '25'))
check('英數混編的卡號整段比（TG 系列）', cardNumbersAgree('TG12', 'TG12/TG30'))
check('TG12 不等於 12 —— 不靠猜前綴放行', !cardNumbersAgree('TG12', '12/190'))
/* 舊版把數字全串起來，"331" vs "331190" 判成不同；順帶檢查串接不會
   讓兩張不同的卡撞在一起（19/01 與 1/901 串起來都是 1901）。 */
check('19/01 與 1/901 是不同的卡（串接比法會把它們判成同一張）',
  !cardNumbersAgree('19/01', '1/901'))
check('任一邊沒有值就不擋（沒有東西可以比）',
  cardNumbersAgree(null, '331/190') && cardNumbersAgree('331', null))
/* 一邊完全湊不出英數字（例如 PSA 回了一串符號）：沒有東西可以拆成
   「編號／總數」，退回整串比對；比不出結論就放行，不硬擋。 */
check('一邊湊不出英數字時退回整串比對', !cardNumbersAgree('--', '331') && cardNumbersAgree('--', '#'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
