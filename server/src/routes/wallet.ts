import { Hono } from 'hono'
import { sql } from '../db.js'
import { requireAuth } from '../auth.js'
import { walletOf } from '../money.js'

export const wallet = new Hono()
wallet.use('*', requireAuth)

/** 餘額 + 最近的帳本。餘額是算出來的，帳本是原始紀錄 —— 兩者永遠一致，因為前者來自後者 */
wallet.get('/', async c => {
  const me = c.get('userId')
  const rows = await sql`
    select id, delta, reason, ref_id, created_at from points_ledger
    where user_id = ${me} order by id desc limit 100
  `
  return c.json({ wallet: await walletOf(me), ledger: rows, serverTime: Date.now() })
})
