<script setup lang="ts">
/**
 * 池的外殼 —— 標題列 + tab + 桌機側欄，子頁只管自己的內容。
 *
 * 原本 PoolDetailPage 一頁塞六件事（封面、獎項表、競標面板、托管、承諾雜湊、
 * 購買面板），手機上購買面板還被 order:-1 頂到最上面 —— 使用者先看到
 * 「買幾抽」才看得到「有什麼獎」，決策順序反了。
 *
 * 拆成三個 tab：總覽 / 獎項 / 驗證。tab 之間用 router.replace 切換，
 * 不推 history —— 返回鍵應該直接跳出池，不該在 tab 之間來回彈。
 * 桌機保留側欄的購買面板：同一屏邊看獎項邊決定抽數，這是桌機該有的效率。
 *
 * 尾籤競標面板有 500ms ticker 與 11s 模擬對手兩個 interval，原本只要打開
 * 池詳情就在跑。現在只在「總覽」tab 且進入競標階段時掛載，離開就拆。
 */
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { usePoolStore } from '@/stores/pools'
import { useSellerStore } from '@/stores/sellers'
import DrawPanel from '@/components/DrawPanel.vue'
import PoolModeBadge from '@/components/PoolModeBadge.vue'
import PoolOriginBadge from '@/components/PoolOriginBadge.vue'
import { track } from '@/lib/ga'

const route = useRoute()
const pools = usePoolStore()
const sellers = useSellerStore()

const pool = computed(() => pools.byId(String(route.params.id)))
const inAuctionPhase = computed(() =>
  pool.value?.mode === 'auction' && pool.value.remainingTickets <= (pool.value.auctionSeats ?? 0))

onMounted(async () => {
  await Promise.all([pools.ensureLoaded(), sellers.ensureLoaded()])
  track('view_pool_detail')
})

const tabs = [
  { name: 'pool-overview', label: '總覽' },
  { name: 'pool-prizes', label: '獎項' },
  { name: 'pool-proof', label: '驗證' }
] as const
const activeTab = computed(() => String(route.name))
</script>

<template>
  <div v-if="pool" class="shell container">
    <!-- 標題列：貼在 header 下面，切 tab 不動 -->
    <header class="top">
      <div class="titleRow">
        <h1>{{ pool.title }}</h1>
        <PoolModeBadge :mode="pool.mode" />
        <PoolOriginBadge :origin="pool.origin" />
      </div>
      <p class="meta mono muted">
        <span>{{ pool.ticketPrice.toLocaleString() }} 點 / 抽</span>
        <span>剩 {{ pool.remainingTickets }} / {{ pool.totalTickets }}</span>
        <span :class="{ live: pool.status === 'open' }">{{ pool.status === 'open' ? '抽選中' : '已完抽' }}</span>
      </p>
      <nav class="tabs" aria-label="池的分頁">
        <RouterLink
          v-for="t in tabs" :key="t.name"
          :to="{ name: t.name, params: { id: pool.id } }"
          replace
          class="tab" :class="{ on: activeTab === t.name }"
          :aria-current="activeTab === t.name ? 'page' : undefined"
        >{{ t.label }}</RouterLink>
      </nav>
    </header>

    <div class="layout">
      <!--
        子頁刻意沒有轉場，理由跟 App.vue 拿掉全站換頁轉場完全一樣 ——
        這裡是同一個 <Transition mode="out-in"> 漏掉沒改到的地方。

        實測：在「總覽 / 獎項 / 驗證」之間切換時，網址與分頁標題都換了，
        畫面卻停在上一個 tab（App.vue 註解裡的故障 3）。mode="out-in"
        要等離場結束才讓新頁進場，而離場那一步靠 requestAnimationFrame
        切 class，:duration 計時器保護不到它 —— rAF 一被節流（背景分頁、
        iOS Safari 省電、系統忙碌）就永遠停在舊 tab。

        :key 留著：params 換池時要重新建立子頁。
      -->
      <div class="body">
        <RouterView v-slot="{ Component }">
          <component :is="Component" :key="route.name" :pool="pool" />
        </RouterView>
      </div>

      <!-- 桌機側欄：購買面板一直在。手機收進總覽頁的主 CTA -->
      <aside class="side">
        <div v-if="pool.status === 'open' && inAuctionPhase" class="done card">
          <p><strong>已進入尾籤競標</strong></p>
          <p class="muted fine">剩下的 {{ pool.remainingTickets }} 支籤改由競標決定得主，請到「總覽」出價。</p>
        </div>
        <DrawPanel v-else-if="pool.status === 'open'" :pool="pool" />
        <div v-else class="done card">
          <p>本池已完抽</p>
          <RouterLink :to="{ name: 'fairness-pool', params: { poolId: pool.id } }" class="btn">驗證抽選結果</RouterLink>
        </div>
      </aside>
    </div>
  </div>

  <div v-else-if="pools.loading" class="container shell">
    <div class="skel"><i class="a"></i><i class="b"></i><i class="c"></i></div>
  </div>

  <div v-else class="container shell">
    <p class="muted">找不到這個池，可能已下架。<RouterLink :to="{ name: 'home' }">回抽選列表</RouterLink></p>
  </div>
</template>

<style scoped>
/* 底部導覽的讓位交給頁尾（見 App.vue），這裡只留自己的排版留白 */
.shell { padding-top: 26px; padding-bottom: 60px; }

.top { margin-bottom: 18px; }
.titleRow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 22px; margin: 0; letter-spacing: -.01em; }
.meta { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; margin: 8px 0 0; }
.live { color: var(--ok); font-weight: 600; }

/* tab：底線式，選中的字色與底線走強調色。膠囊式在三個以上會太吵 */
.tabs {
  display: flex; gap: 4px;
  margin-top: 16px;
  border-bottom: 1px solid var(--line-soft);
}
.tab {
  position: relative;
  padding: 10px 14px 12px;
  font-size: 14.5px; font-weight: 500;
  color: var(--muted);
  transition: color .15s;
}
.tab::after {
  content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px;
  height: 2px; border-radius: 2px;
  background: var(--accent);
  transform: scaleX(0); transform-origin: 50% 50%;
  transition: transform .22s cubic-bezier(.2, .8, .3, 1);
}
.tab.on { color: var(--ink); font-weight: 600; }
.tab.on::after { transform: scaleX(1); }
@media (hover: hover) { .tab:hover { color: var(--ink); } }
.tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }

.layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 28px; align-items: start; }
.side { position: sticky; top: 76px; }
.done { padding: 20px; text-align: center; display: grid; gap: 10px; }
.done p { margin: 0; }
.done .fine { font-size: 12.5px; }

.skel { display: grid; gap: 12px; max-width: 520px; }
.skel i { display: block; height: 18px; border-radius: 6px; background: var(--surface-2); }
.skel .a { width: 60%; height: 26px; } .skel .b { width: 40%; } .skel .c { width: 100%; height: 200px; }

/* 手機：側欄拿掉（總覽頁自己有主 CTA），tab 平均分 */
@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; }
  .side { display: none; }
}
@media (max-width: 720px) {
  .shell { padding-top: 16px; }
  h1 { font-size: 19px; }
  .meta { gap: 6px 12px; font-size: 12px; }
  .tabs { margin-top: 12px; }
  .tab { flex: 1; text-align: center; padding: 10px 6px 11px; }
}
</style>
