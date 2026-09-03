/**
 * 檔案上傳與讀取。位元組不經過這台伺服器——這裡只發「限時通行證」。
 *
 *   POST /v1/files/presign   要一個可以直接 PUT 到 R2 的網址
 *   GET  /v1/files/:id       要一個可以讀這個檔案的網址（依用途決定誰能要），回 JSON
 *   GET  /v1/files/:id/raw   同樣的權限判斷，但 302 導到那個網址 —— 給 <img src> 用
 *
 * 讀取權限：
 *   pool-cover / avatar   公開，誰都能看——池封面跟頭像本來就要能在列表頁顯示
 *   其餘全部            只有上傳者本人或平台管理員
 *
 * ship-photo / unbox-video 原本是「任何登入使用者都能讀」，理由是「物件 key 隨機、
 * 不會被列出來，先求夠擋住路人」。那個判斷是錯的：這兩種正好是最敏感的內容——
 * 出貨照會拍到面單上的收件人姓名、電話、地址，開箱影片會拍到家裡。
 * 只要註冊一個帳號、拿到 fileId 就看得到，而 fileId 會在 API 回應裡流動。
 *
 * 收緊的代價是爭議時當事人看不到對方的證據，只有裁決的管理員看得到。
 * 要讓當事人互看，得先把 file id 真的存進 orders —— 目前 ship 端點收了 photos
 * 卻沒有落地，所以那條路現在也不存在，收緊不會弄壞任何在用的東西。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from '../db.js'
import { requireAuth, optionalUserId } from '../auth.js'
import { configured, presignPut, presignGet, publicUrlOf } from '../r2.js'

export const files = new Hono()

type Purpose = 'pool-cover' | 'ship-photo' | 'unbox-video' | 'seller-doc' | 'avatar' | 'ticket-doc' | 'card-front'

const MB = 1024 * 1024
const PURPOSES: Record<Purpose, { mimes: string[]; maxBytes: number; public: boolean }> = {
  'pool-cover': { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * MB, public: true },
  'card-front': { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * MB, public: true },
  avatar: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 4 * MB, public: true },
  'ship-photo': { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 15 * MB, public: false },
  'unbox-video': { mimes: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 300 * MB, public: false },
  'seller-doc': { mimes: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 15 * MB, public: false },
  /* 工單附件。public: false —— 只有上傳者本人或管理員讀得到（下面 files.get 那段）。
     已知限制：爭議雙方互相看不到對方的附件，只有管理員看得到。那是既有行為
     （見檔頭 ship-photo / unbox-video 那一段的說明），不在這次範圍。

     ⚠️ files.purpose 在 002_core.sql 有 CHECK 白名單，而 024 沒有放寬它。
     放寬那條約束的補丁在 src/tickets.ts 的 ticketDocPurposePatch()（開機時跑一次）——
     那本來應該是一支遷移，見那裡的說明。 */
  'ticket-doc': { mimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 15 * MB, public: false }
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'application/pdf': 'pdf'
}

const notReady = (c: import('hono').Context) =>
  c.json({ error: 'NOT_CONFIGURED', message: '檔案上傳尚未設定' }, 503)

const PresignBody = z.object({
  purpose: z.enum(['pool-cover', 'ship-photo', 'unbox-video', 'seller-doc', 'avatar', 'ticket-doc', 'card-front']),
  mime: z.string().min(1),
  bytes: z.number().int().positive()
})

files.post('/presign', requireAuth, async c => {
  const me = c.get('userId')
  /* 先驗請求，再看服務有沒有設定。
     順序原本是相反的，於是 R2 沒設定的環境（本機、剛部署還沒填金鑰）
     會把「mime 不在白名單」「檔案太大」這種請求端的錯誤一律回成 503 ——
     呼叫端被告知「服務尚未就緒」，實際上是他自己送錯了。
     請求格式不對就是不對，跟服務有沒有設定無關。 */
  const parsed = PresignBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'BAD_REQUEST', message: '參數不合法' }, 400)
  const { purpose, mime, bytes } = parsed.data

  const rule = PURPOSES[purpose]
  if (!rule.mimes.includes(mime)) {
    return c.json({ error: 'BAD_MIME', message: `這個用途只接受：${rule.mimes.join('、')}` }, 400)
  }
  if (bytes > rule.maxBytes) {
    return c.json({ error: 'TOO_LARGE', message: `檔案太大，上限 ${Math.floor(rule.maxBytes / MB)}MB` }, 400)
  }

  // 請求本身沒問題，這才輪到「後端有沒有能力處理」
  if (!configured()) return notReady(c)

  const id = 'f-' + randomBytes(6).toString('hex')
  const ext = EXT[mime] ?? 'bin'
  // key 帶 owner 跟隨機值——不可猜測是私密用途唯一的一層防護，見檔頭說明
  const key = `${purpose}/${me}/${randomBytes(10).toString('hex')}.${ext}`

  await sql`insert into files (id, owner_id, purpose, key, mime, bytes)
            values (${id}, ${me}, ${purpose}, ${key}, ${mime}, ${bytes})`

  /* bytes 一併簽進通行證（ContentLength）：上面那道 maxBytes 只擋得住
     「宣告」的大小，實際傳多少 R2 才是最終權威。宣告與實傳對不上時
     簽章驗不過，R2 直接拒收 —— 上限這才在儲存層有強制力。 */
  const uploadUrl = await presignPut(key, mime, bytes)
  return c.json({ fileId: id, uploadUrl, key })
})

/**
 * 解析一個 file id 成「可以讀的網址」，或是一個該回給呼叫端的錯誤。
 *
 * 抽出來的理由：/:id（回 JSON）與 /:id/raw（302 導轉）是同一段權限判斷，
 * 抄兩份的話總有一天只有其中一份被收緊 —— 而被漏掉的那一份就是洞。
 */
async function resolveFile(c: import('hono').Context): Promise<
  { ok: true; url: string; public: boolean } | { ok: false; res: Response }
> {
  if (!configured()) return { ok: false, res: notReady(c) }
  const [f] = await sql`select * from files where id = ${c.req.param('id') ?? ''}`
  if (!f) return { ok: false, res: c.json({ error: 'NOT_FOUND', message: '找不到這個檔案' }, 404) }

  const purpose = f.purpose as Purpose
  if (!PURPOSES[purpose].public) {
    const me = await optionalUserId(c)
    if (!me) return { ok: false, res: c.json({ error: 'UNAUTHORIZED', message: '請先登入' }, 401) }
    /* 私有用途一律「本人或管理員」。
       原本只有 seller-doc 這樣擋，ship-photo / unbox-video 是任何登入使用者都能讀 ——
       但那兩種正是最敏感的：出貨照會拍到面單（收件人姓名、電話、地址），
       開箱影片會拍到家裡。只要註冊一個帳號、猜到或撞到 file id 就看得到，
       這個洞比「爭議時對方看不到證據」嚴重得多。

       代價是爭議時當事人看不到對方的證據，只有裁決的管理員看得到。
       要讓當事人互看，得先把 file id 真的存進 orders（現在根本沒存，
       ship 端點收了 photos 卻沒有落地），那是另一件事。 */
    const [u] = await sql`select role from users where id = ${me}`
    if (me !== f.owner_id && u?.role !== 'admin') {
      return { ok: false, res: c.json({ error: 'NOT_PARTY', message: '沒有權限查看這個檔案' }, 403) }
    }
  }

  const pub = PURPOSES[purpose].public ? publicUrlOf(f.key as string) : null
  const url = pub ?? (await presignGet(f.key as string))
  return { ok: true, url, public: !!pub }
}

files.get('/:id', async c => {
  const r = await resolveFile(c)
  if (!r.ok) return r.res
  return c.json({ url: r.url, public: r.public })
})

/**
 * GET /v1/files/:id/raw —— 給 `<img src>` 直接指的網址。
 *
 * 為什麼要有這一條：/:id 回的是 **JSON**（`{url, public}`），content-type 是
 * application/json。把它塞進 `<img src>` 得到的一定是破圖 —— 而卡冊、市場、
 * 開池那三個地方存進資料庫的 image 就是 `/v1/files/f-xxx` 這個字串，
 * 前端 CardArt 只是加上 API_URL 就當圖片用。也就是說在這條路存在之前，
 * **每一張使用者上傳的卡面都是破圖**，沒有例外。
 *
 * 為什麼是 302 而不是把位元組讀出來轉發：整個 r2.ts 的前提就是「位元組不經過
 * 這台伺服器」。轉發等於把每一張卡圖的頻寬與記憶體都搬回 Node 行程裡，
 * 而且會失去 R2／CDN 的快取。302 到公開網址或簽名網址兩者都成立。
 *
 * Cache-Control 只給 60 秒：私密用途拿到的是 1 小時的簽名網址，
 * 導轉本身被快取太久會讓使用者在權限被撤銷後還導得過去。
 */
files.get('/:id/raw', async c => {
  const r = await resolveFile(c)
  if (!r.ok) return r.res
  c.header('cache-control', 'private, max-age=60')
  return c.redirect(r.url, 302)
})
