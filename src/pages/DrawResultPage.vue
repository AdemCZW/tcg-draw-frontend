<script setup lang="ts">
/**
 * 抽選結果。
 *
 * 演出從 Three.js 的立體翻卡換成煙霧凝聚（CardEmerge）。換掉的理由有兩個：
 *
 * 1. Three.js 是 720 KB（gzip 後 188 KB），而它只被這一頁用到 ——
 *    整個 app 情緒最高的那一刻，使用者要先等一包比整個網站還大的
 *    函式庫下載完才看得到自己抽到什麼。CardEmerge 用的是原生 WebGL2，
 *    跟首頁那支 shader 同一套，沒有額外相依。
 * 2. 煙霧把卡「拼湊出來」比翻卡更有儀式感，也是這個網站想要的調性。
 *
 * 只播最高賞那一張：十抽播十次、每次八秒，沒有人看得完。
 * 其餘的卡在下方明細一次揭曉。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { usePoolStore } from '@/stores/pools'
import CardArt from '@/components/CardArt.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import CardEmerge from '@/components/CardEmerge.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import type { Tier } from '@/types/models'
import { track } from '@/lib/ga'

const route = useRoute()
const pools = usePoolStore()
/* 依網址的 drawId 取，不是拿 store 裡「最後一筆」——
   reload 後 store 是空的，但 sessionStorage 還有；
   而且兩個分頁各抽一次時，網址才是唯一可靠的鍵。 */
const result = pools.resultById(String(route.params.drawId))
const revealed = ref(false)

/* ---- 演出的等級 ----
   整批抽選用「最高賞」決定演出強度：一抽裡有 A 賞就演得完整。
   這是誠實的 —— 演出等級對應真的開出來的東西，不是先假裝再降級。 */
const TIER_RANK: Record<Tier, number> = { BUST: 0, D: 1, C: 2, B: 3, A: 4, LAST: 5 }
const bestTier = computed<Tier>(() => {
  if (!result?.items.length) return 'D'
  return result.items.reduce<Tier>((best, it) =>
    TIER_RANK[it.tier] > TIER_RANK[best] ? it.tier : best, 'D')
})
/* 煙霧演出的主角：最高賞的那一張。同賞別時取第一張 */
const heroItem = computed(() =>
  result?.items.length
    ? result.items.reduce((best, it) => TIER_RANK[it.tier] > TIER_RANK[best.tier] ? it : best, result.items[0]!)
    : null)

/* 演出速度依賞別調。最高賞看完整段（十秒），低賞加速 ——
   每抽一張 D 賞都播滿十秒只會讓人想關掉。
   這跟 RevealBuildup 的分級是同一個原則：演出對應真的開出來的東西。 */
const emergePace = computed(() => {
  const r = TIER_RANK[bestTier.value]
  return r >= 4 ? 1 : r === 3 ? 1.4 : 1.9
})
/* 強度跟速度分開。只調速度的話，低賞別看到的是同一場大爆炸的快轉版，
   「衝擊」就變成常態；常態化的衝擊等於沒有衝擊。
   要讓最高賞那一下打得出來，低賞別就必須真的小聲。 */
const emergeIntensity = computed(() => {
  const r = TIER_RANK[bestTier.value]
  return r >= 5 ? 1 : r === 4 ? 0.92 : r === 3 ? 0.6 : 0.32
})

/* 原本煙霧前面還有一段光球蓄勢演出（RevealBuildup），已移除，
   而且在這次「加長、加衝擊」的改版裡重新評估過，結論仍然是不啟用：
   它是另一支獨立的全螢幕演出，播完畫面重來一次才輪到煙霧，兩段之間沒有交接。
   把它接回來只是把演出變長，不會變得更有份量。
   真正需要的蓄力已經做進煙霧演出內部（CardEmerge 的 charge 那一拍），
   共用同一個核心光、同一團煙，爆完的殘料直接變成卡片的材料。

   動態偏好關動效的人直接看結果，不必先等一支動畫。 */
const reduceMotion = typeof matchMedia !== 'undefined'
  && matchMedia('(prefers-reduced-motion: reduce)').matches
if (reduceMotion || !result) revealed.value = true

/* 開獎當下是使用者最會懷疑「這是不是喬過的」的時刻，驗算入口留在這一頁 ——
   但收成按鈕下方的一行連結，不再把整套材料攤在結果上面擋住卡片。 */
const pool = computed(() => (result ? pools.byId(result.poolId) : undefined))
/* 種子池用 fixture:<池id> 當來源（seed 不能等 drand 兩分鐘）。
   那些池的結果不具備對外驗證的意義，畫面要講實話。 */
const isFixture = computed(() => (pool.value?.clientSeedSource ?? '').startsWith('fixture:'))

/* 帶著剛拿到的卡片 id 過去，卡冊才標得出「就是這幾張」。
   舊的結果（reload 前存進 sessionStorage 的）沒有 stashId，那就只導頁不標記。 */
const cardbookLink = computed(() => {
  const ids = (result?.items ?? []).map(i => i.stashId).filter(Boolean)
  return ids.length ? `/me/cards?new=${ids.join(',')}` : '/me/cards'
})

onMounted(() => {
  track('view_prize_result')
  /* 保險絲：明細清單原本只在 3D 演出發出 revealed 後才淡入，
     但 WebGL 中途失敗、或分頁在背景導致 rAF 暫停時，那個事件永遠不會來，
     使用者就再也看不到自己抽到什麼。時間到就強制顯示。 */
  /* 保險絲：WebGL 中途失敗、或分頁在背景導致動畫暫停時，
     CardEmerge 的 done 事件永遠不會來，使用者就再也看不到自己抽到什麼。
     演出最長十秒（七拍，含蓄力與爆發），這裡給到十五秒。 */
  setTimeout(() => { revealed.value = true }, 15000)
})
</script>

<template>
  <div class="container page" v-if="result">
    <h1 class="display">抽選結果</h1>
    <p class="muted sub mono">draw {{ result.drawId }} · 共 {{ result.items.length }} 抽 · {{ result.cost.toLocaleString() }} 點</p>
    <!-- 煙霧凝聚：只播最高賞那張，播完（或被點掉）就揭曉全部。
         按鈕而不是 div：鍵盤也要能跳過。
         Teleport 到 body —— 全螢幕的 position: fixed 不能住在會被 transform
         的頁面子樹裡（見 MyCardsPage 出貨面板的說明）。 -->
    <Teleport to="body">
    <button
      v-if="!revealed && heroItem"
      type="button" class="emergeWrap"
      aria-label="跳過開卡演出"
      @click="revealed = true"
    >
      <CardEmerge
        :art-id="heroItem.card.artId"
        :image="heroItem.card.image"
        :name="heroItem.card.name"
        :tier="heroItem.tier"
        :pace="emergePace"
        :intensity="emergeIntensity"
        auto
        @done="revealed = true"
      />
      <span class="skipHint mono">
        {{ result.items.length > 1 ? `最高賞 · 其餘 ${result.items.length - 1} 張在下方` : '點一下跳過' }}
      </span>
    </button>
    </Teleport>

    <!-- 明細（3D 之外仍需可讀、可複製的文字資訊） -->
    <ul class="detail" :class="{ in: revealed }">
      <li v-for="(item, i) in result.items" :key="i">
        <Tilt3D :max="12" radius="10px" class="thumb">
          <CardArt :image="item.card.image" :alt="item.card.name" :tier="item.tier" :cert-no="item.card.certNo" :art-id="item.card.artId" />
        </Tilt3D>
        <div class="meta">
          <div class="row">
            <TierBadge :tier="item.tier" />
            <span v-if="item.bonus" class="bonus">最後賞加贈</span>
            <span v-else class="mono seat">籤 #{{ item.ticketSeq }}</span>
          </div>
          <strong>{{ item.card.name }}</strong>
          <CertTag :card="item.card" />
        </div>
      </li>
    </ul>

    <!-- 這一行是重點：卡在抽完的當下就已經寫進卡冊了（後端在同一個交易裡），
         底下那顆按鈕只是帶你過去看。原本的文案是「收進卡冊」，
         讀起來像「要按了才會進去」—— 沒按的人就以為自己抽到的卡不見了。 -->
    <p class="stashed">
      {{ result.items.length > 1 ? `這 ${result.items.length} 張` : '這張' }}已經在你的卡冊裡了，不必再收。
    </p>
    <div class="actions">
      <RouterLink :to="cardbookLink" class="btn primary">去卡冊看這{{ result.items.length > 1 ? '幾' : '' }}張</RouterLink>
      <RouterLink :to="`/pools/${result.poolId}`" class="btn">再抽一次</RouterLink>
    </div>

    <!-- 公平性收成一行連結。原本整段（主張、原理、承諾雜湊、隨機來源）攤在
         結果上方，剛抽完的人要的是看卡，那一大塊把卡推下去而且多半被略過。
         材料一個都沒少，只是搬到驗算頁 —— 想查的人一定會點進去看，
         不想查的人本來就不會讀。
         示範池仍然要當場說清楚不可驗證：把「不需要你信任我們」收起來、
         卻讓人以為這一池可驗證，比原本那一大塊更糟。 -->
    <p v-if="pool" class="proof">
      <RouterLink v-if="!isFixture" :to="`/fairness/${result.poolId}`">
        這一池怎麼證明沒有作弊 →
      </RouterLink>
      <span v-else class="warn">這是示範池，籤序是固定的測試值，無法驗算。</span>
    </p>
  </div>
  <div v-else class="container page">
    <p class="muted">沒有可顯示的抽選結果。<RouterLink to="/pools">去抽選</RouterLink></p>
  </div>
</template>

<style scoped>
/* 公平性收成按鈕下方的一行小字，不跟主要動作搶份量 */
.proof { margin: 14px 0 0; font-size: 12.5px; line-height: 1.7; text-align: center; }
.proof a { color: var(--accent); }
.proof .warn { color: #fcd34d; }

/* 「已經在卡冊裡」的說明。按鈕上方，比按鈕先讀到 */
.stashed {
  margin: 18px 0 0; font-size: 13px; line-height: 1.7; color: var(--muted);
}


/* 煙霧演出：整個視窗。按鈕的預設外觀全部拿掉 —— 它只是為了讓鍵盤能跳過。 */
.emergeWrap {
  position: fixed; inset: 0; z-index: 80;
  padding: 0; border: 0; cursor: pointer;
  background: #05040b;
  overflow: hidden;
}

/* CardEmerge 內部的 shader 座標是綁死 4:5 舞台算出來的
   （見那支元件裡 cardHalf 的說明），改掉比例會讓煙聚出來的卡跟 DOM 那張錯位。
   所以不改它的比例，而是整個放大到「蓋滿視窗」再把超出的裁掉 ——
   煙本來就填滿整個畫面，裁邊看不出來。
   max() 挑較大的那一邊：寬螢幕吃 100vw，窄長的手機吃 100dvh × 4/5。 */
/* 置中方式從 grid 的 place-items 換成絕對定位 + translate。
   **grid 的置中在子元素比容器大時，配上 overflow: hidden 會裁得不對稱** ——
   溢出到起始方向的那一半變成不可及，畫面看起來整個偏右、左邊被切掉。
   393×852 的手機上舞台算出來是 682px 寬，比視窗多 289px，實機就是這樣壞的。
   translate 置中沒有這個問題：兩側各自溢出一樣多，裁掉的也一樣多。 */
.emergeWrap :deep(.emerge) {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: max(100vw, calc(100dvh * 4 / 5));
  border-radius: 0;
}
.emergeWrap .skipHint {
  position: absolute; left: 0; right: 0;
  /* 下面那條給蓄勢演出用的 .skipHint 還帶著 translateX(-50%)，
     而這裡改用 left:0/right:0 置中，兩條疊起來會把整行字往左推半個螢幕寬 ——
     實測 left = -196.5px，字只剩最右邊幾個像素露在畫面上。
     transform 沒有被 left/right 覆蓋掉，得自己歸零。 */
  transform: none;
  bottom: calc(22px + var(--safe-b, 0px));
  font-size: 12px; color: rgba(255, 255, 255, .6); text-align: center;
  text-shadow: 0 1px 6px #000;
}

.page { padding-top: 40px; padding-bottom: 72px; text-align: center; }

/* 蓄勢演出的全畫面舞台 */
.buildupWrap {
  position: fixed; inset: 0; z-index: 80;
  display: block; padding: 0; margin: 0;
  border: none; cursor: pointer;
  background: #05040a;
  /* 演出元件是 position:absolute; inset:0，這裡要有定位上下文 */
  contain: layout;
}
.buildupWrap:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; }
.skipHint {
  position: absolute; left: 50%; bottom: calc(22px + var(--safe-b));
  transform: translateX(-50%);
  font-size: 11.5px; letter-spacing: .14em;
  color: rgba(255, 255, 255, .42);
  pointer-events: none;
}
@media (prefers-reduced-motion: no-preference) {
  /* 提示遲一點才浮出：第一秒不打擾，讓人先看演出 */
  .skipHint { opacity: 0; animation: hint-in .6s ease 1.4s forwards; }
}
@keyframes hint-in { to { opacity: 1; } }
h1 { font-size: 26px; margin: 0; }
.sub { font-size: 12.5px; margin: 6px 0 30px; }
/* 兩欄直向排列。舞台寬度要貼近「2 卡寬 : N 列高」的比例 ——
   太寬時相機會為了框住高度而後退，卡片就被推小、兩側空一大片。 */
.stage { width: 100%; max-width: 430px; margin: 8px auto 4px; }

/* fallback（無 WebGL / 減少動態）用的平面排列 */
.grid.flat { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; align-content: center; height: 100%; }
.grid.flat .slot { width: 150px; }
.grid.flat .face { padding: 8px; }
.grid.flat .info { display: grid; gap: 5px; justify-items: start; padding: 8px 2px 2px; text-align: left; }
.grid.flat .info strong { font-size: 13px; }

/* 明細清單 */
.detail {
  list-style: none; padding: 0;
  margin: 20px auto 0; max-width: 620px;
  display: grid; gap: 10px;
  opacity: 0; transform: translateY(10px);
  transition: opacity .6s ease, transform .6s cubic-bezier(.2,.7,.3,1);
}
.detail.in { opacity: 1; transform: none; }
.detail li {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  text-align: left;
}
.thumb { width: 54px; flex: none; }
.meta { display: grid; gap: 5px; justify-items: start; min-width: 0; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.meta strong { font-size: 14.5px; font-weight: 600; }
.seat { font-size: 12px; color: var(--muted); }
.bonus {
  font-size: 12px; font-weight: 600;
  padding: 2px 10px; border-radius: var(--pill);
  background: var(--accent-wash); color: var(--accent);
}

.actions { display: flex; gap: 12px; justify-content: center; margin-top: 30px; }

@media (max-width: 720px) {
  .page { padding-top: 24px; padding-bottom: 40px; }
  h1 { font-size: 24px; }
  .sub { font-size: 11.5px; margin: 5px 0 14px; }
  .grid.flat { gap: 12px; }
  .grid.flat .slot { width: calc(50% - 6px); max-width: 150px; }
  .detail li { padding: 10px 12px; gap: 11px; }
  .thumb { width: 46px; }
  .meta strong { font-size: 13.5px; line-height: 1.35; }
  .actions { margin-top: 24px; }
  .actions .btn { flex: 1; padding: 11px 8px; font-size: 13.5px; }
}
</style>
