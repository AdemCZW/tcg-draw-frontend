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
      完全自製，不含任何廠商素材。立體卡盒 —— 正面／側面／頂面加上方吊掛卡榫，
      全部用 CSS <code>preserve-3d</code> 疊成真實幾何，傾斜時各面的面積真的改變。
      正面橫貼防拆封條，承諾雜湊印在上面 —— 撕開即破壞，
      跟「開賣前就已封存、事後可驗算」是同一個語意。
      <br><br>
      美術刻意避開任何特定角色：屬性符號（火／水／葉／雷／晶／星）是這個品類
      共通的通用圖形，放射光芒與光球負責儀式感。
      用寶可夢角色剪影會把自製包裝好不容易移除的版權曝險放回來 ——
      而且剪影「一眼認得出是誰」，比抽象圖案更難主張合理使用。
    </p>

    <h2>材質：灰 / 銀 / 金</h2>
    <div class="grid pair three">
      <figure>
        <PackArt material="grey" tier="D" label="銅板入門賞" serial="VD-0062/080" hash="c3f81a09bb27de44" />
        <figcaption class="mono muted">灰 —— 錫灰霧面，無特效</figcaption>
      </figure>
      <figure>
        <PackArt material="silver" tier="B" label="經典促販卡" serial="VD-0014/040" hash="a1b2c3d4e5f60718" />
        <figcaption class="mono muted">銀 —— 冷白高光，雷擊特效</figcaption>
      </figure>
      <figure>
        <PackArt material="gold" tier="A" label="朱紫 SAR 精選" serial="VD-0001/080" hash="f3a91c04bb27de44" />
        <figcaption class="mono muted">金 —— 暖金箔面，火焰特效</figcaption>
      </figure>
    </div>
    <p class="muted note">
      材質是獨立於賞別的一條等級軸。金屬感靠明暗交錯的多段漸層（lo→base→hi→rim），
      不是單色加白。特效預設跟著材質走，也可以用 <code>effect</code> 個別覆寫。
    </p>

    <h2>各賞別（材質自動對應）</h2>
    <div class="grid">
      <figure v-for="t in tiers" :key="t.tier">
        <PackArt :tier="t.tier" :label="t.label" :serial="t.serial" :hash="t.hash" />
        <figcaption class="mono muted">{{ t.tier }}</figcaption>
      </figure>
    </div>

    <h2>未開封 / 已開封（盒蓋掀起）</h2>
    <div class="grid pair">
      <figure>
        <PackArt tier="A" label="朱紫 SAR 精選" serial="VD-0001/080" hash="f3a91c04bb27de44" />
        <figcaption class="mono muted">未開封 —— 盒蓋閉合、封條完整</figcaption>
      </figure>
      <figure>
        <PackArt tier="A" label="朱紫 SAR 精選" serial="VD-0001/080" hash="f3a91c04bb27de44" opened />
        <figcaption class="mono muted">已開封 —— 盒蓋掀起 58°、封條與封緘褪色</figcaption>
      </figure>
    </div>

    <h2>小尺寸（列表縮圖 88px，關閉傾斜）</h2>
    <div class="row">
      <PackArt v-for="t in tiers" :key="t.tier" :tier="t.tier" compact flat class="mini" />
    </div>
    <p class="muted note">
      縮到 88px 時序號與標題會糊，所以小尺寸只留封條與封緘，賞別字級放大。
      列表裡通常會有幾十個，游標傾斜關掉（<code>flat</code>）避免整片一起晃，
      但靜止傾角保留 —— 縮圖仍然是立體的。
      幾何全部用 <code>cqw</code>，所以縮圖與滿版共用同一套數字。
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
.grid.pair.three { max-width: 760px; }
figure { margin: 0; }
figcaption { font-size: 11.5px; margin-top: 9px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.mini { width: 88px; }
.note { font-size: 13px; margin-top: 14px; max-width: 52ch; }
@media (max-width: 720px) {
  .grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
}
</style>
