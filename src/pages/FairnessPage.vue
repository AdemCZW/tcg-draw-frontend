<script setup lang="ts">
import { onMounted } from 'vue'
import { track } from '@/lib/ga'
onMounted(() => track('view_fairness_page'))

/* 這三段原本寫錯，而且錯得剛好把實際做法講成了比較弱的版本：
   第一段說承諾的是「洗牌後的完整籤序」（實際是 server seed 本身的 SHA-256），
   第二段說亂數來自「比特幣區塊 hash」（實際是 drand）。
   後者差別很大 —— 區塊 hash 是礦工算出來的、理論上可被影響，
   而 drand 是 League of Entropy 的門檻簽章信標，任何人都能獨立驗證某一輪的值。
   文案講錯自己的機制，比沒有文案更傷：懂的人會發現對不上。 */
const steps = [
  {
    t: '開池前：承諾（Commit）',
    d: '我們產生一組 server seed，公布它的 SHA-256，但不公布 seed 本身。籤序由這組 seed 決定，所以一旦公布了這個 hash，我們就改不動籤序而不被發現。'
  },
  {
    t: '開賣時：鎖定外部亂數（Client seed）',
    d: '開池的當下，我們鎖定 drand（League of Entropy）一個「還沒發生」的未來輪次。那一輪的值在承諾當下全世界都還不知道，包括我們 —— 所以我們無法挑一組對自己有利的籤序。輪次編號一併公布，事後誰都能去 drand 對答案。'
  },
  {
    t: '完抽後：揭示（Reveal）',
    d: '公開 server seed 與完整籤序。任何人都能在自己的瀏覽器重跑一次洗牌：先驗 seed 的 SHA-256 是否等於開賣前那個 hash，再用 seed 與 drand 的值重算籤序，逐一比對。'
  }
]
</script>

<template>
  <div class="container page">
    <h1 class="display">公平性驗證</h1>
    <p class="lead muted">不是「相信我們」，是「自己算一次」。</p>
    <ol class="steps">
      <li v-for="(s, i) in steps" :key="i" class="card">
        <span class="n mono">{{ i + 1 }}</span>
        <div>
          <h3>{{ s.t }}</h3>
          <p class="muted">{{ s.d }}</p>
        </div>
      </li>
    </ol>
    <div class="verify card holo-edge">
      <h3>自助驗算</h3>
      <!-- 「完抽」與「開獎」是兩個狀態，中間隔著一段等待：籤抽完了
           （sold_out）種子還沒公開，這一頁算不動。列得出 seed 的是
           已開獎（revealed）的池，所以這兩句話要講已開獎，不是完抽。 -->
      <p class="muted">已開獎的池會在此列出 seed 與籤序，可下載驗算腳本或直接在瀏覽器計算 hash。</p>
      <RouterLink to="/pools" class="btn">找一個已開獎的池 →</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 48px; padding-bottom: 72px; max-width: 680px; }
h1 { font-size: 26px; margin: 0 0 6px; }
.lead { font-size: 15px; margin: 0 0 28px; }
.steps { list-style: none; margin: 0 0 28px; padding: 0; display: grid; gap: 12px; }
.steps li { display: flex; gap: 16px; padding: 18px 20px; }
.n { font-size: 20px; color: var(--holo-b); flex: none; }
h3 { margin: 0 0 4px; font-size: 15px; }
p { margin: 0; font-size: 13.5px; }
.verify { padding: 20px; display: grid; gap: 10px; justify-items: start; border-radius: var(--radius-lg); }
</style>
