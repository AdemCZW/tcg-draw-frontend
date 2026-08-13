<script setup lang="ts">
/**
 * 卡包設計展示頁（未列在導覽，網址直達：/design/pack）
 * 用途是把各賞別、各狀態一次攤開比對，改配色時能立刻看出哪裡不對。
 */
import PackArt from '@/components/PackArt.vue'
import type { Tier } from '@/types/models'

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
    <p class="lede muted">
      完全自製，不含任何廠商素材。做成真實 booster pack 的樣子 ——
      上下鋸齒熱封邊、中央鼓起的圓柱受光、鋁膜光澤與折痕，比例 1:1.8。
      封條上直接印承諾雜湊，包裝與「開賣前就已封存」講同一件事。
      滑鼠移上去有微幅傾斜與跟隨游標的反光。
    </p>

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
        <figcaption class="mono muted">未開封 —— 封條完整、流光緩掃</figcaption>
      </figure>
      <figure>
        <PackArt tier="A" label="朱紫 SAR 精選" serial="VD-0001/080" hash="f3a91c04bb27de44" opened />
        <figcaption class="mono muted">已開封 —— 封條褪色、虛線斷開、流光停止</figcaption>
      </figure>
    </div>

    <h2>小尺寸（列表縮圖 88px，關閉傾斜）</h2>
    <div class="row">
      <PackArt v-for="t in tiers" :key="t.tier" :tier="t.tier" compact flat class="mini" />
    </div>
    <p class="muted note">
      縮到 88px 時序號與標題會糊，所以小尺寸只留封條與封緘，賞別字級放大。
      列表裡通常會有幾十個，傾斜一併關掉（<code>flat</code>）避免整片一起晃。
    </p>
  </div>
</template>

<style scoped>
.page { padding-top: 32px; padding-bottom: 80px; }
.lede { max-width: 60ch; margin: 10px 0 34px; font-size: 15px; }
h2 { font-size: 17px; margin: 34px 0 16px; font-weight: 600; }
.grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 20px;
}
.grid.pair { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); max-width: 620px; }
figure { margin: 0; }
figcaption { font-size: 11.5px; margin-top: 9px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.mini { width: 88px; }
.note { font-size: 13px; margin-top: 14px; max-width: 52ch; }
@media (max-width: 720px) {
  .grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
}
</style>
