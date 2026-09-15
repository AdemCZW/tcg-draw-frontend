# 收藏家等級畫面 Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在展示模式（MOCK）用假資料做出收藏家等級徽章，顯示在公開卡冊、賣家頁、我的頁，並有一頁同時比較五個等級。

**Architecture:** 等級表與換算放在 `src/shared/collector.ts`（純函式，前後端共用，後端用 selftest 驗）。畫面由兩個元件組成：`CollectorBadge.vue`（徽章）與 `CollectorProgress.vue`（我的頁進度條）。資料只在 MOCK 分支給值；非 MOCK 時欄位不存在、元件不渲染，正式站行為不變。

**Tech Stack:** Vue 3.5 `<script setup>` + TypeScript、Vite、vue-tsc；後端 selftest 用 tsx；畫面驗證用 headless Playwright。

**Spec:** `docs/superpowers/specs/2026-09-15-collector-level-design.md`（本計畫只涵蓋「第一步：畫面 demo」）

## Global Constraints

- 收藏積分與錢包點數分開：畫面一律寫「收藏積分」，不可寫「點」。
- 等級表：0 分以下 → 等級 0（不顯示）；1 → 新手收藏家；10 → 收藏家；30 → 資深收藏家；100 → 大師收藏家；300 → 傳奇收藏家。
- 等級名稱不可使用寶可夢官方用語（訓練家、冠軍等）。
- 行動版 UI 不可使用 emoji；徽章圖形用 CSS／inline SVG。
- 顏色只用 `src/styles/tokens.css` 既有 token（例如 `--gold`、`--gold-deep`、`--accent`、`--holo-a/b/c`、`--surface-2`、`--line`、`--muted`、`--ink`），淺色與深色主題都要可讀。
- 可點區域至少 44px；375px 寬不可橫向捲動。
- 不動資料庫、不動後端路由；非 MOCK 模式不發任何新請求。
- `src/shared/` 內不可 import Vue、`@/` 別名、`window`／`document`。
- 驗證用 headless Playwright，不使用 `mcp__Claude_Browser__*` 工具。
- 提交前在 repo 根目錄跑 `npm run build`（不接 pipe，讀 exit code）。
- 不可 `git add -A` / `git add -u`，只 add 本任務的檔案。
- commit 訊息結尾加 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。
- 註解風格比照周邊程式：中文、講「為什麼」。

---

### Task 1: 共用等級表與換算

**Files:**
- Create: `src/shared/collector.ts`
- Modify: `server/src/selftest.ts`（加 import 與檢查）
- Generated: `server/src/shared/collector.ts`（由 sync-shared 產生，不手改）

**Interfaces:**
- Produces:
  - `interface CollectorLevelDef { level: number; name: string; min: number }`
  - `const COLLECTOR_LEVELS: readonly CollectorLevelDef[]`
  - `function collectorLevelFor(points: number): number` → 0..5
  - `function collectorLevelName(level: number): string | null` → 等級 0 或超出範圍回 null
  - `interface CollectorProgress { level: number; name: string | null; points: number; nextMin: number | null; toNext: number | null; ratio: number }`
  - `function collectorProgress(points: number): CollectorProgress`

- [ ] **Step 1: 在 selftest 寫檢查（先失敗）**

在 `server/src/selftest.ts` 既有 import 區塊後加：

```ts
import { collectorLevelFor, collectorLevelName, collectorProgress, COLLECTOR_LEVELS } from './shared/collector.js'
```

在檔案最後的彙總輸出（印 pass/fail 並決定 exit code 的那段）**之前**加：

```ts
console.log('\nshared/collector 等級換算：')
check('0 分 → 等級 0', collectorLevelFor(0) === 0)
check('負分與 NaN 都當 0', collectorLevelFor(-3) === 0 && collectorLevelFor(Number.NaN) === 0)
check('1 分 → 等級 1', collectorLevelFor(1) === 1)
check('9 分還是等級 1', collectorLevelFor(9) === 1)
check('10 分 → 等級 2', collectorLevelFor(10) === 2)
check('30 分 → 等級 3', collectorLevelFor(30) === 3)
check('100 分 → 等級 4', collectorLevelFor(100) === 4)
check('299 分 → 等級 4', collectorLevelFor(299) === 4)
check('300 分 → 等級 5', collectorLevelFor(300) === 5)
check('超過最高門檻仍是 5', collectorLevelFor(99999) === 5)
check('小數無條件捨去（9.9 → 等級 1）', collectorLevelFor(9.9) === 1)
check('等級名稱', collectorLevelName(1) === '新手收藏家' && collectorLevelName(5) === '傳奇收藏家')
check('等級 0 沒有名稱', collectorLevelName(0) === null && collectorLevelName(6) === null)
check('等級表遞增且共 5 級', COLLECTOR_LEVELS.length === 5 &&
  COLLECTOR_LEVELS.every((d, i) => i === 0 || d.min > COLLECTOR_LEVELS[i - 1]!.min))
{
  const p = collectorProgress(42)
  check('42 分：等級 3、下一級門檻 100、還差 58', p.level === 3 && p.nextMin === 100 && p.toNext === 58)
  check('42 分：區間進度 (42-30)/(100-30)', Math.abs(p.ratio - 12 / 70) < 1e-9)
}
{
  const p = collectorProgress(0)
  check('0 分：等級 0、下一級門檻 1、還差 1、進度 0', p.level === 0 && p.nextMin === 1 && p.toNext === 1 && p.ratio === 0)
}
{
  const p = collectorProgress(500)
  check('滿級：沒有下一級、進度 1', p.level === 5 && p.nextMin === null && p.toNext === null && p.ratio === 1)
}
```

- [ ] **Step 2: 跑 selftest 確認失敗**

Run: `cd server && npx tsx src/selftest.ts`
Expected: 失敗，錯誤訊息含 `Cannot find module './shared/collector.js'`（或同義的找不到模組）。

- [ ] **Step 3: 實作 `src/shared/collector.ts`**

```ts
/**
 * 收藏家等級。
 *
 * 等級只由「收藏積分」決定，而收藏積分跟錢包點數是兩回事：不能花、不能轉讓、
 * 不能兌換任何東西（見 docs/superpowers/specs/2026-09-15-collector-level-design.md）。
 * 放在 shared 是因為後端之後要用同一張表算公開卡冊與賣家頁的等級 ——
 * 門檻寫兩份的話，總有一天前端說你是大師、後端說你是資深。
 *
 * 名稱刻意不用寶可夢的官方用語（訓練家、冠軍），避免被讀成官方授權。
 */

export interface CollectorLevelDef {
  level: number
  name: string
  /** 達到這一級需要的最低收藏積分（含） */
  min: number
}

export const COLLECTOR_LEVELS: readonly CollectorLevelDef[] = [
  { level: 1, name: '新手收藏家', min: 1 },
  { level: 2, name: '收藏家', min: 10 },
  { level: 3, name: '資深收藏家', min: 30 },
  { level: 4, name: '大師收藏家', min: 100 },
  { level: 5, name: '傳奇收藏家', min: 300 }
]

/* 積分是整數事件的加總，理論上不會有小數或負數；但它最後是從 API 進來的，
   壞資料不該讓徽章顯示成奇怪的等級。一律捨去、低於 0 當 0。 */
function clean(points: number): number {
  return Number.isFinite(points) ? Math.max(0, Math.floor(points)) : 0
}

/** 0 = 還沒有等級（不顯示徽章），1..5 對應 COLLECTOR_LEVELS */
export function collectorLevelFor(points: number): number {
  const p = clean(points)
  let lv = 0
  for (const d of COLLECTOR_LEVELS) if (p >= d.min) lv = d.level
  return lv
}

export function collectorLevelName(level: number): string | null {
  return COLLECTOR_LEVELS.find(d => d.level === level)?.name ?? null
}

export interface CollectorProgress {
  level: number
  name: string | null
  points: number
  /** 下一級門檻；已經滿級時為 null */
  nextMin: number | null
  /** 還差幾分升級；已經滿級時為 null */
  toNext: number | null
  /** 目前等級區間內的進度 0..1。滿級為 1 */
  ratio: number
}

export function collectorProgress(points: number): CollectorProgress {
  const p = clean(points)
  const level = collectorLevelFor(p)
  const cur = COLLECTOR_LEVELS.find(d => d.level === level)
  const next = COLLECTOR_LEVELS.find(d => d.level === level + 1)
  if (!next) return { level, name: cur?.name ?? null, points: p, nextMin: null, toNext: null, ratio: 1 }
  /* 區間的起點：等級 0 從 0 算起，其他從該級門檻算起。
     用區間內的比例而不是 p / next.min —— 否則剛升上 100 分的人看到的是「已經滿 30%」，
     進度條一升級就從快滿掉回三分之一，看起來像退步。 */
  const floor = cur?.min ?? 0
  return {
    level, name: cur?.name ?? null, points: p,
    nextMin: next.min, toNext: next.min - p,
    ratio: (p - floor) / (next.min - floor)
  }
}
```

- [ ] **Step 4: 同步到後端並跑 selftest**

Run: `cd server && node scripts/sync-shared.mjs && npx tsx src/selftest.ts`
Expected: 新增的 `shared/collector 等級換算` 區塊全部 `ok`，最後彙總沒有 FAIL，exit code 0。

- [ ] **Step 5: 型別檢查**

Run: `cd server && npx tsc --noEmit -p .`
Expected: exit code 0。

- [ ] **Step 6: Commit**

```bash
git add src/shared/collector.ts server/src/shared/collector.ts server/src/selftest.ts
git commit -m "收藏家等級表與換算（共用，selftest 驗證）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: 徽章元件與五級比較頁

**Files:**
- Create: `src/components/CollectorBadge.vue`
- Create: `src/pages/DesignCollectorPage.vue`
- Modify: `src/router/index.ts`（在 `/design/pack` 那筆路由後面加一筆）

**Interfaces:**
- Consumes: `collectorLevelName(level: number): string | null`（Task 1）
- Produces: `<CollectorBadge :level="number" size?="'sm' | 'md'" :show-name?="boolean" />`
  - `level` 為 0 或無名稱時整個元件不渲染任何節點。
  - 預設 `size='sm'`、`showName=true`。

- [ ] **Step 1: 建立 `src/components/CollectorBadge.vue`**

```vue
<script setup lang="ts">
/**
 * 收藏家等級徽章。
 *
 * 等級 0 不畫任何東西：還沒登記過鑑定卡的人頭像旁邊掛一個「0 級」，
 * 讀起來像是被點名「你什麼都沒有」。
 *
 * 圖形是一枚六角盾，等級越高層次越多：
 *   1 單色描邊  2 實心  3 金色  4 金色＋內圈  5 全息漸層＋內圈
 * 用形狀層次而不是只換顏色 —— 色弱的人、以及淺色主題下金銀對比變弱時，
 * 仍然分得出高低。
 */
import { computed } from 'vue'
import { collectorLevelName } from '@/shared/collector'

const props = withDefaults(defineProps<{
  level: number
  size?: 'sm' | 'md'
  showName?: boolean
}>(), { size: 'sm', showName: true })

const name = computed(() => collectorLevelName(props.level))
</script>

<template>
  <span
    v-if="name"
    class="cb"
    :class="[`lv${level}`, size]"
    role="img"
    :aria-label="`收藏家等級 ${level}：${name}`"
  >
    <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient :id="`cbHolo${level}`" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--holo-a)" />
          <stop offset=".5" stop-color="var(--holo-b)" />
          <stop offset="1" stop-color="var(--holo-c)" />
        </linearGradient>
      </defs>
      <path class="shield" d="M12 2 20.5 7v10L12 22 3.5 17V7Z" :fill="level === 5 ? `url(#cbHolo${level})` : undefined" />
      <path v-if="level >= 4" class="inner" d="M12 6.5 16.8 9.3v5.4L12 17.5 7.2 14.7V9.3Z" />
      <text class="num" x="12" y="15.2" text-anchor="middle">{{ level }}</text>
    </svg>
    <span v-if="showName" class="nm">{{ name }}</span>
  </span>
</template>

<style scoped>
.cb {
  display: inline-flex; align-items: center; gap: 6px;
  min-width: 0; max-width: 100%;
  padding: 3px 10px 3px 4px;
  border: 1px solid var(--line); border-radius: var(--pill);
  background: var(--surface-2); color: var(--ink);
  font-size: 12px; font-weight: 700; line-height: 1.2;
  vertical-align: middle;
}
.cb.md { font-size: 13.5px; padding: 4px 12px 4px 5px; gap: 8px; }
.mark { width: 20px; height: 20px; flex: none; }
.cb.md .mark { width: 26px; height: 26px; }
.nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.shield { stroke-width: 1.6; stroke-linejoin: round; }
.num { font-family: var(--font-mono); font-size: 9px; font-weight: 800; }
.inner { fill: none; stroke-width: 1.2; }

/* 1：只有描邊 */
.lv1 .shield { fill: none; stroke: var(--muted); }
.lv1 .num { fill: var(--muted); }
/* 2：實心 */
.lv2 .shield { fill: var(--muted); stroke: var(--muted); }
.lv2 .num { fill: var(--surface); }
/* 3：金 */
.lv3 { border-color: color-mix(in srgb, var(--gold) 55%, var(--line)); }
.lv3 .shield { fill: var(--gold); stroke: var(--gold-deep); }
.lv3 .num { fill: var(--gold-deep); }
/* 4：金＋內圈 */
.lv4 { border-color: var(--gold); }
.lv4 .shield { fill: var(--gold); stroke: var(--gold-deep); }
.lv4 .inner { stroke: var(--gold-deep); }
.lv4 .num { fill: var(--gold-deep); }
/* 5：全息＋內圈 */
.lv5 { border-color: var(--holo-b); }
.lv5 .shield { stroke: var(--ink); }
.lv5 .inner { stroke: var(--ink); }
.lv5 .num { fill: var(--ink); }
</style>
```

- [ ] **Step 2: 建立比較頁 `src/pages/DesignCollectorPage.vue`**

```vue
<script setup lang="ts">
/**
 * 收藏家徽章比較頁（未列在導覽，網址直達：/design/collector）
 * 比照 /design/pack：五個等級、兩種尺寸一次攤開，改配色時能立刻看出哪裡不對。
 */
import CollectorBadge from '@/components/CollectorBadge.vue'
import { COLLECTOR_LEVELS } from '@/shared/collector'
</script>

<template>
  <div class="container page">
    <h1>收藏家等級</h1>
    <p class="muted lead">收藏積分跟錢包點數是兩回事，不能花也不能轉讓。登記一張鑑定卡、在站內買到一張卡各加 1 分。</p>
    <table class="tbl">
      <thead>
        <tr><th>等級</th><th>門檻</th><th>小</th><th>中</th></tr>
      </thead>
      <tbody>
        <tr v-for="d in COLLECTOR_LEVELS" :key="d.level">
          <td class="mono">{{ d.level }}</td>
          <td class="mono">{{ d.min }} 分</td>
          <td><CollectorBadge :level="d.level" /></td>
          <td><CollectorBadge :level="d.level" size="md" /></td>
        </tr>
      </tbody>
    </table>
    <h2>只有圖形</h2>
    <div class="row">
      <CollectorBadge v-for="d in COLLECTOR_LEVELS" :key="d.level" :level="d.level" :show-name="false" />
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 20px; padding-bottom: 72px; max-width: 640px; }
h1 { font-size: 20px; margin: 0 0 6px; }
h2 { font-size: 15px; margin: 22px 0 10px; }
.lead { font-size: 13px; line-height: 1.7; margin: 0 0 14px; }
.tbl { width: 100%; border-collapse: collapse; table-layout: fixed; }
.tbl th, .tbl td { padding: 8px 4px; border-bottom: 1px solid var(--line-soft); text-align: left; font-size: 12.5px; vertical-align: middle; }
.tbl th:nth-child(1), .tbl td:nth-child(1) { width: 40px; }
.tbl th:nth-child(2), .tbl td:nth-child(2) { width: 62px; }
.tbl td { overflow: hidden; }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
</style>
```

- [ ] **Step 3: 加路由**

在 `src/router/index.ts` 的 `path: '/design/pack'` 那一筆物件結束（`},`）之後加：

```ts
    {
      /* 收藏家徽章比較頁。比照 /design/pack 不掛導覽，網址直達。 */
      path: '/design/collector', name: 'design-collector',
      component: () => import('@/pages/DesignCollectorPage.vue'),
      meta: { depth: 1, title: '收藏家徽章' }
    },
```

- [ ] **Step 4: Build**

Run: `npm run build`（repo 根目錄，不接 pipe）
Expected: exit code 0。

- [ ] **Step 5: Commit**

```bash
git add src/components/CollectorBadge.vue src/pages/DesignCollectorPage.vue src/router/index.ts
git commit -m "收藏家徽章元件與五級比較頁（/design/collector）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: 掛進公開卡冊、賣家頁、我的頁（MOCK 資料）

**Files:**
- Create: `src/components/CollectorProgress.vue`
- Modify: `src/lib/social.ts`（`PublicCardbookPage.owner` 型別加欄位；MOCK owner 給值）
- Modify: `src/types/models.ts`（`Seller` 加欄位）
- Modify: `src/mocks/data.ts`（MOCK 賣家給等級）
- Modify: `src/lib/api.ts`（新增 `collectorApi`）
- Modify: `src/pages/PublicCardbookPage.vue`（hero 名稱下方）
- Modify: `src/pages/SellerPage.vue`（profile 內 SellerChip 下方）
- Modify: `src/pages/MePage.vue`（hero 下方）

**Interfaces:**
- Consumes: `CollectorBadge`（Task 2）、`collectorProgress(points)`（Task 1）
- Produces:
  - `PublicCardbookPage.owner.collectorLevel?: number`
  - `Seller.collectorLevel?: number`
  - `collectorApi.me(): Promise<{ points: number } | null>`（非 MOCK 一律回 null、不發請求）
  - `<CollectorProgress :points="number" />`

- [ ] **Step 1: 型別與 MOCK 資料**

`src/lib/social.ts`，把

```ts
  owner: { name: string; handle: string }
```

改成

```ts
  owner: {
    name: string
    handle: string
    /** 收藏家等級 0..5。後端還沒提供時不存在，畫面就不顯示徽章 */
    collectorLevel?: number
  }
```

同檔 MOCK 分支把

```ts
        owner: { name: '示範收藏家', handle: 'VD-DEMO' },
```

改成

```ts
        owner: { name: '示範收藏家', handle: 'VD-DEMO', collectorLevel: 3 },
```

`src/types/models.ts` 的 `export interface Seller {` 內，`bio: string` 下一行加：

```ts
  /** 收藏家等級 0..5（見 src/shared/collector.ts）。後端還沒提供時不存在 */
  collectorLevel?: number
```

`src/mocks/data.ts`：找到 `sellers` 陣列，依陣列順序在每個賣家物件加上 `collectorLevel`，值依序循環使用 `[5, 3, 2, 4, 1, 0]`（第 1 位 5、第 2 位 3……第 7 位回到 5）。讓不同賣家頁看得到不同等級，包含一位 0 級（不顯示徽章）。

- [ ] **Step 2: `collectorApi`**

在 `src/lib/api.ts` 檔尾（最後一個 export 之後）加：

```ts
/**
 * 收藏積分（demo）。後端還沒有這支端點 —— 見
 * docs/superpowers/specs/2026-09-15-collector-level-design.md 的第二步。
 * 非 MOCK 一律回 null 而且**不發請求**：正式站打一支不存在的路由只會多一個 404，
 * 畫面收到 null 就不顯示那一塊。
 */
export const collectorApi = {
  async me(): Promise<{ points: number } | null> {
    if (!MOCK) return null
    await delay(120)
    return { points: 42 }
  }
}
```

（`MOCK` 與 `delay` 已在 api.ts 上方定義並被既有程式使用。）

- [ ] **Step 3: 建立 `src/components/CollectorProgress.vue`**

```vue
<script setup lang="ts">
/**
 * 我的頁的收藏家等級區塊：徽章、目前積分、離下一級還差多少。
 * 「還差 N 分」比百分比好懂 —— 使用者要做的判斷是「再登記幾張」。
 */
import { computed } from 'vue'
import { collectorProgress } from '@/shared/collector'
import CollectorBadge from '@/components/CollectorBadge.vue'

const props = defineProps<{ points: number }>()
const p = computed(() => collectorProgress(props.points))
</script>

<template>
  <section class="cp card" aria-label="收藏家等級">
    <div class="top">
      <CollectorBadge v-if="p.level > 0" :level="p.level" size="md" />
      <span v-else class="none">還沒有等級</span>
      <span class="pts mono">{{ p.points }}<span class="u">收藏積分</span></span>
    </div>
    <div
      class="bar" role="progressbar"
      :aria-valuenow="Math.round(p.ratio * 100)" aria-valuemin="0" aria-valuemax="100"
    >
      <span class="fill" :style="{ width: `${Math.round(p.ratio * 100)}%` }"></span>
    </div>
    <p class="hint">
      <template v-if="p.toNext !== null">還差 <b class="mono">{{ p.toNext }}</b> 分升到下一級。登記一張鑑定卡加 1 分。</template>
      <template v-else>已達最高等級。</template>
    </p>
  </section>
</template>

<style scoped>
.cp { margin-top: 12px; padding: 12px 14px; display: grid; gap: 8px; min-width: 0; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.none { font-size: 13px; color: var(--muted); }
.pts { flex: none; font-size: 16px; font-weight: 700; color: var(--ink); }
.pts .u { margin-left: 4px; font-family: var(--font-body); font-size: 11.5px; font-weight: 500; color: var(--muted); }
.bar { height: 6px; border-radius: var(--pill); background: var(--surface-2); overflow: hidden; }
.fill { display: block; height: 100%; border-radius: inherit; background: var(--gold); }
.hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); overflow-wrap: anywhere; }
.hint b { color: var(--ink); }
</style>
```

- [ ] **Step 4: 掛到三個頁面**

`src/pages/PublicCardbookPage.vue`：
- import 區加 `import CollectorBadge from '@/components/CollectorBadge.vue'`
- 把
```html
            <h1>{{ owner.name }}</h1>
            <p class="handle mono">{{ owner.handle }}</p>
```
改成
```html
            <h1>{{ owner.name }}</h1>
            <p class="handle mono">{{ owner.handle }}</p>
            <!-- 收藏家等級。分享出去的人第一眼要看得到，所以放在名字正下方而不是統計列裡 -->
            <CollectorBadge v-if="owner.collectorLevel" :level="owner.collectorLevel" class="lvBadge" />
```
- `<style scoped>` 末尾加 `.lvBadge { margin-top: 6px; }`

`src/pages/SellerPage.vue`：
- import 區加 `import CollectorBadge from '@/components/CollectorBadge.vue'`
- 把
```html
      <SellerChip :seller="seller" size="md" :link="false" />
```
改成
```html
      <SellerChip :seller="seller" size="md" :link="false" />
      <CollectorBadge v-if="seller.collectorLevel" :level="seller.collectorLevel" class="lvBadge" />
```
- `<style scoped>` 末尾加 `.lvBadge { margin-top: 8px; }`

`src/pages/MePage.vue`：
- 把 `import { trainerCardApi } from '@/lib/api'` 改成 `import { trainerCardApi, collectorApi } from '@/lib/api'`
- import 區加 `import CollectorProgress from '@/components/CollectorProgress.vue'`
- 在 `const trainerEligible = ref<boolean | null>(null)` 之後加：
```ts
/* 收藏家等級。讀不到（或正式站還沒有這支端點）就是 null，整塊不顯示 */
const collector = ref<{ points: number } | null>(null)
```
- 在 `onMounted(() => {` 區塊內 `trainerCardApi.eligibility()` 那串之後加：
```ts
  collectorApi.me().then(r => { collector.value = r }).catch(() => {})
```
- 在 `</header>`（hero 那個 header 的結尾，緊接在 `<ul class="menu">` 之前）之後加：
```html
    <CollectorProgress v-if="collector" :points="collector.points" />
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exit code 0。

- [ ] **Step 6: Commit**

```bash
git add src/components/CollectorProgress.vue src/lib/social.ts src/types/models.ts src/mocks/data.ts src/lib/api.ts src/pages/PublicCardbookPage.vue src/pages/SellerPage.vue src/pages/MePage.vue
git commit -m "收藏家徽章掛進公開卡冊、賣家頁、我的頁（展示模式假資料）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: 畫面驗證與截圖

**Files:**
- Create: `/private/tmp/claude-501/-Users-adem-tcg-draw-frontend/01b45770-8e18-485f-b83d-6c108ca27a70/scratchpad/collector/check.mjs`（驗證腳本，不進 repo）

**Interfaces:**
- Consumes: Task 2 的 `/design/collector`、Task 3 的三個頁面。

- [ ] **Step 1: 啟動 MOCK 開發伺服器（背景）**

Run（repo 根目錄，背景執行）：`VITE_API_URL= npm run dev -- --port 5187 --strictPort`
Expected: 輸出含 `Local:   http://localhost:5187/`。

- [ ] **Step 2: 寫驗證腳本**

`check.mjs`：

```js
import { chromium } from 'playwright'

const BASE = 'http://localhost:5187'
const OUT = new URL('.', import.meta.url).pathname
const errors = []
const results = []
const ok = (name, cond, detail = '') => results.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)

const browser = await chromium.launch()
for (const scheme of ['dark', 'light']) {
  for (const vp of [{ w: 375, h: 812, tag: 'm' }, { w: 1280, h: 900, tag: 'd' }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: scheme })
    const page = await ctx.newPage()
    page.on('console', m => { if (m.type() === 'error') errors.push(`${scheme}/${vp.tag}: ${m.text()}`) })
    page.on('pageerror', e => errors.push(`${scheme}/${vp.tag}: ${e.message}`))

    // 展示模式要先在首頁按「登入」才會進站
    await page.goto(BASE + '/')
    await page.getByRole('button', { name: '登入' }).first().click()
    await page.waitForTimeout(800)

    const shots = [
      ['design', '/design/collector'],
      ['cardbook', '/u/demo'],
      ['me', '/me'],
      ['seller', null]
    ]
    for (const [name, path] of shots) {
      if (path) await page.goto(BASE + path)
      else {
        // 賣家頁：從 mock 賣家清單第一位進去（id 由頁面連結取得）
        await page.goto(BASE + '/lobby')
        await page.waitForTimeout(800)
        const href = await page.locator('a[href*="/sellers/"]').first().getAttribute('href')
        await page.goto(BASE + (href?.startsWith('/') ? href : '/sellers/' + href))
      }
      await page.waitForTimeout(900)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      ok(`${scheme}/${vp.tag}/${name} 沒有橫向捲動`, !overflow)
      const badges = await page.locator('.cb').count()
      ok(`${scheme}/${vp.tag}/${name} 徽章數`, name === 'design' ? badges === 15 : badges >= 1, String(badges))
      await page.screenshot({ path: `${OUT}${name}-${scheme}-${vp.tag}.png`, fullPage: name === 'design' })
    }
    const meText = await (async () => { await page.goto(BASE + '/me'); await page.waitForTimeout(900); return page.locator('.cp').innerText() })()
    ok(`${scheme}/${vp.tag}/me 進度文字`, meText.includes('還差') && meText.includes('58') && !meText.includes('點'), meText.replace(/\s+/g, ' '))
    await ctx.close()
  }
}
await browser.close()
console.log(results.join('\n'))
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors')
process.exit(results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0)
```

- [ ] **Step 3: 跑驗證**

Run: `node /private/tmp/claude-501/-Users-adem-tcg-draw-frontend/01b45770-8e18-485f-b83d-6c108ca27a70/scratchpad/collector/check.mjs`
（若 `playwright` 套件在 repo 裡找不到，改在 scratchpad/collector 目錄 `npm i playwright@latest` 後再跑，並用 `npx playwright install chromium` 安裝瀏覽器。）
Expected: 所有行 `ok`、`no console errors`、exit code 0。

若「賣家頁」徽章數為 0：檢查第一位 mock 賣家是否被分配到等級 0（Task 3 Step 1 的循環），必要時改抓第一位 `collectorLevel > 0` 的賣家。若「我的頁進度文字」含「點」：檢查文案是否誤寫「點」。修正後重跑。

- [ ] **Step 4: 看截圖**

逐張檢查 `*.png`：徽章在淺色與深色都讀得到、五個等級分得出高低、名稱沒有被截斷到看不出來、進度條位置合理。有問題回到對應 Task 修正後重跑 Step 3。

- [ ] **Step 5: 關閉開發伺服器**

停止 Step 1 的背景程序。
