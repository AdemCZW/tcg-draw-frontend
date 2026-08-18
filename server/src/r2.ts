/**
 * Cloudflare R2（S3 相容 API）的薄封裝。
 *
 * 檔案的位元組不經過這台伺服器：這裡只做兩件事——
 *   1 簽一張「限時可以 PUT 到這個 key」的通行證，給瀏覽器直接上傳
 *   2 簽一張「限時可以 GET 這個 key」的通行證，給需要私密讀取的檔案用
 *
 * R2 帳號沒設齊時（本機開發常見）不要讓整個伺服器掛掉——configured() 回 false，
 * 呼叫端負責回 503，其他不相關的功能照常跑。
 */
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from './env.js'

export const configured = () =>
  !!(env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY)

let client: S3Client | null = null
function s3() {
  if (!configured()) throw new Error('R2 未設定')
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! }
    })
  }
  return client
}

const PUT_EXPIRES_S = 10 * 60      // 上傳連結：10 分鐘內要傳完
const GET_EXPIRES_S = 60 * 60      // 私密讀取連結：1 小時內有效，過期前端要再要一次

export async function presignPut(key: string, mime: string): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: env.R2_BUCKET!, Key: key, ContentType: mime })
  return getSignedUrl(s3(), cmd, { expiresIn: PUT_EXPIRES_S })
}

export async function presignGet(key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET!, Key: key })
  return getSignedUrl(s3(), cmd, { expiresIn: GET_EXPIRES_S })
}

/** 有沒有公開讀取網址（bucket 開了 r2.dev 或自訂網域）。沒設就走簽名網址，安全的預設值 */
export const publicUrlOf = (key: string): string | null =>
  env.R2_PUBLIC_URL ? `${env.R2_PUBLIC_URL}/${key}` : null

/** 確認物件真的傳上去了（有些用途要在寫進資料庫前驗證，例如賣家審核文件） */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: env.R2_BUCKET!, Key: key }))
    return true
  } catch {
    return false
  }
}
