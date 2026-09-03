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

/* S3 端點。正式走 R2 的帳號網域；`R2_ENDPOINT` 有值時改指它。
   為什麼要這個開關：R2 的行為（物件不在回 404、問不到就是連不上）
   是這一層唯一要分辨的東西，而那兩種情況在沒有一個可控端點的情況下
   驗不出來 —— 迴歸測試要能把端點指向本機的 S3 相容假伺服器
   （也讓 MinIO 之類的自架儲存可用）。刻意直接讀 process.env 而不進 env.ts 的
   schema：它不是部署要填的東西，沒填就是正式行為。
   自架端點多半只吃 path-style（bucket 放在路徑而不是主機名）。 */
const endpointOverride = process.env.R2_ENDPOINT?.trim() || null

let client: S3Client | null = null
function s3() {
  if (!configured()) throw new Error('R2 未設定')
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: endpointOverride ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      ...(endpointOverride ? { forcePathStyle: true } : {}),
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! }
    })
  }
  return client
}

const PUT_EXPIRES_S = 10 * 60      // 上傳連結：10 分鐘內要傳完
const GET_EXPIRES_S = 60 * 60      // 私密讀取連結：1 小時內有效，過期前端要再要一次

/**
 * 簽一張上傳通行證。
 *
 * `bytes` 是**必填**而且會被簽進 ContentLength：沒有它的話，
 * routes/files.ts 那道 8MB 上限在儲存層完全沒有強制力 ——
 * 宣告 `bytes: 1` 拿到通行證之後，PUT 多大的檔案 R2 都照收。
 * 把長度簽進去之後，實際 PUT 的 Content-Length 只要跟宣告的不一樣，
 * 簽章就對不上，R2 自己會擋（伺服器不必看到任何位元組）。
 *
 * 代價：呼叫端必須先知道確切大小才能要通行證。瀏覽器端本來就是
 * 拿 File.size 送 presign 再原樣 PUT 同一個 File，所以是對得上的；
 * 串流上傳（大小未知）走不了這條路 —— 目前沒有那種呼叫端。
 */
export async function presignPut(key: string, mime: string, bytes: number): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET!, Key: key, ContentType: mime, ContentLength: bytes
  })
  return getSignedUrl(s3(), cmd, {
    expiresIn: PUT_EXPIRES_S,
    /* content-length 預設會被 presigner 當成「不可簽的標頭」丟進 query 而不是簽章裡。
       明確要求把它簽進 SignedHeaders，否則上面那段強制力不存在。 */
    signableHeaders: new Set(['content-length'])
  })
}

export async function presignGet(key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET!, Key: key })
  return getSignedUrl(s3(), cmd, { expiresIn: GET_EXPIRES_S })
}

/** 有沒有公開讀取網址（bucket 開了 r2.dev 或自訂網域）。沒設就走簽名網址，安全的預設值 */
export const publicUrlOf = (key: string): string | null =>
  env.R2_PUBLIC_URL ? `${env.R2_PUBLIC_URL}/${key}` : null

/**
 * 物件在不在。
 *
 * **三態，不是布林。** 舊版 objectExists() 把所有例外吞成 false，
 * 於是「這個 key 真的沒有東西」跟「這一刻問不到 R2」長得一模一樣。
 * 拿那種答案當入庫關卡，一次 DNS 抖動或逾時就會把一張**傳好的圖**
 * 擋成「你的圖沒傳完」，比不檢查更糟 —— 使用者做對了事卻被指責，
 * 而且重試也沒用（他不知道要重試什麼）。
 *
 *   present     HEAD 200，物件確實在
 *   missing     R2 明確說沒有（404）—— 這才可以拿來拒絕呼叫端
 *   unavailable 問不到（網路、逾時、憑證、5xx、403）—— 呼叫端該回可重試的 503
 *
 * 403 刻意歸到 unavailable：bucket 政策不給 HeadObject 時 S3 也回 403，
 * 那是我們這邊設定的問題，不是使用者的圖有問題。
 */
export type ObjectState = 'present' | 'missing' | 'unavailable'

export async function objectState(key: string): Promise<ObjectState> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: env.R2_BUCKET!, Key: key }))
    return 'present'
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
    const status = err.$metadata?.httpStatusCode
    if (status === 404 || err.name === 'NotFound' || err.name === 'NoSuchKey') return 'missing'
    /* 只進 log，不外送 —— 上游訊息可能帶 bucket 名稱與帳號 id */
    console.warn('[r2] 查詢物件失敗（視為暫時無法查詢）:', key, err.name ?? e)
    return 'unavailable'
  }
}

/**
 * @deprecated 舊的布林版本。**新的呼叫端一律用 objectState()** ——
 * 布林分不出「物件不在」與「這一刻問不到 R2」，拿它當關卡會把
 * 網路抖動誤判成「使用者的圖沒傳完」。
 * 留著只是因為 routes/orders.ts 還有一行指著它的 import（該檔沒有實際呼叫），
 * 而那支檔案目前由另一條工作線持有。等那行 import 清掉就可以刪。
 */
export const objectExists = async (key: string): Promise<boolean> =>
  (await objectState(key)) === 'present'
