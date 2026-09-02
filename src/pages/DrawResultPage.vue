<script setup lang="ts">
/**
 * 抽選結果。
 *
 * 演出從 Three.js 的立體翻卡換成煙霧凝聚（CardEmerge）。換掉的理由有兩個：
 *
 * 1. Three.js 是 720 KB（gzip 後 188 KB），而它只被這一頁用到 ——
 *    整個 app 情緒最高的那一刻，使用者要先等一包比整個網站還大的
 *    函式庫下載完才看得到自己抽到什麼。CardEmerge 用的是原生 WebGL2，
 *    跟首頁那支 shader 同一套，沒有額外相依。
 * 2. 煙霧把卡「拼湊出來」比翻卡更有儀式感，也是這個網站想要的調性。
 *
 * 只播最高賞那一張：十抽播十次、每次八秒，沒有人看得完。
 * 其餘的卡在下方卡牆一次揭曉。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { usePoolStore } from '@/stores/pools'
import CardArt from '@/components/CardArt.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import CardEmerge from '@/components/CardEmerge.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import type { Tier } from '@/types/models'
import { track } from '@/lib/ga'
import { FAIRNESS_UI } from '@/lib/config'

const route = useRoute()
const pools = usePoolStore()
/* 依網址的 drawId 取，不是拿 store 裡「最後一筆」——
   reload 後 store 是空的，但 sessionStorage 還有；
   而且兩個分頁各抽一次時，網址才是唯一可靠的鍵。 */
const result = pools.resultById(String(route.params.drawId))
const revealed = ref(false)

/* ---- 演出的等級 ----
   整批抽選用「最高賞」決定演出強度：一抽裡有 A 賞就演得完整。
   這是誠實的 —— 演出等級對應真的開出來的東西，不是先假裝再降級。 */
const TIER_RANK: Record<Tier, number> = { BUST: 0, D: 1, C: 2, B: 3, A: 4, LAST: 5 }
const bestTier = computed<Tier>(() => {
  if (!result?.items.length) return 'D'
  return result.items.reduce<Tier>((best, it) =>
    TIER_RANK[it.tier] > TIER_RANK[best] ? it.tier : best, 'D')
})
/* 煙霧演出的主角：最高賞的那一張。同賞別時取第一張 */
const heroItem = computed(() =>
  result?.items.length
    ? result.items.reduce((best, it) => TIER_RANK[it.tier] > TIER_RANK[best.tier] ? it : best, result.items[0]!)
    : null)

/* 演出速度依賞別調。最高賞看完整段（十秒），低賞加速 ——
   每抽一張 D 賞都播滿十秒只會讓人想關掉。
   這跟 RevealBuildup 的分級是同一個原則：演出對應真的開出來的東西。 */
const emergePace = computed(() => {
  const r = TIER_RANK[bestTier.value]
  return r >= 4 ? 1 : r === 3 ? 1.4 : 1.9
})
/* 強度跟速度分開。只調速度的話，低賞別看到的是同一場大爆炸的快轉版，
   「衝擊」就變成常態；常態化的衝擊等於沒有衝擊。
   要讓最高賞那一下打得出來，低賞別就必須真的小聲。 */
const emergeIntensity = computed(() => {
  const r = TIER_RANK[bestTier.value]
  return r >= 5 ? 1 : r === 4 ? 0.92 : r === 3 ? 0.6 : 0.32
})

/* 原本煙霧前面還有一段光球蓄勢演出（RevealBuildup），已移除，
   而且在這次「加長、加衝擊」的改版裡重新評估過，結論仍然是不啟用：
   它是另一支獨立的全螢幕演出，播完畫面重來一次才輪到煙霧，兩段之間沒有交接。
   把它接回來只是把演出變長，不會變得更有份量。
   真正需要的蓄力已經做進煙霧演出內部（CardEmerge 的 charge 那一拍），
   共用同一個核心光、同一團煙，爆完的殘料直接變成卡片的材料。

   動態偏好關動效的人直接看結果，不必先等一支動畫。 */
const reduceMotion = typeof matchMedia !== 'undefined'
  && matchMedia('(prefers-reduced-motion: reduce)').matches
if (reduceMotion || !result) revealed.value = true

/* 開獎當下是使用者最會懷疑「這是不是喬過的」的時刻，驗算入口留在這一頁 ——
   但收成按鈕下方的一行連結，不再把整套材料攤在結果上面擋住卡片。 */
const pool = computed(() => (result ? pools.byId(result.poolId) : undefined))
/* 種子池用 fixture:<池id> 當來源（seed 不能等 drand 兩分鐘）。
   那些池的結果不具備對外驗證的意義，畫面要講實話。 */
const isFixture = computed(() => (pool.value?.clientSeedSource ?? '').startsWith('fixture:'))

/* ---- 版面：主秀 + 卡牆 ----
   舊版是「一列一張卡」的清單：46px 的縮圖配四行字，卡圖只佔那一列面積的
   不到一成。這一頁的主角是卡，不是卡的屬性表 —— 屬性表在卡冊裡本來就有一份。

   所以改成：值得單獨看的那一張放大當主秀，其餘鋪成卡牆，
   籤號、鑑定這些次要資訊疊回卡面上（同 MyCardsPage 的 .scrim 手法），
   卡片以外不留任何一行文字，省下來的高度全部還給卡圖。 */

/* 只有 B 賞以上才值得從卡牆裡拉出來單獨放大 —— 十張全是 D 賞時還硬選一張
   當主秀，等於告訴使用者「這張很特別」，但它不是。謊講一次就不值錢了。
   單抽例外：只有一張時它本來就是全部，不放大只會讓整頁空著。 */
const spotlight = computed(() => {
  if (!result?.items.length) return null
  if (result.items.length === 1) return result.items[0]!
  return TIER_RANK[bestTier.value] >= 3 ? heroItem.value : null
})
/* 卡牆保留使用者選籤的順序，不依賞別重排 ——
   籤號是他自己一格一格挑的，打亂順序他就對不回自己挑了什麼。 */
const wall = computed(() => (result?.items ?? []).filter(it => it !== spotlight.value))

/* 欄數依「卡牆剩幾張」決定，不是固定值：
   剩兩三張還鋪成三欄，卡片會無謂地縮小，右邊空一格；
   剩九張鋪成兩欄則要捲三個畫面才看得完。 */
const cols = computed(() => {
  const n = wall.value.length
  return n <= 1 ? 1 : n <= 4 ? 2 : 3
})
const colsWide = computed(() => Math.min(wall.value.length, 5) || 1)

/* 賞別色當成一個變數傳進 CSS，邊框、光暈、徽章才不必為六個賞別各寫一次 */
const TIER_VAR: Record<Tier, string> = {
  A: 'var(--tier-a)', B: 'var(--tier-b)', C: 'var(--tier-c)',
  D: 'var(--tier-d)', LAST: 'var(--tier-last)', BUST: 'var(--ink)'
}
/* 只有 B 賞以上才給卡面描邊。C/D 也描的話，十張裡有九張都在發光，
   剩下那張真正的大獎就淹沒在裡面了 —— 強調的前提是別人不強調。 */
const isRare = (t: Tier) => TIER_RANK[t] >= 3

/* 帶著剛拿到的卡片 id 過去，卡冊才標得出「就是這幾張」。
   舊的結果（reload 前存進 sessionStorage 的）沒有 stashId，那就只導頁不標記。 */
const cardbookLink = computed(() => {
  const ids = (result?.items ?? []).map(i => i.stashId).filter(Boolean)
  return ids.length ? `/me/cards?new=${ids.join(',')}` : '/me/cards'
})

onMounted(() => {
  track('view_prize_result')
  /* 池資料是公平性那一行連結的依據。從池頁抽完過來時 store 裡已經有了，
     但重整之後結果還在（sessionStorage）、池卻沒了 ——
     於是最需要驗算的那個時刻，入口反而不見。 */
  void pools.ensureLoaded()
  /* 保險絲：WebGL 中途失敗、或分頁在背景導致動畫暫停時，CardEmerge 的
     done 事件永遠不會來，使用者就再也看不到自己抽到什麼。時間到就強制顯示。

     這個數字必須大於演出本身最長的那一種，否則演出會被自己的保險絲掐掉。
     目前最長是 A／最後賞的 16.14 秒（見 CardEmerge 的 EPIC_SCRIPT），
     20 秒只剩 3.86 秒餘裕。**再往演出加拍就要一起調這個數字**，
     否則演出會被自己的保險絲掐掉。 */
  setTimeout(() => { revealed.value = true }, 20000)
})
</script>

<template>
  <div class="container page" v-if="result">
    <h1 class="display">抽選結果</h1>
    <p class="muted sub mono">draw {{ result.drawId }} · 共 {{ result.items.length }} 抽 · {{ result.cost.toLocaleString() }} 點</p>
    <!-- 煙霧凝聚：只播最高賞那張，播完（或被點掉）就揭曉全部。
         按鈕而不是 div：鍵盤也要能跳過。
         Teleport 到 body —— 全螢幕的 position: fixed 不能住在會被 transform
         的頁面子樹裡（見 MyCardsPage 出貨面板的說明）。 -->
    <Teleport to="body">
    <button
      v-if="!revealed && heroItem"
      type="button" class="emergeWrap"
      aria-label="跳過開卡演出"
      @click="revealed = true"
    >
      <CardEmerge
        :art-id="heroItem.card.artId"
        :image="heroItem.card.image"
        :name="heroItem.card.name"
        :tier="heroItem.tier"
        :pace="emergePace"
        :intensity="emergeIntensity"
        auto
        @done="revealed = true"
      />
      <span class="skipHint mono">
        {{ result.items.length > 1 ? `最高賞 · 其餘 ${result.items.length - 1} 張在下方` : '點一下跳過' }}
      </span>
    </button>
    </Teleport>

    <!-- 揭曉後的結果本體：主秀一張 + 卡牆其餘 -->
    <div class="board" :class="{ in: revealed }">
      <!-- 主秀。單抽時它就是唯一那張，多抽時是 B 賞以上的那一張。
           只有這一張的資訊寫在卡片外面 —— 值得讀的就這一張。 -->
      <figure
        v-if="spotlight"
        class="spot"
        :class="{ solo: result.items.length === 1 }"
        :style="{ '--t': TIER_VAR[spotlight.tier] }"
      >
        <Tilt3D :max="10" radius="16px" class="spotArt">
          <CardArt
            :image="spotlight.card.image" :alt="spotlight.card.name" :tier="spotlight.tier"
            :art-id="spotlight.card.artId"
          />
        </Tilt3D>
        <figcaption class="spotMeta">
          <div class="row">
            <TierBadge :tier="spotlight.tier" />
            <span v-if="spotlight.bonus" class="bonus">最後賞加贈</span>
            <span v-else class="mono seat">籤 #{{ spotlight.ticketSeq }}</span>
          </div>
          <strong>{{ spotlight.card.name }}</strong>
          <CertTag :card="spotlight.card" />
        </figcaption>
      </figure>

      <!-- 卡牆。卡片以外沒有任何一行字：賞別、籤號、鑑定都疊在卡面上，
           省下來的高度全部給卡圖。--i 只是進場動畫的順序，不影響排版。 -->
      <ul
        v-if="wall.length"
        class="wall"
        :style="{ '--cols-narrow': cols, '--cols-wide': colsWide }"
      >
        <li
          v-for="(item, i) in wall" :key="i"
          class="cell" :class="{ rare: isRare(item.tier) }"
          :style="{ '--t': TIER_VAR[item.tier], '--i': i }"
        >
          <CardArt
            :image="item.card.image" :alt="item.card.name" :tier="item.tier"
            :art-id="item.card.artId"
          />
          <TierBadge class="cellTier" :tier="item.tier" />
          <!-- 鑑定分數只在「有鑑定」時出現。每張都掛一個「RAW · 未鑑定」
               等於在九張卡上重複同一句廢話，把真正有 PSA 10 的那張稀釋掉；
               完整的鑑定狀態卡冊裡每一張都有。 -->
          <span v-if="item.card.grader && item.card.grade != null" class="cellGrade mono">
            {{ item.card.grader }} {{ item.card.grade }}
          </span>
          <div class="scrim">
            <span class="cellName">{{ item.card.name }}</span>
            <span class="cellSeat mono">{{ item.bonus ? '加贈' : `#${item.ticketSeq}` }}</span>
          </div>
        </li>
      </ul>
    </div>

    <!-- 這一行是重點：卡在抽完的當下就已經寫進卡冊了（後端在同一個交易裡），
         底下那顆按鈕只是帶你過去看。原本的文案是「收進卡冊」，
         讀起來像「要按了才會進去」—— 沒按的人就以為自己抽到的卡不見了。 -->
    <p class="stashed">
      {{ result.items.length > 1 ? `這 ${result.items.length} 張` : '這張' }}已經在你的卡冊裡了，不必再收。
    </p>
    <div class="actions">
      <RouterLink :to="cardbookLink" class="btn primary">去卡冊看這{{ result.items.length > 1 ? '幾' : '' }}張</RouterLink>
      <RouterLink :to="`/pools/${result.poolId}`" class="btn">再抽一次</RouterLink>
    </div>

    <!-- 公平性收成一行連結。原本整段（主張、原理、承諾雜湊、隨機來源）攤在
         結果上方，剛抽完的人要的是看卡，那一大塊把卡推下去而且多半被略過。
         材料一個都沒少，只是搬到驗算頁 —— 想查的人一定會點進去看，
         不想查的人本來就不會讀。
         示範池仍然要當場說清楚不可驗證：把「不需要你信任我們」收起來、
         卻讓人以為這一池可驗證，比原本那一大塊更糟。 -->
    <!-- 整段（含示範池的警告）一起收在 FAIRNESS_UI 之下（見 lib/config.ts）。
         示範池那句警告是為了避免有人以為「點進驗算頁就能驗這一池」——
         連結不在了，那個誤會就不存在，單獨留一句「無法驗算」反而在暗示
         別的池點得進某個驗算頁，而那個入口現在不在。
         整個 <p> 一起 v-if：只拿掉裡面的內容會留一個有上邊距的空段落。 -->
    <p v-if="FAIRNESS_UI && pool" class="proof">
      <RouterLink v-if="!isFixture" :to="`/fairness/${result.poolId}`">
        這一池怎麼證明沒有作弊 →
      </RouterLink>
      <span v-else class="warn">這是示範池，籤序是固定的測試值，無法驗算。</span>
    </p>
  </div>
  <div v-else class="container page">
    <p class="muted">沒有可顯示的抽選結果。<RouterLink to="/pools">去抽選</RouterLink></p>
  </div>
</template>

<style scoped>
/* 公平性收成按鈕下方的一行小字，不跟主要動作搶份量 */
.proof { margin: 14px 0 0; font-size: 12.5px; line-height: 1.7; text-align: center; }
.proof a { color: var(--accent); }
.proof .warn { color: #fcd34d; }

/* 「已經在卡冊裡」的說明。按鈕上方，比按鈕先讀到 */
.stashed {
  margin: 18px 0 0; font-size: 13px; line-height: 1.7; color: var(--muted);
}


/* 煙霧演出：整個視窗。按鈕的預設外觀全部拿掉 —— 它只是為了讓鍵盤能跳過。 */
.emergeWrap {
  position: fixed; inset: 0; z-index: 80;
  padding: 0; border: 0; cursor: pointer;
  background: #05040b;
  overflow: hidden;
}

/* CardEmerge 內部的 shader 座標是綁死 4:5 舞台算出來的
   （見那支元件裡 cardHalf 的說明），改掉比例會讓煙聚出來的卡跟 DOM 那張錯位。
   所以不改它的比例，而是整個放大到「蓋滿視窗」再把超出的裁掉 ——
   煙本來就填滿整個畫面，裁邊看不出來。
   max() 挑較大的那一邊：寬螢幕吃 100vw，窄長的手機吃 100dvh × 4/5。 */
/* 置中方式從 grid 的 place-items 換成絕對定位 + translate。
   **grid 的置中在子元素比容器大時，配上 overflow: hidden 會裁得不對稱** ——
   溢出到起始方向的那一半變成不可及，畫面看起來整個偏右、左邊被切掉。
   393×852 的手機上舞台算出來是 682px 寬，比視窗多 289px，實機就是這樣壞的。
   translate 置中沒有這個問題：兩側各自溢出一樣多，裁掉的也一樣多。 */
.emergeWrap :deep(.emerge) {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: max(100vw, calc(100dvh * 4 / 5));
  border-radius: 0;
}
.emergeWrap .skipHint {
  position: absolute; left: 0; right: 0;
  /* 下面那條給蓄勢演出用的 .skipHint 還帶著 translateX(-50%)，
     而這裡改用 left:0/right:0 置中，兩條疊起來會把整行字往左推半個螢幕寬 ——
     實測 left = -196.5px，字只剩最右邊幾個像素露在畫面上。
     transform 沒有被 left/right 覆蓋掉，得自己歸零。 */
  transform: none;
  bottom: calc(22px + var(--safe-b, 0px));
  font-size: 12px; color: rgba(255, 255, 255, .6); text-align: center;
  text-shadow: 0 1px 6px #000;
}

.page { padding-top: 40px; padding-bottom: 72px; text-align: center; }

.skipHint {
  position: absolute; left: 50%; bottom: calc(22px + var(--safe-b));
  transform: translateX(-50%);
  font-size: 11.5px; letter-spacing: .14em;
  color: rgba(255, 255, 255, .42);
  pointer-events: none;
}
@media (prefers-reduced-motion: no-preference) {
  /* 提示遲一點才浮出：第一秒不打擾，讓人先看演出 */
  .skipHint { opacity: 0; animation: hint-in .6s ease 1.4s forwards; }
}
@keyframes hint-in { to { opacity: 1; } }
h1 { font-size: 26px; margin: 0; }
.sub { font-size: 12.5px; margin: 6px 0 30px; }
/* ---- 結果本體 ---- */
.board {
  margin: 18px auto 0; max-width: 620px;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px;
  opacity: 0; transform: translateY(10px);
  transition: opacity .6s ease, transform .6s cubic-bezier(.2,.7,.3,1);
}
.board.in { opacity: 1; transform: none; }

/* ---- 主秀 ----
   寬度用 min(vw, px)：手機吃視窗比例，桌機停在一個不會大到失禮的上限。
   單抽時再放大一階 —— 那一頁沒有別的東西可看，卡片就該佔住畫面。 */
.spot {
  margin: 0; justify-self: center;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px;
  width: min(58vw, 216px);
}
.spot.solo { width: min(74vw, 268px); }
.spotArt {
  border-radius: 16px;
  /* 賞別色的光暈。這是「這張跟其他張不一樣」唯一需要說的話，
     不必再加一行字去講它特別。 */
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--t) 70%, transparent),
    0 18px 60px color-mix(in srgb, var(--t) 26%, transparent);
}
.spotMeta { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; justify-items: center; }
.spotMeta strong { font-size: 16px; font-weight: 600; line-height: 1.35; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
.seat { font-size: 12px; color: var(--muted); }
.bonus {
  font-size: 12px; font-weight: 600;
  padding: 2px 10px; border-radius: var(--pill);
  background: var(--accent-wash); color: var(--accent);
}

/* ---- 卡牆 ----
   用 flex-wrap 而不是 grid：張數不是欄數的倍數時（5 張三欄、3 張兩欄），
   最後一列只剩一兩張，grid 會把它們靠左黏著，右邊開一個洞；
   flex 的 justify-content: center 讓那一列自己置中，看起來是收尾不是缺角。
   欄寬自己算而不是交給 flex 分配：這樣每一列的卡片寬度都一樣，
   最後一列不會因為東西少而變成兩張特別大的卡。 */
.wall {
  /* --cols 在樣式表裡取值、不由 inline style 直接給：inline 的自訂屬性
     贏過任何選擇器，桌機那條 media query 就再也蓋不掉它。 */
  --cols: var(--cols-narrow);
  /* 間距也走變數：欄寬是自己算的，寫死 8px 的話桌機一改 gap，
     每一列就會多出或少掉幾個像素、最後一欄被擠到下一行。 */
  --gap: 8px;
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-wrap: wrap; gap: var(--gap); justify-content: center;
}
.cell {
  position: relative; min-width: 0;
  width: calc((100% - (var(--cols) - 1) * var(--gap)) / var(--cols));
  border-radius: 12px; overflow: hidden;
  background: var(--surface-2);
}
.cell :deep(.art), .cell :deep(.art-img) { border-radius: 12px; }
/* B 賞以上的描邊。卡牆裡若還有第二張大獎（主秀只拉得走一張），
   它靠這圈色仍然找得到。 */
.cell.rare { box-shadow: inset 0 0 0 2px var(--t), 0 6px 20px color-mix(in srgb, var(--t) 22%, transparent); }

.cellTier {
  position: absolute; top: 5px; left: 5px;
  font-size: 10px; padding: 2px 7px;
}
.cellGrade {
  position: absolute; top: 5px; right: 5px;
  font-size: 9.5px; font-weight: 600; line-height: 1.5;
  padding: 2px 6px; border-radius: var(--pill);
  /* 這幾個黑白是「蓋在卡照上的遮罩」不是介面表面色：卡圖在兩套主題下
     一樣亮，跟著主題翻轉反而會在淺色主題下變成白底白字（同 MyCardsPage）。 */
  background: rgba(0, 0, 0, .55); color: #fff;
  white-space: nowrap;
}
/* 卡名與籤號疊在卡面下緣。滿版彩色的卡圖上白字會消失，先鋪一層漸層遮罩 */
.scrim {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 22px 6px 5px;
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; align-items: baseline;
  background: linear-gradient(180deg, transparent, rgba(0, 0, 0, .6) 42%, rgba(0, 0, 0, .88));
  pointer-events: none;
}
.cellName {
  min-width: 0; font-size: 10.5px; font-weight: 600; line-height: 1.3;
  color: #fff; text-align: left;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cellSeat { font-size: 9.5px; color: rgba(255, 255, 255, .62); }

/* 卡片一張接一張浮出來，不是整面同時亮起 ——
   演出已經播完了，這裡不再演一次，只是讓眼睛有順序可以跟。 */
@media (prefers-reduced-motion: no-preference) {
  .board.in .cell { opacity: 0; animation: cell-in .42s cubic-bezier(.2,.7,.3,1) forwards; animation-delay: calc(var(--i) * 45ms); }
}
@keyframes cell-in {
  from { opacity: 0; transform: translateY(10px) scale(.94); }
  to   { opacity: 1; transform: none; }
}

/* 桌機放寬一階、欄數開多。620px 是舊清單的寬度 ——
   那是「一行字讀起來的舒適上限」，卡牆不是字，被限在那個寬度只會
   讓每張卡比手機上還小，而且兩側各空一大片。 */
@media (min-width: 721px) {
  .board { max-width: 780px; gap: 26px; }
  .wall { --cols: var(--cols-wide); --gap: 10px; }
  .spot { width: min(40vw, 250px); }
  .spot.solo { width: min(46vw, 300px); }
}

.actions { display: flex; gap: 12px; justify-content: center; margin-top: 30px; }

@media (max-width: 720px) {
  .page { padding-top: 24px; padding-bottom: 40px; }
  h1 { font-size: 24px; }
  .sub { font-size: 11.5px; margin: 5px 0 14px; }
  .actions { margin-top: 24px; }
  .actions .btn { flex: 1; padding: 11px 8px; font-size: 13.5px; }
}
</style>
