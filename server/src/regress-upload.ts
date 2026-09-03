/**
 * 卡片上傳入庫的迴歸測試（routes/cardbook.ts + migration 027）。
 *
 * 驗的是卡冊優先的最後一塊：賣家把手上的實體卡登記進卡冊，
 * 而且**登記進來的卡走得完整條路** —— 進池（重用同一列、賞別被寫上）、
 * 被抽走、過戶給買家；或直接上架市場（需寄送）。
 * 半條路的入口比沒有入口更糟：卡進得來出不去，就是 audit-3 A-3 那種死路。
 *
 *   npx tsx src/regress-upload.ts http://localhost:8060
 *
 * 伺服器要 DEV_LOGIN=1 與 DEV_LOGIN_SECRET。
 *
 * ⚠️ **要有自己的乾淨資料庫，不能跟 smoke 共用一個。**
 * 理由同 regress-pledge：兩邊都會消耗種子資料而且互相干擾
 * （smoke 會把 u-seller 的違約累積到停權門檻；這支會開池、抽卡，
 * 改掉 smoke 預期的種子狀態）。各自 migrate + seed 一個新庫再跑。
 *
 * ⚠️ 每一支迴歸都要**各自一個乾淨庫**，不只是躲開 smoke ——
 * 這支會消耗 u-seller 的種子池、登記 STUB 編號、抽卡改籤位，
 * regress-pledge 接在後面跑會倒在「池已沒籤」「編號已佔用」這類
 * 污染上（實測 6 條假失敗）。反過來也一樣。
 */
const base = (process.argv[2] ?? 'http://localhost:8060').replace(/\/$/, '')
const devSecret = process.env.DEV_LOGIN_SECRET
const devHeaders = () => {
  if (!devSecret) throw new Error('regress-upload 需要 DEV_LOGIN_SECRET，請與開發伺服器設定相同的值')
  return { 'x-dev-login-secret': devSecret }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const json = (r: Response): Promise<Any> => r.json()
let pass = 0, fail = 0, skipped = 0
const ck = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(` FAIL ${n}${d ? ' — ' + d : ''}`) }
}
/* 沒有 R2 就驗不了的那幾條**明說跳過**，不要為了讓輸出變綠而放寬斷言 ——
   一條被悄悄放寬的斷言，比一條寫著「這件事今天沒驗到」的紀錄危險得多。 */
const skip = (n: string, why: string) => { skipped++; console.log(`  SKIP ${n} — ${why}`) }
const head = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 52 - s.length))}`)

async function login(handle: string, name: string) {
  const r = await fetch(`${base}/v1/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...devHeaders() },
    body: JSON.stringify({ handle, name })
  })
  if (!r.ok) throw new Error(`login ${handle}: ${r.status}`)
  return (await json(r)).token as string
}
const call = (t: string, p: string, b?: unknown) =>
  fetch(`${base}${p}`, {
    method: b === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    ...(b === undefined ? {} : { body: JSON.stringify(b) })
  })

const platform = await login('platform', 'VaultDraw 官方')
/* 用已經完成過池的種子賣家，避開「第一個池額度上限」那道閘（同 regress-pledge）。 */
const seller = await login('seller', '測試賣家')
await call(platform, '/v1/admin/grant', { userId: 'u-seller', points: 5_000_000, note: 'upload 測試' })

/* 帶時間戳讓這支可以重複跑：編號一旦登記過就永遠佔著（那正是防線本身），
   固定編號第二次跑就會被自己上一輪擋住。
   stub 的卡號取 split('-')[2]，所以 'STUB-OK-777-<ts>' 回的 CardNumber 是 '777' ——
   卡號填 '777' 只是要一個穩定的值 —— 平台已經不查證編號真偽，
   所以沒有「對得上／對不上」這回事了。 */
const RUN = String(Date.now()).slice(-8)
const upCard = (certNo: string | null, cardNo = '777') => ({
  name: '噴火龍 ex SAR', setCode: 'sv4a', cardNo,
  artId: 'SV4a-777', language: 'JP',
  grader: certNo ? 'PSA' : null, grade: certNo ? 10 : null,
  certNo, refPrice: 26000
})

/* 建池用的卡：重用押記那條路要靠 grader+cert_no 對上同一列。 */
const certCard = (certNo: string) => ({
  id: 'c-SV4a-349', name: '噴火龍 ex SAR', artId: 'SV4a-349', cardNo: '349/190',
  setCode: 'sv4a', language: 'JP', grader: 'PSA', grade: 10, certNo, refPrice: 26000
})
const plainCard = {
  id: 'c-SV8a-237', name: '太樂巴戈斯 ex UR', artId: 'SV8a-237', cardNo: '237/187',
  setCode: 'sv8a', language: 'JP', grader: 'RAW', grade: null, certNo: null, refPrice: 900
}
const makePool = (title: string, certNo: string) => call(seller, '/v1/pools', {
  mode: 'muteki', title, ticketPrice: 2000, totalTickets: 4, days: 7,
  prizes: [
    { tier: 'A', card: certCard(certNo), total: 1 },
    { tier: 'D', card: plainCard, total: 3 }
  ],
  tierBuyback: { A: 3000, D: 200 }
})

const bookOf = async (t: string) => (await json(await call(t, '/v1/prizes?limit=100'))).items ?? []

head('上傳含編號的卡 → in_book、tier null、custodian 是自己')
const CERT = `STUB-OK-777-${RUN}`
{
  const r = await call(seller, '/v1/cardbook/upload', { card: upCard(CERT) })
  const b = await json(r.clone())
  ck('上傳成功', r.ok, `${r.status} ${JSON.stringify(b).slice(0, 200)}`)
  ck('回應帶新列的 id', typeof b.prize?.id === 'string' && b.prize.id.length > 0, JSON.stringify(b.prize).slice(0, 120))

  const mine = (await bookOf(seller)).find((x: Any) => x.card?.certNo === CERT)
  ck('卡冊裡出現那張卡', !!mine, `找不到 certNo=${CERT}`)
  ck('狀態是 in_book', mine?.status === 'in_book', `status=${mine?.status}`)
  ck('tier 是 null（還沒進過池，賞別還沒發生）', mine?.tier === null, `tier=${JSON.stringify(mine?.tier)}`)
  ck('custodian 是自己（卡在我手上）', mine?.custodian_id === 'u-seller', `custodian_id=${mine?.custodian_id}`)
  ck('origin 是 upload', mine?.origin === 'upload', `origin=${mine?.origin}`)

  /* 開池挑選器打的就是這一支（?status=in_book）。
     STATUSES 少了 in_book 的時候這裡會回 400，而畫面上的症狀是
     「卡冊說持有 1 張、開池挑選器說 0 張」—— 使用者沒有任何辦法
     從畫面上和好那兩個數字。所以這條要照挑選器的參數原樣打一次。 */
  const filtered = await call(seller, '/v1/prizes?status=in_book&limit=100')
  const fj = await json(filtered.clone())
  ck('?status=in_book 查得動（不是 400）', filtered.ok, `${filtered.status} ${JSON.stringify(fj).slice(0, 160)}`)
  ck('而且查得到剛上傳的那張', (fj.items ?? []).some((x: Any) => x.card?.certNo === CERT),
    `${(fj.items ?? []).length} 筆`)
  ck('回來的每一張都真的是 in_book',
    (fj.items ?? []).every((x: Any) => x.status === 'in_book'),
    JSON.stringify((fj.items ?? []).map((x: Any) => x.status)))

  const sum = await call(seller, '/v1/prizes/summary')
  const sj = await json(sum.clone())
  ck('summary 沒被 tier null 弄炸', sum.ok, `${sum.status}`)
  ck('賞別分佈不含 null 的格子', !(sj.tierMix ?? []).some((t: Any) => t.tier == null),
    JSON.stringify(sj.tierMix))
  /* counts 的鍵是從 STATUSES 初始化的。少了 in_book 這一格永遠不會出現，
     卡冊那排分頁上「在卡冊」就永遠不存在 —— 跟上面那條是同一個根因。 */
  ck('summary 的 counts 有 in_book 這一格，而且算得到剛上傳的那張',
    Number(sj.counts?.in_book ?? 0) >= 1, JSON.stringify(sj.counts))
}

head('同編號再傳 → 409，「自己的」與「別人的」訊息要分開')
{
  const r = await call(seller, '/v1/cardbook/upload', { card: upCard(CERT) })
  const b = await json(r.clone())
  ck('自己再傳被擋', r.status === 409, `${r.status}`)
  ck('講清楚已經在自己卡冊裡', b.error === 'ALREADY_IN_BOOK' && String(b.message).includes('你的卡冊'),
    JSON.stringify(b).slice(0, 200))

  const other = await login('uploader2', '第二個人')
  const r2 = await call(other, '/v1/cardbook/upload', { card: upCard(CERT) })
  const b2 = await json(r2.clone())
  ck('別人再傳也被擋', r2.status === 409, `${r2.status}`)
  ck('引導他去申請接管', b2.error === 'CERT_ALREADY_LISTED' && String(b2.message).includes('接管'),
    JSON.stringify(b2).slice(0, 200))
}

head('裸卡照收（登記進自己的卡冊沒有欺騙任何人）')
{
  const r = await call(seller, '/v1/cardbook/upload', { card: upCard(null) })
  const b = await json(r.clone())
  ck('裸卡上傳成功', r.ok, `${r.status} ${JSON.stringify(b).slice(0, 160)}`)
  ck('狀態是 in_book', b.prize?.status === 'in_book', `status=${b.prize?.status}`)
}

/* 「假編號 → 400 CERT_NOT_FOUND」這一段已刪除。
   平台不再查證編號真偽，捏造的編號（例如 `00000001`）現在會被收下、回 200。
   這是移除查證要付的代價，條款頁與隱私頁已照實寫進去（TermsPage.vue / PrivacyPage.vue）。
   擋住重複的仍然是下面那一段的唯一性約束，跟真偽無關。 */

/* 「卡號比對」整段已刪除（原本 8 條）：PSA 回的 CardNumber 與賣家挑的卡號
   對不對得上、CERT_MISMATCH 的 409 要帶出哪些欄位、確認後放行並標 verified ——
   這些全部建立在「有一個外部來源說得出這張卡是什麼」之上，那個來源已經沒了。
   card-cert.ts 的 cardNumbersAgree 因此在正式路徑上不再有呼叫者，
   目前只剩 selftest.ts 還在驗它。 */

head('整條路：上傳 → 開池重用同一列（tier 被寫上）→ 抽走 → 過戶')
{
  const CERT2 = `STUB-OK-349-${RUN}`
  const up = await call(seller, '/v1/cardbook/upload', { card: upCard(CERT2, '349') })
  const upB = await json(up.clone())
  ck('上傳成功', up.ok, `${up.status} ${JSON.stringify(upB).slice(0, 160)}`)
  const uploadedId = upB.prize?.id as string

  const pr = await makePool('upload 測試池（重用上傳的卡）', CERT2)
  const pb = await json(pr.clone())
  ck('用同編號開池成功（上傳的卡不擋自己）', pr.ok, `${pr.status} ${JSON.stringify(pb).slice(0, 200)}`)
  const poolId = pb.poolId as string

  const pledged = (await bookOf(seller)).find((x: Any) => x.card?.certNo === CERT2)
  ck('是同一列（重用，不是開新列）', pledged?.id === uploadedId, `${uploadedId} vs ${pledged?.id}`)
  ck('狀態進 in_pool', pledged?.status === 'in_pool', `status=${pledged?.status}`)
  ck('tier 被池寫上（A）', pledged?.tier === 'A', `tier=${JSON.stringify(pledged?.tier)}`)

  const buyer = await login('upbuyer', '上傳測試買家')
  await call(platform, '/v1/admin/grant', { userId: 'u-upbuyer', points: 100_000, note: 'upload 測試' })
  /* 建池只到 committed —— 開賣要等 drand 的未來輪次（FUTURE_ROUNDS=4，
     約兩分鐘後），測試裡自己推（同 regress-pledge，但上限放到五分鐘：
     40 秒等不到那個 round 是常態，不是故障）。 */
  for (let i = 0; i < 150; i++) {
    const o = await json(await call(buyer, `/v1/pools/${poolId}/open`, {}))
    if (o.opened) break
    await new Promise(r => setTimeout(r, 2000))
  }
  const { pool } = await json(await call(buyer, `/v1/pools/${poolId}`))
  ck('池已開賣', pool?.status === 'open', `status=${pool?.status}`)
  const seats: number[] = []
  const takenSet = new Set<number>(pool?.takenSeats ?? [])
  for (let i = 1; i <= (pool?.totalTickets ?? 0); i++) if (!takenSet.has(i)) seats.push(i)
  const dr = await call(buyer, `/v1/pools/${poolId}/draw`, { seats, idempotencyKey: 'up-' + Date.now() })
  ck('抽完整池', dr.ok, `${dr.status} ${(await dr.clone().text()).slice(0, 200)}`)

  const got = (await bookOf(buyer)).filter((x: Any) => x.card?.certNo === CERT2)
  ck('買家卡冊裡有那張卡（一列，不是兩列）', got.length === 1, `找到 ${got.length} 列`)
  ck('過戶的還是上傳那一列（id 沒變）', got[0]?.id === uploadedId, `${uploadedId} vs ${got[0]?.id}`)
  ck('狀態是保管中', got[0]?.status === 'stashed', `status=${got[0]?.status}`)
  const left = (await bookOf(seller)).filter((x: Any) => x.card?.certNo === CERT2)
  ck('賣家卡冊不再有那張卡', left.length === 0, `還剩 ${left.length} 列`)
}

head('整條路：上傳 → 直接上架市場（in_book 走需寄送）')
{
  const CERT3 = `STUB-OK-555-${RUN}`
  const up = await call(seller, '/v1/cardbook/upload', { card: upCard(CERT3, '555') })
  const upB = await json(up.clone())
  ck('上傳成功', up.ok, `${up.status} ${JSON.stringify(upB).slice(0, 160)}`)

  const lr = await call(seller, '/v1/listings', { prizeId: upB.prize.id, price: 500 })
  const lb = await json(lr.clone())
  ck('上傳的卡上架成功', lr.ok, `${lr.status} ${JSON.stringify(lb).slice(0, 160)}`)
  ck('交付方式是需寄送（實體在自己手上）', lb.listing?.delivery === 'ship', `delivery=${lb.listing?.delivery}`)

  const listed = (await bookOf(seller)).find((x: Any) => x.card?.certNo === CERT3)
  ck('卡冊那一列進 listed', listed?.status === 'listed', `status=${listed?.status}`)
}

head('目錄外的卡沒有正面照 → 後端擋（I-1；這一段不需要 R2）')
{
  /* 前端 canSubmit 早就擋了，但規則要在後端才算數：直接打 API 的
     呼叫端不會經過那顆按鈕。改掉之前這三種請求全部回 200。 */
  const noArt = { name: `無圖幽靈卡 ${RUN}`, setCode: 'sv0z', cardNo: `G${RUN}`, refPrice: 1234 }

  const r1 = await call(seller, '/v1/cardbook/upload', { card: { ...noArt, artId: null, frontFileId: null } })
  const b1 = await json(r1.clone())
  ck('artId 與 frontFileId 都給 null → 400', r1.status === 400, `${r1.status} ${JSON.stringify(b1).slice(0, 200)}`)
  ck('代號是 CARD_IMAGE_REQUIRED', b1.error === 'CARD_IMAGE_REQUIRED', JSON.stringify(b1).slice(0, 200))
  ck('訊息說得出使用者該做什麼（上傳正面照）', String(b1.message ?? '').includes('正面'), String(b1.message))

  const r2 = await call(seller, '/v1/cardbook/upload', { card: noArt })
  ck('兩個鍵都不送也一樣被擋', (await json(r2.clone())).error === 'CARD_IMAGE_REQUIRED', `${r2.status}`)

  const r3 = await call(seller, '/v1/cardbook/upload', { card: { ...noArt, artId: '   ' } })
  ck('artId 只有空白也算沒有', (await json(r3.clone())).error === 'CARD_IMAGE_REQUIRED', `${r3.status}`)

  /* 反向那半條同樣重要：目錄卡本來就沒有正面照，不能被這道規則掃到。 */
  const ok = await call(seller, '/v1/cardbook/upload', {
    card: { name: '目錄卡（有 artId）', setCode: 'sv4a', cardNo: `C${RUN}`, artId: 'SV4a-349', refPrice: 26000 }
  })
  ck('有 artId 的目錄卡不受影響，照樣收', ok.ok, `${ok.status} ${(await ok.clone().text()).slice(0, 160)}`)
}

head('正面照流程（I-2 / I-3；沒設 R2 的環境會逐條標 SKIP）')
{
  // 1×1 PNG，位元組寫死 —— 這支測試不該依賴任何外部檔案
  const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    + '0000000a49444154789c6360000002000100ffff03000006000557bfabd4000000'
    + '0049454e44ae426082', 'hex')

  const presign = (t: string, purpose: string) => call(t, '/v1/files/presign', {
    purpose, mime: 'image/png', bytes: PNG.length
  })
  const manualCard = (tag: string, frontFileId: string | null) => ({
    name: `手填卡 ${tag} ${RUN}`, setCode: 'sv0z', cardNo: `${tag}${RUN}`, artId: null, frontFileId
  })

  const p0 = await presign(seller, 'card-front')
  const b0 = await json(p0.clone())

  if (p0.status === 503 && b0.error === 'NOT_CONFIGURED') {
    /* R2 沒設定（本機常見）。跟 presign 有關的四條全部驗不到 ——
       逐條列出來，讓「今天沒驗到什麼」是一筆紀錄而不是一片空白。
       要跑完整版：設好 R2_* 四項，或把 R2_ENDPOINT 指到本機的
       S3 相容伺服器（見 r2.ts 那個開關的說明）。 */
    const why = 'R2 未設定（R2_ACCOUNT_ID / R2_BUCKET / 金鑰四項），presign 回 503'
    skip('card-front presign 拿得到通行證', why)
    skip('本人圖片真的傳上去後可以入庫', why)
    skip('他人／錯誤用途的 file ID 回 BAD_CARD_IMAGE', why)
    skip('/v1/files/:id/raw 取得實際圖片', why)
    skip('presign 後沒 PUT（物件不存在）回 BAD_CARD_IMAGE', why)
  } else {
    ck('card-front presign 拿得到通行證', p0.ok && typeof b0.fileId === 'string' && typeof b0.uploadUrl === 'string',
      `${p0.status} ${JSON.stringify(b0).slice(0, 200)}`)
    /* 8MB 上限在儲存層的強制力就靠這個：content-length 有被簽進去，
       宣告 bytes: 1 再 PUT 一個大檔，簽章對不上，R2 直接拒收。 */
    ck('通行證把 content-length 簽進去了（宣告大小才有強制力）',
      (new URL(String(b0.uploadUrl)).searchParams.get('X-Amz-SignedHeaders') ?? '').includes('content-length'),
      String(new URL(String(b0.uploadUrl)).searchParams.get('X-Amz-SignedHeaders')))

    /* A：拿到通行證但**沒有** PUT —— 正是「取得 URL 後取消／逾時」那個情境。
       這裡要的是 400 BAD_CARD_IMAGE；回 503 就代表 R2 問不到，
       那是另一種情況（見下面），兩種混在一起等於沒修。 */
    const ra = await call(seller, '/v1/cardbook/upload', { card: manualCard('A', b0.fileId) })
    const ba = await json(ra.clone())
    if (ra.status === 503) {
      skip('presign 後沒 PUT（物件不存在）回 BAD_CARD_IMAGE',
        'R2 這一刻問不到（回 IMAGE_CHECK_UNAVAILABLE），分不出物件在不在')
    } else {
      ck('presign 後沒 PUT（物件不存在）回 BAD_CARD_IMAGE',
        ra.status === 400 && ba.error === 'BAD_CARD_IMAGE', `${ra.status} ${JSON.stringify(ba).slice(0, 200)}`)
      ck('而且說得出該做什麼（重新上傳）', String(ba.message ?? '').includes('重新'), String(ba.message))
    }

    // B：真的把位元組 PUT 上去 → 入庫成功
    const pb = await json(await presign(seller, 'card-front'))
    const put = await fetch(String(pb.uploadUrl), {
      method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) }, body: PNG
    })
    if (!put.ok) {
      const why = `PUT 到 R2 失敗（${put.status}）`
      skip('本人圖片真的傳上去後可以入庫', why)
      skip('/v1/files/:id/raw 取得實際圖片', why)
    } else {
      const rb = await call(seller, '/v1/cardbook/upload', { card: manualCard('B', pb.fileId) })
      const bb = await json(rb.clone())
      ck('本人圖片真的傳上去後可以入庫', rb.ok, `${rb.status} ${JSON.stringify(bb).slice(0, 200)}`)
      ck('卡的 image 指到那個檔案', bb.prize?.card?.image === `/v1/files/${pb.fileId}`,
        `image=${bb.prize?.card?.image}`)

      /* 卡冊、市場、開池存進資料庫的就是這個字串，<img src> 直接指它。
         這一條驗的是「使用者最後看不看得到圖」，不是「資料列在不在」。 */
      const raw = await fetch(`${base}/v1/files/${pb.fileId}/raw`, { redirect: 'follow' })
      const got = Buffer.from(await raw.arrayBuffer())
      ck('/v1/files/:id/raw 取得實際圖片（位元組一致）',
        raw.ok && got.equals(PNG), `${raw.status} ${got.length}B vs ${PNG.length}B`)
    }

    // C：別人的 file id
    const other = await login('uploader3', '第三個人')
    const pc = await json(await presign(other, 'card-front'))
    await fetch(String(pc.uploadUrl), { method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) }, body: PNG })
    const rc = await call(seller, '/v1/cardbook/upload', { card: manualCard('C', pc.fileId) })
    const bc = await json(rc.clone())
    ck('別人上傳的 file ID 回 BAD_CARD_IMAGE', rc.status === 400 && bc.error === 'BAD_CARD_IMAGE',
      `${rc.status} ${JSON.stringify(bc).slice(0, 200)}`)

    // D：用途不是 card-front（拿頭像的 file id 來當卡面）
    const pd = await json(await presign(seller, 'avatar'))
    await fetch(String(pd.uploadUrl), { method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) }, body: PNG })
    const rd = await call(seller, '/v1/cardbook/upload', { card: manualCard('D', pd.fileId) })
    const bd = await json(rd.clone())
    ck('錯誤用途的 file ID 回 BAD_CARD_IMAGE', rd.status === 400 && bd.error === 'BAD_CARD_IMAGE',
      `${rd.status} ${JSON.stringify(bd).slice(0, 200)}`)

    // E：不存在的 file id
    const re = await call(seller, '/v1/cardbook/upload', { card: manualCard('E', 'f-000000000000') })
    ck('查無此 file ID 也回 BAD_CARD_IMAGE', (await json(re.clone())).error === 'BAD_CARD_IMAGE', `${re.status}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(fail ? 1 : 0)

export {}
