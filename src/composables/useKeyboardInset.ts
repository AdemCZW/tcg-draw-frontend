import { onBeforeUnmount, onMounted } from 'vue'

/**
 * 把軟鍵盤吃掉的高度寫成根節點上的 `--kb`，讓貼底的覆蓋層停在鍵盤上面。
 *
 * 為什麼需要它：覆蓋層是 position: fixed，而 fixed 貼的是「版面視窗」。
 * iOS Safari 的軟鍵盤不會縮版面視窗，只縮 visualViewport —— 鍵盤一彈出來，
 * 面板的下緣（連同黏在那裡的送出鍵）就躲到鍵盤底下了。填地址、打金額、
 * 設密碼都必然彈鍵盤，這不是邊角情況，是主要路徑。
 *
 * 為什麼掛在 documentElement 而不是元件內：這幾張面板都是 Teleport 到 body 的，
 * 不在呼叫端的 DOM 子樹裡，scoped 的 style 綁得到、CSS 變數要走根節點。
 *
 * 為什麼抽成 composable：同一段程式碼原本在 MyCardsPage 與 PublicCardbookPage
 * 各存一份，LoginMethods 是第三個 —— 再複製一次，下次修 scale 防呆就要記得改三處。
 */
export function useKeyboardInset() {
  /* scale 的防呆：雙指放大時 visualViewport 也會變小，那不是鍵盤，
     照著縮會讓面板莫名其妙變矮。 */
  const sync = () => {
    const vv = window.visualViewport
    const kb = vv && vv.scale <= 1.01
      ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      : 0
    document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`)
  }

  onMounted(() => {
    window.visualViewport?.addEventListener('resize', sync)
    window.visualViewport?.addEventListener('scroll', sync)
    sync()
  })
  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener('resize', sync)
    window.visualViewport?.removeEventListener('scroll', sync)
    /* 離開這一頁要還原：--kb 掛在根節點上，留著會讓別頁的固定元件也跟著位移 */
    document.documentElement.style.removeProperty('--kb')
  })
}
