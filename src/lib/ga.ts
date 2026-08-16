// ------------------------------------------------------------------
// GA4 tracking — project convention:
//   * every key funnel node gets its own flat event name
//   * NO params, ever — analysis is segmented by event name only
// ------------------------------------------------------------------

type GaEvent =
  | 'view_play'
  | 'view_lobby'
  | 'view_pool_list'
  | 'view_market'
  | 'market_buy_success'
  | 'view_pool_detail'
  | 'click_draw_1'
  | 'click_draw_3'
  | 'click_draw_5'
  | 'click_draw_10'
  | 'draw_success'
  | 'draw_failed_insufficient'
  | 'draw_failed_soldout'
  | 'draw_blocked_by_lock'
  | 'view_prize_result'
  | 'click_topup'
  | 'topup_success'
  | 'topup_failed'
  | 'click_recycle'
  | 'recycle_success'
  | 'click_ship_request'
  | 'ship_request_success'
  | 'view_fairness_page'
  | 'click_verify_pool'
  | 'signup_start'
  | 'signup_success'
  | 'login_success'

declare global {
  interface Window { gtag?: (...args: unknown[]) => void }
}

export function track(event: GaEvent): void {
  window.gtag?.('event', event)
  if (import.meta.env.DEV) console.debug('[ga]', event)
}
