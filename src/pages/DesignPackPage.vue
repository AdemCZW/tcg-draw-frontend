<script setup lang="ts">
/**
 * 收藏艙設計展示頁（未列在導覽，網址直達：/design/pack）
 * 把各等級、各屬性、各狀態一次攤開比對，改配色時能立刻看出哪裡不對。
 */
import { computed, nextTick, ref, watch } from 'vue'
import CapsuleArt from '@/components/CapsuleArt.vue'
import RevealBuildup from '@/components/RevealBuildup.vue'
import CardEmerge from '@/components/CardEmerge.vue'
import type { Tier } from '@/types/models'

const openedCount = ref(0)

/* 煙霧浮出：每階一張代表卡，換階或按重播就重新掛載重跑。
   一次性演出要重播只能重新掛載 —— 同一個節點上重設 CSS 動畫不會重跑。 */
const EMERGE_CARDS: Record<Tier, { artId: string; name: string }> = {
  LAST: { artId: 'SV4a-349', name: '噴火龍 ex UR' },
  A: { artId: 'SV4a-350', name: '奇樹 SAR' },
  B: { artId: 'SV8a-237', name: '太樂巴戈斯 ex UR' },
  C: { artId: 'SV8a-217', name: '月亮伊布 ex SAR' },
  D: { artId: 'SV4a-341', name: '謎擬Ｑ SAR' },
  BUST: { artId: 'SV4a-341', name: '謎擬Ｑ SAR' }
}
const emergeTier = ref<Tier>('LAST')
const emergeKey = ref(0)
function replayEmerge(t?: Tier) {
  if (t) emergeTier.value = t
  emergeKey.value++
}

/* 蓄勢演出的展示控制。改成單一大舞台 —— 縮圖尺寸下這個特效根本讀不出來，
   它本來就是設計給接近滿版的畫面用的。 */
const bigBuildup = ref<{ start: () => void; reset: () => void } | null>(null)
const bigTier = ref<Tier>('LAST')
const bigPlaying = ref(false)
const bigLoop = ref(false)

function playBig(tier: Tier) {
  bigTier.value = tier
  bigPlaying.value = true
  bigBuildup.value?.reset()
  // reset 之後要等 Vue 把 class 換回 ph-idle，動畫才會重新播
  nextTick(() => bigBuildup.value?.start())
}
watch(bigPlaying, v => {
  if (!v && bigLoop.value) setTimeout(() => playBig(bigTier.value), 500)
})

const LADDER_LEN: Record<string, number> = { D: 1, C: 2, B: 3, A: 4, LAST: 5 }
const ladderLen = (t: string) => LADDER_LEN[t] ?? 1

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

/* ---- 五階可開啟範本 ----
   等級階梯那一區是靜態的，只能比外觀；這一區是五顆都能實際按開的樣本，
   要看的是「同一套開球序列在五個球階跑起來差多少」——
   微粒數、環繞軌道、光爆強度全部綁在 grade.glow 上，不並排跑一次看不出來。

   卡圖刻意照稀有度往上疊，讓開出來的東西跟球階對得上：
     普卡 → Rare → Double Rare ex → SAR → UR 金卡
   屬性特效則跟著卡片的寶可夢屬性走，開蓋前後的顏色才是同一件事。 */
type OpenFx = 'fire' | 'water' | 'bolt' | 'crystal' | 'star'
interface Openable {
  tier: Tier
  /** 球階名稱 */
  ball: string
  hash: string
  effect: OpenFx
  /** 卡圖網址（TCGdex 官方示意圖） */
  card: string
  cardName: string
  /** 稀有度標示，用來說明「為什麼這張配這階」 */
  rarity: string
  /** Tier 徽章用的權杖色 */
  ink: string
}
const openables: Openable[] = [
  {
    tier: 'D', ball: '精靈球', hash: 'c3f81a09bb27de44', effect: 'fire',
    card: 'https://assets.tcgdex.net/zh-tw/SV/SV7/016/high.webp',
    cardName: '炎兔兒', rarity: '普卡 C', ink: 'var(--tier-d)'
  },
  {
    tier: 'C', ball: '超級球', hash: 'c0ffee9988776655', effect: 'water',
    card: 'https://assets.tcgdex.net/zh-tw/SV/SV7/026/high.webp',
    cardName: '暴噬龜', rarity: '閃卡 R', ink: 'var(--tier-c)'
  },
  {
    tier: 'B', ball: '高級球', hash: 'a1b2c3d4e5f60718', effect: 'bolt',
    card: 'https://assets.tcgdex.net/zh-tw/SV/SV7/033/high.webp',
    cardName: '電蜘蛛 ex', rarity: '雙閃 RR', ink: 'var(--tier-b)'
  },
  {
    tier: 'A', ball: '豪華球', hash: 'f3a91c04bb27de44', effect: 'crystal',
    card: 'https://assets.tcgdex.net/zh-tw/SV/SV7/130/high.webp',
    cardName: '太樂巴戈斯 ex', rarity: '特別異圖 SAR', ink: 'var(--tier-a)'
  },
  {
    tier: 'LAST', ball: '大師球', hash: 'a0c7104ebeef55aa', effect: 'star',
    card: 'https://assets.tcgdex.net/zh-tw/SV/SV8a/236/high.webp',
    cardName: '皮卡丘 ex', rarity: '金卡 UR', ink: 'var(--tier-last)'
  }
]

/* CapsuleArt 的 phase machine 是單向的（idle → … → reveal 之後就停住），
   元件本身沒有回到 idle 的路。要重開只能整顆重新掛載 ——
   所以每顆綁一個會遞增的 run 計數當 :key，按重置就換 key、Vue 丟掉舊實例重建。
   比在外面硬改元件內部狀態可靠：計時器、IntersectionObserver、SVG 的 uid
   全部跟著新實例重來，不會留下上一輪的殘留。 */
const runs = ref<Record<string, number>>({ D: 0, C: 0, B: 0, A: 0, LAST: 0 })
/** 哪幾顆已經開完（reveal）—— 只有開完才讓「再開一次」可按 */
const done = ref<Record<string, boolean>>({ D: false, C: false, B: false, A: false, LAST: false })
const doneCount = computed(() => Object.values(done.value).filter(Boolean).length)

function markOpened(tier: string) {
  done.value[tier] = true
}
function reopen(tier: string) {
  runs.value[tier]++
  done.value[tier] = false
}
function reopenAll() {
  for (const o of openables) reopen(o.tier)
}
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

    <h2 class="withAside">
      五階全開範本
      <span class="aside mono muted">已開 {{ doneCount }} / {{ openables.length }}</span>
      <button
        class="btn ghost sm" type="button"
        :disabled="doneCount === 0" @click="reopenAll"
      >全部重置</button>
    </h2>
    <p class="lede muted">
      五個球階各一顆，按中央按鈕就會跑完整段開球序列。卡圖依稀有度往上疊，屬性特效跟著卡片的寶可夢屬性走。
    </p>
    <div class="grid openable">
      <figure v-for="o in openables" :key="o.tier">
        <!-- :key 換掉就整顆重新掛載 —— 這是讓單向 phase machine 能重跑的唯一乾淨作法 -->
        <CapsuleArt
          :key="`${o.tier}-${runs[o.tier]}`"
          :tier="o.tier" :label="o.ball" :hash="o.hash"
          interactive :effect="o.effect"
          :card-image="o.card"
          @opened="markOpened(o.tier)"
        />
        <figcaption>
          <span class="tierTag mono" :style="{ color: o.ink, borderColor: o.ink }">{{ o.tier }}</span>
          <span class="ballName">{{ o.ball }}</span>
          <span class="mono muted cardMeta">{{ o.cardName }} · {{ o.rarity }}</span>
          <button
            class="btn ghost sm reopen" type="button"
            :disabled="!done[o.tier]" @click="reopen(o.tier)"
          >再開一次</button>
        </figcaption>
      </figure>
    </div>

    <h2>卡片從煙霧浮出</h2>
    <p class="note">
      「從煙裡浮上來」的關鍵不是淡入 —— 淡入只會像貼圖漸漸變不透明。
      真正的訊號是卡的下半部還陷在煙裡看不清，而這條界線隨著卡片上升往下退。
      核心是一條會移動的遮罩，不是 opacity。
    </p>
    <div class="emergeDemo">
      <div class="emergeStage">
        <CardEmerge
          :key="emergeKey"
          :tier="emergeTier"
          :art-id="EMERGE_CARDS[emergeTier].artId"
          :name="EMERGE_CARDS[emergeTier].name"
        />
      </div>
      <div class="emergeCtl">
        <button
          v-for="t in (['D','C','B','A','LAST'] as Tier[])" :key="t"
          type="button" class="btn sm"
          :class="{ primary: emergeTier === t }"
          @click="replayEmerge(t)"
        >{{ t === 'LAST' ? '最後賞' : t + ' 賞' }}</button>
        <button type="button" class="btn sm" @click="replayEmerge()">↻ 重播</button>
      </div>
    </div>

    <h2>開卡前蓄勢演出</h2>
    <p class="note muted">
      球體碎幾次、最後停在什麼顏色，就是稀有度的暗號：藍 → 青 → 金 → 橙 → 虹。
      升級是誠實的，不會先閃大獎再降回去。建議從精靈球依序按到大師球 ——
      單看一顆感覺不出差別，連著看才知道「等越久＝獎越大」。
    </p>
    <div class="buildBig">
      <div class="bigStage">
        <RevealBuildup ref="bigBuildup" :tier="bigTier" @done="bigPlaying = false" />
        <p v-if="!bigPlaying" class="hint muted mono">選一個球階播放</p>
      </div>
      <div class="bigBar">
        <button
          v-for="g in grades" :key="`big-${g.tier}`"
          type="button" class="btn ghost sm"
          :class="{ act: bigTier === g.tier && bigPlaying }"
          @click="playBig(g.tier)"
        >{{ g.label }}<span class="mono steps">{{ ladderLen(g.tier) }}</span></button>
        <label class="loop">
          <input v-model="bigLoop" type="checkbox" />循環
        </label>
      </div>
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
.emergeDemo { display: grid; gap: 14px; margin-bottom: 30px; }
.emergeStage { width: 100%; max-width: 420px; }
.emergeCtl { display: flex; gap: 8px; flex-wrap: wrap; }
.emergeCtl .btn.sm { padding: 8px 14px; font-size: 13px; }

.note { font-size: 13px; margin: -6px 0 16px; max-width: 62ch; }
.buildBig { max-width: 720px; }
.bigStage {
  position: relative;
  aspect-ratio: 16 / 10;
  border-radius: var(--radius-lg);
  background: #06050a;
  border: 1px solid var(--line);
  overflow: hidden;
  display: grid; place-items: center;
}
.hint { font-size: 12px; letter-spacing: .1em; }
.bigBar {
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 8px; margin-top: 12px;
}
.btn.sm { padding: 7px 14px; font-size: 13px; display: inline-flex; align-items: center; gap: 7px; }
.btn.act { background: var(--accent-wash); color: var(--accent); }
.steps {
  font-size: 10.5px; opacity: .6;
  border: 1px solid currentColor; border-radius: var(--pill);
  padding: 0 5px;
}
.loop {
  margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; color: var(--muted); cursor: pointer;
}
@media (max-width: 720px) {
  .bigStage { aspect-ratio: 4 / 5; }
  .btn.sm { padding: 6px 11px; font-size: 12px; }
  .loop { margin-left: 0; }
}
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

/* ---- 五階全開範本 ---- */
.withAside { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.aside { font-size: 12px; font-weight: 400; }
.lede { font-size: 13px; line-height: 1.6; margin: -6px 0 18px; max-width: 60ch; }
.btn.sm { padding: 6px 13px; font-size: 12px; }

/* 每顆球要留得夠大，中央按鈕才按得到 —— 它的直徑只有版位寬度的 8.7%，
   版位一窄就變成一顆點不到的點。所以這一區的最小欄寬比其他區大一截。 */
.grid.openable { grid-template-columns: repeat(auto-fit, minmax(216px, 1fr)); }
.grid.openable figcaption {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 10px;
}
.tierTag {
  font-size: 10.5px; letter-spacing: .06em;
  border: 1px solid; border-radius: var(--pill);
  padding: 2px 8px; opacity: .9;
}
.ballName { font-size: 12.5px; }
.cardMeta { font-size: 11px; flex: 1 1 100%; }
.reopen { flex: 1 1 100%; margin-top: 2px; }

@media (max-width: 720px) {
  .grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
  /* 兩欄下版位剩不到 160px，中央按鈕會縮到 14px 左右 —— 手指按不到。
     這一區改單欄，讓球維持在可以確實點開的尺寸。 */
  .grid.openable { grid-template-columns: 1fr; max-width: 340px; gap: 26px; }
}
</style>
