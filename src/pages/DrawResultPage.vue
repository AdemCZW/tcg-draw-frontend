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
import RevealBuildup from '@/components/RevealBuildup.vue'
import type { Tier } from '@/types/models'
import { track } from '@/lib/ga'

const route = useRoute()
const pools = usePoolStore()
/* 依網址的 drawId 取，不是拿 store 裡「最後一筆」——
   reload 後 store 是空的，但 sessionStorage 還有；
   而且兩個分頁各抽一次時，網址才是唯一可靠的鍵。 */
const result = pools.resultById(String(route.params.drawId))
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
/* 煙霧演出的主角：最高賞的那一張。同賞別時取第一張 */
const heroItem = computed(() =>
  result?.items.length
    ? result.items.reduce((best, it) => TIER_RANK[it.tier] > TIER_RANK[best.tier] ? it : best, result.items[0]!)
    : null)

/* 演出速度依賞別調。最高賞看完整段，低賞加速 ——
   每抽一張 D 賞都播滿八秒只會讓人想關掉。
   這跟 RevealBuildup 的分級是同一個原則：演出對應真的開出來的東西。 */
const emergePace = computed(() => {
  const r = TIER_RANK[bestTier.value]
  return r >= 4 ? 1 : r === 3 ? 1.4 : 1.9
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
/* 種子池用 fixture:<池id> 當來源（seed 不能等 drand 兩分鐘）。
   那些池的結果不具備對外驗證的意義，畫面要講實話。 */
const isFixture = computed(() => (pool.value?.clientSeedSource ?? '').startsWith('fixture:'))

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

onMounted(() => {
  track('view_prize_result')
  /* 保險絲：明細清單原本只在 3D 演出發出 revealed 後才淡入，
     但 WebGL 中途失敗、或分頁在背景導致 rAF 暫停時，那個事件永遠不會來，
     使用者就再也看不到自己抽到什麼。時間到就強制顯示。 */
  setTimeout(() => { revealed.value = true; buildupDone.value = true }, 16000)
})
</script>

<template>
  <div class="container page" v-if="result">
    <!-- 蓄勢演出：全畫面覆蓋，播完自動退場；點一下任何地方直接跳到結果。
         按鈕而不是 div：鍵盤 Enter/Space 也要能跳過。 -->
    <!-- 全畫面覆蓋，必須 Teleport 到 body：換頁轉場會在 .page 上加 transform，
         祖先有 transform 時 position: fixed 會改以那個祖先為基準而錯位 -->
    <Teleport to="body">
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
    </Teleport>

    <h1 class="display">抽選結果</h1>
    <p class="muted sub mono">draw {{ result.drawId }} · 共 {{ result.items.length }} 抽 · {{ result.cost.toLocaleString() }} 點</p>
    <!-- 煙霧凝聚：只播最高賞那張，播完（或被點掉）就揭曉全部。
         按鈕而不是 div：鍵盤也要能跳過。 -->
    <button
      v-if="buildupDone && !revealed && heroItem"
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
        auto
        @done="revealed = true"
      />
      <span class="skipHint mono">
        {{ result.items.length > 1 ? `最高賞 · 其餘 ${result.items.length - 1} 張在下方` : '點一下跳過' }}
      </span>
    </button>

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

    <!-- 公平性：不要求信任，直接給驗算材料 -->
    <section v-if="pool" class="verify">
      <p class="claim">這個結果<strong>不需要你信任我們</strong></p>
      <!-- 這段原本寫「籤序在開賣前就已洗好封存，當時公布的承諾雜湊如下」，
           意思是承諾涵蓋的是籤序 —— 但 commitOf() 雜湊的是 server seed。
           講錯自己的機制比不講更傷：懂的人一驗就發現對不上。 -->
      <p class="how">
        開賣前我們就公布了種子的雜湊，但不公布種子本身。籤序由那組種子決定，
        所以雜湊一旦公布，我們就改不動籤序而不被發現。完抽後種子會公開，
        你可以在自己的瀏覽器重算一次。
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
          <!-- 示範資料的來源字串是 fixture:<池id>，那不是真的第三方隨機。
               直接把它原樣印出來，會在「不需要你信任我們」正下方
               擺一個字面寫著 fixture 的值 —— 那是自相矛盾。
               老實標示它是示範池，比假裝它可驗證好。 -->
          <dd v-if="isFixture" class="mono src warn">示範池 · 非正式隨機來源</dd>
          <dd v-else class="mono src">{{ pool.clientSeedSource }}</dd>
        </div>
      </dl>
      <RouterLink v-if="!isFixture" :to="`/fairness/${result.poolId}`" class="btn verify-btn">自己驗算這一池 →</RouterLink>
      <p v-else class="fixnote">
        這是示範池，種子與籤序是固定的測試值，驗算頁對它沒有意義。
        正式開的池會鎖定 drand 的未來輪次，那時這裡會是可驗證的。
      </p>
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
.src.warn { color: #fcd34d; }
.fixnote { font-size: 12px; line-height: 1.7; color: var(--muted); margin: 10px 0 0; }

/* 煙霧演出的容器。按鈕的預設外觀全部拿掉 —— 它只是為了讓鍵盤能跳過 */
.emergeWrap {
  display: block; width: 100%; max-width: 460px; margin: 0 auto 18px;
  padding: 0; border: 0; background: none; cursor: pointer;
  position: relative;
}
.emergeWrap .skipHint {
  display: block; margin-top: 10px;
  font-size: 12px; color: var(--muted); text-align: center;
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
