/**
 * 把 src/shared/fairness.ts 轉譯後**原封不動**塞進 chain-anchor.html。
 *
 * 為什麼要有這支腳本：原型宣稱「驗算那一段是真的」。
 * 如果我把 fairness.ts 手抄一份進 HTML，那句話第一天就是假的 ——
 * 正式碼改了、原型不會跟著改，而原型看起來還是會通過。
 *
 * 所以這裡走機械路徑：esbuild 只做「拿掉型別」，不改任何一行邏輯，
 * 輸出注入到 HTML 裡兩個標記之間。要重新產生就跑：
 *
 *     node docs/proto/build-anchor-proto.mjs
 *
 * 產生的那一段是 build artifact，**不要手改**（改了下次跑就被蓋掉）。
 * 這支腳本不進建置、不被 vite 掃到，只是原型的產生器。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const src = join(repo, 'src', 'shared', 'fairness.ts')
const html = join(here, 'chain-anchor.html')
const esbuild = join(repo, 'node_modules', '.bin', 'esbuild')

const BEGIN = '/* ==== FAIRNESS:BEGIN (generated — 不要手改) ==== */'
const END = '/* ==== FAIRNESS:END ==== */'

/* IIFE + global name：原型是 file:// 開的單檔，ES module 的 import 在 file://
   會被 CORS 擋掉，所以不能用 <script type="module">。掛成 window.Fairness。 */
const js = execFileSync(esbuild, [
  src, '--bundle', '--format=iife', '--global-name=Fairness', '--target=es2022'
], { encoding: 'utf8' })

const page = readFileSync(html, 'utf8')
const a = page.indexOf(BEGIN)
const b = page.indexOf(END)
if (a < 0 || b < 0) throw new Error('chain-anchor.html 裡找不到 FAIRNESS 標記')

const out = page.slice(0, a + BEGIN.length) + '\n' + js.trimEnd() + '\n' + page.slice(b)
writeFileSync(html, out)
console.log(`injected ${js.length} bytes of fairness.ts into ${html}`)
