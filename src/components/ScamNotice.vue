<script setup lang="ts">
/**
 * 顯示賣家聯絡方式時一定要跟著出現的防詐提醒 ＋ 檢舉入口。
 *
 * ── 為什麼需要 ────────────────────────────────────────────────────
 * 第一階段平台不經手款項，買賣雙方拿到聯絡方式之後會自己談。最常見的騙法
 * 正是從這一步開始：用 LINE 把買家帶去站外匯款，收到錢就消失。
 * 那一刻買家眼前唯一的站內畫面，就是印著賣家 LINE ID 的這一塊 ——
 * 提醒不在這裡講，就沒有別的地方講得到了。
 *
 * ── 為什麼抽成元件 ────────────────────────────────────────────────
 * 同一句提醒只要在兩個地方各寫一份，改措辭時一定漏一邊，而且檢舉連結帶的
 * 參數也會分岔。所以凡是會亮出聯絡方式的地方，都掛這一顆。
 *
 * ── 語氣 ─────────────────────────────────────────────────────────
 * 刻意寫短、寫白話、不寫「詐騙」兩個字：買家大多數時候面對的是正常賣家，
 * 一整塊紅色警告會讓他懷疑眼前這個人，或乾脆養成略過黃框的習慣。
 * 手機 375px 上不超過兩行。
 *
 * ── 檢舉入口為什麼是工單 ─────────────────────────────────────────
 * 站上已經有客服工單，客服端也只看那一個佇列；另開一條檢舉管道等於多一個
 * 沒人盯的收件匣。所以這裡只是把人帶到開單頁，並用 query 帶上**識別碼**
 * （訂單編號、賣家編號）。聯絡方式本身絕對不進網址 —— 網址會進瀏覽紀錄、
 * 會被轉貼、會進伺服器存取紀錄，客服拿訂單編號就查得到賣家留了什麼。
 */
defineProps<{
  orderId: string
  sellerId: string
}>()
</script>

<template>
  <div class="scam" data-testid="scam-notice">
    <p class="scamT">確認身分與卡片再匯款；平台不經手站外付款，也無法追回。</p>
    <RouterLink
      class="scamGo"
      :to="{ name: 'support-new', query: { kind: 'other', report: 'seller', order: orderId, seller: sellerId } }"
      data-testid="report-seller"
    >
      檢舉這個賣家
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </RouterLink>
  </div>
</template>

<style scoped>
.scam {
  margin-top: 10px; padding: 9px 12px 2px;
  background: var(--warn-wash); border-radius: var(--radius);
  min-width: 0;
}
.scamT {
  margin: 0; font-size: 12px; line-height: 1.7;
  color: var(--warn-ink); overflow-wrap: anywhere;
}
/* 低權重的文字連結，但點擊區撐滿 44px 高 —— 手指按得到，視覺上又不搶「撥給賣家」 */
.scamGo {
  display: inline-flex; align-items: center; gap: 2px;
  min-height: 44px; padding: 0 8px 0 0;
  color: var(--warn-ink); font-size: 12.5px; font-weight: 600;
  text-decoration: underline; text-underline-offset: 3px;
}
.scamGo:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--pill); }
</style>
