<script setup lang="ts">
/**
 * 池 · 獎項與剩餘。
 *
 * 除了獎項表，這裡多了兩塊本來算得出來卻從來沒呈現的資訊：
 *
 * 1. **即時機率**。定量池的中獎率不是設定值，是組成的衍生結果，
 *    而且會隨銷售改變 —— 剩 40 籤而最後賞還沒出，就是 1/40。
 *    這是買家最想知道的事，也是公平會處理原則裡「機會中獎商品的機率」所指的東西。
 * 2. **還元率**。獎品總值 ÷ 票收。同業幾乎沒有人公開它。
 */
import { computed } from 'vue'
import type { Pool } from '@/types/models'
import PrizeTable from '@/components/PrizeTable.vue'
import TierBadge from '@/components/TierBadge.vue'
import { tierOdds, oddsText, poolReturn } from '@/lib/pool-odds'
import type { Tier } from '@/types/models'

const props = defineProps<{ pool: Pool }>()

const odds = computed(() => tierOdds(props.pool))
const ret = computed(() => poolReturn(props.pool))
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

    <section class="card ret" :class="ret.verdict">
      <div class="rrow">
        <span class="muted lbl">還元率</span>
        <strong class="mono val">{{ ret.ratio.toFixed(1) }}%</strong>
      </div>
      <p class="muted fine">
        獎品市值總和 ÷ 全部籤的票收。
        <template v-if="ret.stored">這是開賣當下算的，之後行情浮動也不會改。</template>
        <template v-else>這一池沒有存下開賣當下的數字，這是用目前的參考價現算的。</template>
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
.ret.thin .val, .ret.loss .val { color: var(--warn, #fcd34d); }
.ret.predatory .val { color: var(--danger); }

.fine { font-size: 12px; line-height: 1.7; margin: 0; }
.fine strong { color: var(--ink); }
</style>
