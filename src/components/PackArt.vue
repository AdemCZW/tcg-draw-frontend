<script setup lang="ts">
/**
 * 自製卡盒視覺 —— 完全不使用任何廠商素材。
 *
 * 幾何：正面／側面／頂面 + 上方吊掛卡榫，全部用 CSS preserve-3d 疊成真實的
 * 立體，不是用漸層假裝厚度。傾斜時各面的面積真的改變。
 * 預設帶靜止傾角（rotateX 9° / rotateY -21°），不用互動也看得出是盒子。
 *
 * 吊掛卡榫（歐洲孔）是零售卡盒最好認的特徵之一 —— 它從盒頂突出、打一個
 * 圓孔，而且因為薄，會在盒蓋上投下一小段陰影。這個細節比任何光影都更能
 * 讓人第一眼認出「這是實體商品的包裝」。
 *
 * 正面美術刻意避開任何特定角色：屬性符號（火／水／葉／雷／晶／星）是通用
 * 圖形，放射光芒與光球負責 TCG 的儀式感。用寶可夢角色剪影會把自製包裝
 * 好不容易removed 的版權曝險放回來，而且剪影「一眼認得出是誰」，
 * 比抽象圖案更難主張合理使用。
 *
 * 品牌上維持「封存」：正面橫貼防拆封條，承諾雜湊直接印在上面。
 * 尺寸全部用 cqw，88px 縮圖到滿版共用同一套幾何。
 */
import { computed } from 'vue'
import type { Tier } from '@/types/models'
import { useTilt } from '@/composables/useTilt'

const props = withDefaults(defineProps<{
  tier?: Tier
  label?: string
  serial?: string
  hash?: string
  /** 已開封：封條褪色、盒蓋掀起 */
  opened?: boolean
  /** 縮圖模式：拿掉小字，只留封條與封緘 */
  compact?: boolean
  /** 關掉游標傾斜，靜止傾角仍保留 */
  flat?: boolean
  /** 盒身材質。不給就依賞別自動選 */
  material?: 'grey' | 'silver' | 'gold'
  /** 特效。不給就依材質自動選（金=火、銀=雷、灰=晶） */
  effect?: 'fire' | 'bolt' | 'water' | 'leaf' | 'crystal' | 'star' | 'none'
}>(), {
  tier: 'D', label: '', serial: '', hash: '',
  opened: false, compact: false, flat: false,
  material: undefined, effect: undefined
})

/**
 * 材質：灰／銀／金。這是獨立於賞別的一條「等級軸」——
 * 金屬感靠的不是單一顏色，而是明暗交錯的多段漸層，所以每種材質都要
 * 一組 lo/base/hi 三色，少了任何一段就會變成平塗的色塊。
 */
const MATERIALS = {
  grey:   { lo: '#2b2e34', base: '#6e757f', hi: '#c6ccd5', rim: '#d8dde3', ink: '#101216' },
  silver: { lo: '#3b4148', base: '#939ba4', hi: '#f4f7fa', rim: '#ffffff', ink: '#14161a' },
  gold:   { lo: '#4f3709', base: '#b9862a', hi: '#f9e6a8', rim: '#ffeab4', ink: '#201704' }
} as const
export type PackMaterial = keyof typeof MATERIALS

/** 賞別預設對應的材質，呼叫端可用 material 覆寫 */
const TIER_MATERIAL: Record<Tier, PackMaterial> = {
  A: 'gold', LAST: 'gold', B: 'silver', C: 'silver', D: 'grey', BUST: 'grey'
}

/** 特效預設：金配火、銀配雷、灰不動 */
export type PackEffect = 'fire' | 'bolt' | 'water' | 'leaf' | 'crystal' | 'star' | 'none'
const MATERIAL_EFFECT: Record<PackMaterial, PackEffect> = {
  gold: 'fire', silver: 'bolt', grey: 'crystal'
}

const mat = computed(() => MATERIALS[props.material ?? TIER_MATERIAL[props.tier]])
const matName = computed(() => props.material ?? TIER_MATERIAL[props.tier])
const fx = computed(() => props.effect ?? MATERIAL_EFFECT[matName.value])
const foil = computed(() => mat.value.base)
const hashChip = computed(() => (props.hash ? props.hash.slice(0, 10).toUpperCase() : ''))
const tierLabel = computed(() =>
  props.tier === 'LAST' ? '最後賞' : props.tier === 'BUST' ? '爆賞' : `${props.tier} 賞`
)
// uid 必須含材質 —— 否則同一頁不同材質的盒子會共用漸層 id 而互相覆蓋
const uid = computed(() => `bx${props.tier}${matName.value}${(props.serial || props.label || 'vd').replace(/\W/g, '')}`)

const { el, rx, ry, gx, gy, active, onMove, reset } = useTilt(9)

/** 靜止傾角：不互動也看得出立體 */
const REST_X = 9, REST_Y = -21

const boxTransform = computed(() => {
  const x = REST_X + (props.flat ? 0 : rx.value)
  const y = REST_Y + (props.flat ? 0 : ry.value)
  return `rotateX(${x}deg) rotateY(${y}deg)`
})

const CY = computed(() => (props.compact ? 214 : 200))

/**
 * 屬性符號環。通用圖形，不對應任何特定角色 ——
 * 火、水、葉、雷、晶、星，是這個品類共通的視覺語彙。
 */
const GLYPHS = [
  'M0 -9 C4.5 -3 7 0 7 3.4 A7 7 0 0 1 -7 3.4 C-7 -0.4 -3 -2 0 -9 Z',            // 火
  'M0 -9.5 C5.5 -3 7.5 0.6 7.5 3.6 A7.5 7.5 0 0 1 -7.5 3.6 C-7.5 0.6 -5.5 -3 0 -9.5 Z', // 水
  'M0 -9 C7 -4.5 7.5 4 0 9 C-7.5 4 -7 -4.5 0 -9 Z',                              // 葉
  'M-2.6 -9.5 L4.2 -1.6 L0.4 -0.9 L3.2 9.5 L-3.8 1 L0 0.2 Z',                    // 雷
  'M0 -9.5 L6 -2.4 L3.2 8.6 L-3.2 8.6 L-6 -2.4 Z',                               // 晶
  'M0 -9.5 Q1.5 -1.6 9.5 0 Q1.5 1.6 0 9.5 Q-1.5 1.6 -9.5 0 Q-1.5 -1.6 0 -9.5 Z'  // 星
]

/** 符號沿上方弧線排開，避開中央封緘 */
const glyphRing = computed(() =>
  GLYPHS.map((d, i) => {
    const a = (-152 + i * 24.8) * (Math.PI / 180)
    return { d, x: 150 + Math.cos(a) * 108, y: CY.value + Math.sin(a) * 108 }
  })
)

/** 火焰：底部竄動的幾簇，各自不同相位 */
const FLAMES = [
  { x: 52,  s: 1.0, d: '0s'   },
  { x: 104, s: 1.5, d: '-.7s' },
  { x: 150, s: 2.1, d: '-1.4s' },
  { x: 196, s: 1.4, d: '-.35s' },
  { x: 248, s: 0.9, d: '-1.05s' }
]
/* 底寬、頂尖。原本頭尾都收成一點（杏仁形），配上「下亮上淡」的漸層，
   看起來會變成倒三角的尖刺而不是火苗。 */
const FLAME_D = 'M-10 0 C-11 -13 -5 -19 -1 -38 C1 -26 4 -24 6 -30 C9 -20 10 -11 10 0 Z'
/** 內焰：更窄更亮，疊在外焰上做出層次 */
const FLAME_CORE_D = 'M-4.5 0 C-5 -9 -2 -13 0 -23 C2 -13 4.5 -9 4.5 0 Z'

/** 閃電：三道，錯開閃爍時間 */
const BOLTS = [
  { x: 74,  y: 108, s: 1.5, d: '0s'    },
  { x: 226, y: 132, s: 1.1, d: '-1.9s' },
  { x: 150, y: 96,  s: 0.8, d: '-3.3s' }
]
const BOLT_D = 'M-7 -34 L9 -6 L1 -3 L11 30 L-9 -1 L-1 -4 Z'

/* ---- 其餘四種屬性特效的粒子 ----
   共通做法：外層 <g> 負責定位，內層元素跑 CSS 動畫。
   位置與延遲刻意錯開，避免整組同步跳動而讀成「圖案」。 */

/** 水：底部升起的氣泡 + 擴散漣漪 */
const BUBBLES = [
  { x: 62, r: 5, d: '0s' }, { x: 108, r: 3, d: '-2.1s' }, { x: 152, r: 6.5, d: '-1.1s' },
  { x: 196, r: 3.5, d: '-3.2s' }, { x: 242, r: 4.5, d: '-1.7s' }, { x: 132, r: 2.5, d: '-2.7s' }
]
const RIPPLES = [{ d: '0s' }, { d: '-1.6s' }, { d: '-3.2s' }]

/** 葉：飄落並左右搖擺 */
const LEAVES = [
  { x: 58, s: 1.1, rot: -20, d: '0s' }, { x: 118, s: .8, rot: 35, d: '-2.4s' },
  { x: 176, s: 1.3, rot: -50, d: '-1.2s' }, { x: 232, s: .9, rot: 15, d: '-3.6s' },
  { x: 148, s: .7, rot: 70, d: '-4.8s' }
]
const LEAF_D = 'M0 -11 C9 -6 9 6 0 11 C-9 6 -9 -6 0 -11 Z'

/** 晶：緩慢浮沉並轉動的碎晶 */
const SHARDS = [
  { x: 66, y: 132, s: 1.2, d: '0s' }, { x: 236, y: 176, s: .9, d: '-2.2s' },
  { x: 96, y: 300, s: .7, d: '-4.1s' }, { x: 214, y: 288, s: 1.05, d: '-1.3s' }
]
const SHARD_D = 'M0 -14 L9 -4 L5 13 L-5 13 L-9 -4 Z'

/** 星：散布的閃爍星芒 */
const SPARKS = [
  { x: 54, y: 152, s: 1.1, d: '0s' }, { x: 246, y: 138, s: .8, d: '-.9s' },
  { x: 88, y: 250, s: .6, d: '-1.8s' }, { x: 212, y: 262, s: 1, d: '-.4s' },
  { x: 150, y: 138, s: .7, d: '-2.3s' }, { x: 40, y: 320, s: .9, d: '-1.4s' },
  { x: 262, y: 330, s: .65, d: '-2.8s' }, { x: 150, y: 358, s: .8, d: '-.6s' }
]
const SPARK_D = 'M0 -13 Q1.8 -2 13 0 Q1.8 2 0 13 Q-1.8 2 -13 0 Q-1.8 -2 0 -13 Z'

/** 封緘後方的放射光芒 */
const rays = computed(() =>
  Array.from({ length: 16 }, (_, i) => ({
    a: i * 22.5,
    o: i % 2 ? 0.05 : 0.11
  }))
)
</script>

<template>
  <div
    class="stage"
    :class="{ opened, tilting: !flat, active }"
    @pointermove="flat || onMove($event)"
    @pointerleave="flat || reset()"
  >
    <div ref="el" class="box" :style="{ transform: boxTransform }">
      <!-- 吊掛卡榫：貼在盒背、從盒頂突出，中間打歐洲孔 -->
      <div class="face tab">
        <svg viewBox="0 0 200 62" aria-hidden="true">
          <defs>
            <linearGradient :id="`${uid}-tab`" x1="0" y1="0" x2="0.2" y2="1">
              <stop offset="0%" stop-color="var(--surface-3)" />
              <stop offset="100%" stop-color="var(--surface)" />
            </linearGradient>
          </defs>
          <!-- 卡榫本體 + 歐洲孔（evenodd 打穿） -->
          <path
            fill-rule="evenodd" :fill="`url(#${uid}-tab)`"
            d="M22 62 L22 20 Q22 6 42 6 L158 6 Q178 6 178 20 L178 62 Z
               M100 22 m-7.5 6.5 a11 11 0 1 1 15 0 l-2 9 a5.5 5.5 0 0 1 -11 0 Z"
          />
          <path
            fill="none" stroke="#fff" stroke-opacity=".16"
            d="M22 62 L22 20 Q22 6 42 6 L158 6 Q178 6 178 20 L178 62"
          />
          <!-- 孔的內緣：上暗下亮，暗示紙板厚度 -->
          <path fill="none" stroke="#000" stroke-opacity=".6" stroke-width="2"
                d="M100 22 m-7.5 6.5 a11 11 0 1 1 15 0" />
          <path fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1.5"
                d="M92.5 28.5 l-2 9 a5.5 5.5 0 0 0 11 0" />
          <rect x="22" y="48" width="156" height="14" :fill="foil" opacity=".2" />
        </svg>
      </div>

      <!-- 頂面 -->
      <div class="face top">
        <span class="top-foil" :style="{ background: foil }"></span>
        <!-- 卡榫在盒蓋上的落影，這道影子是「突出物」讀得出來的關鍵 -->
        <span class="tab-shadow"></span>
      </div>

      <!-- 右側面 -->
      <div class="face side">
        <span class="side-stripe" :style="{ background: foil }"></span>
        <span class="side-text">VAULTDRAW</span>
      </div>

      <!-- 正面 -->
      <div class="face front">
        <svg viewBox="0 0 300 400" role="img"
             :aria-label="label ? `${label} 卡盒` : '卡盒'">
          <defs>
            <linearGradient :id="`${uid}-card`" x1="0" y1="0" x2="0.35" y2="1">
              <stop offset="0%" stop-color="var(--surface-3)" />
              <stop offset="45%" stop-color="var(--surface)" />
              <stop offset="100%" stop-color="var(--bg)" />
            </linearGradient>

            <!-- 金屬感靠明暗交錯的多段漸層，不是單色加白 -->
            <linearGradient :id="`${uid}-seal`" x1="0" y1="0" x2="1" y2="0.35">
              <stop offset="0%" :stop-color="mat.lo" />
              <stop offset="10%" :stop-color="mat.base" />
              <stop offset="24%" :stop-color="mat.hi" />
              <stop offset="36%" :stop-color="mat.base" />
              <stop offset="50%" :stop-color="mat.rim" />
              <stop offset="62%" :stop-color="mat.base" />
              <stop offset="78%" :stop-color="mat.lo" />
              <stop offset="90%" :stop-color="mat.hi" />
              <stop offset="100%" :stop-color="mat.base" />
            </linearGradient>

            <!-- 火焰漸層：底部亮心，往上收成材質色 -->
            <linearGradient :id="`${uid}-flame`" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" :stop-color="mat.rim" stop-opacity=".85" />
              <stop offset="35%" :stop-color="mat.hi" stop-opacity=".5" />
              <stop offset="100%" :stop-color="mat.base" stop-opacity="0" />
            </linearGradient>

            <radialGradient :id="`${uid}-emberglow`" cx="0.5" cy="1" r="0.7">
              <stop offset="0%" :stop-color="mat.base" stop-opacity=".5" />
              <stop offset="100%" :stop-color="mat.base" stop-opacity="0" />
            </radialGradient>

            <radialGradient :id="`${uid}-orb`">
              <stop offset="0%" :stop-color="foil" stop-opacity=".5" />
              <stop offset="40%" :stop-color="foil" stop-opacity=".17" />
              <stop offset="100%" :stop-color="foil" stop-opacity="0" />
            </radialGradient>

            <linearGradient :id="`${uid}-lit`" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#fff" stop-opacity=".09" />
              <stop offset="42%" stop-color="#fff" stop-opacity="0" />
              <stop offset="100%" stop-color="#000" stop-opacity=".38" />
            </linearGradient>

            <radialGradient :id="`${uid}-vig`" cx="0.5" cy="0.48" r="0.7">
              <stop offset="52%" stop-color="#000" stop-opacity="0" />
              <stop offset="100%" stop-color="#000" stop-opacity=".5" />
            </radialGradient>
          </defs>

          <rect x="0" y="0" width="300" height="400" :fill="`url(#${uid}-card)`" />

          <!-- 放射光芒：封緘後方的儀式感 -->
          <g :transform="`translate(150 ${CY})`" :fill="mat.hi">
            <path
              v-for="(r, i) in rays" :key="i"
              :transform="`rotate(${r.a})`" :opacity="r.o"
              d="M-7 -40 L7 -40 L2.5 -168 L-2.5 -168 Z"
            />
          </g>

          <circle cx="150" :cy="CY" r="118" :fill="`url(#${uid}-orb)`" />

          <!-- 火：底部竄動的火苗 + 餘燼光 -->
          <g v-if="fx === 'fire' && !opened" class="fire">
            <ellipse cx="150" cy="400" rx="150" ry="90" :fill="`url(#${uid}-emberglow)`" />
            <!-- 定位在外層 <g>、動畫在內層 <path>：
                 CSS animation 的 transform 會整個覆蓋 SVG 的 transform 屬性，
                 兩者寫在同一個元素上，火苗會塌回畫布原點消失在畫面外。 -->
            <g v-for="(f, i) in FLAMES" :key="i"
               :transform="`translate(${f.x} 392) scale(${f.s})`">
              <path
                class="flame" :d="FLAME_D"
                :fill="`url(#${uid}-flame)`"
                :style="{ animationDelay: f.d }"
              />
              <path
                class="flame core" :d="FLAME_CORE_D"
                :fill="mat.rim" opacity=".55"
                :style="{ animationDelay: f.d }"
              />
            </g>
          </g>

          <!-- 雷：錯開閃爍的三道電光 -->
          <g v-if="fx === 'bolt' && !opened" class="bolts">
            <g v-for="(b, i) in BOLTS" :key="i"
               :transform="`translate(${b.x} ${b.y}) scale(${b.s})`">
              <path
                class="bolt" :d="BOLT_D" :fill="mat.rim"
                :style="{ animationDelay: b.d }"
              />
            </g>
          </g>

          <!-- 水：漣漪 + 上升氣泡 -->
          <g v-if="fx === 'water' && !opened" class="water">
            <g v-for="(r, i) in RIPPLES" :key="'r' + i" transform="translate(150 386)">
              <ellipse class="ripple" rx="52" ry="13" fill="none"
                       :stroke="mat.hi" stroke-width="2" :style="{ animationDelay: r.d }" />
            </g>
            <g v-for="(b, i) in BUBBLES" :key="'b' + i" :transform="`translate(${b.x} 392)`">
              <circle class="bubble" :r="b.r" fill="none" :stroke="mat.hi"
                      stroke-width="1.6" :style="{ animationDelay: b.d }" />
            </g>
          </g>

          <!-- 葉：飄落搖擺 -->
          <g v-if="fx === 'leaf' && !opened" class="leaves">
            <g v-for="(l, i) in LEAVES" :key="i" :transform="`translate(${l.x} 40) scale(${l.s})`">
              <path class="leaf" :d="LEAF_D" :fill="mat.hi" opacity=".5"
                    :style="{ animationDelay: l.d, '--rot': l.rot + 'deg' }" />
            </g>
          </g>

          <!-- 晶：浮沉轉動的碎晶 -->
          <g v-if="fx === 'crystal' && !opened" class="shards">
            <g v-for="(c, i) in SHARDS" :key="i" :transform="`translate(${c.x} ${c.y}) scale(${c.s})`">
              <path class="shard" :d="SHARD_D" :fill="mat.hi" opacity=".38"
                    :style="{ animationDelay: c.d }" />
              <path class="shard" :d="SHARD_D" fill="none" :stroke="mat.rim"
                    stroke-width="1" opacity=".5" :style="{ animationDelay: c.d }" />
            </g>
          </g>

          <!-- 星：散布閃爍 -->
          <g v-if="fx === 'star' && !opened" class="sparks">
            <g v-for="(p, i) in SPARKS" :key="i" :transform="`translate(${p.x} ${p.y}) scale(${p.s})`">
              <path class="spark" :d="SPARK_D" :fill="mat.rim" :style="{ animationDelay: p.d }" />
            </g>
          </g>

          <!-- 屬性符號環 -->
          <g :fill="mat.hi" opacity=".42">
            <g v-for="(g, i) in glyphRing" :key="i"
               :transform="`translate(${g.x.toFixed(1)} ${g.y.toFixed(1)})`">
              <path class="glyph" :d="g.d" :style="{ animationDelay: `${i * -0.45}s` }" />
            </g>
          </g>

          <rect x="0" y="0" width="300" height="400" :fill="`url(#${uid}-vig)`" />

          <!-- 盒蓋接縫 -->
          <path d="M0 96 H300" stroke="#000" stroke-opacity=".5" stroke-width="2" />
          <path d="M0 98.5 H300" stroke="#fff" stroke-opacity=".08" />

          <!-- 防拆封條 -->
          <g :opacity="opened ? .35 : 1">
            <rect x="0" y="72" width="300" height="48" :fill="`url(#${uid}-seal)`" />
            <path d="M0 72 H300" stroke="#fff" stroke-opacity=".5" />
            <path d="M0 120 H300" stroke="#000" stroke-opacity=".35" />
            <path d="M0 96 H300" stroke="#000" stroke-opacity=".28" stroke-dasharray="3 4" />
            <text v-if="hashChip && !compact" class="seal-text" x="20" y="102"
                  :fill="mat.ink">封存 {{ hashChip }}</text>
            <text
              class="seal-tier" :class="{ solo: compact }"
              :x="compact ? 150 : 280" y="102"
              :text-anchor="compact ? 'middle' : 'end'" :fill="mat.ink"
            >{{ tierLabel }}</text>
          </g>

          <!-- 火漆封緘 -->
          <g :transform="`translate(150 ${CY})${compact ? ' scale(1.3)' : ''}`"
             :opacity="opened ? .3 : 1">
            <path d="M0 -48 L42 -24 L42 24 L0 48 L-42 24 L-42 -24 Z"
                  fill="var(--bg)" fill-opacity=".72" :stroke="foil" stroke-width="2" />
            <path d="M0 -35 L30 -17.5 L30 17.5 L0 35 L-30 17.5 L-30 -17.5 Z"
                  fill="none" stroke="#fff" stroke-opacity=".14" />
            <path d="M-14 -13 L0 18 L14 -13" fill="none" :stroke="foil"
                  stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
          </g>

          <template v-if="!compact">
            <text v-if="label" class="label" x="150" y="308" text-anchor="middle">{{ label }}</text>
            <g transform="translate(0 330)">
              <path d="M26 0 H182 L194 12 V34 H26 Z" fill="#0b0a0c" fill-opacity=".9" />
              <path d="M26 0 H182 L194 12 V34 H26 Z" fill="none" :stroke="foil" stroke-opacity=".45" />
              <text class="brand" x="40" y="23">VAULTDRAW</text>
              <template v-if="serial">
                <rect x="198" y="0" width="76" height="34" :fill="foil" opacity=".9" />
                <text class="serial" x="236" y="23" text-anchor="middle"
                      :fill="mat.ink">{{ serial.slice(-7) }}</text>
              </template>
            </g>
          </template>

          <rect x="0" y="0" width="300" height="400" :fill="`url(#${uid}-lit)`" />
        </svg>

        <span
          v-if="!flat" class="gloss" aria-hidden="true"
          :style="{ background: `radial-gradient(42% 32% at ${gx}% ${gy}%, rgba(255,255,255,.3), transparent 72%)` }"
        ></span>
      </div>

      <div class="shadow"></div>
    </div>
  </div>
</template>

<style scoped>
.stage {
  container-type: inline-size;
  position: relative;
  width: 100%;
  /* 上方要留給卡榫 */
  aspect-ratio: 1 / 1.42;
  /* 透視拉近 —— 距離越短，同樣的角度看起來越立體 */
  perspective: 62cqw;
  perspective-origin: 50% 44%;
}

.box {
  position: absolute;
  left: 5cqw; top: 26cqw;
  width: 72cqw; height: 96cqw;
  transform-style: preserve-3d;
  transition: transform .5s cubic-bezier(.2, .7, .3, 1);
}
.tilting.active .box { transition: transform .08s linear; }

.face { position: absolute; backface-visibility: hidden; }

/* 正面。右緣與上緣各一道亮邊 —— 那是實體盒的稜線受光，
   少了它三個面會糊在一起，看起來就「平」。 */
.front {
  inset: 0;
  overflow: hidden;
  border-radius: 1.2cqw;
  box-shadow:
    inset -1px 0 0 rgba(255, 255, 255, .18),
    inset 0 1px 0 rgba(255, 255, 255, .14),
    inset 1px 0 0 rgba(0, 0, 0, .5);
}
.front svg { display: block; width: 100%; height: 100%; }

/* 吊掛卡榫：貼在盒背，向上突出 */
.tab {
  left: 18%; bottom: 100%;
  width: 64%; height: 20cqw;
  /* 與正面同一平面。放到盒深中段（translateZ(-9cqw)）雖然物理上更接近
     真實的背板卡榫，但在 -21° 的視角下會跟盒頂錯開一段，看起來像浮著的
     另一塊板子。齊平反而讀得出「長在盒子上」。 */
  transform: translateZ(0);
  transform-origin: 50% 100%;
}
.tab svg { display: block; width: 100%; height: 100%; }

/* 右側面 */
.side {
  left: 100%; top: 0;
  width: 20cqw; height: 100%;
  transform-origin: 0 50%;
  transform: rotateY(90deg);
  background: linear-gradient(90deg, var(--surface-2), var(--bg) 78%);
  border-radius: 0 1.2cqw 1.2cqw 0;
  overflow: hidden;
}
/* 對齊正面封條（y 72→120 於 400 高 = 18%→30%）。
   數字不一致的話，封條繞到側面就會錯開一截，立體感立刻破功。 */
.side-stripe {
  position: absolute; left: 0; right: 0; top: 18%;
  height: 12%;
  opacity: .9;
}
.side-text {
  position: absolute; left: 50%; top: 60%;
  transform: translate(-50%, -50%) rotate(90deg);
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 3cqw; font-weight: 700; letter-spacing: .3em;
  color: var(--faint);
}

/* 頂面 */
.top {
  left: 0; bottom: 100%;
  width: 100%; height: 20cqw;
  transform-origin: 50% 100%;
  transform: rotateX(90deg);
  background: linear-gradient(180deg, var(--bg), var(--surface-2));
  border-radius: 1.2cqw 1.2cqw 0 0;
  overflow: hidden;
}
.top-foil {
  position: absolute; left: 0; right: 0; bottom: 0;
  height: 30%;
  opacity: .8;
}
/* 卡榫落在盒蓋上的影子 —— 沒有它，卡榫會像貼紙而不是突出物 */
/* 卡榫落在盒蓋上的影子。原本 62% 高、.62 濃度會把卡榫與盒身之間
   整段糊成黑塊，反而讓卡榫看起來是浮在旁邊的另一塊板子。 */
.tab-shadow {
  position: absolute; left: 18%; width: 64%;
  top: 0; height: 34%;
  background: linear-gradient(180deg, rgba(0, 0, 0, .45), transparent);
}
.opened .top { transform: rotateX(58deg); }

.shadow {
  position: absolute;
  left: -8%; right: -16%; top: 100%;
  height: 30cqw;
  transform-origin: 50% 0;
  transform: rotateX(90deg) translateZ(-10cqw);
  background: radial-gradient(closest-side, rgba(0, 0, 0, .7), transparent 76%);
  filter: blur(1.6cqw);
  pointer-events: none;
}

.gloss {
  position: absolute; inset: 0;
  pointer-events: none;
  opacity: 0; transition: opacity .3s;
  mix-blend-mode: soft-light;
}
.tilting.active .gloss { opacity: 1; }

.seal-text, .seal-tier {
  font-family: var(--font-mono);
  font-size: 16px; font-weight: 700; letter-spacing: .05em;
  fill: #14110e;
}
.seal-tier { letter-spacing: .02em; }
/* 縮圖時正面只算繪到約 62px 寬，viewBox 卻是 300 單位 —— 縮放比約 0.21。
   28px 會變成螢幕上的 5.8px 根本讀不到；40px 才有約 8.8px。 */
.seal-tier.solo { font-size: 40px; }
.serial {
  font-family: var(--font-mono);
  font-size: 13px; font-weight: 700;
  fill: #14110e;
}
.label {
  font-family: var(--font-body);
  font-size: 21px; font-weight: 600; letter-spacing: -.01em;
  fill: #fff;
}
.brand {
  font-family: var(--font-mono);
  font-size: 13px; font-weight: 700; letter-spacing: .2em;
  fill: #efeae4;
}

/* ---- 屬性特效 ----
   全部走 CSS 動畫，沒有 JS 迴圈。transform-box: fill-box 是必要的：
   SVG 元素的 transform-origin 預設參照的是整個 viewBox 原點，
   不設的話火苗會繞著畫布左上角縮放而不是自己的底部。 */
.flame, .bolt {
  transform-box: fill-box;
  transform-origin: 50% 100%;
}
.ripple, .bubble, .leaf, .shard, .spark, .glyph {
  transform-box: fill-box;
  transform-origin: 50% 50%;
}
@media (prefers-reduced-motion: no-preference) {
  .flame  { animation: flame-lick 1.9s ease-in-out infinite alternate; }
  .bolt   { animation: bolt-strike 4.6s steps(1, end) infinite; }
  .ripple { animation: ripple-out 4.8s ease-out infinite; }
  .bubble { animation: bubble-rise 6.4s ease-in infinite; }
  .leaf   { animation: leaf-fall 7.2s linear infinite; }
  .shard  { animation: shard-float 6.8s ease-in-out infinite alternate; }
  .spark  { animation: spark-twinkle 3.4s ease-in-out infinite; }
  .glyph  { animation: glyph-pulse 3.6s ease-in-out infinite alternate; }
}
@keyframes flame-lick {
  0%   { transform: scaleY(.82) scaleX(1.05); opacity: .55; }
  45%  { transform: scaleY(1.18) scaleX(.92); opacity: .95; }
  100% { transform: scaleY(.95) scaleX(1.08); opacity: .7; }
}
/* 閃電是「大部分時間不在」，偶爾爆閃兩下 —— 持續發亮就變成裝飾線條 */
@keyframes bolt-strike {
  0%, 100% { opacity: 0; }
  2%   { opacity: .95; }
  4%   { opacity: .12; }
  6%   { opacity: .85; }
  11%  { opacity: 0; }
}
@keyframes ripple-out {
  0%   { transform: scale(.25); opacity: .5; }
  100% { transform: scale(1.7); opacity: 0; }
}
@keyframes bubble-rise {
  0%   { transform: translateY(0) translateX(0); opacity: 0; }
  12%  { opacity: .55; }
  50%  { transform: translateY(-150px) translateX(7px); }
  85%  { opacity: .35; }
  100% { transform: translateY(-300px) translateX(-5px); opacity: 0; }
}
/* --rot 讓每片葉子有不同的初始角度，否則五片會同角度同步落下 */
@keyframes leaf-fall {
  0%   { transform: translateY(0) translateX(0) rotate(var(--rot, 0deg)); opacity: 0; }
  10%  { opacity: .5; }
  50%  { transform: translateY(180px) translateX(18px) rotate(calc(var(--rot, 0deg) + 180deg)); }
  90%  { opacity: .4; }
  100% { transform: translateY(350px) translateX(-10px) rotate(calc(var(--rot, 0deg) + 360deg)); opacity: 0; }
}
@keyframes shard-float {
  0%   { transform: translateY(-8px) rotate(-14deg); opacity: .3; }
  100% { transform: translateY(10px) rotate(16deg); opacity: .62; }
}
@keyframes spark-twinkle {
  0%, 100% { transform: scale(.25); opacity: 0; }
  45%      { transform: scale(1); opacity: .85; }
  60%      { transform: scale(.8); opacity: .5; }
}
@keyframes glyph-pulse {
  from { opacity: .55; transform: scale(.94); }
  to   { opacity: 1;   transform: scale(1.06); }
}

/* 減少動態時特效靜止但保留，維持材質與屬性的辨識度 */
@media (prefers-reduced-motion: reduce) {
  .box { transition: none; }
  .gloss { display: none; }
  .flame { opacity: .8; }
  .bolt { opacity: .5; }
  .ripple { opacity: .25; }
  .bubble { opacity: .4; }
  .leaf, .shard { opacity: .45; }
  .spark { opacity: .6; }
}
</style>
