<script setup lang="ts">
/**
 * 賣家的信任標示。
 *
 * ── 這支為什麼被整個換掉 ──────────────────────────────────────────────
 * 舊版是「官方／商家／個人」三級徽章，`detailed` 模式還會把「這一級保障你
 * 什麼」寫出來。查證之後那三句話**沒有一句是真的**：
 *
 *   官方池「平台自營、沒有第三方托管期」
 *       → 假的。每一次抽卡都照樣建結算列，鑑賞期、出貨時限一模一樣。
 *         而且 official 這個值真人根本拿不到 —— routes/sellers.ts 的申請
 *         端點只收 'merchant' | 'personal'，官方只有 seed 寫得進去。
 *   商家池「已完成營業登記與身分驗證」
 *       → 假的。origin 是申請時使用者自己勾的一個 enum，後端沒有驗過
 *         任何東西，也沒有任何一行程式碼因為它而改變行為。
 *   個人池「托管期較長、單池總額有上限、賣家需先繳保證金」
 *       → 三項全部沒有實作。POOL_SHIP_DEADLINE_MS / POOL_INSPECT_MS /
 *         POOL_VAULT_ACCEPT_MS / SELLER_DEFAULT_LIMIT 都是全站常數，
 *         shared 的規則層一次都沒有讀過 origin。
 *
 * 舊版檔頭自己寫著「這個標籤要對應真實的保障差異，不是分級榮譽」。
 * 它變成了自己警告的那種東西，而且更糟 —— 不只是沒有差異，是**對外
 * 承諾了不存在的保障**，而使用者是看了那句話才決定要不要買的。
 *
 * ── 換成什麼 ──────────────────────────────────────────────────────────
 * 顯示 `sellers.tier`（pending / verified / trusted）。那是客服實際審過的
 * 結果，是這張表上唯一真的信任訊號。origin 降級成一個**不承諾任何事**的
 * 身分描述，而且只在 detailed 模式下當附註出現。
 *
 * 保障文案改成講真的規則，而真的規則是**三種賣家一視同仁**。
 * 講「大家一樣」比講一個好聽但不存在的差別誠實，也比整段拿掉有用 ——
 * 買家真正要知道的是「我付的錢什麼時候才會到賣家手上」。
 */
import type { PoolOrigin, SellerTier } from '@/types/models'

const props = defineProps<{
  origin: PoolOrigin
  /** 賣家的審核狀態。舊資料沒有這一欄，當成「還沒審」處理 */
  tier?: SellerTier
  detailed?: boolean
}>()

/* 措辭刻意不做成「好→壞」的階梯。待審核不是劣質，是還沒排到；
   而三級的**保障完全相同**，差的只有平台對這個賣家的了解程度。
   把它寫成等級榮譽，就會回到舊版那個「顏色不同、內容一樣」的問題。 */
const TIER: Record<SellerTier, { label: string; note: string; icon: string }> = {
  trusted: {
    label: '資深賣家',
    note: '已通過審核，並且有一段時間的出貨紀錄。',
    icon: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z'
  },
  verified: {
    label: '已審核',
    note: '身分文件已由平台審核通過。',
    icon: 'M20 6L9 17l-5-5'
  },
  pending: {
    label: '待審核',
    note: '這位賣家的身分文件還在審核中。保障規則跟其他賣家相同。',
    icon: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'
  }
}
/* 舊池沒有 sellerTier。當成待審核而不是隱藏徽章：看不到標示的人會以為
   「沒標示＝沒問題」，那比誠實說「還沒審」更容易誤導。 */
const t = () => TIER[props.tier ?? 'pending']

/** 純身分描述，不帶任何保障含意。自己申報、平台沒驗，所以措辭要弱 */
const ORIGIN_NOUN: Record<PoolOrigin, string> = {
  official: '平台自營',
  merchant: '商家',
  personal: '個人賣家'
}
</script>

<template>
  <span class="pob" :class="[tier ?? 'pending', { 'is-detailed': detailed }]">
    <span class="tag">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path :d="t().icon" />
      </svg>
      {{ t().label }}
    </span>
    <span v-if="detailed" class="rule">
      {{ t().note }}
      <!-- 這一句是整塊的重點：三種賣家的保障一樣。舊版正是在這裡編出了
           不存在的差別，所以新版把「一樣」明白寫出來，不留想像空間。 -->
      <br>
      這一池由<b>{{ ORIGIN_NOUN[origin] }}</b>開設（賣家自己申報）。
      無論哪一種賣家，出貨期限、鑑賞期與違約處理都<b>完全相同</b>。
    </span>
  </span>
</template>

<style scoped>
.pob { display: inline-flex; align-items: center; gap: 8px; }
.pob.is-detailed { display: grid; gap: 6px; justify-items: start; }

.tag {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 700;
  padding: 5px 11px;
  border-radius: var(--pill);
  white-space: nowrap;
}
.tag svg {
  width: 13px; height: 13px; flex: none;
  fill: none; stroke: currentColor; stroke-width: 1.9;
  stroke-linecap: round; stroke-linejoin: round;
}

/* 顏色只表示「平台對這個賣家了解多少」，不表示商品好壞。
   所以待審核用中性灰而不是警示紅 —— 紅色會讓人以為那一池有問題，
   但保障其實跟其他池一模一樣。 */
.trusted .tag { background: var(--accent); color: #fff; }
.verified .tag { background: var(--ok-wash); color: var(--ok); box-shadow: inset 0 0 0 1px currentColor; }
.pending .tag { background: var(--surface-3); color: var(--muted); }

.rule {
  font-size: 11.5px; line-height: 1.6; color: var(--muted);
  /* 格線子元素：長句不該把整欄撐寬（手機兩欄很敏感） */
  min-width: 0; overflow-wrap: anywhere;
}
.rule b { color: var(--ink); font-weight: 700; }
</style>
