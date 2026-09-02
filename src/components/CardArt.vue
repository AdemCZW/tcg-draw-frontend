<script setup lang="ts">
/**
 * 卡圖顯示，依序嘗試三個來源：
 *   1. image 是真實網址（賣家實拍 / R2）——這是實際要出貨的那張卡，最優先
 *   2. 沒有實拍圖 → 依卡名向 TCGdex 取官方卡圖當「示意圖」（見 tcgdex.ts 的授權風險說明；
 *      示意圖不代表實際出貨那張卡的狀況，只是讓玩家看得出這是哪隻寶可夢）
 *   3. 都查不到 → 漸層佔位卡（"placeholder:<hue>")
 */
import { computed, ref, watch } from 'vue'
import type { Tier } from '@/types/models'
import { artUrlById, canonicalArt } from '@/lib/tcgdex'
import { useNearViewport } from '@/lib/near-viewport'
import { API_URL } from '@/lib/config'

const props = defineProps<{
  image: string
  alt?: string
  /** null 與 undefined 同義：沒有賞別（例如使用者自己登記的卡），角標不畫 */
  tier?: Tier | null
  caption?: string
  /** TCGdex 卡片編號。給了就直接用那一張的圖，不必靠卡名去猜 */
  artId?: string | null
}>()

const remoteUrl = ref<string | null>(null)

/* 只有接近畫面才去查圖。
  查圖要打 TCGdex，一頁四十張卡就會形成大量請求 ——
   畫面外的卡把頻寬吃光，正在看的那幾張反而最慢出來。
   這是「載入慢一拍」的真正原因，`loading="lazy"` 管不到（那只管圖片本身，
   網址早就查完了）。 */
const { el: rootEl, near } = useNearViewport()

const hue = computed(() => {
  const m = (props.image || '').match(/^placeholder:(\d+)/)
  return m ? Number(m[1]) : 220
})
const TIER_LABEL: Record<Tier, string> = {
  A: 'A 賞', B: 'B 賞', C: 'C 賞', D: 'D 賞', LAST: '最後賞', BUST: '爆賞'
}
const tierLabel = computed(() => (props.tier ? TIER_LABEL[props.tier] : ''))
const rawImage = computed(() => (props.image || '').trim())
/* 站內檔案的網址要補 /raw。
   資料庫裡存的是 `/v1/files/f-xxx`（server/src/routes/cardbook.ts），
   而**那條路徑回的是 JSON**（`{url, public}`）不是圖片位元組 ——
   直接餵給 <img src> 每一張都是破圖。要位元組得走 `/v1/files/:id/raw`，
   它做同一套權限判斷之後 302 導到 R2。
   這裡而不是在資料庫裡補，是因為已經寫進去的列也要能畫得出來。 */
const ownSrc = computed(() => {
  const img = rawImage.value
  if (!img || img.startsWith('placeholder:')) return ''
  if (!img.startsWith('/v1/')) return img
  const path = /^\/v1\/files\/[^/]+$/.test(img) ? `${img}/raw` : img
  return `${API_URL}${path}`
})

/* 載不出來的那個網址。
   R2 沒設定會回 503、檔案被刪會 404、mock 模式下 API_URL 是空字串
   會打到 SPA 自己 —— 三種情況以前都是一張破圖收場，因為
   「有自己的圖」直接短路掉 TCGdex 與佔位卡兩條退路。
   記下失敗的網址（而不是一個布林）：props.image 換成別張時要能重試。 */
const failedSrc = ref('')

/* 空字串不算「有自己的圖」（ownSrc 對空字串與 placeholder: 都回 ''）。
   原本只判斷開頭不是 placeholder:，於是 image:'' 會被當成有實拍圖，
   watch 直接 return，artId 與卡名搜尋都不會跑 —— 整站卡圖變成佔位漸層。 */
const hasOwnImage = computed(() => !!ownSrc.value && ownSrc.value !== failedSrc.value)
// 有自己的實拍就不必打任何 API
const src = computed(() => (hasOwnImage.value ? ownSrc.value : remoteUrl.value))
const isPlaceholder = computed(() => !src.value)

/** 這一張畫不出來 —— 往下一個來源退，而不是留一個破圖在那裡 */
function onImgError() {
  if (hasOwnImage.value) { failedSrc.value = ownSrc.value; return }
  // 退到 TCGdex 的示意圖也載不出來 → 剩下漸層佔位卡
  remoteUrl.value = null
}
const tierClass = computed(() => (props.tier ? `t-${props.tier.toLowerCase()}` : ''))

watch(
  () => [props.alt, props.artId, hasOwnImage.value, near.value] as const,
  async ([alt, artId, own, visible]) => {
    remoteUrl.value = null
    if (own) return
    // 還沒接近畫面就先不查。near 變 true 時這個 watch 會再跑一次
    if (!visible) return

    /* 有指定編號就直接組網址，不必查 API 也不會拿錯版本。
       靠卡名搜尋只會拿到「第一張有圖的」—— 通常是普卡而不是密卡。 */
    if (artId) {
      const byId = artUrlById(artId)
      if (byId) { remoteUrl.value = byId; return }
    }
    // 沒有 cert 也沒有編號 → 退一步用卡名搜示意圖
    const canon = await canonicalArt(alt)
    if (canon && props.alt === alt && !hasOwnImage.value) remoteUrl.value = canon
  },
  { immediate: true }
)
</script>

<template>
  <div
    v-if="isPlaceholder"
    ref="rootEl"
    class="art"
    :class="tierClass"
    :style="{ '--h': hue }"
    role="img"
    :aria-label="alt ?? '卡片圖'"
  >
    <div class="foil" aria-hidden="true"></div>
    <div class="sheen" aria-hidden="true"></div>
    <div class="frame" aria-hidden="true"></div>
    <!-- 沒有實拍圖時，至少讓卡面帶出卡片身分，否則只是一塊空白粉彩 -->
    <div class="ident">
      <span v-if="tier" class="t-chip" :class="tierClass">{{ tierLabel }}</span>
      <span v-if="alt" class="c-name">{{ alt }}</span>
    </div>
    <div class="mark" aria-hidden="true">VD</div>
    <div v-if="caption" class="caption">{{ caption }}</div>
  </div>
  <!-- decoding="async" 讓解碼不擋主執行緒：一次進場十幾張卡時，
       同步解碼會讓捲動卡住一拍 -->
  <img
    v-else ref="rootEl" class="art-img" :src="src!" :alt="alt ?? '卡片圖'"
    loading="lazy" decoding="async" @error="onImgError"
  />
</template>

<style scoped>
/* ---- 全像反光 ----
   真的 holo 卡轉動時本來就會跑彩虹光，所以這不是裝飾，是模擬實體商品。
   預設不開：卡冊列表的 40px 縮圖跑這個只是雜訊，
   由使用端在需要的版位加 .holo。 */
.holo { position: relative; overflow: hidden; }
.holo::after {
  content: '';
  position: absolute; inset: 0;
  pointer-events: none;
  /* 亮度調高、光帶收窄。
     第一版透明度只有 .28 疊在本來就鮮豔的卡圖上，對比不足 —— 時間夠長卻看不見。
     真的 holo 卡反光是「一道明確的光帶掃過」，不是整張變亮。 */
  background: linear-gradient(105deg,
    transparent 38%,
    rgba(255, 255, 255, .55) 46%,
    rgba(140, 210, 255, .8) 49.5%,
    rgba(255, 255, 255, .7) 51%,
    rgba(255, 160, 235, .75) 53%,
    transparent 62%);
  background-size: 300% 100%;
  mix-blend-mode: screen;
}
@media (prefers-reduced-motion: no-preference) {
  .holo::after { animation: holoSweep 4.6s cubic-bezier(.3, 0, .3, 1) var(--holo-delay, 0s) infinite; }
}
@keyframes holoSweep {
  0%, 72% { background-position: 190% 0; }
  100%    { background-position: -80% 0; }
}

.art, .art-img {
  width: 100%; aspect-ratio: 63 / 88;
  border-radius: 14px;
  display: block;
  /* 讓卡面文字用 cqw 依卡片寬度縮放，縮圖與大圖共用同一份排版 */
  container-type: inline-size;
}
.art {
  /* 比頁面底色明顯一階，否則卡片會融進白背景看起來像空白 */
  background:
    radial-gradient(110% 80% at 22% 8%, hsl(var(--h) 85% 78%), transparent 62%),
    radial-gradient(110% 85% at 88% 96%, hsl(calc(var(--h) + 55) 78% 72%), transparent 64%),
    radial-gradient(70% 60% at 55% 50%, hsl(calc(var(--h) + 25) 70% 86%), transparent 70%),
    hsl(var(--h) 52% 85%);
  position: relative; overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(26, 22, 20, .1);
}

/* faint foil crosshatch texture across the whole face */
.foil {
  position: absolute; inset: 0;
  background-image:
    repeating-linear-gradient(115deg, rgba(255,255,255,.05) 0 1px, transparent 1px 7px),
    repeating-linear-gradient(25deg, rgba(255,255,255,.035) 0 1px, transparent 1px 9px);
  mix-blend-mode: overlay;
}

/* moving holo sheen band */
.sheen {
  position: absolute; inset: -20%;
  background: linear-gradient(115deg, transparent 30%, rgba(255,255,255,.16) 46%, rgba(255,255,255,.02) 52%, transparent 62%);
}
@media (prefers-reduced-motion: no-preference) {
  .sheen { animation: sheen-drift 5s ease-in-out infinite alternate; }
}
@keyframes sheen-drift {
  from { transform: translate(-6%, -4%) rotate(0deg); }
  to   { transform: translate(6%, 4%) rotate(2deg); }
}

/* inset frame — gives the placeholder a "graded slab" edge */
.frame {
  position: absolute; inset: 7px;
  border: 1.5px solid rgba(255, 255, 255, .75);
  border-radius: 9px;
  box-shadow: inset 0 0 0 1px rgba(26, 22, 20, .06);
}
.art.t-a  .frame { border-color: color-mix(in srgb, var(--tier-a) 65%, transparent); }
.art.t-b  .frame { border-color: color-mix(in srgb, var(--tier-b) 65%, transparent); }
.art.t-c  .frame { border-color: color-mix(in srgb, var(--tier-c) 65%, transparent); }
.art.t-d  .frame { border-color: color-mix(in srgb, var(--tier-d) 65%, transparent); }
.art.t-last .frame { border-color: color-mix(in srgb, var(--tier-last) 65%, transparent); }

/* 卡片身分：賞別 + 卡名。用 container query 讓小縮圖自動只留賞別 */
.ident {
  position: absolute; left: 0; right: 0; top: 0;
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  padding: 9%;
}
.t-chip {
  font-size: clamp(8px, 9cqw, 12px);
  font-weight: 600; line-height: 1.4;
  padding: 2px 8px;
  border-radius: var(--pill);
  color: #fff;
  background: var(--tier-d);
  white-space: nowrap;
}
.t-chip.t-a { background: var(--tier-a); }
.t-chip.t-b { background: var(--tier-b); }
.t-chip.t-c { background: var(--tier-c); }
.t-chip.t-d { background: rgba(26, 22, 20, .55); }
.t-chip.t-last { background: var(--tier-last); }
.t-chip.t-bust { background: var(--ink); }
.c-name {
  font-size: clamp(9px, 10cqw, 15px);
  font-weight: 600; line-height: 1.3;
  color: rgba(26, 22, 20, .88);
  text-shadow: 0 1px 2px rgba(255, 255, 255, .6);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden;
}

/* small brand monogram watermark, bottom-right */
.mark {
  position: absolute; right: 11px; bottom: 9px;
  font-size: 10.5px; font-weight: 600; letter-spacing: .06em;
  color: rgba(26, 22, 20, .3);
}

.caption {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 18px 11px 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: rgba(26, 22, 20, .6);
  background: linear-gradient(180deg, transparent, rgba(255, 255, 255, .8) 60%);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.art-img { object-fit: cover; }
</style>
