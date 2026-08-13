<script setup lang="ts">
/**
 * 卡包設計展示頁（未列在導覽，網址直達：/design/pack）
 * 用途是把各賞別、各狀態一次攤開比對，改配色時能立刻看出哪裡不對。
 */
import PackArt from '@/components/PackArt.vue'
import type { Tier } from '@/types/models'

const effects = [
  { k: 'fire'    as const, n: '火 · 竄動火苗',   m: 'gold'   as const, t: 'A' as Tier,    h: 'f3a91c04bb27de44' },
  { k: 'water'   as const, n: '水 · 氣泡漣漪',   m: 'silver' as const, t: 'C' as Tier,    h: 'c0ffee9988776655' },
  { k: 'leaf'    as const, n: '葉 · 飄落搖擺',   m: 'silver' as const, t: 'B' as Tier,    h: 'a1b2c3d4e5f60718' },
  { k: 'bolt'    as const, n: '雷 · 間歇爆閃',   m: 'silver' as const, t: 'B' as Tier,    h: 'a0c7104ebeef55aa' },
  { k: 'crystal' as const, n: '晶 · 浮沉轉動',   m: 'grey'   as const, t: 'D' as Tier,    h: 'c3f81a09bb27de44' },
  { k: 'star'    as const, n: '星 · 散布閃爍',   m: 'gold'   as const, t: 'LAST' as Tier, h: 'a0c7104ebeef55aa' }
]

const tiers: { tier: Tier; label: string; serial: string; hash: string }[] = [
  { tier: 'A', label: '朱紫 SAR 精選', serial: 'VD-0001/080', hash: 'f3a91c04bb27de44' },
  { tier: 'B', label: '經典促販卡', serial: 'VD-0014/040', hash: 'a1b2c3d4e5f60718' },
  { tier: 'C', label: '皮卡丘 指定賞', serial: 'VD-0027/050', hash: 'c0ffee9988776655' },
  { tier: 'D', label: '銅板入門賞', serial: 'VD-0062/080', hash: 'c3f81a09bb27de44' },
  { tier: 'LAST', label: '尾籤競標', serial: 'VD-0080/080', hash: 'a0c7104ebeef55aa' }
]
</script>

<template>
  <div class="container page">
    <h1 class="display">卡包設計</h1>

    <h2>材質：灰 / 銀 / 金</h2>
    <div class="grid pair three">
      <figure>
        <PackArt material="grey" effect="none" tier="D" label="銅板入門賞" serial="VD-0062/080" hash="c3f81a09bb27de44" />
        <figcaption class="mono muted">灰</figcaption>
      </figure>
      <figure>
        <PackArt material="silver" effect="none" tier="B" label="經典促販卡" serial="VD-0014/040" hash="a1b2c3d4e5f60718" />
        <figcaption class="mono muted">銀</figcaption>
      </figure>
      <figure>
        <PackArt material="gold" effect="none" tier="A" label="朱紫 SAR 精選" serial="VD-0001/080" hash="f3a91c04bb27de44" />
        <figcaption class="mono muted">金</figcaption>
      </figure>
    </div>

    <h2>六種屬性特效</h2>
    <div class="grid fx">
      <figure v-for="e in effects" :key="e.k">
        <PackArt :material="e.m" :effect="e.k" :tier="e.t" :label="e.n" :hash="e.h" />
        <figcaption class="mono muted">{{ e.n }}</figcaption>
      </figure>
    </div>

    <h2>各賞別</h2>
    <div class="grid">
      <figure v-for="t in tiers" :key="t.tier">
        <PackArt :tier="t.tier" :label="t.label" :serial="t.serial" :hash="t.hash" />
        <figcaption class="mono muted">{{ t.tier }}</figcaption>
      </figure>
    </div>

    <h2>未開封 / 已開封</h2>
    <div class="grid pair">
      <figure>
        <PackArt tier="A" label="朱紫 SAR 精選" serial="VD-0001/080" hash="f3a91c04bb27de44" />
        <figcaption class="mono muted">未開封</figcaption>
      </figure>
      <figure>
        <PackArt tier="A" label="朱紫 SAR 精選" serial="VD-0001/080" hash="f3a91c04bb27de44" opened />
        <figcaption class="mono muted">已開封</figcaption>
      </figure>
    </div>

    <h2>小尺寸 88px</h2>
    <div class="row">
      <PackArt v-for="t in tiers" :key="t.tier" :tier="t.tier" compact flat class="mini" />
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 32px; padding-bottom: 80px; }
h1 { margin-bottom: 30px; }
h2 { font-size: 17px; margin: 34px 0 16px; font-weight: 600; }
.grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 20px;
}
.grid.pair { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); max-width: 620px; }
.grid.pair.three { max-width: 760px; }
.grid.fx { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
figure { margin: 0; }
figcaption { font-size: 11.5px; margin-top: 9px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.mini { width: 88px; }
@media (max-width: 720px) {
  .grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
}
</style>
