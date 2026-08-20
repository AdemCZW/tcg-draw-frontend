/**
 * 檔案上傳與讀取。位元組不經過這台伺服器——這裡只發「限時通行證」。
 *
 *   POST /v1/files/presign   要一個可以直接 PUT 到 R2 的網址
 *   GET  /v1/files/:id       要一個可以讀這個檔案的網址（依用途決定誰能要）
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

type Purpose = 'pool-cover' | 'ship-photo' | 'unbox-video' | 'seller-doc' | 'avatar'

const MB = 1024 * 1024
const PURPOSES: Record<Purpose, { mimes: string[]; maxBytes: number; public: boolean }> = {
  'pool-cover': { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * MB, public: true },
  avatar: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 4 * MB, public: true },
  'ship-photo': { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 15 * MB, public: false },
  'unbox-video': { mimes: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 300 * MB, public: false },
  'seller-doc': { mimes: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 15 * MB, public: false }
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'application/pdf': 'pdf'
}

const notReady = (c: import('hono').Context) =>
  c.json({ error: 'NOT_CONFIGURED', message: '檔案上傳尚未設定' }, 503)

const PresignBody = z.object({
  purpose: z.enum(['pool-cover', 'ship-photo', 'unbox-video', 'seller-doc', 'avatar']),
  mime: z.string().min(1),
  bytes: z.number().int().positive()
})

files.post('/presign', requireAuth, async c => {
  if (!configured()) return notReady(c)
  const me = c.get('userId')
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

  const id = 'f-' + randomBytes(6).toString('hex')
  const ext = EXT[mime] ?? 'bin'
  // key 帶 owner 跟隨機值——不可猜測是私密用途唯一的一層防護，見檔頭說明
  const key = `${purpose}/${me}/${randomBytes(10).toString('hex')}.${ext}`

  await sql`insert into files (id, owner_id, purpose, key, mime, bytes)
            values (${id}, ${me}, ${purpose}, ${key}, ${mime}, ${bytes})`

  const uploadUrl = await presignPut(key, mime)
  return c.json({ fileId: id, uploadUrl, key })
})

files.get('/:id', async c => {
  if (!configured()) return notReady(c)
  const [f] = await sql`select * from files where id = ${c.req.param('id') ?? ''}`
  if (!f) return c.json({ error: 'NOT_FOUND', message: '找不到這個檔案' }, 404)

  const purpose = f.purpose as Purpose
  if (!PURPOSES[purpose].public) {
    const me = await optionalUserId(c)
    if (!me) return c.json({ error: 'UNAUTHORIZED', message: '請先登入' }, 401)
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
      return c.json({ error: 'NOT_PARTY', message: '沒有權限查看這個檔案' }, 403)
    }
  }

  const pub = PURPOSES[purpose].public ? publicUrlOf(f.key as string) : null
  const url = pub ?? (await presignGet(f.key as string))
  return c.json({ url, public: !!pub })
})
