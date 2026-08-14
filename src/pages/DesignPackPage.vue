<script setup lang="ts">
/**
 * 收藏艙設計展示頁（未列在導覽，網址直達：/design/pack）
 * 把各等級、各屬性、各狀態一次攤開比對，改配色時能立刻看出哪裡不對。
 */
import { ref } from 'vue'
import CapsuleArt from '@/components/CapsuleArt.vue'
import type { Tier } from '@/types/models'

const openedCount = ref(0)

const grades: { tier: Tier; label: string; hash: string }[] = [
  { tier: 'D', label: '精靈球', hash: 'c3f81a09bb27de44' },
  { tier: 'C', label: '超級球', hash: 'c0ffee9988776655' },
  { tier: 'B', label: '高級球', hash: 'a1b2c3d4e5f60718' },
  { tier: 'A', label: '豪華球', hash: 'f3a91c04bb27de44' },
  { tier: 'LAST', label: '大師球', hash: 'a0c7104ebeef55aa' }
]

const effects = [
  { k: 'fire' as const, n: '火' },
  { k: 'water' as const, n: '水' },
  { k: 'leaf' as const, n: '葉' },
  { k: 'bolt' as const, n: '雷' },
  { k: 'crystal' as const, n: '晶' },
  { k: 'star' as const, n: '星' }
]
</script>

<template>
  <div class="container page">
    <h1 class="display">寶貝球設計</h1>

    <h2>開球互動</h2>
    <div class="grid solo">
      <figure>
        <CapsuleArt
          tier="LAST" label="朱紫 SAR 精選" hash="a0c7104ebeef55aa"
          interactive effect="star"
          card-image="https://assets.tcgdex.net/zh-tw/SV/SVF/001/high.webp"
          @opened="openedCount++"
        />
        <figcaption class="mono muted">按中央按鈕開球（已開 {{ openedCount }} 次）</figcaption>
      </figure>
    </div>

    <h2>等級階梯</h2>
    <div class="grid">
      <figure v-for="g in grades" :key="g.tier">
        <CapsuleArt :tier="g.tier" :hash="g.hash" />
        <figcaption class="mono muted">{{ g.tier }} · {{ g.label }}</figcaption>
      </figure>
    </div>

    <h2>六種屬性</h2>
    <div class="grid">
      <figure v-for="e in effects" :key="e.k">
        <CapsuleArt tier="B" :effect="e.k" hash="a1b2c3d4e5f60718" />
        <figcaption class="mono muted">{{ e.n }}</figcaption>
      </figure>
    </div>

    <h2>已開啟</h2>
    <div class="grid pair">
      <figure>
        <CapsuleArt tier="LAST" hash="a0c7104ebeef55aa" />
        <figcaption class="mono muted">閉合</figcaption>
      </figure>
      <figure>
        <CapsuleArt
          tier="LAST" hash="a0c7104ebeef55aa" opened
          card-image="https://assets.tcgdex.net/zh-tw/SV/SVC/001/high.webp"
        />
        <figcaption class="mono muted">開啟</figcaption>
      </figure>
    </div>

    <h2>小尺寸 96px</h2>
    <div class="row">
      <CapsuleArt v-for="g in grades" :key="g.tier" :tier="g.tier" compact flat class="mini" />
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 32px; padding-bottom: 80px; }
h1 { margin-bottom: 30px; }
h2 { font-size: 17px; margin: 40px 0 16px; font-weight: 600; }
.grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 20px;
}
.grid.solo { grid-template-columns: 1fr; max-width: 340px; }
.grid.pair { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); max-width: 620px; }
figure { margin: 0; }
figcaption { font-size: 11.5px; margin-top: 9px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.mini { width: 96px; }
@media (max-width: 720px) {
  .grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
}
</style>
