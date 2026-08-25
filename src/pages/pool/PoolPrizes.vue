<script setup lang="ts">
/**
 * 池 · 獎項與剩餘。
 *
 * 除了獎項表，這裡多了兩塊本來算得出來卻從來沒呈現的資訊：
 *
 * 1. **即時機率**。定量池的中獎率不是設定值，是組成的衍生結果，
 *    而且會隨銷售改變 —— 剩 40 籤而最後賞還沒出，就是 1/40。
 *    這是買家最想知道的事，也是公平會處理原則裡「機會中獎商品的機率」所指的東西。
 * 2. **保底回饋率**。Σ(賣家宣告的買回價 × 數量) ÷ 票收。
 *    分子是賣家有義務付出去的錢，不是他標示的市值 —— 那個數字沒有外部依據，
 *    賣家填高就一起說謊（docs/HANDOFF.md 4.1）。同業幾乎沒有人公開任何一種。
 *
 * 獎項表裡每一列都帶「買回價」，而且**在抽卡之前就看得到** ——
 * 抽完才知道能買回多少就是釣魚。
 */
import { computed } from 'vue'
import type { Pool } from '@/types/models'
import PrizeTable from '@/components/PrizeTable.vue'
import TierBadge from '@/components/TierBadge.vue'
import { tierOdds, oddsText, poolFloor } from '@/lib/pool-odds'
import { FLOOR_RATIO_LABEL, FLOOR_RATIO_MEANING } from '@/shared/economics'
import type { Tier } from '@/types/models'

const props = defineProps<{ pool: Pool }>()

const odds = computed(() => tierOdds(props.pool))
const floor = computed(() => poolFloor(props.pool))

/**
 * 這個池最差的賞別保底買回多少。
 *
 * 為什麼要有這一句：百分比是抽象的，「500 點一抽、最差保底買回 120 點」
 * 是具體的，而且問的正是玩家真正在意的事 —— 最壞的情況長什麼樣。
 * 這句話的資料一直都算得出來，只是以前的「回收價」是 refPrice × 比率，
 * 講出來的數字沒有人有義務履行，所以不能講。現在可以了。
 */
const worst = computed(() => {
  const withBuyback = props.pool.prizes.filter(p => p.buyback != null && p.buyback > 0)
  if (!withBuyback.length) return null
  return withBuyback.reduce((m, p) => (p.buyback! < m.buyback! ? p : m))
})
const tierText = (t: string) => (t === 'BUST' ? '爆賞' : t === 'LAST' ? '最後賞' : t + ' 賞')
const asTier = (t: string) => t as Tier
/* 開賣前與開獎後都不該顯示「現在抽中的機率」——
   前者還沒開始賣、後者已經沒得抽了 */
const live = computed(() => props.pool.status === 'open' && props.pool.remainingTickets > 0)
</script>

<template>
  <div class="pz">
    <h2 class="sr-only">獎項與剩餘</h2>

    <section v-if="live" class="card odds">
      <header>
        <h3>現在抽中的機率</h3>
        <span class="muted">剩 <strong class="mono">{{ pool.remainingTickets }}</strong> 籤</span>
      </header>
      <ul>
        <li v-for="o in odds" :key="o.tier" :class="{ gone: o.remaining === 0 }">
          <TierBadge :tier="asTier(o.tier)" />
          <span class="mono n">剩 {{ o.remaining }}</span>
          <span class="mono p">{{ oddsText(o) }}</span>
        </li>
      </ul>
      <p class="muted fine">
        這是<strong>定量池</strong>：獎品數量固定，抽走一張就少一張，
        所以機率會隨著銷售改變 —— 不是一個固定的中獎率。
      </p>
    </section>

    <section v-if="floor" class="card ret" :class="floor.verdict">
      <div class="rrow">
        <span class="muted lbl">{{ FLOOR_RATIO_LABEL }}</span>
        <strong class="mono val">{{ floor.ratio.toFixed(1) }}%</strong>
      </div>
      <p v-if="worst" class="plain">
        <strong class="mono">{{ pool.ticketPrice.toLocaleString() }} 點一抽，最差的{{ tierText(worst.tier) }}保底買回 {{ worst.buyback!.toLocaleString() }} 點。</strong>
      </p>
      <p class="muted fine">
        {{ FLOOR_RATIO_MEANING }}
        每個獎品的買回價都在下面的表裡，<strong>開賣前就鎖死了</strong> ——
        它被寫進公平性承諾的雜湊，賣家事後改不了。
      </p>
    </section>

    <!-- 舊池：沒有宣告過買回價。照實說，不要拿參考價湊一個數字出來 -->
    <section v-else class="card ret legacy">
      <div class="rrow">
        <span class="muted lbl">{{ FLOOR_RATIO_LABEL }}</span>
        <strong class="mono val na">未宣告</strong>
      </div>
      <p class="muted fine">
        這一池是買回制上線之前開的，賣家<strong>沒有宣告任何買回價</strong>，
        抽到的卡不能換回點數。
        <template v-if="pool.returnRatio != null">
          它當初公布的是「還元率 {{ pool.returnRatio.toFixed(1) }}%」，
          那個數字的分子是<strong>賣家自己標示的市值</strong>，不是他有義務付出的金額。
        </template>
      </p>
    </section>

    <PrizeTable :pool="pool" />
  </div>
</template>

<style scoped>
.pz { display: grid; gap: 14px; }

.odds { padding: 14px 16px; }
.odds header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.odds h3 { font-size: 15px; margin: 0; }
.odds header span { margin-left: auto; font-size: 12.5px; }
.odds ul { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.odds li { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
.odds li.gone { opacity: .45; }
.odds .n { flex: none; color: var(--muted); font-size: 12.5px; }
.odds .p { margin-left: auto; font-variant-numeric: tabular-nums; }

.ret { padding: 12px 16px; }
.rrow { display: flex; align-items: baseline; gap: 10px; }
.rrow .lbl { font-size: 13px; }
.rrow .val { margin-left: auto; font-size: 20px; }
/* 顏色只在「值得留意」時才出現。ok 用中性色 —— 每個池都染色等於沒有訊息 */
.ret.thin .val { color: var(--warn, #fcd34d); }
.ret.mint .val, .ret.predatory .val { color: var(--danger); }
.ret .val.na { color: var(--faint); font-size: 16px; }

.plain { font-size: 13.5px; line-height: 1.7; margin: 10px 0 6px; }
.plain strong { color: var(--ink); }
.fine { font-size: 12px; line-height: 1.7; margin: 0; }
.fine strong { color: var(--ink); }
</style>
