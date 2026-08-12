<script setup lang="ts">
import { onMounted } from 'vue'
import { usePoolStore } from '@/stores/pools'
import PoolCard from '@/components/PoolCard.vue'
import WinnerTicker from '@/components/WinnerTicker.vue'
import HeroScene3D from '@/components/HeroScene3D.vue'

const pools = usePoolStore()
onMounted(() => pools.ensureLoaded())

const steps = [
  { n: '01', t: '開賣前封存', d: '籤序預先洗好，公布 SHA-256 承諾雜湊。' },
  { n: '02', t: '親手選籤', d: '不是系統代抽 —— 你自己挑要開哪一支。' },
  { n: '03', t: '完抽後驗算', d: '公開種子，任何人都能重算一次結果。' }
]
</script>

<template>
  <div class="home">
    <!-- Hero -->
    <section class="hero wash">
      <div class="container hero-inner">
        <div class="copy">
          <p class="eyebrow">PSA 鑑定卡 · 定量抽選 · 可驗證公平</p>
          <h1 class="display">
            每一支籤<br />
            <em>開賣前就已封存</em>
          </h1>
          <p class="lede">
            總籤數與各賞剩餘全程公開。籤序在開賣前以 SHA-256 承諾封存，
            完抽後公開種子，任何人都能自行驗算。
          </p>
          <div class="cta">
            <RouterLink to="/pools" class="btn primary">看抽選中的池</RouterLink>
            <RouterLink to="/fairness" class="btn ghost">公平性怎麼驗證 →</RouterLink>
          </div>
        </div>
        <div class="stage">
          <HeroScene3D />
        </div>
      </div>
    </section>

    <div class="container">
      <WinnerTicker />
    </div>

    <!-- 三步流程 -->
    <section class="container steps">
      <div v-for="s in steps" :key="s.n" class="step">
        <span class="num mono">{{ s.n }}</span>
        <h3>{{ s.t }}</h3>
        <p class="muted">{{ s.d }}</p>
      </div>
    </section>

    <!-- 抽選中 -->
    <section class="container pools">
      <header class="sec-head">
        <h2 class="display">抽選中</h2>
        <RouterLink to="/pools" class="btn ghost sm">看全部 →</RouterLink>
      </header>
      <div class="grid">
        <PoolCard v-for="p in pools.openPools" :key="p.id" :pool="p" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.home { padding-bottom: 80px; }

/* ---- Hero ---- */
.hero {
  position: relative;
  border-radius: 0 0 var(--radius-xl) var(--radius-xl);
  padding: 86px 0 104px;
  margin-bottom: 26px;
  overflow: hidden;
}
.hero-inner {
  display: grid; grid-template-columns: 1.02fr 1.18fr;
  gap: 32px; align-items: center;
}
.copy { position: relative; z-index: 1; }
h1 {
  /* 上限壓在 72px：再大「開賣前就已封存」在 1440 寬會斷成三行 */
  font-size: clamp(40px, 4.6vw, 72px);
  margin: 22px 0 24px;
  text-wrap: balance;
}
h1 em { font-style: normal; color: var(--accent); }
.lede { font-size: 18px; color: var(--muted); max-width: 480px; margin: 0; line-height: 1.62; }
.cta { display: flex; gap: 12px; margin-top: 34px; flex-wrap: wrap; }
/* 3D 舞台向外溢出容器，讓環繞的卡片不會被切齊邊界 */
.stage {
  height: 620px;
  margin: -60px -14vw -60px -4vw;
  pointer-events: none;
}

/* ---- 三步流程 ---- */
.steps {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 20px; margin: 44px auto;
}
.step { padding: 26px 24px; background: var(--surface-2); border-radius: var(--radius-lg); }
.num { font-size: 12px; font-weight: 600; color: var(--accent); }
.step h3 { font-size: 18px; font-weight: 600; margin: 10px 0 6px; letter-spacing: -0.02em; }
.step p { font-size: 14.5px; margin: 0; line-height: 1.6; }

/* ---- 抽選中 ---- */
.pools { margin-top: 56px; }
.sec-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 22px; }
h2 { font-size: clamp(26px, 3vw, 36px); margin: 0; }
.btn.sm { padding: 8px 16px; font-size: 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(258px, 1fr)); gap: 20px; }

@media (max-width: 900px) {
  .hero { padding: 48px 0 64px; }
  .hero-inner { grid-template-columns: 1fr; gap: 4px; }
  .stage { height: 420px; order: -1; margin: -40px -10vw -30px; }
  .lede { max-width: none; }
}
@media (max-width: 720px) {
  .hero { padding: 12px 0 40px; border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
  /* 手機版拉滿版高度感 —— 原本固定 360px 在長螢幕上只佔畫面不到一半，
     現在用視窗高度的比例撐開，同時設上下限避免極端裝置跑版 */
  .stage { height: min(62vh, 560px); min-height: 400px; margin: -10px -14vw -6px; }
  h1 { margin: 14px 0 14px; }
  .lede { font-size: 15px; }
  .cta { gap: 10px; }
  .cta .btn { flex: 1; padding: 12px 14px; font-size: 14px; }
  .steps { grid-template-columns: 1fr; gap: 12px; margin: 32px auto; }
  .step { padding: 20px; }
  .pools { margin-top: 38px; }
  .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
}
</style>
