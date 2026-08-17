/**
 * 手機誤觸防護裡 CSS 做不到的那一半。
 *
 * 大部分的防護寫在 base.css（-webkit-touch-callout、touch-action、
 * overscroll-behavior）。這裡只補三件 CSS 管不到的事。
 */

/** 這是不是主要靠觸控的裝置 */
const coarse = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

export function installTouchGuard() {
  if (typeof document === 'undefined') return

  /* 1. 圖片的長按選單。
     iOS 用 -webkit-touch-callout: none 就夠了，但 Android Chrome 仍然會跳
     「下載圖片 / 搜尋圖片」選單，必須攔 contextmenu 事件。

     只擋圖片，不做全站 —— 桌機使用者在文字上按右鍵是正常需求，
     全站封鎖右鍵是那種讓人立刻想關掉分頁的設計。 */
  document.addEventListener('contextmenu', e => {
    const el = e.target as HTMLElement | null
    if (el?.tagName === 'IMG' || el?.closest('.art, .art-tilt, .cover')) {
      e.preventDefault()
    }
  })

  /* 2. 雙指以外的多點觸控造成的意外縮放／手勢。
     iOS Safari 的 gesturestart 在雙擊後仍可能觸發縮放，
     而抽卡演出跟選籤牆在縮放狀態下版面會歪掉。
     只在觸控裝置攔，桌機不動。 */
  if (coarse()) {
    document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false })
  }

  /* 3. 快速連點造成的重複觸發。
     選籤牆上使用者會連續快點多格，300ms 內的第二次 click 若落在
     同一個座標上，多半是手指抖動不是刻意的第二次點擊。

     這裡刻意不做 —— 寫下來是因為想過：籤位的 toggle 本來就是冪等的
     （再點一次就取消選取），加防抖反而會讓「快速改選」變得遲鈍。
     真正需要防重複的是送出按鈕，那已經用 busy 狀態擋住了。 */
}
