<script setup lang="ts">
/**
 * 煙霧凝聚特效的獨立調校頁。
 *
 * 從 /design/pack 拆出來的原因不只是版面：那一頁有寶貝球的示範，
 * 每個示範都吃 GPU，跟這支 shader 擠在同一頁的時候量到的幀率不是這支的幀率。
 * 要調動畫就得讓畫面上只有它。
 */
import { computed, ref } from 'vue'
import type { Tier } from '@/types/models'
import CardEmerge from '@/components/CardEmerge.vue'

const CARDS: { tier: Tier; artId: string; name: string }[] = [
  { tier: 'LAST', artId: 'SV4a-349', name: '噴火龍 ex UR' },
  { tier: 'A', artId: 'SV4a-350', name: '奇樹 SAR' },
  { tier: 'B', artId: 'SV8a-237', name: '太樂巴戈斯 ex UR' },
  { tier: 'C', artId: 'SV8a-217', name: '月亮伊布 ex SAR' },
  { tier: 'D', artId: 'SV4a-341', name: '謎擬Ｑ SAR' }
]

const pick = ref(0)
const runKey = ref(0)
const current = computed(() => CARDS[pick.value])

/* 一次性演出要重播只能重新掛載 —— 同一個節點上重設 CSS 動畫不會重跑。 */
function replay(i?: number) {
  if (i !== undefined) pick.value = i
  runKey.value++
}

const slow = new URLSearchParams(location.search).get('fxslow')
</script>

<template>
  <section class="wrap">
    <h1>煙霧凝聚</h1>
    <p class="note">
      煙從四個邊慢慢往內聚攏、圍成一片，接著往卡片的位置堆積，
      先堆出一張<strong>煙做的卡</strong>（這時還沒有圖案），
      圖案才在堆好的煙上一塊一塊顯影。先有形，後有圖。
    </p>

    <div class="stage">
      <CardEmerge
        :key="runKey"
        :tier="current.tier"
        :art-id="current.artId"
        :name="current.name"
      />
    </div>

    <div class="ctl">
      <button
        v-for="(c, i) in CARDS" :key="c.artId"
        type="button" class="btn sm"
        :class="{ primary: pick === i }"
        @click="replay(i)"
      >{{ c.tier === 'LAST' ? '最後賞' : c.tier + ' 賞' }}</button>
      <button type="button" class="btn sm" @click="replay()">↻ 重播</button>
    </div>

    <p class="hint">
      目前：{{ current.name }}<span v-if="slow"> · 慢速 {{ slow }}×</span>
    </p>
    <p class="hint">
      逐格看細節可以在網址加 <code>?fxslow=5</code> 把整段放慢；
      <code>?nogl=1</code> 強制走沒有 WebGL 的替代版。
    </p>
  </section>
</template>

<style scoped>
.wrap {
  padding: 20px 16px calc(28px + var(--safe-b, 0px));
  max-width: 520px;
  margin: 0 auto;
}
h1 { font-size: 22px; margin: 0 0 10px; }
.note { font-size: 14px; line-height: 1.75; color: var(--muted); margin: 0 0 20px; }
.note strong { color: var(--ink); font-weight: 700; }

.stage { width: 100%; margin-bottom: 16px; }

.ctl { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.ctl .btn.sm { padding: 8px 14px; font-size: 13px; }

.hint { font-size: 12.5px; line-height: 1.7; color: var(--muted); margin: 0 0 6px; }
.hint code {
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--surface-3);
}
</style>
