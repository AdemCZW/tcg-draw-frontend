/**
 * 連點防呆 —— 送出型按鈕的重複觸發。
 *
 * 跟 touch-guard.ts 分成兩支是刻意的：那支管的是「系統手勢」
 * （長按選單、縮放手勢），關掉就對了、幾乎沒有取捨；這支管的是
 * 「使用者的第二次點擊」，而第二次點擊有時候是誤觸、有時候是真的想再點一次，
 * 每一條規則都要交代為什麼判它是誤觸。兩種東西的判斷成本差太多，
 * 放在一起會讓人以為都是「關掉就好」的那種規則。
 *
 * 為什麼需要：站上多數送出流程已經有 busy 旗標擋住重複送出
 * （選籤、開池、儲存個資、下標、市場購買），但不是全部 ——
 * 卡冊的「確認回收」與訂單的「確認出貨／送出申訴」沒有，
 * 手機上點兩下就會送出兩次。那些是扣卡、送單的不可逆動作，
 * 送兩次的代價遠高於「偶爾吃掉一次真的想連按的點擊」。
 */

/** 兩次點擊間隔小於這個數就當成誤觸。
 *  450ms 是「手指抖一下」與「看完畫面決定再點一次」的分界：
 *  真的要再送一次的人，光是把手指移開再放回去就不只這個時間。 */
const REPEAT_MS = 450

/** 哪些按鈕算「送出型」。
 *  只挑會扣點數、送單、改狀態的那些 —— 站上的主要動作鍵一律是
 *  .btn.primary / .btn.danger（後台是 .c-btn.pri / .c-btn.danger），
 *  次要動作用 .btn / .btn.ghost，那些多半是切換、展開、取消，
 *  本來就該讓人連按，不能掃進來。
 *  新元件若不想靠猜的，可以自己標 data-commit。 */
const COMMIT =
  'button[type="submit"], .btn.primary, .btn.danger, .c-btn.pri, .c-btn.danger, [data-commit]'

/** 真的需要連按的送出型按鈕（例如加減數量）標上 data-repeat 就能豁免。 */
const OPT_OUT = 'data-repeat'

/** 這幾種東西被長按拖曳只會拖出一張圖，沒有任何使用情境。 */
const NO_DRAG = 'img, picture, svg, canvas, video, .art, .art-tilt, .cover'

export function installTapGuard() {
  if (typeof document === 'undefined') return

  /* 用 WeakMap 記「這顆按鈕上次被放行的時間」，不是記全域的最後一次點擊：
     快速在兩顆不同的按鈕之間切換是正常操作，不該被互相拖累。
     WeakMap 讓元件卸載後自動回收，不必清表。 */
  const lastAccepted = new WeakMap<Element, number>()

  /* 掛在捕獲階段：Vue 的 @click 是掛在元素自己身上（目標階段），
     在捕獲階段就 stopPropagation，事件根本不會走到那裡。
     若改在冒泡階段攔，handler 早就跑完了，擋了也沒用。 */
  document.addEventListener(
    'click',
    e => {
      const target = e.target as Element | null
      const btn = target?.closest?.(COMMIT)
      if (!btn || btn.hasAttribute(OPT_OUT)) return

      const now = e.timeStamp || performance.now()
      const prev = lastAccepted.get(btn)
      if (prev !== undefined && now - prev < REPEAT_MS) {
        /* stopImmediatePropagation 而非 stopPropagation：同一顆按鈕上
           可能同時掛了多個 handler（元件自己的 + 父層的埋點），
           要嘛全部不跑，要嘛全部跑，不能只擋一半留下不一致的狀態。 */
        e.stopImmediatePropagation()
        e.preventDefault()
        return
      }
      lastAccepted.set(btn, now)
    },
    true
  )

  /* 圖片拖曳。CSS 的 -webkit-user-drag 只有 WebKit / Blink 認，
     Firefox 得靠攔 dragstart。手機上少見，但桌機把卡圖拖進另一個分頁
     一樣是誤操作 —— 一行的事，順手補完。 */
  document.addEventListener('dragstart', e => {
    const target = e.target as Element | null
    if (target?.closest?.(NO_DRAG)) e.preventDefault()
  })
}
