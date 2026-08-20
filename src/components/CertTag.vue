<script setup lang="ts">
/**
 * 鑑定標籤。
 *
 * 判斷「鑑定過沒有」看的是 grader/grade，不是 certNo ——
 * 原本用 certNo 判斷，於是一張有 PSA 10 但手上沒有編號的卡會被畫成
 * 「RAW · 未鑑定」。把鑑定卡講成生卡是實質錯誤，比少顯示一個編號嚴重得多：
 * 公開卡冊、分享頁這些對外的地方本來就拿不到 certNo（那是持有人的資料）。
 *
 * prop 收窄成只要三個欄位，不要求整個 CardItem：公開卡冊只拿得到這三個，
 * 為了滿足型別去補 setCode / cardNo / language 這種假值反而會騙到下一個人。
 * 三個欄位都收 null 與 undefined —— CardItem 用 null 表示「沒有」，
 * 公開卡冊的 JSON 則是整個欄位不存在，兩種都要吃得下。
 */
defineProps<{
  card: {
    grader?: string | null
    grade?: number | null
    certNo?: string | null
  }
}>()
</script>

<template>
  <span v-if="card.grader && card.grade != null" class="cert mono">
    {{ card.grader }} {{ card.grade }}
    <!-- 編號拿得到才顯示。沒有編號不代表沒鑑定，只代表這個畫面看不到 -->
    <em v-if="card.certNo">#{{ card.certNo }}</em>
  </span>
  <span v-else class="cert mono raw">RAW · 未鑑定</span>
</template>

<style scoped>
.cert {
  display: inline-flex; gap: 6px; align-items: baseline;
  font-size: 11.5px; padding: 3px 10px;
  border-radius: var(--pill);
  background: color-mix(in srgb, var(--gold) 14%, transparent);
  color: var(--gold-deep);
  white-space: nowrap;
}
.cert em { font-style: normal; color: color-mix(in srgb, var(--gold-deep) 65%, var(--muted)); }
.cert.raw { background: var(--surface-2); color: var(--muted); }
</style>
