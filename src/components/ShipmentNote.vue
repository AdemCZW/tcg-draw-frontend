<script lang="ts">
/**
 * 卡冊上「這張卡的出貨單」那一格。**獨立元件，還沒有掛到任何頁面上。**
 *
 * ── 它要解決什麼 ────────────────────────────────────────────────────
 * 寄存滿 90 天時，系統會**自動替買家申請出貨**（server 的 D-1／699e239）。
 * 買家沒有按過任何按鈕，卡冊上那一格卻自己從「寄存中」變成「待出貨」——
 * 第一反應必然是「我沒有按過」。而他也看不到**會寄到哪一份地址**
 * （他可能兩年前就搬家了）。通知內文兩件事都有講，但通知是一次性的訊息，
 * 不是他隨時看得到的狀態。
 *
 * ── 兩個 variant，都**不會把卡冊那一格撐高** ────────────────────────
 * 剛修過一次同樣的問題（commit 7d1d864：訓練家卡那格多一行字，
 * 那一行是**版面流裡的元素**，於是只有那一格變高、同排另外兩格對不齊，
 * 整片格狀選單就歪了）。一格的狀態不該改變版面。
 *
 *   variant="mark"   右上角一枚「自動」小標。`position: absolute`，
 *                    **不進版面流** —— 跟 7d1d864 的 .dot 同一個角落、
 *                    同一個手法，差別是它帶兩個字（那顆點只能說「有事」，
 *                    這裡要說的是「這是誰做的」，非說不可）。
 *                    掛在 MyCardsPage 的 .artBox 底下（那一層是
 *                    position: relative），不要放進 .sTags —— 那一排是
 *                    flex-wrap，第三個膠囊會換行擠掉卡面。
 *   variant="detail" 展開面板（.pop）裡的內容。.pop 本身是
 *                    `absolute + max-height: 100%`，貼著卡圖下緣往上長，
 *                    再長也不會超出卡圖 —— 所以放多少字都不影響格線高度。
 *
 * ── 為什麼是「一次請求」不是「一格一個請求」──────────────────────────
 * 卡冊一頁 24 張，每一格自己去打一次 `/for-prize/:id` 就是 24 個請求。
 * 這支檔案在模組層（不是 `<script setup>` 裡）放一份共用的快取：
 * 第一個掛上來的實例去拉一次 `GET /v1/shipments`（買家的出貨單本來就少），
 * 其餘實例讀同一份 Map。同時掛 24 個也只會有一個請求在飛。
 *
 * ── 個資 ────────────────────────────────────────────────────────────
 * 後端回的地址**已經是遮罩過的**（`server/src/routes/shipments.ts`），
 * 前端手上從來沒有全文，所以不可能不小心印到 console 或塞進網址。
 * 這支檔案也沒有任何 console 呼叫。
 */
import { shallowRef } from 'vue'
import { api, type BuyerShipment } from '@/lib/api'

/** prizeId → 那張卡現在在哪一張出貨單上。null = 確定沒有 */
const byPrize = shallowRef(new Map<string, BuyerShipment>())
/** 同時只會有一個請求在飛。之後掛上來的實例等同一個 promise */
let inflight: Promise<void> | null = null
let loaded = false

/**
 * 把買家的出貨單拉一次並建索引。
 *
 * 失敗不重試也不拋：這一格是**補充說明**，拉不到就什麼都不顯示，
 * 卡冊本身照常運作。為了一行說明把整頁弄出一個錯誤狀態是本末倒置。
 */
export async function loadShipments(force = false): Promise<void> {
  if (loaded && !force) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const map = new Map<string, BuyerShipment>()
      /* 分頁跟到底。買家的出貨單是少數（一次到期最多 50 張併成一張單），
         但「跟到底」是唯一能保證某一格不會因為剛好在第二頁而失去說明的做法。
         上限 10 頁是保險絲，不是預期會用到的數字。 */
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const r: { items: BuyerShipment[]; nextCursor: string | null } =
          await api.myShipments({ cursor, limit: 100 })
        for (const sh of r.items) {
          for (const c of sh.cards) {
            /* 同一張卡理論上只在一張活著的單上；真的有兩張時取先遇到的
               （清單是新到舊，所以那是**最新的**那一張）—— 舊那張講的是
               一次已經結束的出貨，不是「這張卡現在怎麼了」。 */
            if (!map.has(c.prizeId)) map.set(c.prizeId, sh)
          }
        }
        cursor = r.nextCursor
        if (!cursor) break
      }
      byPrize.value = map
      loaded = true
    } catch {
      /* 靜默。理由見上面 */
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 出貨狀態改變之後（例如按了「申請出貨」）叫這一支，下次讀會重新拉 */
export function invalidateShipments() {
  loaded = false
  byPrize.value = new Map()
}
</script>

<script setup lang="ts">
import { computed, onMounted } from 'vue'

const props = withDefaults(defineProps<{
  prizeId: string
  variant?: 'mark' | 'detail'
}>(), { variant: 'mark' })

onMounted(() => { void loadShipments() })

const sh = computed(() => byPrize.value.get(props.prizeId) ?? null)
const auto = computed(() => sh.value?.origin === 'auto-stash-expiry')

/** 這一格的進度。用出貨單的狀態，不用卡片的 —— 一張單可以有多張卡 */
const stepText = computed(() => {
  switch (sh.value?.status) {
    case 'requested': return '已申請，等賣家寄出'
    case 'packed': return '賣家整理中'
    case 'shipped': return '賣家已寄出'
    case 'delivered': return '已送達'
    default: return ''
  }
})

/* 期限只講到「還剩多久」，不講精確到秒的時間戳：使用者要做的判斷是
   「我還要等多久 / 賣家是不是已經超時」，一個 2026-09-08 14:32 幫不上忙。 */
const dueText = computed(() => {
  const due = sh.value?.sellerDueAt
  if (due == null) return ''
  const ms = due - Date.now()
  if (ms <= 0) return '賣家已逾期'
  const h = Math.ceil(ms / 3_600_000)
  return h >= 24 ? `賣家還有 ${Math.ceil(h / 24)} 天` : `賣家還有 ${h} 小時`
})

/** 遮罩過的收件地點，串成一行。全文前端從來沒有拿到過（見檔頭） */
const whereText = computed(() => {
  const a = sh.value?.shipTo
  if (!a) return ''
  return [a.zip, a.city, a.line1Masked].filter(Boolean).join(' ')
})
</script>

<template>
  <!-- ── 右上角的「自動」小標 ──────────────────────────────────────────
       只在**系統自動申請**的單上出現。自己按過「申請出貨」的人不需要被
       提醒他自己做過什麼，常駐一枚標籤只會教人忽略這個位置。
       aria-label 帶完整句子：畫面上兩個字放得下，讀屏要聽得懂前因後果。
       它不是按鈕，所以不適用 44px 觸控目標 —— 要展開細節按的是那一格
       本來就有的展開鈕。 -->
  <span
    v-if="variant === 'mark' && auto"
    class="mark"
    :aria-label="`這張卡的出貨是系統在寄存期滿時自動申請的，寄到 ${whereText}`"
    :title="`寄存期滿，系統自動申請出貨 · 寄到 ${whereText}`"
  >自動</span>

  <!-- ── 展開面板裡的細節 ─────────────────────────────────────────────
       放進 MyCardsPage 的 .pop（absolute + max-height: 100%），所以這裡
       寫多少行都不會改變格線高度。 -->
  <div v-else-if="variant === 'detail' && sh" class="detail">
    <p v-if="auto" class="why">
      <strong>寄存期滿，系統自動替你申請出貨</strong>
      你沒有按過任何按鈕 —— 實體卡一直在賣家手上，期限到了平台會替你把它要回來。
    </p>
    <p v-else class="why muted">你在 {{ new Date(sh.createdAt ?? Date.now()).toLocaleDateString('zh-TW') }} 申請的出貨。</p>

    <dl class="rows">
      <div class="row">
        <dt>寄到</dt>
        <!-- 遮罩版。他要判斷的是「還是不是這裡」，那不需要看到全文 -->
        <dd class="mono">{{ whereText }}</dd>
      </div>
      <div class="row">
        <dt>收件人</dt>
        <dd class="mono">{{ sh.shipTo.nameMasked }} · {{ sh.shipTo.phoneMasked }}</dd>
      </div>
      <div class="row">
        <dt>進度</dt>
        <dd>
          {{ stepText }}
          <span v-if="dueText" :class="['due', { late: sh.sellerOverdue }]">{{ dueText }}</span>
        </dd>
      </div>
    </dl>

    <!-- 地址不對的出口。**目前只有客服這一條** —— 出貨單上的地址是快照，
         而賣家在他的出貨頁上已經讀得到它，買家單方面改掉會讓賣家手上那份
         變成錯的而他不會知道（理由見後端檔頭）。所以這裡不畫編輯鈕，
         畫的是一條真的走得通的路。addressEditable 之後變 true 時，
         這一段自然會換成編輯鈕，不必回頭改文案。 -->
    <p v-if="!sh.addressEditable" class="fix">
      <span v-if="sh.differsFromProfile && auto" class="warnLine">
        這份地址跟你現在的「我的資料」不一樣 —— 出貨單是申請當下的快照，不會跟著更新。
      </span>
      地址不對？<RouterLink to="/support/new">開一張客服單</RouterLink>，越早越好：賣家可能已經印好單了。
    </p>
  </div>
</template>

<style scoped>
/* ---- 右上角的「自動」小標 ----
   position: absolute 是這一段的重點，也是它跟被 7d1d864 改掉的那一行字
   唯一的差別：一進版面流，這一格就會比同排其他格高，整片格線跟著歪。
   掛在 .artBox（position: relative）底下，貼卡圖右上角。 */
.mark {
  position: absolute; top: 8px; right: 8px; z-index: 1;
  font-size: 10px; font-weight: 700; line-height: 1.4;
  padding: 2px 7px; border-radius: var(--pill);
  background: var(--accent); color: var(--on-accent);
  white-space: nowrap; pointer-events: none;
  /* 卡圖的顏色不可控（深卡、亮卡都有），描一圈把它跟卡面分開 */
  box-shadow: 0 0 0 1.5px rgba(0, 0, 0, .32);
}

/* ---- 展開面板裡的細節 ---- */
.detail {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px;
  font-size: 11.5px; line-height: 1.45; color: var(--text);
  text-align: left; width: 100%;
}
.why { margin: 0; }
.why strong { display: block; font-size: 12px; color: var(--accent-soft); }
.why.muted { color: var(--muted); }

.rows { margin: 0; display: grid; gap: 4px; }
/* 標籤窄、值可伸縮。minmax(0, 1fr) 不能省：遮罩過的地址仍然可能不換行，
   隱含的 auto 軌道會被它撐開，把左邊那欄擠扁。 */
.row { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 8px; align-items: baseline; }
.row dt { color: var(--muted); }
.row dd { margin: 0; overflow-wrap: anywhere; }

.due { margin-left: 6px; color: var(--muted); }
.due.late { color: var(--danger-ink); font-weight: 700; }

.fix { margin: 0; color: var(--muted); font-size: 11px; }
.fix a { color: var(--accent-soft); }
/* 「地址跟現在的資料不一樣」自成一行：它是這一段裡唯一可能讓人採取
   行動的句子，跟在後面的客服連結混成一段就讀不出來了。 */
.warnLine { display: block; color: var(--warn-ink); font-weight: 600; margin-bottom: 3px; }
</style>
