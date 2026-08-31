<script setup lang="ts">
import type { Seller } from '@/types/models'

withDefaults(defineProps<{ seller: Seller; size?: 'sm' | 'md'; link?: boolean }>(), {
  size: 'sm',
  link: true
})

const tierMeta: Record<Seller['tier'], { label: string }> = {
  pending: { label: '待審核' },
  verified: { label: '已驗證' },
  trusted: { label: '金牌賣家' }
}
</script>

<template>
  <component
    :is="link ? 'RouterLink' : 'span'"
    :to="link ? `/sellers/${seller.id}` : undefined"
    class="chip-wrap" :class="size"
  >
    <span class="avatar" :style="{ '--h': seller.avatarHue }" aria-hidden="true">
      {{ seller.name.slice(0, 1) }}
    </span>
    <span class="name">{{ seller.name }}</span>
    <span class="tier" :class="seller.tier" :title="tierMeta[seller.tier].label">
      {{ tierMeta[seller.tier].label }}
    </span>
  </component>
</template>

<style scoped>
.chip-wrap { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
/* ---- 觸控目標 ----
   這顆 chip 只有 22px 高（頭像的高度），而 link 版是一條真的連結，
   在市場詳情、抽選台面板、池總覽三處都是「想知道賣家是誰」的唯一入口。
   撐到 44px 的是**可點區域**，不是頭像與字級 —— 版面上看起來一樣，
   只是上下各多了 11px 的可按範圍。

   只給 a.chip-wrap，不給 span 版：link=false 的三處（賣家頁的大標、
   訂單頁、大廳的池卡）它只是一段標示，不是觸控目標，撐高只會在版面裡
   多開一個 22px 的洞。訂單頁另外包了一層 44px 的外層連結繞開這件事，
   那個繞法在這裡仍然成立，不必動它。 */
a.chip-wrap { min-height: 44px; }
.avatar {
  display: grid; place-items: center;
  width: 22px; height: 22px; flex: none;
  border-radius: 50%;
  background: hsl(var(--h) 62% 86%);
  font-size: 11px; font-weight: 600; color: var(--ink);
}
.name {
  font-size: 13px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tier {
  flex: none;
  font-size: 10.5px; font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--pill);
  background: var(--surface-2);
  color: var(--muted);
}
.tier.trusted { background: color-mix(in srgb, var(--gold) 22%, transparent); color: var(--gold-deep); }
.tier.verified { background: var(--wash-mint); color: var(--ok-ink); }

.md .avatar { width: 38px; height: 38px; font-size: 17px; }
.md .name { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
.md .tier { font-size: 12px; padding: 3px 11px; }

a.chip-wrap:hover .name { color: var(--accent); }
</style>
