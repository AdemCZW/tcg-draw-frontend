/**
 * 可驗證的公平抽選。前後端共用。
 *
 * 模型：籤序在開賣前就決定好，開賣後只是查表。
 *
 *   1 伺服器產生 server_seed，公布 commit = SHA256(server_seed)
 *   2 外部亂數（drand）在 commit 之後才出現，當 client_seed
 *   3 sequence = shuffle(prizes, HMAC-SHA256(server_seed, client_seed))
 *   4 池結束後公布 server_seed，任何人可以重算並比對
 *
 * 用 WebCrypto（crypto.subtle）不用 node:crypto —— 這樣同一份程式碼
 * 可以在瀏覽器裡跑，前端的公平性頁面能自己重算，不用信後端。
 *
 * 這裡沒有任何 I/O、沒有 Date.now()、沒有 Math.random()。
 * 給同樣的輸入永遠得到同樣的輸出，這是「可驗證」的全部意思。
 */

const subtle = globalThis.crypto.subtle
const te = new TextEncoder()
/* 不直接寫 CryptoKey / BufferSource 這些名字：它們在 DOM lib 跟 @types/node 裡
   的宣告位置不同，這個檔案要在兩邊都能編譯。從 subtle 本身推型別最穩。 */
type Key = Awaited<ReturnType<typeof subtle.importKey>>

export const bytesToHex = (b: Uint8Array) =>
  Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  if (clean.length % 2 || /[^0-9a-f]/.test(clean)) throw new Error('not hex')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? te.encode(data) : data
  return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', buf)))
}

/**
 * v1 的承諾：commit = SHA256(server_seed)。
 *
 * 只涵蓋種子，**不涵蓋獎品內容**。這代表：
 *   - 改「某個獎項有幾張」→ 籤序會變 → 驗算抓得到
 *   - 改「第 3 個獎項是哪張卡」→ 籤序不變 → **驗算照樣回 ok**
 * 也就是開賣後把噴火龍偷偷換成同賞別的廉價卡，驗算抓不到。
 * 新的池一律走 v2（見 commitV2），這支留著是為了驗證既有的池。
 */
export const commitOf = (serverSeedHex: string) => sha256Hex(hexToBytes(serverSeedHex))

/**
 * 獎品清單裡，會被寫進承諾的欄位。
 *
 * 只收「決定這個獎項是什麼」的資訊。圖片網址、庫存位置那些會變動又不影響
 * 玩家權益的東西不收 —— 收了會讓誠實的維護（換一張圖）看起來像作弊。
 */
export interface PrizeManifestEntry {
  prizeId: string
  tier: string
  total: number
  name: string
  setCode?: string | null
  cardNo?: string | null
  grader?: string | null
  grade?: number | null
  certNo?: string | null
  refPrice?: number | null
}

/**
 * 把獎品清單序列化成一個決定性的字串。
 *
 * 格式必須精確到任何人都能自己重做，否則「自己驗算」就是空話：
 *   - 依 prizeId 以 UTF-16 碼位排序（跟 seatSequence 的展開順序同一個規則）
 *   - 每個獎項一行，欄位以 `|` 分隔，順序固定為
 *     prizeId | tier | total | name | setCode | cardNo | grader | grade | certNo | refPrice
 *   - null / undefined 一律寫成空字串
 *   - 行與行之間用 `\n`，結尾不加換行
 *
 * 不用 JSON.stringify：它的鍵順序與跳脫規則跟實作綁在一起，
 * 換一個語言重做就可能算出不同的雜湊。
 */
export function manifestString(prizes: PrizeManifestEntry[]): string {
  const v = (x: string | number | null | undefined) => (x === null || x === undefined ? '' : String(x))
  return [...prizes]
    .sort((a, b) => (a.prizeId < b.prizeId ? -1 : a.prizeId > b.prizeId ? 1 : 0))
    .map(p => [
      p.prizeId, p.tier, p.total, p.name,
      v(p.setCode), v(p.cardNo), v(p.grader), v(p.grade), v(p.certNo), v(p.refPrice)
    ].map(v).join('|'))
    .join('\n')
}

/** 獎品清單的雜湊 */
export const manifestHashOf = (prizes: PrizeManifestEntry[]) => sha256Hex(manifestString(prizes))

/**
 * v2 的承諾：commit = SHA256(server_seed_bytes ‖ manifest_hash_bytes)。
 *
 * 把獎品清單一起綁進承諾。開賣後只要動到任何一個獎項的身分
 * （卡名、鑑定編號、參考價、賞別），重算出來的 commit 就對不上。
 *
 * 用位元組串接而不是字串相加：兩段都是固定長度的 32 bytes，
 * 不會有「A 的結尾被當成 B 的開頭」那種歧義。
 */
export async function commitV2(serverSeedHex: string, manifestHash: string): Promise<string> {
  const seed = hexToBytes(serverSeedHex)
  const man = hexToBytes(manifestHash)
  const buf = new Uint8Array(seed.length + man.length)
  buf.set(seed, 0)
  buf.set(man, seed.length)
  return sha256Hex(buf)
}

async function hmacKey(seed: Uint8Array) {
  return subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

/**
 * 決定性的位元組流。
 * block_i = HMAC(server_seed, client_seed || i)，i 是 32-bit big-endian counter。
 * 一次一個 block（32 bytes），需要多少要多少。
 */
class Stream {
  private buf = new Uint8Array(0)
  private pos = 0
  private counter = 0
  constructor(private key: Key, private client: Uint8Array) {}

  private async refill() {
    const msg = new Uint8Array(this.client.length + 4)
    msg.set(this.client, 0)
    new DataView(msg.buffer).setUint32(this.client.length, this.counter++, false)
    this.buf = new Uint8Array(await subtle.sign('HMAC', this.key, msg))
    this.pos = 0
  }

  async u32(): Promise<number> {
    if (this.pos + 4 > this.buf.length) await this.refill()
    const v = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(this.pos, false)
    this.pos += 4
    return v
  }

  /**
   * [0, n) 的均勻整數。用拒絕取樣，不用取餘數。
   * 取餘數在 n 不整除 2^32 時有偏差 —— 偏差很小，但「很小」在公平性驗證裡
   * 等於「有」，會被拿來質疑。拒絕取樣的期望重試次數 < 2，成本可忽略。
   */
  async below(n: number): Promise<number> {
    if (n <= 0 || n > 0xffffffff) throw new Error('bad range')
    const limit = 0x100000000 - (0x100000000 % n)
    for (;;) {
      const v = await this.u32()
      if (v < limit) return v % n
    }
  }
}

export interface PrizeCount { prizeId: string; total: number }

/**
 * 把獎品清單依數量展開，再用 seed 決定性地洗牌。
 * 回傳長度 = 總籤數的陣列，index 0 是 1 號籤。
 */
export async function seatSequence(
  serverSeedHex: string, clientSeed: string, prizes: PrizeCount[]
): Promise<string[]> {
  const seq: string[] = []
  // 展開順序固定：依 prizeId 排序，不依傳入順序 —— 呼叫端傳的順序不該影響結果
  for (const p of [...prizes].sort((a, b) => (a.prizeId < b.prizeId ? -1 : 1))) {
    if (!Number.isInteger(p.total) || p.total < 0) throw new Error(`bad total for ${p.prizeId}`)
    for (let i = 0; i < p.total; i++) seq.push(p.prizeId)
  }
  const s = new Stream(await hmacKey(hexToBytes(serverSeedHex)), te.encode(clientSeed))
  // Fisher-Yates，從尾端往前
  for (let i = seq.length - 1; i > 0; i--) {
    const j = await s.below(i + 1)
    const t = seq[i]!; seq[i] = seq[j]!; seq[j] = t
  }
  return seq
}

export interface Reveal {
  serverSeed: string
  commitHash: string
  clientSeed: string
  prizes: PrizeCount[]
  /** 伺服器公布的籤序，index 0 是 1 號籤 */
  publishedSequence: string[]
  /**
   * v2 才有：開賣前承諾的獎品清單。
   * 有帶就會被重新雜湊並綁回 commit —— 這是「獎品內容有沒有被換過」的檢查。
   * 沒帶代表這是 v1 的舊池，只驗得到籤序（見 commitOf 的說明）。
   */
  manifest?: PrizeManifestEntry[]
}

/**
 * 玩家端的驗證。
 *
 * v2（有 manifest）要四件事都成立：
 *   1. 用「種子 + 獎品清單」重算的 commit 跟開賣前公布的一樣
 *      —— 這一條同時涵蓋「種子沒被換」與**「獎品內容沒被換」**
 *   2. 籤數跟宣告的一致
 *   3. 重算的籤序跟公布的完全一樣
 *   4. 清單裡的張數跟用來排籤序的張數一致（兩邊都來自伺服器，要對得起來）
 *
 * v1（沒有 manifest）只驗得到 1（僅種子）與 2、3。舊池只能到這裡，
 * 那正是加 v2 的原因。
 */
export async function verifyReveal(r: Reveal): Promise<{ ok: boolean; reason?: string; version: 1 | 2 }> {
  const version: 1 | 2 = r.manifest ? 2 : 1
  const fail = (reason: string) => ({ ok: false, reason, version })

  if (r.manifest) {
    /* 清單裡的張數必須跟拿去排籤序的張數一致。
       不查這個的話，伺服器可以在 manifest 寫「A 賞 1 張」卻用「A 賞 0 張」排序，
       兩邊各自對得上，合起來卻是假的。 */
    const byId = new Map(r.prizes.map(p => [p.prizeId, p.total]))
    for (const m of r.manifest) {
      if (byId.get(m.prizeId) !== m.total) {
        return fail(`獎品「${m.name}」的張數對不上：清單說 ${m.total}，籤序用的是 ${byId.get(m.prizeId) ?? '（沒有這一項）'}`)
      }
    }
    if (byId.size !== r.manifest.length) {
      return fail(`獎項數量對不上：清單 ${r.manifest.length} 項，籤序用了 ${byId.size} 項`)
    }

    const expect = await commitV2(r.serverSeed, await manifestHashOf(r.manifest))
    if (expect !== r.commitHash.toLowerCase()) {
      return fail('commit 對不上：server_seed 或獎品內容被換過')
    }
  } else if ((await commitOf(r.serverSeed)) !== r.commitHash.toLowerCase()) {
    return fail('commit 對不上：server_seed 被換過')
  }
  const total = r.prizes.reduce((a, p) => a + p.total, 0)
  if (r.publishedSequence.length !== total) {
    return fail(`籤數不符：宣告 ${total}，公布 ${r.publishedSequence.length}`)
  }
  const seq = await seatSequence(r.serverSeed, r.clientSeed, r.prizes)
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] !== r.publishedSequence[i]) {
      return fail(`第 ${i + 1} 號籤不符：重算 ${seq[i]}，公布 ${r.publishedSequence[i]}`)
    }
  }
  return { ok: true, version }
}
