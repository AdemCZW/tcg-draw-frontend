#!/usr/bin/env node
/**
 * 把 ../src/shared 複製一份進 server/src/shared。
 *
 * 為什麼要複製，不能直接 import 外面的檔案：
 * Railway 部署這個服務時，Root Directory 設成 server 之後，
 * 準備 build 用的 snapshot 只會包含 server/ 資料夾本身——
 * 實測過（2026-08-19 的部署 log）：build context 是先在 Railway 端
 * 把整個 repo 縮限到 server/ 這一層再送進 build 容器，
 * 容器裡完全看不到 ../src/shared，tsup 會直接找不到那些檔案而 build 失敗。
 *
 * 所以「共用同一份規則」的真相來源還是 ../src/shared（前端也是從那裡讀），
 * 但這裡的檔案必須是實體複製、物理上存在於 server/ 底下，
 * Railway 的 build context 才拿得到。
 *
 * 用法：改了 src/shared/* 之後，跑一次 `npm run sync-shared`，
 * 把這裡的複製本一起 commit 進去。忘記跑的話 CI/selftest 會抓到不同步
 * （見下面的 --check）。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', '..', 'src', 'shared')
const DEST = join(here, '..', 'src', 'shared')
const CHECK = process.argv.includes('--check')

const HEADER = `/* ⚠️ 這個檔案是複製本，不要手動編輯。
   真正的來源是 src/shared/（repo 根目錄），改那邊之後跑
   \`npm run sync-shared\`（在 server/ 底下）重新產生這份複製。
   為什麼需要複製一份見 scripts/sync-shared.mjs 開頭的說明。 */
`

if (!existsSync(SRC)) {
  console.error(`[sync-shared] 找不到來源 ${SRC}`)
  process.exit(1)
}

mkdirSync(DEST, { recursive: true })
const files = readdirSync(SRC).filter(f => f.endsWith('.ts'))
let mismatched = []

for (const f of files) {
  const content = HEADER + readFileSync(join(SRC, f), 'utf8')
  const destPath = join(DEST, f)
  if (CHECK) {
    const existing = existsSync(destPath) ? readFileSync(destPath, 'utf8') : null
    if (existing !== content) mismatched.push(f)
  } else {
    writeFileSync(destPath, content)
    console.log(`[sync-shared] ${f}`)
  }
}

if (CHECK) {
  if (mismatched.length) {
    console.error(`[sync-shared] 不同步：${mismatched.join(', ')}`)
    console.error('先跑 npm run sync-shared 再 commit')
    process.exit(1)
  }
  console.log('[sync-shared] 一致')
}
