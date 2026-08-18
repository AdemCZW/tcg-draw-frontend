/**
 * 遷移。
 *
 * 沒有用遷移框架：檔案照編號跑一次，跑過的記在 schema_migrations。
 * 四張表的專案不需要 up/down、不需要 rollback —— 真的要退版就寫一支新的。
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from './db.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

async function run() {
  await sql`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now()
  )`
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map(r => r.name))
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()

  for (const f of files) {
    if (done.has(f)) { console.log(`skip ${f}`); continue }
    const body = await readFile(join(dir, f), 'utf8')
    // 整支遷移包在一個交易裡：跑到一半失敗不會留下半套結構
    await sql.begin(async tx => {
      await tx.unsafe(body)
      await tx`insert into schema_migrations (name) values (${f})`
    })
    console.log(`applied ${f}`)
  }
  await sql.end()
  console.log('migrations done')
}

run().catch(e => { console.error(e); process.exit(1) })
