<script setup lang="ts">
/**
 * 收藏家徽章比較頁（未列在導覽，網址直達：/design/collector）
 * 比照 /design/pack：五個等級、兩種尺寸一次攤開，改配色時能立刻看出哪裡不對。
 */
import CollectorBadge from '@/components/CollectorBadge.vue'
import { COLLECTOR_LEVELS } from '@/shared/collector'
</script>

<template>
  <div class="container page">
    <h1>收藏家等級</h1>
    <p class="muted lead">收藏積分跟錢包點數是兩回事，不能花也不能轉讓。登記一張鑑定卡、在站內買到一張卡各加 1 分。</p>
    <table class="tbl">
      <thead>
        <tr><th>等級</th><th>門檻</th><th>小</th><th>中</th></tr>
      </thead>
      <tbody>
        <tr v-for="d in COLLECTOR_LEVELS" :key="d.level">
          <td class="mono">{{ d.level }}</td>
          <td class="mono">{{ d.min }} 分</td>
          <td><CollectorBadge :level="d.level" /></td>
          <td><CollectorBadge :level="d.level" size="md" /></td>
        </tr>
      </tbody>
    </table>
    <h2>只有圖形</h2>
    <div class="row">
      <CollectorBadge v-for="d in COLLECTOR_LEVELS" :key="d.level" :level="d.level" :show-name="false" />
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 20px; padding-bottom: 72px; max-width: 640px; }
h1 { font-size: 20px; margin: 0 0 6px; }
h2 { font-size: 15px; margin: 22px 0 10px; }
.lead { font-size: 13px; line-height: 1.7; margin: 0 0 14px; }
.tbl { width: 100%; border-collapse: collapse; table-layout: fixed; }
.tbl th, .tbl td { padding: 8px 4px; border-bottom: 1px solid var(--line-soft); text-align: left; font-size: 12.5px; vertical-align: middle; }
.tbl th:nth-child(1), .tbl td:nth-child(1) { width: 40px; }
.tbl th:nth-child(2), .tbl td:nth-child(2) { width: 62px; }
.tbl td { overflow: hidden; }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
</style>
