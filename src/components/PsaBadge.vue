<script setup lang="ts">
/**
 * PSA 查證狀態徽章。
 *
 * 'verified' → 一個連到 PSA 官方 cert 頁的膠囊，讓買家可以自己去對。
 *   我們**不轉存 PSA 的照片**（EULA 未確認，見 docs/psa-api-access.md），
 *   所以「證明這張卡是真的」這件事靠的是把人導到 PSA 官網、而不是搬圖過來。
 * 'pending'  → 一段灰字「暫無法驗證」。目前 PSA API 待核准，鑑定卡多半落在這裡，
 *   所以這個狀態要講得中性、不要讓人以為是賣家有問題。
 *
 * 手機不放 emoji（見 docs/HANDOFF.md）：勾勾用 inline SVG 畫。
 * grade 由呼叫端傳進來（就是賣家宣告、且已被 PSA 對上的分數），
 * 不自己去查 —— 這個元件不打 API。
 */
defineProps<{
  status?: 'verified' | 'pending' | null
  certNo?: string | null
  grade?: number | null
}>()
</script>

<template>
  <a
    v-if="status === 'verified' && certNo"
    class="psa ok"
    :href="`https://www.psacard.com/cert/${encodeURIComponent(certNo)}`"
    target="_blank"
    rel="noopener noreferrer"
  >
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span>已向 PSA 查證<template v-if="grade != null"> · PSA {{ grade }}</template> · 編號 {{ certNo }}</span>
  </a>
  <span v-else-if="status === 'pending'" class="psa pending">
    PSA 暫無法驗證（未驗證）
  </span>
</template>

<style scoped>
.psa {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; padding: 3px 9px;
  border-radius: var(--pill);
  white-space: nowrap; max-width: 100%;
  min-width: 0;
}
.psa.ok {
  background: var(--ok-wash);
  color: var(--ok-ink);
  text-decoration: none;
}
.psa.ok span {
  /* 編號可能很長，窄欄要縮得下不要撐爆（grid 子元素預設 min-width: auto） */
  overflow: hidden; text-overflow: ellipsis;
}
.psa.ok svg { flex: 0 0 auto; }
.psa.pending {
  background: var(--surface-2);
  color: var(--faint);
}
</style>
