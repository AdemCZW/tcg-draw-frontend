<script setup lang="ts">
import { onMounted } from 'vue'
import { track } from '@/lib/ga'
onMounted(() => track('view_fairness_page'))

const steps = [
  { t: '開池前：承諾（Commit）', d: '我們產生 server seed，將洗牌後的完整籤序做 SHA-256，並在開賣前公布這個 hash。此後籤序不可能被更動而不被發現。' },
  { t: '開賣時：外部亂數（Client seed）', d: '洗牌種子混入未來的比特幣區塊 hash。承諾當下沒有人知道這個值，因此我們無法挑選對自己有利的籤序。' },
  { t: '完抽後：揭示（Reveal）', d: '公開 server seed 與原始籤序。任何人都能自行計算 SHA-256，比對開賣前公布的 hash 是否一致。' }
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
      <p class="muted">完抽的池會在此列出 seed 與籤序，可下載驗算腳本或直接在瀏覽器計算 hash。</p>
      <RouterLink to="/pools" class="btn">找一個已完抽的池 →</RouterLink>
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
