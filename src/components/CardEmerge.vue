<script setup lang="ts">
/**
 * 卡片從煙霧中浮出。
 *
 * 參考的是「smoke logo reveal」那一類的片頭：一團煙衝進畫面、翻捲，
 * 然後散開露出後面的東西。所以揭曉靠的是**煙散掉**，不是卡片變亮 ——
 * 煙畫在卡片「前面」（SmokePlume，輸出帶 alpha），不是背景。
 * 這是煙霧揭曉跟一般淡入的根本差別。
 *
 * 卡片自己的動作不是 Y 軸，是深度：從遠處又小又糊被煙包著，
 * 由遠推近、霾散掉。上下只留一點浮動，多了就變成貼圖在滑。
 *
 * 層次由後往前：
 *   1 背光：卡背後的光源，跟卡片一起放大 = 光源正在靠近
 *   2 卡片本體：由小放大、去霾
 *   3 煙霧羽流：蓋在卡片前面，湧入 → 翻捲 → 散開
 *   4 衝擊層：蓄力吸入、爆發、粒子（ImpactBurst，加法疊光）
 *
 * 第 4 層是後來補的，因為整段演出原本從頭到尾都是柔和的漸變，沒有爆點。
 * 衝擊感的來源不是「更亮更多」而是**對比**：charge 那一拍先把畫面收暗、
 * 把東西吸進核心，burst 才炸得開。詳見 docs/reveal-fx-research.md。
 *
 * ---- 二次改版：高賞別的加碼 ----
 * A／LAST 賞多兩拍（crack + inhale），整段從 10.0 s 拉到 12.5 s，
 * 變成「蓄力 → 第一次爆 → 更深的吸入 → 主爆」的雙段爆發。
 * 加碼**只給高賞別**：每抽一張 D 賞都播一場十幾秒的雙段爆炸，
 * 會讓人想關掉，而且衝擊一旦變成常態就不再是衝擊。
 * B 賞以下的節奏與強度跟改版前一模一樣（七拍、單一爆點）。
 *
 * ---- 三次改版：三段式、靜默、卡片自己出力 ----
 * 12.5 s → 16.15 s（十二拍）。多的 3.65 s 沒有一秒是重播：
 *   surge  第二次爆，三段式的中間那一級（神光第一次出現）
 *   hush   主爆前最深的靜默 + 慢動作，畫面幾乎全黑、完全不動
 *   lock   卡片自己砸進畫面，方形衝擊波與地面塵，DOM 那張卡在這裡接手
 * 主爆本身也加長 0.25 s，用來放神光與玻璃裂紋的退場；
 * settle 加長 0.4 s，放卡面能量流與繞行光點。
 * **加碼仍然只給 A／LAST**：B/C/D 的腳本一個字都沒動。
 *
 * 相位用 setTimeout 推進，不用 rAF：分頁被節流時 rAF 不推進，
 * 整段演出會凍在某一格，使用者切回來看到的是半截卡片。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Tier } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import { artUrlById } from '@/lib/tcgdex'
import SmokePlume from '@/components/SmokePlume.vue'
import ImpactBurst from '@/components/ImpactBurst.vue'

const props = withDefaults(defineProps<{
  artId?: string | null
  image?: string
  name?: string
  tier?: Tier
  /** 掛載後自動播 */
  auto?: boolean
  /**
   * 演出速度倍率。1 = 完整十秒。
   *
   * 開卡結果頁會依實際開出的賞別調 —— 最高賞值得看完整段，
   * 每抽一張 D 賞都播十秒只會讓人想關掉。這跟 RevealBuildup
   * 「演出等級對應真的開出來的東西」是同一個原則。
   */
  pace?: number
  /**
   * 演出強度 0..1。爆發的粒子量、震幅、爆光量都乘這個數。
   *
   * 跟 pace 分開的理由：光靠加速，低賞別看到的還是同一場大爆炸只是快轉，
   * 「衝擊感」就被稀釋成常態。要衝擊感成立，它必須是**稀有的**——
   * 低賞別要真的比較小聲，不只是比較短。
   */
  intensity?: number
}>(), { artId: null, image: '', name: '', tier: 'D', auto: true, pace: 1, intensity: 1 })

const emit = defineEmits<{ (e: 'done'): void }>()

/* 相位：
   still   空的，只有一點微光
   gather  煙從四個邊往內聚攏
   swell   煙合攏成一片，翻騰、懸著
   charge  核心把煙吸進去壓實，畫面收暗、震動累積
   crack   第一次爆（高賞別）。小一號的爆點，語彙跟主爆一樣但規模砍半
   inhale  更深的吸入（高賞別）。比第一次爆之前更暗、更空、吸得更急
   surge   第二次爆（高賞別）。中間那一級：兩道環、神光第一次出現
   hush    最深的靜默（高賞別）。幾乎全黑、慢動作，只有殘骸在落
   burst   主爆：命中停頓、爆光、衝擊波、十字光芒、裂紋、神光、玻璃裂紋、粒子
   form    卡片從爆散的餘料裡凝聚出來
   lock    卡片砸定（高賞別）。方形衝擊波、地面塵、第四次停頓；DOM 那張卡接手
   settle  煙散掉，卡片定裝，餘韻
*/
/* 兩套腳本。
   低賞別維持原本的七拍（10.0 s），高賞別是十二拍（16.15 s）。

   多的拍子不是為了「更長」。每一拍都要負責一件前面沒做過的事，
   否則同一個爆點播三次只會讓人想按跳過：

   crack  0.55 s  第一聲。它是一聲不是一段，所以短。
   inhale 1.25 s  吸氣一定要比爆炸久，不然那不是吸氣是抽搐。
   surge  0.80 s  第二聲，中間那一級。**神光第一次出現**在這裡 ——
                  第一次出現的東西自帶份量，把它放在中間級，
                  主爆才有東西可以變本加厲，而不是重播一次。
   hush   1.35 s  最深的靜默。**這是整段裡最重要的一拍，而它幾乎不畫東西。**
                  前面已經炸過兩次，觀眾的基準線被抬高了；主爆要還打得動人，
                  唯一的辦法是把基準線一次踩到比開場更低的地方。
                  這一拍同時是慢動作段（見 warps）：時間先慢下來，
                  主爆瞬間跳回全速 —— 速度的**變化**比長度更有衝擊。
   burst  1.45 s  主爆。比二版多的 0.25 s 給神光與玻璃裂紋的退場。
   lock   0.85 s  卡片砸定。在這之前卡片全程是被動的（被聚出來、被照亮、
                  被推近）；這一拍讓它自己出一次力，撞出方形衝擊波與地面塵。
                  DOM 那張卡也在這裡接手 —— 接手點本身就是一個事件，
                  不該躲在餘韻的淡入裡。
   settle 2.40 s  餘韻：環境光呼吸、兩道掃光、卡面能量流、繞行光點。

   form 那一拍裡面還分兩段：煙先堆成卡的形狀，圖案才在上面顯影。
   swell 那一拍（煙已經合攏、卡片還沒開始成形）是刻意留的空白 ——
   演出要有一個「什麼都沒發生」的懸置，後面的凝聚才有份量。 */
type Phase = 'still' | 'gather' | 'swell' | 'charge' | 'crack' | 'inhale'
  | 'surge' | 'hush' | 'burst' | 'form' | 'lock' | 'settle'
type Beat = { k: Phase; ms: number }
const BASE_SCRIPT: Beat[] = [
  { k: 'still', ms: 700 },
  { k: 'gather', ms: 1600 },
  { k: 'swell', ms: 1100 },
  { k: 'charge', ms: 1500 },
  { k: 'burst', ms: 900 },
  { k: 'form', ms: 2600 },
  { k: 'settle', ms: 1600 }
]
const EPIC_SCRIPT: Beat[] = [
  { k: 'still', ms: 700 },
  { k: 'gather', ms: 1600 },
  { k: 'swell', ms: 1100 },
  { k: 'charge', ms: 1500 },
  { k: 'crack', ms: 550 },
  { k: 'inhale', ms: 1250 },
  { k: 'surge', ms: 800 },
  { k: 'hush', ms: 1350 },
  { k: 'burst', ms: 1450 },
  { k: 'form', ms: 2600 },
  { k: 'lock', ms: 850 },
  { k: 'settle', ms: 2400 }
]
/* 誰值得加碼。用 tier 而不是 intensity 判斷：intensity 是「多大聲」的旋鈕，
   加不加碼是「有沒有這一段」的分岔，兩件事不該共用一個數字。

   注意上限：結果頁有一條 20 s 的保險絲（WebGL 掛掉時強制顯示明細），
   整段演出必須明顯短於它，否則保險絲會在演出還沒播完時把它掐掉。
   十二拍是 16.15 s，留了 3.85 s。**再加拍之前先確認那條保險絲。** */
const EPIC_TIERS = new Set<Tier>(['A', 'LAST'])
const epic = computed(() => EPIC_TIERS.has(props.tier))
const script = computed(() => (epic.value ? EPIC_SCRIPT : BASE_SCRIPT))

/** 各拍的起點（毫秒，未乘倍率）。衝擊層要知道「幾毫秒的時候該炸」，
    而它跑的是自己的 rAF 時鐘，不是這裡的 setTimeout。 */
const mark = computed(() => {
  const m = {} as Record<Phase, number>
  let t = 0
  for (const b of script.value) { m[b.k] = t; t += b.ms }
  return { m, total: t }
})

/* 演出可以整段放慢，用來逐格調動畫：?fxslow=8。
   跟 ?nogl=1 同一套除錯開關。正式流程不會帶這個參數，倍率就是 1。 */
const SLOW = Math.min(20, Math.max(1, Number(new URLSearchParams(location.search).get('fxslow')) || 1))
/** 每一拍實際的毫秒數 = 腳本值 × 除錯倍率 ÷ 速度倍率 */
const rate = computed(() => SLOW / Math.max(0.2, props.pace))

const phase = ref<Phase>('still')
let timer: number | undefined

/** 整段演出的總長 */
const TOTAL = computed(() => mark.value.total * rate.value)
/** 煙霧那一層自己的長度（到 form 結束為止）。
    form 之後煙已經沒事做了：高賞別接的是 lock（DOM 那張卡砸定），
    低賞別接的是 settle。用哪一拍當終點，就等於「shader 那張卡什麼時候完工」。 */
const SMOKE_TOTAL = computed(() =>
  (epic.value ? mark.value.m.lock : mark.value.m.settle) * rate.value)

/* ---- 煙霧的時間重映射 ----
   SmokePlume 的 shader 常數是寫在一條**正規時間軸**上的（見那支的檔頭對照表），
   跟這裡每一拍實際幾毫秒無關。高賞別多插的兩拍如果直接改變 uProg 的比例，
   那邊所有 smoothstep 都要重算一次 —— 那是一定會忘記做的事。
   所以這裡把實際節奏對應回正規軸：crack／inhale／surge／hush 全部併進 charge
   那一段，煙看到的只是「charge 這一段變長了」（1.5 s → 5.45 s），
   於是它自己就吸得更久、壓得更實。三次改版又多插兩拍，這張表**還是沒有動**。

   lock 不在任何一組裡：它在 form 之後，那時 shader 那張卡已經完工，
   煙的工作結束了（SMOKE_TOTAL 就是收在那裡）。 */
const SMOKE_GROUPS: Phase[][] = [
  ['still'], ['gather'], ['swell'],
  ['charge', 'crack', 'inhale', 'surge', 'hush'], ['burst'], ['form']
]
const CANON_MS = [700, 1600, 1100, 1500, 900, 2600]
const CANON_TOTAL = 8400
const smokeSegments = computed<[number, number, number][]>(() => {
  const dur = (k: Phase) => script.value.find(x => x.k === k)?.ms ?? 0
  let acc = 0
  return SMOKE_GROUPS.map((g, i) => {
    const ms = g.reduce((s, k) => s + dur(k), 0) * rate.value
    const from = acc / CANON_TOTAL
    acc += CANON_MS[i]!
    return [ms, from, acc / CANON_TOTAL] as [number, number, number]
  })
})

const TIER_HUE: Record<Tier, string> = {
  D: '#ef4040', C: '#3f7fd8', B: '#f5c400', A: '#d8b25a', LAST: '#8b4fd0', BUST: '#ef4040'
}
const hue = computed(() => TIER_HUE[props.tier])
const tint = computed<[number, number, number]>(() => {
  const h = hue.value.replace('#', '')
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
  return [Math.min(1, v(0) * 1.15), Math.min(1, v(2) * 1.15), Math.min(1, v(4) * 1.15)]
})

const plumeGl = ref(!new URLSearchParams(location.search).has('nogl'))

/* 要交給 shader 當貼圖的卡圖。拿不到就退回 DOM 那張卡自己做推近。 */
const cardUrl = computed(() => {
  if (props.image && !props.image.startsWith('placeholder:')) return props.image
  return props.artId ? artUrlById(props.artId) : null
})

/* 卡片矩形換算到 shader 座標（以畫布高為 1）。
   舞台 4:5、卡片佔寬 58%、卡面 5:7 —— 這三個數字一改這裡就要跟著改，
   對不上的話 shader 聚出來的卡跟 DOM 那張會錯位。 */
const STAGE_AR = 4 / 5
const CARD_W = 0.58
const cardHalf = computed<[number, number]>(() => {
  const hx = (CARD_W * STAGE_AR) / 2
  return [hx, hx * (7 / 5)]
})

/** shader 已經拿到卡圖：卡片改由煙聚出來，DOM 那張等 settle 才接手 */
const shaderCard = ref(false)
const plume = ref<{ restart: () => void } | null>(null)
const burst = ref<{ restart: () => void } | null>(null)
const burstGl = ref(!new URLSearchParams(location.search).has('nogl'))
const reduce = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/* ---- 命中停頓 ----
   DOM 這邊做的是「定格」：不做過渡、直接跳到一個被推開的姿勢
   （鏡頭推近、傾斜、失焦、過曝），撐住一段時間再放開。
   CSS 的 transition 沒辦法真的暫停，所以停頓不是「凍住動畫」而是
   「插進一格不動的畫」—— 讀起來是一樣的，而且不必接管任何時間軸。
   衝擊層那邊是把餵給 shader 的秒數重映射，兩邊對的是同一個時刻。

   高賞別有五次停頓，長度本身就是三段式的量尺：
     1 第一次爆         70 ms  小格（.hitS）
     2 第二次爆        110 ms  中格（.hitM）
     3 主爆            165 ms  大格（.hit）
     4 主爆的第二拍     60 ms  大格，跟第 3 次隔 190 ms
     5 卡片砸定        130 ms  砸定格（.hitL），方向朝下
   第 4 次是「回彈」：重物砸下去之後還會再頓一下，只頓一次讀起來像單擊，
   頓兩次才有重量。兩次之間一定要放開（190 ms），連在一起就只是一次長停頓。
   第 5 次是**卡片自己**造成的，所以姿勢跟前四次不同：不推近、不歪，
   而是往下沉一格再彈回來 —— 受力方向朝下，那是「砸」不是「炸」。

   停頓長度不隨 pace 縮放：40–80 ms 這個量級是人眼的門檻，
   按倍率縮下去就低到看不出來了。強度倒是要縮 —— 小獎不該有重擊。

   FLASH 那兩個偏移是「相位切換」到「畫面真的炸開」之間的差。
   要凍在**已經炸開**那一格，凍在還沒亮的那一格是看不出來的。 */
const CRACK_FLASH = 45
const CRACK_STOP = 70
const SURGE_FLASH = 50
const SURGE_STOP = 110
const HIT_DELAY = 55
const HIT_STOP = 165
const HIT2_GAP = 190
const HIT2_STOP = 60
const LOCK_FLASH = 40
const LOCK_STOP = 130

/** 第一次爆的引爆瞬間（毫秒，實際時間）。低賞別沒有，就等於主爆 */
const crackAtMs = computed(() =>
  (epic.value ? mark.value.m.crack + CRACK_FLASH : mark.value.m.burst + HIT_DELAY) * rate.value)
/** 深吸氣起點。低賞別沒有，就等於主爆 */
const inhaleAtMs = computed(() =>
  (epic.value ? mark.value.m.inhale : mark.value.m.burst + HIT_DELAY) * rate.value)
/** 第二次爆的引爆瞬間。低賞別沒有，就等於主爆 */
const surgeAtMs = computed(() =>
  (epic.value ? mark.value.m.surge + SURGE_FLASH : mark.value.m.burst + HIT_DELAY) * rate.value)
/** 最深靜默的起點。低賞別沒有，就等於主爆 */
const hushAtMs = computed(() =>
  (epic.value ? mark.value.m.hush : mark.value.m.burst + HIT_DELAY) * rate.value)
/** 主爆的引爆瞬間 */
const burstAtMs = computed(() => (mark.value.m.burst + HIT_DELAY) * rate.value)
/** 卡片砸定的瞬間。低賞別沒有這一拍，傳 0（衝擊層用 0 當哨兵） */
const lockAtMs = computed(() =>
  (epic.value ? (mark.value.m.lock + LOCK_FLASH) * rate.value : 0))

/* ---- 時間伸縮：慢動作 → 突然全速 ----
   hush 那一拍舞台時間只走 0.45 倍，主爆的那一刻跳回 1 倍。
   加長一拍只會讓人覺得久；讓速度在同一段畫面裡**變一次**才有衝擊 ——
   觀眾感覺到的不是「這裡比較慢」，是「剛剛那下突然變快了」。

   只作用在衝擊層（它跑自己的 rAF 時鐘，重映射一個數字就好）。
   DOM 這邊不需要：那些 keyframes 的曲線本來就是照著這一拍實際的秒數寫的，
   要慢就直接把曲線寫慢，多套一層時間映射只會多一個對不準的地方。

   終點取 burst 那一拍的起點（不是引爆時刻）：全速要在爆之前就恢復，
   否則爆光的前 55 ms 會是慢動作的，那一下就軟掉了。 */
const warps = computed<[number, number, number][]>(() =>
  epic.value
    ? [[hushAtMs.value, mark.value.m.burst * rate.value, 0.45]]
    : [])

/** [起點, 長度, 是否小格][]。衝擊層只要前兩欄，DOM 這邊用第三欄選定格的姿勢。
    衝擊層與 DOM 共用**同一份**清單 —— 各算一次的話兩邊會對不到同一個時刻，
    那比沒有停頓還糟（畫面凍住的瞬間爆光已經退掉了）。 */
type HitKind = 'hit' | 'hitS' | 'hitM' | 'hitL'
const hitPlan = computed(() => {
  const out: { at: number; ms: number; kind: HitKind }[] = []
  const int = props.intensity
  if (epic.value) {
    const c = CRACK_STOP * int
    if (c > 20) out.push({ at: crackAtMs.value, ms: c, kind: 'hitS' })
    const s = SURGE_STOP * int
    if (s > 20) out.push({ at: surgeAtMs.value, ms: s, kind: 'hitM' })
  }
  const m1 = HIT_STOP * int
  if (m1 > 20) {
    const a1 = burstAtMs.value
    out.push({ at: a1, ms: m1, kind: 'hit' })
    if (epic.value) out.push({ at: a1 + m1 + HIT2_GAP, ms: HIT2_STOP * int, kind: 'hit' })
  }
  if (epic.value) {
    const l = LOCK_STOP * int
    if (l > 20) out.push({ at: lockAtMs.value, ms: l, kind: 'hitL' })
  }
  /* 衝擊層拿到的必須是**依時間排序**的清單：stageMs 沿著它累加已凍時間，
     順序亂掉的話累加會提早中斷，後半段的舞台時間就全部錯位。 */
  return out.sort((a, b) => a.at - b.at)
})
const stops = computed<[number, number][]>(() => hitPlan.value.map(s => [s.at, s.ms]))

const hit = ref(false)
const hitS = ref(false)
const hitM = ref(false)
const hitL = ref(false)
const hitFlag: Record<HitKind, typeof hit> = { hit, hitS, hitM, hitL }
const hitTimers: number[] = []

function clearHits() {
  while (hitTimers.length) clearTimeout(hitTimers.pop())
  hit.value = false
  hitS.value = false
  hitM.value = false
  hitL.value = false
}

function run(i = 0) {
  const s = script.value
  if (i >= s.length) { emit('done'); return }
  phase.value = s[i]!.k
  timer = window.setTimeout(() => run(i + 1), s[i]!.ms * rate.value)
}
function play() {
  clearTimeout(timer)
  clearHits()
  plume.value?.restart()
  burst.value?.restart()
  if (reduce()) { phase.value = 'settle'; emit('done'); return }
  run(0)
  for (const s of hitPlan.value) {
    hitTimers.push(window.setTimeout(() => {
      const flag = hitFlag[s.kind]
      flag.value = true
      hitTimers.push(window.setTimeout(() => { flag.value = false }, s.ms))
    }, s.at))
  }
}
defineExpose({ play })

onMounted(() => { if (props.auto) play() })
onBeforeUnmount(() => { clearTimeout(timer); clearHits() })
</script>

<template>
  <div
    class="emerge"
    :class="[`ph-${phase}`, { sc: shaderCard, hit, hitS, hitM, hitL, epic }]"
    :style="{ '--hue': hue, '--rate': rate, '--int': intensity }"
  >
    <!-- 所有層都住在 .stage 裡，螢幕震動與曝光加在 .stage 上。
         **不能加在 .emerge 上** —— 結果頁靠 .emerge 自己的 transform 做置中
         （見 DrawResultPage 的說明），在上面再寫一次 transform 會把置中蓋掉，
         整個舞台會跳到左上角。

         .lens 是再往內一層的「鏡頭」，只做推近／傾斜／失焦。
         跟 .stage 分開是因為兩者的時間曲線不一樣：震動要在 0.7 s 內收斂，
         推近要用 1.25 s 慢慢壓上來 —— 寫在同一個元素上就得共用一條 transition，
         而且 keyframes 一跑就會把另一邊寫的 scale 清掉。
         它跟 .stage 一樣大、子元素都不比它大，所以這裡用 grid 置中是安全的。 -->
    <div class="stage">
      <div class="lens">
        <!-- 1 卡背後的光：跟著卡片一起由小放大，才會像「那個光源正在靠近」 -->
        <div class="coreGlow" aria-hidden="true"></div>
        <!-- 稀有度環境光：只在餘韻登場，慢慢呼吸。見下方樣式的說明 -->
        <div class="aura" aria-hidden="true"></div>

        <!-- 2 卡片 -->
        <div class="cardWrap">
          <div class="card3d">
            <CardArt
              class="face"
              :image="image"
              :alt="name"
              :art-id="artId"
              :tier="tier"
            />
            <span class="sheen" aria-hidden="true"></span>
            <span class="sheen sheen2" aria-hidden="true"></span>
            <span class="flow" aria-hidden="true"></span>
          </div>
        </div>

        <!-- 3 煙霧：聚攏成一片，再收攏成卡片本身 -->
        <SmokePlume
          v-if="plumeGl"
          ref="plume"
          class="plumeLayer"
          :duration="SMOKE_TOTAL"
          :segments="smokeSegments"
          :crack-at="epic ? crackAtMs : 0"
          :surge-at="epic ? surgeAtMs : 0"
          :tint="tint"
          :image="cardUrl"
          :card-half="cardHalf"
          @fail="plumeGl = false"
          @cardready="shaderCard = true"
        />
        <div v-else class="plumeCss" aria-hidden="true"></div>

        <!-- 4 衝擊：蓄力吸入 → 第一次爆 → 深吸氣 → 第二次爆 → 最深的靜默
             → 主爆 → 卡片砸定 → 繞行光點。加法疊在最上面 -->
        <ImpactBurst
          v-if="burstGl"
          ref="burst"
          class="burstLayer"
          :charge-at="mark.m.charge * rate"
          :crack-at="crackAtMs"
          :inhale-at="inhaleAtMs"
          :surge-at="surgeAtMs"
          :hush-at="hushAtMs"
          :burst-at="burstAtMs"
          :lock-at="lockAtMs"
          :card-half="cardHalf"
          :total="TOTAL"
          :intensity="intensity"
          :epic="epic"
          :stops="stops"
          :warps="warps"
          :tint="tint"
          @fail="burstGl = false"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.emerge {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 5;
  overflow: hidden;
  border-radius: var(--radius-lg);
  background: #05040b;
  isolation: isolate;
  /* 震幅倍率。--int 管的是「這個賞別多大聲」，--shake 管的是
     「這一場是不是雙段爆發」—— 兩件事分開，改其中一個不會動到另一個。 */
  --shake: 1;
}
.epic { --shake: 1.55; }

/* 舞台：震動與曝光的載體。
   它跟 .emerge 一樣大，子元素都不比它大，所以這裡用 grid 置中是安全的 ——
   會裁得不對稱的是「子元素比容器大 + overflow: hidden」那個組合，
   那個問題發生在外層 .emergeWrap，不在這裡。 */
.stage {
  position: absolute; inset: 0;
  /* 震動用 translate，跟 .lens 的 scale／rotate 是不同元素的不同屬性。
     同一個元素上 keyframes 一跑就會把非動畫的那一項清掉，
     分兩層之後兩邊互不干涉。 */
  translate: 0 0;
}

/* ---- 鏡頭 ----
   推近（zoom punch）、傾斜、失焦全部住在這裡。
   這一層是後來補的：原本衝擊只有「畫面在抖」，抖是**受力**的表達，
   但沒有**視點**。鏡頭被推近一格、歪了一點、失焦一下再回來，
   讀起來才是「有人在現場、而且被震到」。 */
.lens {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  scale: 1;
  rotate: 0deg;
  transform-origin: 50% 50%;
}

/* ---- 蓄力：把基準線壓低 ----
   畫面收暗、掉彩度。爆發的「亮」是相對的，前面不暗就炸不亮。
   時間跟著 --rate 縮放，低賞別整段被壓縮時這一段也要跟著短。 */
.ph-charge .stage {
  filter: brightness(calc(1 - .34 * var(--int))) saturate(.82) contrast(1.06);
  transition: filter calc(1.4s * var(--rate)) ease-in;
}
/* 鏡頭很輕地開始靠近。這一格幾乎看不出來，它的作用是**建立方向** ——
   後面 inhale 那一拍要壓到 1.07，中間沒有這一段的話那個推近會是憑空出現的。 */
.ph-charge .lens {
  scale: calc(1 + .018 * var(--int));
  transition: scale calc(1.5s * var(--rate)) ease-in;
}
@media (prefers-reduced-motion: no-preference) {
  /* 低頻震動漸強：還沒炸，但已經按不住了 */
  .ph-charge .stage { animation: emergeTremor calc(1.5s * var(--rate)) linear both; }
}
@keyframes emergeTremor {
  0%   { translate: 0 0; }
  20%  { translate: .4px -.3px; }
  40%  { translate: -.7px .5px; }
  60%  { translate: 1.1px .8px; }
  80%  { translate: -1.8px -1.3px; }
  100% { translate: 2.4px 1.6px; }
}

/* ---- 第一次爆（高賞別）----
   小一號的爆發：震幅是主爆的四成、鏡頭彈回原位、亮度只推一點。
   它必須明顯比主爆小，否則主爆就沒有「更大一級」可言。 */
.ph-crack .stage {
  filter: brightness(calc(1 + .12 * var(--int))) contrast(1.08);
  transition: filter .28s ease-out;
}
.ph-crack .lens {
  scale: 1;
  rotate: 0deg;
  filter: blur(0px);
  transition: scale .38s cubic-bezier(.1, .85, .25, 1),
              rotate .38s cubic-bezier(.1, .85, .25, 1),
              filter .26s ease-out;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-crack .stage { animation: emergeShakeS calc(.42s * var(--rate)) cubic-bezier(.2, .7, .3, 1) both; }
}
@keyframes emergeShakeS {
  0%   { translate: 0 0; }
  9%   { translate: calc(-3.6px * var(--int)) calc(2.6px * var(--int)); }
  22%  { translate: calc(2.8px * var(--int)) calc(-2.4px * var(--int)); }
  40%  { translate: calc(-2px * var(--int)) calc(-1.2px * var(--int)); }
  62%  { translate: calc(1.2px * var(--int)) calc(1px * var(--int)); }
  82%  { translate: calc(-.6px * var(--int)) calc(-.4px * var(--int)); }
  100% { translate: 0 0; }
}

/* ---- 深吸氣（高賞別）----
   比第一次爆之前**更暗**（0.34 → 0.5）。這一拍的工作是把基準線再往下踩一階：
   已經爆過一次了，再回到原本那個暗度只會讀成「回到剛才」，不是「更深」。

   鏡頭同時壓到 1.07 並且往反方向歪 —— 傾斜的方向跟主爆命中那一格相反，
   所以主爆是把鏡頭「甩過去」，不是繼續往同一邊推。 */
.ph-inhale .stage {
  filter: brightness(calc(1 - .50 * var(--int))) saturate(.7) contrast(1.1);
  transition: filter calc(1.1s * var(--rate)) ease-in;
}
.ph-inhale .lens {
  scale: calc(1 + .07 * var(--int));
  rotate: calc(-.75deg * var(--int));
  transition: scale calc(1.25s * var(--rate)) cubic-bezier(.6, 0, .85, .2),
              rotate calc(1.25s * var(--rate)) ease-in;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-inhale .stage { animation: emergeTremor2 calc(1.25s * var(--rate)) linear both; }
}
/* 第二次的震動比第一次密、也比第一次大：吸得更急，按不住的程度也更高 */
@keyframes emergeTremor2 {
  0%   { translate: 0 0; }
  14%  { translate: calc(-.8px * var(--int)) calc(.6px * var(--int)); }
  28%  { translate: calc(1.3px * var(--int)) calc(-1px * var(--int)); }
  42%  { translate: calc(-1.9px * var(--int)) calc(1.4px * var(--int)); }
  56%  { translate: calc(2.6px * var(--int)) calc(1.9px * var(--int)); }
  70%  { translate: calc(-3.2px * var(--int)) calc(-2.4px * var(--int)); }
  85%  { translate: calc(3.8px * var(--int)) calc(2.6px * var(--int)); }
  100% { translate: calc(-4.4px * var(--int)) calc(-3px * var(--int)); }
}

/* ---- 第二次爆（高賞別）----
   中間那一級。震幅是 crack 的 1.7 倍、主爆的六成，鏡頭往**正的**方向歪一點點
   （crack 是 -0.5°、inhale 是 -0.75°），所以三次的方向是 0 → + → 主爆再甩回 +1.15°。
   彩度在這裡第一次被推上去（1.18）：色彩往賞別色靠攏本身就是一條進度條，
   越接近主爆，畫面越「是那個顏色」。 */
.ph-surge .stage {
  filter: brightness(calc(1 + .22 * var(--int))) contrast(1.14) saturate(1.18);
  transition: filter .3s ease-out;
}
.ph-surge .lens {
  scale: calc(1 + .012 * var(--int));
  rotate: calc(.4deg * var(--int));
  filter: blur(0px);
  transition: scale .5s cubic-bezier(.1, .85, .25, 1),
              rotate .5s cubic-bezier(.1, .85, .25, 1),
              filter .3s ease-out;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-surge .stage { animation: emergeShakeM calc(.58s * var(--rate)) cubic-bezier(.2, .7, .3, 1) both; }
}
@keyframes emergeShakeM {
  0%   { translate: 0 0; }
  7%   { translate: calc(-6px * var(--int)) calc(4.4px * var(--int)); }
  18%  { translate: calc(4.8px * var(--int)) calc(-4px * var(--int)); }
  32%  { translate: calc(-3.4px * var(--int)) calc(-2.2px * var(--int)); }
  50%  { translate: calc(2.2px * var(--int)) calc(1.8px * var(--int)); }
  70%  { translate: calc(-1.2px * var(--int)) calc(-.8px * var(--int)); }
  100% { translate: 0 0; }
}

/* ---- 最深的靜默（高賞別）----
   **這一拍的內容就是「沒有內容」。**
   亮度踩到 -0.68（開場的黑場都沒有這麼暗）、彩度掉到一半，
   而且前 74% 的畫面**完全不動** —— 前面兩拍都有震動漸強，這裡什麼都沒有。
   這個空白才是主爆真正的基準線；沒有它，主爆只是第三次爆炸。

   鏡頭仍然繼續壓（1.07 → 1.105）並且維持傾斜：畫面停了，但壓力沒有停。
   最後 26% 才放一段極短促的微震進來 —— 那是「要來了」，不是「又開始了」。 */
.ph-hush .stage {
  filter: brightness(calc(1 - .68 * var(--int))) saturate(.5) contrast(1.14);
  transition: filter calc(.9s * var(--rate)) ease-in;
}
.ph-hush .lens {
  scale: calc(1 + .105 * var(--int));
  rotate: calc(-1.1deg * var(--int));
  filter: blur(0px);
  transition: scale calc(1.35s * var(--rate)) cubic-bezier(.35, 0, .7, .4),
              rotate calc(1.35s * var(--rate)) ease-in-out,
              filter .3s ease-out;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-hush .stage { animation: emergeHush calc(1.35s * var(--rate)) linear both; }
}
@keyframes emergeHush {
  0%, 74% { translate: 0 0; }
  81%  { translate: calc(-.7px * var(--int)) calc(.5px * var(--int)); }
  87%  { translate: calc(1.1px * var(--int)) calc(-.8px * var(--int)); }
  92%  { translate: calc(-1.7px * var(--int)) calc(1.2px * var(--int)); }
  96%  { translate: calc(2.4px * var(--int)) calc(-1.7px * var(--int)); }
  100% { translate: calc(-3.1px * var(--int)) calc(2.2px * var(--int)); }
}

/* ---- 爆發：指數衰減的螢幕震動 ----
   關鍵在「快速收斂」。一直抖下去畫面就沒法看了，而且抖久了反而不痛 ——
   衝擊是一瞬間的事，之後要立刻讓人看得清楚卡片。
   震幅不隨 pace 縮放但隨 intensity 縮放：小獎不該把畫面搖成這樣。 */
.ph-burst .stage,
.ph-form .stage,
.ph-lock .stage,
.ph-settle .stage {
  filter: none;
  transition: filter .5s ease-out;
}
/* 鏡頭從命中那一格的推近／傾斜／失焦「彈」回來。
   這條 transition 就是 zoom punch 的後半段 —— 前半段是 .hit 那一格的跳進去。
   曲線要一開始就快（.12, .9）：彈回來慢的話讀起來是鏡頭在拉遠，不是回正。 */
.ph-burst .lens,
.ph-form .lens,
.ph-lock .lens,
.ph-settle .lens {
  scale: 1;
  rotate: 0deg;
  filter: blur(0px);
  transition: scale .62s cubic-bezier(.12, .9, .25, 1),
              rotate .72s cubic-bezier(.12, .9, .25, 1),
              filter .34s ease-out;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-burst .stage { animation: emergeShake calc(.7s * var(--rate)) cubic-bezier(.2, .7, .3, 1) both; }
  /* 高賞別的震動再拉長一點、幅度乘 --shake（見 .epic）。
     兩段式爆發的第二聲要壓得過第一聲，震動是最直接的量尺。 */
  .epic.ph-burst .stage { animation-duration: calc(.86s * var(--rate)); }
}
@keyframes emergeShake {
  0%   { translate: 0 0; }
  6%   { translate: calc(-9px * var(--int) * var(--shake)) calc(6px * var(--int) * var(--shake)); }
  13%  { translate: calc(7px * var(--int) * var(--shake)) calc(-7px * var(--int) * var(--shake)); }
  22%  { translate: calc(-6px * var(--int) * var(--shake)) calc(-4px * var(--int) * var(--shake)); }
  33%  { translate: calc(4px * var(--int) * var(--shake)) calc(4px * var(--int) * var(--shake)); }
  46%  { translate: calc(-3px * var(--int) * var(--shake)) calc(2px * var(--int) * var(--shake)); }
  62%  { translate: calc(2px * var(--int) * var(--shake)) calc(-1.5px * var(--int) * var(--shake)); }
  80%  { translate: calc(-1px * var(--int) * var(--shake)) calc(.6px * var(--int) * var(--shake)); }
  100% { translate: 0 0; }
}

/* ---- 砸定的震動（高賞別）----
   跟前面每一次都不同：這一下是**垂直為主**的。
   炸開是四面八方，砸下來只有一個方向 —— 震動的方向就是受力的方向，
   橫向搖一樣多的話它會被讀成第四次爆炸。
   收得也最快（0.5 s）：卡片已經在定位了，畫面必須立刻穩下來讓人看清楚。 */
@media (prefers-reduced-motion: no-preference) {
  .ph-lock .stage { animation: emergeLand calc(.5s * var(--rate)) cubic-bezier(.2, .7, .3, 1) both; }
}
@keyframes emergeLand {
  0%   { translate: 0 0; }
  8%   { translate: calc(.8px * var(--int)) calc(7px * var(--int)); }
  20%  { translate: calc(-.6px * var(--int)) calc(-5px * var(--int)); }
  38%  { translate: calc(.4px * var(--int)) calc(3px * var(--int)); }
  60%  { translate: calc(-.2px * var(--int)) calc(-1.6px * var(--int)); }
  82%  { translate: 0 calc(.7px * var(--int)); }
  100% { translate: 0 0; }
}

/* ---- 命中停頓的那幾格 ----
   transition: none 是重點：這一格要「跳」進去，不能是滑進去的。
   滑進去就變成一個放大效果，讀不出停頓。
   這兩條規則必須寫在所有 .ph-* 之後 —— 選擇器權重一樣（兩個 class），
   誰在後面誰贏。

   亮度只推三成半。推太多（試過 1.85）會跟 shader 的爆光疊成一整片純白 ——
   那一格就什麼形狀都看不到了，讀起來是「畫面壞掉」不是「被打中」。
   衝擊那一格仍然要看得見輪廓，過曝的是核心不是整個螢幕。

   失焦（blur）只在停頓那一格存在，之後由上面的 transition 收回 0。
   常駐一個 blur(0) 會逼瀏覽器每一幀都開一張濾鏡表面，那是白付的成本；
   停頓只有一百多毫秒，值得。 */
.hit .stage {
  transition: none;
  filter: brightness(calc(1 + .35 * var(--int))) contrast(1.22) saturate(1.2);
}
.hit .lens {
  transition: none;
  scale: calc(1 + .085 * var(--int));
  rotate: calc(1.15deg * var(--int));
  filter: blur(calc(2.6px * var(--int)));
}
/* 第一次爆那一格：一樣的語彙，規模砍到四成，而且鏡頭往另一邊歪 */
.hitS .stage {
  transition: none;
  filter: brightness(calc(1 + .18 * var(--int))) contrast(1.12) saturate(1.1);
}
.hitS .lens {
  transition: none;
  scale: calc(1 + .034 * var(--int));
  rotate: calc(-.5deg * var(--int));
  filter: blur(calc(1.3px * var(--int)));
}
/* 第二次爆那一格：介於兩者之間，而且鏡頭歪回**正**的方向。
   三次的傾斜是 -0.5° → +0.72° → +1.15°，每一次都甩過中線 ——
   同一邊歪三次會被讀成鏡頭卡住了，來回甩才是被連續打中。 */
.hitM .stage {
  transition: none;
  filter: brightness(calc(1 + .26 * var(--int))) contrast(1.17) saturate(1.16);
}
.hitM .lens {
  transition: none;
  scale: calc(1 + .056 * var(--int));
  rotate: calc(.72deg * var(--int));
  filter: blur(calc(1.9px * var(--int)));
}
/* 砸定那一格：**不推近、不歪**。
   前四次是爆炸推開鏡頭，這一次是卡片自己落下 ——
   鏡頭該做的是被壓下去一點（縮，不是放大），對比拉高把卡框咬出來。
   鏡頭語言換掉，觀眾才分得出這一下的來源不一樣。 */
.hitL .stage {
  transition: none;
  filter: brightness(calc(1 + .22 * var(--int))) contrast(1.18) saturate(1.14);
}
.hitL .lens {
  transition: none;
  scale: calc(1 - .022 * var(--int));
  rotate: 0deg;
  filter: blur(calc(1.1px * var(--int)));
}

/* ---- 1 卡背後的光 ----
   它跟卡片一起放大，所以讀起來是「那個光源正在往前靠近」，
   而不是背景多了一塊固定的亮斑。煙是背光的，光源就是這個。 */
.coreGlow {
  position: absolute; left: 50%; top: 50%;
  width: 66%; aspect-ratio: 1;
  translate: -50% -50%;
  z-index: 1; pointer-events: none;
  border-radius: 50%;
  background:
    radial-gradient(closest-side, #fff 0%, transparent 24%),
    radial-gradient(closest-side, var(--hue) 0%, transparent 70%);
  filter: blur(26px) saturate(1.3);
  mix-blend-mode: screen;
  opacity: 0;
  scale: .35;
  transition: opacity 1.1s ease, scale 1.9s cubic-bezier(.2, .75, .25, 1);
}
.ph-gather .coreGlow { opacity: .55; scale: .45; }
.ph-swell .coreGlow { opacity: .85; scale: .62; }
/* 蓄力：光源不是變大，是**縮成一點**。
   能量被壓進一個更小的體積裡 —— 這是「要炸了」最直接的視覺說法，
   而且它跟前面 gather→swell 一路放大的方向相反，方向反轉本身就是訊號。 */
.ph-charge .coreGlow {
  opacity: 1; scale: .26;
  transition: opacity .5s ease, scale calc(1.5s * var(--rate)) cubic-bezier(.7, 0, .85, .2);
}
/* 第一次爆：光源撐開到 1.1 —— 只有主爆的一半。
   撐到一樣大的話兩次爆的核心看起來一樣，第二次就不再是「更大的那次」。 */
.ph-crack .coreGlow {
  opacity: 1; scale: 1.1;
  transition: opacity .18s ease, scale .3s cubic-bezier(.05, .8, .3, 1);
}
/* 深吸氣：再收得比第一次更小（.26 → .17）。
   「更深」在畫面上就是這個數字更小 —— 同一件事做第二次一定要更極端，
   回到原本的程度會被讀成重播。 */
.ph-inhale .coreGlow {
  opacity: 1; scale: .17;
  transition: opacity .4s ease, scale calc(1.25s * var(--rate)) cubic-bezier(.75, 0, .9, .25);
}
/* 第二次爆：撐到 1.55 —— crack 1.1、主爆 2.2，剛好在中間。
   三次的核心大小是遞增的，那就是「一次比一次大」最直接的量尺。 */
.ph-surge .coreGlow {
  opacity: 1; scale: 1.55;
  transition: opacity .16s ease, scale .32s cubic-bezier(.05, .8, .3, 1);
}
/* 最深的靜默：核心不只更小（.17 → .09），**還變暗**（1 → .42）。
   前面每一次收縮都是越收越亮（能量被壓進去），這一次連光都快沒了 ——
   那是「熄掉」不是「壓縮」，而熄掉才嚇人。 */
.ph-hush .coreGlow {
  opacity: .42; scale: .09;
  transition: opacity calc(.9s * var(--rate)) ease,
              scale calc(1.35s * var(--rate)) cubic-bezier(.8, 0, .9, .3);
}
.ph-burst .coreGlow {
  opacity: 1; scale: 2.2;
  transition: opacity .2s ease, scale .28s cubic-bezier(.05, .8, .3, 1);
}
.ph-form .coreGlow { opacity: 1; scale: 1.1; }
.ph-lock .coreGlow { opacity: .6; scale: 1.18; }
.ph-settle .coreGlow { opacity: .45; scale: 1.25; }

/* ---- 稀有度環境光 ----
   餘韻原本只有一次掃光，掃完那一秒多就只是「一張卡站在那裡」。
   這一圈用賞別色的環繞光在後面慢慢呼吸，把餘韻撐成一段還在發生的事。

   它是環（closest-side 的中段才有顏色）不是實心光暈：實心的話會從卡片
   後面漫出來，卡面看起來像蒙了一層色紙；環只描邊，卡面本身不受影響。
   放在 coreGlow 之後、卡片之前（z-index 1），所以它永遠在卡背後。 */
.aura {
  position: absolute; left: 50%; top: 50%;
  width: 78%; aspect-ratio: 1;
  translate: -50% -50%;
  z-index: 1; pointer-events: none;
  border-radius: 50%;
  background: radial-gradient(closest-side,
    transparent 50%,
    color-mix(in srgb, var(--hue) 62%, transparent) 68%,
    transparent 84%);
  filter: blur(20px) saturate(1.25);
  mix-blend-mode: screen;
  opacity: 0;
}
/* 高賞別提前到 lock 出現：環境光是「這張卡開始發光」，
   而那件事發生在它砸定的那一刻，不是等到餘韻才慢慢想起來。 */
.ph-lock .aura,
.ph-settle .aura {
  opacity: calc(.75 * var(--int));
  transition: opacity .9s ease;
}
@media (prefers-reduced-motion: no-preference) {
  /* 呼吸要慢（一個來回約兩秒）。快了就變成閃爍，那是警示不是餘韻。 */
  .ph-lock .aura,
  .ph-settle .aura { animation: emergeBreath calc(2s * var(--rate)) ease-in-out infinite; }
}
@keyframes emergeBreath {
  0%, 100% { scale: 1;    opacity: calc(.5 * var(--int)); }
  50%      { scale: 1.13; opacity: calc(.85 * var(--int)); }
}

/* ---- 2 卡片 ----
   位移、縮放、旋轉分開寫在三個獨立屬性上。
   全塞進 transform 的話，任何一條規則改其中一項就會把另外兩項一起清掉。

   這裡不再需要遮罩：遮住卡片的是前面那層真的煙，不是 CSS 假裝的邊界。 */
.cardWrap {
  position: relative; z-index: 2;
  width: 58%;
  perspective: 1100px;
}
.card3d {
  aspect-ratio: 5 / 7;
  border-radius: 10px;
  scale: .46;
  translate: 0 7%;
  transform: rotateX(9deg);
  /* 深處的卡不只是小，還要「隔著煙看」：低對比、掉色、糊。
     只縮小不去霾的話，看起來只是一張變小的貼圖。 */
  filter: blur(11px) brightness(.5) saturate(.5) contrast(.8);
  opacity: 0;
  transition:
    scale 1.95s cubic-bezier(.2, .75, .25, 1),
    translate 1.95s cubic-bezier(.2, .75, .25, 1),
    transform 1.8s cubic-bezier(.2, .75, .25, 1),
    /* 去霾比推近快：卡片還在往前的時候就要讀得出是一張卡，
       不然中段那一秒畫面上什麼都沒有 */
    filter 1.2s ease-out,
    opacity .9s ease-out;
  transform-style: preserve-3d;
}
.face {
  display: block;
  width: 100%; height: 100%;
  object-fit: cover;
  border-radius: 10px;
}

/* 煙裡隱約有東西，還看不出是卡 */
.ph-gather .card3d { opacity: .3; scale: .5; }
.ph-swell .card3d { opacity: .5; scale: .56; }
/* 蓄力時卡片反而被吸得更遠更小：畫面上所有東西都在往核心收 */
.ph-charge .card3d { opacity: .38; scale: .48; }
/* 第一次爆把它往前推了一點點 —— 只有一點點。
   推到定位的話主爆就沒有東西可以推了。 */
.ph-crack .card3d { opacity: .52; scale: .56; }
/* 深吸氣再拉得比蓄力更遠更暗：它跟核心光一起走同一個方向 */
.ph-inhale .card3d { opacity: .28; scale: .42; }
/* 第二次爆推得比第一次遠一點（.56 → .64）。仍然不到定位 ——
   到定位的話主爆就沒有東西可以推了，這條規則對三次爆都成立。 */
.ph-surge .card3d { opacity: .62; scale: .64; }
/* 最深的靜默：卡片被吸到整段裡最遠、最暗的位置。
   它是「等一下要衝出來的東西」，現在必須看起來離得最遠。 */
.ph-hush .card3d { opacity: .16; scale: .34; }
.ph-burst .card3d,
.ph-form .card3d,
.ph-lock .card3d,
.ph-settle .card3d {
  opacity: 1; scale: 1; translate: 0 0;
  transform: rotateX(0deg);
  filter: blur(0) brightness(1) saturate(1) contrast(1);
}
.ph-settle .card3d {
  box-shadow:
    0 0 30px color-mix(in srgb, var(--hue) 60%, transparent),
    0 22px 44px rgba(0, 0, 0, .7);
}
/* 高賞別的定裝再多一圈外擴的賞別色。
   兩層陰影（近的濃、遠的淡）才有厚度；只加一層就只是把光暈調大，
   讀起來是「發光更強」不是「這張比較重要」。 */
.epic.ph-lock .card3d,
.epic.ph-settle .card3d {
  box-shadow:
    0 0 26px color-mix(in srgb, var(--hue) 85%, transparent),
    0 0 76px color-mix(in srgb, var(--hue) 42%, transparent),
    0 22px 44px rgba(0, 0, 0, .7);
}

/* ---- shader 聚出卡片時的接手 ----
   卡片由 shader 用煙聚出來，DOM 這張只負責最後的定裝：
   它有 shader 給不了的東西（正確的色彩管理、陰影、掃光、可被選取的 <img>）。

   接手點放在 settle：shader 那邊的凝聚在 uProg 0.80 完成，settle 正好從
   0.804 開始。兩張卡的矩形是同一組數字算出來的，所以交接時是同一個位置。
   畫布晚一點才淡出，讓殘煙有時間飄完，不要在交接那一刻整片消失。 */
.sc .card3d {
  opacity: 0;
  scale: 1;
  translate: 0 0;
  transform: none;
  filter: none;
  transition: opacity .5s ease;
}
/* 高賞別的接手點提前到 lock。
   接手本身就是一個事件（卡片砸定），不該躲在餘韻的淡入裡 ——
   而且交接那一刻正好有一格爆光，位置差被光蓋掉，看不出兩張卡換過手。
   淡入只給 .12 s：砸下來的東西不會淡入。 */
.sc.ph-lock .card3d,
.sc.ph-settle .card3d { opacity: 1; }
.sc.ph-lock .card3d { transition: opacity .12s ease, scale .42s cubic-bezier(.16, 1.08, .3, 1); }
.sc .plumeLayer { transition: opacity .7s ease .3s; }
.sc.ph-lock .plumeLayer,
.sc.ph-settle .plumeLayer { opacity: 0; }
/* 交接時煙要退得快（.18 s）。慢慢退的話 shader 那張卡會跟 DOM 這張
   疊著各自做各自的縮放，短暫出現兩張卡的重影。 */
.sc.ph-lock .plumeLayer { transition: opacity .18s ease; }
/* 凝聚開始之後，背光交給 shader 裡的凝聚光。
   但 charge / burst 那兩拍要留著 —— 那時候 shader 還沒開始堆卡，
   核心光正是「能量被壓成一點再炸開」這件事的主角。 */
.sc.ph-form .coreGlow,
.sc.ph-lock .coreGlow,
.sc.ph-settle .coreGlow { opacity: 0; }

/* 砸定那一格卡片被硬推大一格再彈回來。
   它必須寫在 .sc 的規則之後（權重相同，靠順序），
   否則會被 .sc .card3d 那條 scale: 1 蓋掉。 */
.hitL.sc .card3d,
.hitL .card3d {
  transition: none;
  scale: calc(1 + .07 * var(--int));
}

/* 全像反光：定位後很淡地掃一次。這是卡面的反光，不是掃描線 */
.sheen {
  position: absolute; inset: 0;
  border-radius: 10px;
  pointer-events: none;
  mix-blend-mode: screen;
  opacity: 0;
  background: linear-gradient(104deg,
    transparent 40%, rgba(255, 255, 255, .3) 48%,
    rgba(190, 225, 255, .38) 51%, transparent 60%);
  background-size: 300% 100%;
}
/* 第二道掃光：角度幾乎垂直、更慢、更窄，而且晚 0.8 s。
   只有高賞別有。兩道同角度的掃光會被讀成「同一件事播兩次」，
   換個角度、換個速度，第二道才是新的資訊 —— 這張卡在轉，不是有人在打光。 */
.sheen2 {
  background: linear-gradient(72deg,
    transparent 44%, rgba(255, 255, 255, .16) 49%,
    rgba(255, 236, 190, .30) 51%, transparent 57%);
  background-size: 320% 100%;
  display: none;
}
.epic .sheen2 { display: block; }
@media (prefers-reduced-motion: no-preference) {
  .ph-settle .sheen { animation: emergeSheen 1.2s ease-out .15s; opacity: 1; }
  .epic.ph-settle .sheen2 { animation: emergeSheen 1.5s ease-out .8s; opacity: 1; }
}
@keyframes emergeSheen {
  from { background-position: 190% 0; }
  to   { background-position: -70% 0; }
}

/* ---- 卡面能量流（只有高賞別）----
   餘韻裡卡面上有幾道很淡的賞別色能量在流。
   它跟掃光的分工是「事件 vs 狀態」：掃光是一次性的（有人打了一下光，
   打完就沒了），能量流不會結束（這張卡自己在發電）。
   所以它是 infinite、很慢、而且淡到只在暗部看得出來 ——
   濃了就變成一層色紙蓋在卡面上，卡圖本身反而看不清楚。

   只給高賞別：每張卡都在發電的話，它就不再是「這張很特別」。 */
.flow {
  position: absolute; inset: 0;
  border-radius: 10px;
  pointer-events: none;
  mix-blend-mode: screen;
  display: none;
  opacity: 0;
  background: repeating-linear-gradient(114deg,
    transparent 0 13%,
    color-mix(in srgb, var(--hue) 48%, transparent) 16.5%,
    rgba(255, 255, 255, .10) 17.5%,
    transparent 21% 33%);
  background-size: 240% 100%;
  transition: opacity .8s ease;
}
.epic .flow { display: block; }
@media (prefers-reduced-motion: no-preference) {
  .epic.ph-lock .flow,
  .epic.ph-settle .flow {
    opacity: calc(.45 * var(--int));
    animation: emergeFlow calc(4.4s * var(--rate)) linear infinite;
  }
}
@keyframes emergeFlow {
  from { background-position: 0 0; }
  to   { background-position: -240% 0; }
}

/* ---- 3 煙霧羽流 ----
   壓在卡片之上。它不是背景，是「擋在前面然後散掉的東西」。 */
.plumeLayer { position: absolute; inset: 0; z-index: 3; }

/* ---- 4 衝擊層 ----
   壓在煙之上。它是「光」不是「物體」，所以是加法疊加（元件內用 screen），
   煙擋不住它 —— 爆光本來就該穿過煙。 */
.burstLayer { position: absolute; inset: 0; z-index: 4; }

/* 拿不到 WebGL2 時的替代：兩片會漂的暗霧 + 一次退場。
   做不到翻捲，但至少「有東西擋著然後讓開」這件事還在。 */
.plumeCss {
  position: absolute; inset: 0; z-index: 3; pointer-events: none;
  background:
    radial-gradient(70% 55% at 50% 78%, color-mix(in srgb, var(--hue) 40%, #0a0616), transparent 72%),
    radial-gradient(60% 45% at 35% 55%, #0b0718, transparent 70%),
    radial-gradient(60% 45% at 68% 62%, #0d081f, transparent 70%);
  filter: blur(18px);
  opacity: 1;
  transition: opacity 1.6s ease, transform 2.2s ease;
}
.ph-charge .plumeCss { opacity: 1; transform: scale(.82); }
.ph-crack .plumeCss { opacity: .9; transform: scale(1.05); }
.ph-inhale .plumeCss { opacity: 1; transform: scale(.72); }
.ph-surge .plumeCss { opacity: .88; transform: scale(1.18); }
.ph-hush .plumeCss { opacity: 1; transform: scale(.6); }
.ph-burst .plumeCss { opacity: .7; transform: scale(1.45); }
.ph-form .plumeCss { opacity: .35; transform: scale(1.3); }
.ph-lock .plumeCss { opacity: .12; transform: scale(1.42); }
.ph-settle .plumeCss { opacity: 0; transform: scale(1.5); }
</style>
