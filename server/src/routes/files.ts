/**
 * 檔案上傳與讀取。位元組不經過這台伺服器——這裡只發「限時通行證」。
 *
 *   POST /v1/files/presign   要一個可以直接 PUT 到 R2 的網址
 *   GET  /v1/files/:id       要一個可以讀這個檔案的網址（依用途決定誰能要）
 *
 * 讀取權限的現況（老實列出來，不是全部都做到位）：
 *   pool-cover / avatar   公開，誰都能看——池封面跟頭像本來就要能在列表頁顯示
 *   ship-photo / unbox-video
 *                         要登入才能要連結。物件的 key 是隨機的、不會被列出來，
 *                         但目前沒有把檔案跟訂單綁在一起做「只有買賣雙方能看」，
 *                         任何登入使用者只要知道 fileId 就能要到讀取連結。
 *                         這是刻意先求「能用、夠擋住路人」，不是完整的存取控制——
 *                         真的要做到「只有這筆訂單的買賣雙方看得到」，
 *                         需要在 files 表加 order_id 或建關聯表，是之後的加強項目。
 *   seller-doc            身分文件，風險比照片高很多：只有上傳者本人或平台管理員能看。
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
    if (purpose === 'seller-doc') {
      const [u] = await sql`select role from users where id = ${me}`
      if (me !== f.owner_id && u?.role !== 'admin') {
        return c.json({ error: 'NOT_PARTY', message: '沒有權限查看這份文件' }, 403)
      }
    }
    // ship-photo / unbox-video：任何登入使用者可讀，見檔頭說明的已知限制
  }

  const pub = PURPOSES[purpose].public ? publicUrlOf(f.key as string) : null
  const url = pub ?? (await presignGet(f.key as string))
  return c.json({ url, public: !!pub })
})
