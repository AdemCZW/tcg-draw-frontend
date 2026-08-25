<script setup lang="ts">
/**
 * 開卡演出的試看頁。
 *
 * 為什麼要有這一頁：要看演出本來得真的去抽一次卡，而且抽到什麼賞別
 * 不是你決定的 —— 想看最後賞那一段，可能要抽二十次。改動演出之後
 * 沒辦法快速確認，只能靠截圖。
 *
 * 這一頁把 CardEmerge 的三個輸入攤出來直接播：賞別、速度、強度。
 * 賞別對應的 pace / intensity 是**照抄 DrawResultPage 的那兩張表**，
 * 不是另外編一組 —— 這裡看到的必須跟真的抽到那個賞別時一模一樣，
 * 否則調完在這裡好看、上線卻不是那樣。
 *
 * 沒有掛進任何導覽：它是給開發與驗收用的，不是產品的一部分。
 * 知道網址的人才進得來。
 */
import { computed, ref, useTemplateRef } from 'vue'
import CardEmerge from '@/components/CardEmerge.vue'
import type { Tier } from '@/types/models'

/* 這兩張表必須跟 DrawResultPage 的一致。抄一份而不是共用一個模組，
   是因為那邊是從整批結果推最高賞、這裡是直接指定 —— 共用會逼出一個
   兩邊都不好用的抽象。改了那邊記得改這裡（有測試守不住，只能靠這行註解）。 */
const TIER_RANK: Record<Tier, number> = { BUST: 0, D: 1, C: 2, B: 3, A: 4, LAST: 5 }
const paceOf = (t: Tier) => {
  const r = TIER_RANK[t]
  return r >= 4 ? 1 : r === 3 ? 1.4 : 1.9
}
const intensityOf = (t: Tier) => {
  const r = TIER_RANK[t]
  return r >= 5 ? 1 : r === 4 ? 0.92 : r === 3 ? 0.6 : 0.32
}

/* 示範卡：一個賞別配一張真的抓得到圖的卡，
   不然高賞別播完浮出一個破圖框，看的是演出還是缺圖會分不清楚。 */
const DEMO: { tier: Tier; artId: string; name: string }[] = [
  { tier: 'LAST', artId: 'SV4a-349', name: '噴火龍 ex SAR' },
  { tier: 'A', artId: 'SV8a-217', name: '月亮伊布 ex SAR' },
  { tier: 'B', artId: 'SV4a-347', name: '多龍巴魯托 ex SAR' },
  { tier: 'C', artId: 'SV4a-341', name: '謎擬Ｑ SAR' },
  { tier: 'D', artId: 'SV3-125', name: '哈魯世 SAR' }
]

const tier = ref<Tier>('LAST')
const current = computed(() => DEMO.find(d => d.tier === tier.value) ?? DEMO[0]!)

/* 手動覆寫。預設跟著賞別走（＝上線的真實行為），
   拉桿是給「想單獨看某個參數的影響」用的。 */
const override = ref(false)
const pace = ref(1)
const intensity = ref(1)
const usePace = computed(() => (override.value ? pace.value : paceOf(tier.value)))
const useIntensity = computed(() => (override.value ? intensity.value : intensityOf(tier.value)))

const playing = ref(false)
const elapsed = ref(0)
let t0 = 0
let tick: number | undefined

/* key 換掉就整支重建 —— CardEmerge 的相位是 setTimeout 排的，
   重播不能只呼叫 play()，得讓它從乾淨的狀態重來。 */
const runId = ref(0)
const stage = useTemplateRef<HTMLElement>('stage')

function start() {
  runId.value++
  playing.value = true
  elapsed.value = 0
  t0 = performance.now()
  clearInterval(tick)
  tick = window.setInterval(() => { elapsed.value = performance.now() - t0 }, 50)
  stage.value?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
function stop() {
  playing.value = false
  clearInterval(tick)
}
function onDone() {
  clearInterval(tick)
  // 停在最後一格，長度數字留著給人看
}
</script>

<template>
  <div class="container page">
    <h1>開卡演出試看</h1>
    <p class="muted lead">
      直接指定賞別播一次，不用真的去抽。賞別對應的速度與強度跟線上一致。
    </p>

    <div class="panel card">
      <p class="lbl">賞別</p>
      <div class="tiers" role="radiogroup" aria-label="賞別">
        <button
          v-for="d in DEMO" :key="d.tier"
          type="button" role="radio" :aria-checked="tier === d.tier"
          class="tierBtn" :class="{ on: tier === d.tier }"
          @click="tier = d.tier"
        >{{ d.tier === 'LAST' ? '最後賞' : `${d.tier} 賞` }}</button>
      </div>

      <p class="meta mono">
        {{ current.name }} · 速度 {{ usePace.toFixed(2) }}× · 強度 {{ useIntensity.toFixed(2) }}
        <span v-if="!override" class="tag">跟線上一致</span>
      </p>

      <label class="chk">
        <input type="checkbox" v-model="override">
        <span>手動覆寫速度與強度</span>
      </label>

      <div v-if="override" class="sliders">
        <label>
          <span>速度 {{ pace.toFixed(2) }}×</span>
          <input type="range" min="0.4" max="3" step="0.05" v-model.number="pace">
        </label>
        <label>
          <span>強度 {{ intensity.toFixed(2) }}</span>
          <input type="range" min="0" max="1" step="0.02" v-model.number="intensity">
        </label>
      </div>

      <div class="acts">
        <button type="button" class="btn primary" @click="start">
          {{ playing ? '重播' : '播放' }}
        </button>
        <button type="button" class="btn" :disabled="!playing" @click="stop">停止</button>
        <span v-if="elapsed > 0" class="clock mono">{{ (elapsed / 1000).toFixed(2) }} s</span>
      </div>
    </div>

    <!-- 舞台維持 4:5，跟真實演出同一個比例。
         這裡不用結果頁那種蓋滿視窗的做法 —— 這一頁要能一邊看一邊調參數，
         全螢幕會把控制項蓋掉。 -->
    <div ref="stage" class="stage" :class="{ live: playing }">
      <CardEmerge
        v-if="playing"
        :key="runId"
        :art-id="current.artId"
        :name="current.name"
        :tier="tier"
        :pace="usePace"
        :intensity="useIntensity"
        auto
        @done="onDone"
      />
      <p v-else class="idle muted">按播放</p>
    </div>

    <p class="note muted">
      這一頁沒有掛進導覽，也不影響正式流程。改完演出用它確認，比抽二十次快。
    </p>
  </div>
</template>

<style scoped>
.page { padding-top: 26px; padding-bottom: 60px; max-width: 720px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.lead { font-size: 13.5px; line-height: 1.75; margin: 0 0 16px; }

.panel { padding: 16px; display: grid; gap: 12px; }
.lbl { margin: 0; font-size: 11.5px; letter-spacing: .12em; color: var(--faint); }

/* 五個賞別平分一列。minmax(0,1fr) 不是 1fr：
   子元素的 min-width: auto 會讓「最後賞」那顆把整列撐爆 */
.tiers { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
.tierBtn {
  min-width: 0; min-height: 44px; padding: 8px 4px;
  border: 1px solid var(--line-soft); border-radius: 10px;
  background: transparent; color: var(--muted);
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  white-space: nowrap;
}
.tierBtn.on { background: var(--ink); color: var(--bg); border-color: transparent; }
.tierBtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.meta { margin: 0; min-width: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.meta .tag {
  margin-left: 6px; padding: 2px 7px; border-radius: var(--pill);
  background: var(--ok-wash); color: var(--ok-ink); font-size: 11px;
}

.chk { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.sliders { display: grid; gap: 10px; }
.sliders label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
.sliders input[type="range"] { width: 100%; accent-color: var(--accent); }

.acts { display: flex; align-items: center; gap: 10px; min-width: 0; }
.clock { margin-left: auto; font-size: 13px; color: var(--gold); }

/* 4:5 跟真實舞台同比例。CardEmerge 的 shader 座標綁死這個比例，
   換掉會讓煙聚出來的卡跟 DOM 那張錯位（見那支元件的 cardHalf 說明）。 */
.stage {
  margin-top: 16px; position: relative;
  aspect-ratio: 4 / 5; width: 100%;
  border-radius: var(--radius-lg); overflow: hidden;
  background: #05040b; border: 1px solid var(--line);
  display: grid; place-items: center;
}
.idle { font-size: 13px; }
.note { margin: 14px 0 0; font-size: 12px; line-height: 1.7; }
</style>
