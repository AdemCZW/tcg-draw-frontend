<script setup lang="ts">
// 抽選結果：Three.js 立體開卡演出，下方保留明細清單
import { computed, onMounted, ref } from 'vue'
import { usePoolStore } from '@/stores/pools'
import CardArt from '@/components/CardArt.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import CardReveal3D from '@/components/CardReveal3D.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import RevealBuildup from '@/components/RevealBuildup.vue'
import type { Tier } from '@/types/models'
import { track } from '@/lib/ga'

const pools = usePoolStore()
const result = pools.lastResult
const revealed = ref(false)

/* ---- 開卡前的蓄勢演出 ----
   整批抽選用「最高賞」的那支編排：一抽裡有 A 賞，就播豪華球的戲。
   這是誠實的 —— 演出等級對應真的開出來的東西，不是先假裝再降級。
   演出蓋在全畫面上，播完（或被跳過）才露出 3D 開卡。 */
const TIER_RANK: Record<Tier, number> = { BUST: 0, D: 1, C: 2, B: 3, A: 4, LAST: 5 }
const bestTier = computed<Tier>(() => {
  if (!result?.items.length) return 'D'
  return result.items.reduce<Tier>((best, it) =>
    TIER_RANK[it.tier] > TIER_RANK[best] ? it.tier : best, 'D')
})
/* 動態偏好關動效的人直接看結果，不必先等一支動畫 */
const reduceMotion = typeof matchMedia !== 'undefined'
  && matchMedia('(prefers-reduced-motion: reduce)').matches
const buildupDone = ref(reduceMotion || !result)
function skipBuildup() { buildupDone.value = true }

/* 開獎當下是使用者最會懷疑「這是不是喬過的」的時刻，
   驗算入口放在這裡比藏在說明頁有意義得多。 */
const pool = computed(() => (result ? pools.byId(result.poolId) : undefined))
const shortHash = computed(() => {
  const h = pool.value?.commitHash
  return h ? `${h.slice(0, 12)}…${h.slice(-8)}` : ''
})
const copied = ref(false)
async function copyHash() {
  const h = pool.value?.commitHash
  if (!h) return
  try {
    await navigator.clipboard.writeText(h)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1800)
  } catch { /* 剪貼簿被拒也不影響驗算，使用者仍可從驗算頁複製 */ }
}

// 兩張並排往下排：舞台高度隨列數成長，讓每張卡維持可辨識的大小
const rows = computed(() => Math.ceil((result?.items.length ?? 1) / 2))
const stageHeight = computed(() => 300 + (rows.value - 1) * 250)

onMounted(() => {
  track('view_prize_result')
  /* 保險絲：明細清單原本只在 3D 演出發出 revealed 後才淡入，
     但 WebGL 中途失敗、或分頁在背景導致 rAF 暫停時，那個事件永遠不會來，
     使用者就再也看不到自己抽到什麼。時間到就強制顯示。 */
  setTimeout(() => { revealed.value = true; buildupDone.value = true }, 14000)
})
</script>

<template>
  <div class="container page" v-if="result">
    <!-- 蓄勢演出：全畫面覆蓋，播完自動退場；點一下任何地方直接跳到結果。
         按鈕而不是 div：鍵盤 Enter/Space 也要能跳過。 -->
    <button
      v-if="!buildupDone"
      type="button"
      class="buildupWrap"
      aria-label="跳過開卡演出"
      @click="skipBuildup"
    >
      <RevealBuildup :tier="bestTier" auto @done="skipBuildup" />
      <span class="skipHint mono">點一下跳過</span>
    </button>

    <h1 class="display">抽選結果</h1>
    <p class="muted sub mono">draw {{ result.drawId }} · 共 {{ result.items.length }} 抽 · {{ result.cost.toLocaleString() }} 點</p>
    <!-- 3D 開卡舞台 -->
    <div class="stage" :style="{ height: stageHeight + 'px' }">
      <CardReveal3D v-if="buildupDone" :items="result.items" @revealed="revealed = true">
        <template #fallback>
          <div class="grid flat">
            <div v-for="(item, i) in result.items" :key="i" class="slot">
              <div class="face card">
                <CardArt :image="item.card.image" :alt="item.card.name" :tier="item.tier" :cert-no="item.card.certNo" />
                <div class="info"><TierBadge :tier="item.tier" /><strong>{{ item.card.name }}</strong></div>
              </div>
            </div>
          </div>
        </template>
      </CardReveal3D>
    </div>

    <!-- 明細（3D 之外仍需可讀、可複製的文字資訊） -->
    <ul class="detail" :class="{ in: revealed }">
      <li v-for="(item, i) in result.items" :key="i">
        <Tilt3D :max="12" radius="10px" class="thumb">
          <CardArt :image="item.card.image" :alt="item.card.name" :tier="item.tier" :cert-no="item.card.certNo" />
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

    <!-- 公平性：不要求信任，直接給驗算材料 -->
    <section v-if="pool" class="verify">
      <p class="claim">這個結果<strong>不需要你信任我們</strong></p>
      <p class="how">
        籤序在開賣前就已洗好封存，當時公布的承諾雜湊如下。
        完抽後我們公開種子，你可以自己重算一次，比對是否相符。
      </p>
      <dl class="facts">
        <div>
          <dt>承諾雜湊 SHA-256</dt>
          <dd>
            <button type="button" class="hash mono" @click="copyHash" :aria-label="copied ? '已複製' : '複製完整雜湊'">
              {{ shortHash }}<span class="copy">{{ copied ? '已複製' : '複製' }}</span>
            </button>
          </dd>
        </div>
        <div>
          <dt>隨機來源</dt>
          <dd class="mono src">{{ pool.clientSeedSource }}</dd>
        </div>
      </dl>
      <RouterLink :to="`/fairness/${result.poolId}`" class="btn verify-btn">自己驗算這一池 →</RouterLink>
    </section>

    <div class="actions">
      <RouterLink to="/me/cards" class="btn primary">收進卡冊</RouterLink>
      <RouterLink :to="`/pools/${result.poolId}`" class="btn">再抽一次</RouterLink>
    </div>
  </div>
  <div v-else class="container page">
    <p class="muted">沒有可顯示的抽選結果。<RouterLink to="/pools">去抽選</RouterLink></p>
  </div>
</template>

<style scoped>
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
/* 公平性區塊 —— 刻意不做淡入、不依賴 3D 演出完成。
   信任訊息如果會因為動畫沒跑完就消失，那它就不是可信的。 */
.verify {
  max-width: 620px; margin: 26px auto 0;
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  text-align: left;
}
.claim { margin: 0; font-size: 15.5px; }
.claim strong { color: var(--accent); }
.how { margin: 7px 0 0; font-size: 13.5px; color: var(--muted); line-height: 1.62; }
.facts {
  display: grid; gap: 10px;
  margin: 15px 0 0; padding-top: 14px;
  border-top: 1px dashed var(--line);
}
.facts div { display: grid; gap: 3px; }
.facts dt { font-size: 11.5px; color: var(--faint); font-weight: 600; }
.facts dd { margin: 0; min-width: 0; }
.hash {
  display: inline-flex; align-items: center; gap: 9px;
  max-width: 100%;
  padding: 5px 10px 5px 12px;
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  font-size: 12.5px;
  overflow: hidden;
}
.hash .copy {
  flex: none;
  font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
  color: var(--accent);
  padding-left: 9px;
  border-left: 1px solid var(--line);
}
.hash:hover { border-color: var(--accent); }
.hash:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.src { font-size: 12.5px; color: var(--muted); }
.verify-btn { margin-top: 15px; width: 100%; }

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
