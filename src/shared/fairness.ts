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

/** commit = SHA256(server_seed)。server_seed 是 hex 字串 */
export const commitOf = (serverSeedHex: string) => sha256Hex(hexToBytes(serverSeedHex))

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
}

/**
 * 玩家端的驗證。三件事都要成立：
 *   commit 對得上、重算的籤序跟公布的一樣、獎品數量跟宣告的一致
 */
export async function verifyReveal(r: Reveal): Promise<{ ok: boolean; reason?: string }> {
  if ((await commitOf(r.serverSeed)) !== r.commitHash.toLowerCase()) {
    return { ok: false, reason: 'commit 對不上：server_seed 被換過' }
  }
  const total = r.prizes.reduce((a, p) => a + p.total, 0)
  if (r.publishedSequence.length !== total) {
    return { ok: false, reason: `籤數不符：宣告 ${total}，公布 ${r.publishedSequence.length}` }
  }
  const seq = await seatSequence(r.serverSeed, r.clientSeed, r.prizes)
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] !== r.publishedSequence[i]) {
      return { ok: false, reason: `第 ${i + 1} 號籤不符：重算 ${seq[i]}，公布 ${r.publishedSequence[i]}` }
    }
  }
  return { ok: true }
}
