<script setup lang="ts">
/**
 * 市場單張卡片 —— 看清楚，然後買下。
 *
 * 為什麼要獨立一頁：購買原本是市場列表裡的行內確認框，而那個框是渲染在
 * 「主列表的那一格」裡的。從上方「今日最殺」的橫向捲軸點一張，確認框會跑到
 * 下面主列表去長出來，使用者看到的是「我點 A，B 問我要不要買」。主列表改成
 * 游標分頁之後更糟：那一格如果還沒載入，點了根本不會有任何事發生。
 *
 * 資料自己載（GET /v1/listings/:id），不靠列表頁帶過來 ——
 * 分享連結、重新整理、直接輸入網址都必須打得開。
 *
 * 兩條通道的差別在「按下購買之前」就講完：
 *   vault 卡在保管庫，成交就是過戶，點數直接扣，買完人就該在卡冊裡
 *   ship  卡在賣家手上，走託管，點數只是凍結，要等收貨才放款給賣家
 * 這件事講在成交之後才講就太晚了 —— 使用者會以為卡沒進卡冊是壞掉。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, MOCK } from '@/lib/api'
/* 直接用傳輸層而不是 api.ts 的方法：這一輪這條線只擁有這一頁，
   api.ts 不歸它動（見 docs/open-issues.md D-2 的分工）。之後要把這支
   收編進 api.ts 的話，位置在 getListing 旁邊。 */
import { http } from '@/lib/http'
import { deliveryOf } from '@/shared/domain'
import type { Listing, Seller } from '@/types/models'
import { useWalletStore } from '@/stores/wallet'
import { useAuthStore } from '@/stores/auth'
import { useOrdersStore } from '@/stores/orders'
import CardArt from '@/components/CardArt.vue'
import CertTag from '@/components/CertTag.vue'
import OwnerTag from '@/components/OwnerTag.vue'
import SellerChip from '@/components/SellerChip.vue'
import TradeGuard from '@/components/TradeGuard.vue'
import BottomActionBar from '@/components/BottomActionBar.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { haptic } from '@/lib/haptics'
import { track } from '@/lib/ga'
import { refPriceText } from '@/lib/refprice'

const route = useRoute()
const router = useRouter()
const wallet = useWalletStore()
const auth = useAuthStore()
const orders = useOrdersStore()

const id = computed(() => String(route.params.id ?? ''))
const listing = ref<Listing | null>(null)
const seller = ref<Seller | null>(null)
const loading = ref(true)
/** 跟「載入中」分開：找不到是預期中的結果（連結過期、掛單被收回），不是錯誤 */
const missing = ref(false)

const lane = computed(() => (listing.value ? deliveryOf(listing.value) : 'vault'))
const diffPct = computed(() => {
  const l = listing.value
  if (!l || !l.card.refPrice) return 0
  return Math.round(((l.price - l.card.refPrice) / l.card.refPrice) * 100)
})

/**
 * 寄存剩餘天數（D-2）。
 *
 * 為什麼這一塊非有不可：prizes.stash_expires_at 是抽中當下算的 90 天，
 * 而**過戶不會重設它**（那 90 天量的是實體卡在原賣家抽屜裡放了多久，
 * 庫內轉移不搬動實體卡）。所以市場上這張卡可能只剩 1 天 ——
 * 不講的話，買家是付完錢才在通知裡看到「已超過寄存期限」，
 * 而他以為自己買到的是一張剛開始寄存的卡。這是資訊落差，不是規則問題。
 */
type Stash = { expiresAt: number; daysLeft: number; totalDays: number; heldByOther: boolean }
const stash = ref<Stash | null>(null)
/** 剩兩週以內就轉成警示色 —— 跟後端寄存提醒的 STASH_WARN_MS 同一個門檻 */
const stashUrgent = computed(() => !!stash.value && stash.value.daysLeft <= 14)
const stashTitle = computed(() => {
  const d = stash.value?.daysLeft ?? 0
  return d <= 0 ? `寄存期限已經過了 ${-d} 天` : `寄存期限剩 ${d} 天`
})
const stashBody = computed(() => {
  const st = stash.value
  if (!st) return ''
  /* 「買下不會重新計算」是這一段唯一非講不可的那句話：使用者的預設想像
     一定是「我買了就從今天開始算」，而事實正好相反。 */
  return (st.heldByOther ? '這張卡的實體還在原賣家手上。' : '')
    + `寄存期是抽中之日起 ${st.totalDays} 天，買下不會重新計算 —— `
    + '你接手的是剩下的天數。期限到了不會沒收、也不影響任何功能，'
    + '只是提醒你把卡處理掉：申請出貨拿到實體卡，或再上架賣掉。'
})

onMounted(async () => {
  try {
    const l = await api.getListing(id.value)
    listing.value = l
    missing.value = !l
    /* 只有庫內轉移問得到（需寄送的卡成交就會寄到買家手上，寄存在那一刻結束），
       而且要登入 —— 端點掛在 /v1/orders 底下。拿不到就整塊不畫：
       這是附加資訊，不該讓它的失敗擋住整頁。 */
    if (l && deliveryOf(l) === 'vault' && auth.isLoggedIn && !MOCK) {
      try {
        stash.value = (await http<{ stash: Stash | null }>(`/v1/orders/listings/${id.value}/stash`)).stash
      } catch { stash.value = null }
    }
    /* 賣家資料拿不到不該擋住整頁：市場上大多數掛單是玩家掛的，
       玩家不是賣家（沒有審核等級可查），那時候只顯示名字就好。 */
    if (l) {
      try { seller.value = (await api.getSeller(l.sellerId)) ?? null } catch { seller.value = null }
    }
  } catch {
    missing.value = true
  } finally {
    loading.value = false
  }
})

/* ---- 購買 ---- */
const confirming = ref(false)
const busy = ref(false)
const error = ref('')
/** 成交後停在哪一種結果。兩條通道的下一步不同，所以要分得出來 */
const done = ref<'vault' | 'ship' | null>(null)

const price = computed(() => listing.value?.price ?? 0)
const canAfford = computed(() => wallet.available >= price.value)
const sold = computed(() => !!listing.value && listing.value.status !== 'live')
/* 自己的掛單。後端本來就擋（orders.ts：「不能買自己的掛單」），
   但那是在使用者已經看完價格、按下購買、等了一個往返之後才擋 ——
   前端知道賣家是誰，就該在他按之前講。
   比對 sellerId 不比對名字（名字會重複、會被改）；未登入時 auth.user 是 null，
   訪客不會踩到任何個人化分支。 */
const isMine = computed(() => !!auth.user && !!listing.value && listing.value.sellerId === auth.user.id)
/* isMine 進 buyable：這樣「買下」那顆鍵在自己的掛單上根本不會被渲染出來，
   而不是渲染一顆按了沒反應的灰鍵 —— 灰鍵仍然是在說「這裡本來可以買」。 */
const buyable = computed(() =>
  !!listing.value && !sold.value && !isMine.value && auth.isLoggedIn && canAfford.value)

/* 721 是底部導覽消失的斷點（見 tokens.css 的 --nav-total）。
   窄螢幕的確認列從畫面下緣滑出，寬螢幕就地當 sticky 列 —— 桌機沒有
   拇指可及的問題，也沒有導覽會蓋住送出鍵，飛進來的列只是噪音。 */
const wide = useMediaQuery('(min-width: 721px)')

/* 導去卡冊的計時器要收乾淨：使用者可能在這 1.4 秒內自己按了按鈕或返回，
   讓一個已經卸載的頁面再導一次會把他從別的地方拽走。 */
let jump: ReturnType<typeof setTimeout> | null = null
/* 剛買到的那張卡在卡冊裡的 id。自動導頁與手動點按鈕走的是同一個目的地，
   兩邊都要帶著它，否則手動點過去就少了標記。 */
const boughtStashId = ref<string | undefined>()
const boughtQuery = computed(() => (boughtStashId.value ? { new: boughtStashId.value } : undefined))
onBeforeUnmount(() => { if (jump) clearTimeout(jump) })

/* ---- 成交之後，畫面要當場說完 ----
   .result 是接在詳情面板後面的流內區塊，在 393px 上它的位置是 945px ——
   視窗下緣再往下 93px。庫內轉移那條靠 router.replace 把人帶走所以看得到結果，
   需寄送這條原本只寫了 done.value，於是使用者按完「確定買下」看到的變化
   只有「買下鈕不見了」：餘額不動（凍結不是扣款，本來就該不動）、卡圖與價格
   一模一樣。那跟按壞了長得一樣，而他其實已經付了 18,220 點。

   兩件事一起補，缺一不可：
     1. 下面那條 sticky 列不消失，就地換成結果列 —— sticky 的位置不受
        捲動位置影響，所以「成交了 / 錢是凍結不是扣款 / 下一步去哪」
        這三件事在任何捲動位置都看得到，不必賭使用者剛好停在哪裡。
     2. 主動把 .result 捲到眼前 —— 託管那段完整說明（誰、什麼時候拿到錢、
        卡什麼時候進卡冊）值得看，光靠一行結果列講不完。
   只做 2 不做 1 的話，使用者往回捲就又找不到下一步；
   只做 1 不做 2 的話，他知道成交了卻不知道接下來會發生什麼。 */
const resultEl = ref<HTMLElement | null>(null)
/* 捲動用 smooth，除非使用者要求減少動態 —— 瞬移到另一段畫面會讓人
   分不清是捲動還是換頁，而這一刻他最需要的就是「我還在同一頁」 */
const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
async function revealResult() {
  await nextTick()
  resultEl.value?.scrollIntoView({
    behavior: reduceMotion.value ? 'auto' : 'smooth',
    block: 'center'
  })
}

function ask() {
  if (!buyable.value) return
  error.value = ''
  confirming.value = true
  haptic('tap')
}

async function buy() {
  const l = listing.value
  if (!l || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const bought = await api.buyListing(l.id)

    /* 兩條通道在這裡分開。
       庫內轉移是原子交換：點數直接扣、卡直接過戶，沒有中間狀態。
       需寄送則建立託管訂單，點數只是「凍結」不是扣款 —— 錢還是買家的，
       要等確認收貨或驗收期滿才真的付給賣家。 */
    if (lane.value === 'vault') {
      wallet.spend(l.price)
      done.value = 'vault'
      /* 使用者的期待就是「買了就該在卡冊裡」，所以真的把他送過去。
         停一拍再走，是為了讓「買到什麼」看得到一眼，不是憑空的延遲。
         帶著剛過戶到手的卡片 id 過去 —— 卡冊會把它標成「剛收進卡冊」，
         否則到了卡冊還是要自己在一整面卡裡找剛買的是哪一張。 */
      boughtStashId.value = bought.stashId
      jump = setTimeout(() => router.replace({ name: 'cards', query: boughtQuery.value }), 1400)
    } else {
      await orders.createFromListing(l, auth.user?.name ?? '我')
      done.value = 'ship'
    }

    listing.value = { ...l, status: 'sold' }
    confirming.value = false
    haptic('success')
    track('market_buy_success')
    /* 兩條通道都捲：庫內轉移雖然 1.4 秒後會自己導去卡冊，但在那之前
       「已買下 ○○」同樣是長在視窗外的，那一拍等於什麼都沒發生。 */
    await revealResult()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '購買失敗'
    // 被別人先買走了：把畫面改成已售出，不要讓他一直按同一顆會失敗的鍵
    if (String(error.value).includes('sold')) listing.value = { ...l, status: 'sold' }
    confirming.value = false
  } finally {
    busy.value = false
  }
}

/* ---- 賣家自己來的時候：下架 ----
   接的是既有的後端能力 POST /v1/listings/:id/delist（server/src/routes/public.ts），
   不是為了這個畫面新造的。那支會把掛單改成 delisted，並把卡的狀態放回
   上架前的樣子（庫內的回 stashed、需寄送的回 shipped），卡才不會一直鎖在
   prizes.status = 'listed' 而出不了貨也回收不了。

   改價沒有對應的端點（後端只有 GET / POST / delist 三支），所以畫面上
   不假裝有一顆「改價」——寧可誠實地說「先下架再重新上架」，那是真的走得通的路。 */
const delistAsking = ref(false)
const delisted = ref(false)
/** 待命列與確認列不能同時在畫面上（同一個位置會疊出兩條），兩種確認共用一個判斷 */
const asking = computed(() => confirming.value || delistAsking.value)
/** 三種「事情已經做完了」收斂成一個值：結果列與結果面板都只看它，
    不必在樣板裡把 done / delisted 兩個旗標的組合再攤開一次 */
const outcome = computed<'vault' | 'ship' | 'delist' | null>(() =>
  delisted.value ? 'delist' : done.value)

function askDelist() {
  if (!isMine.value || sold.value || delisted.value) return
  error.value = ''
  delistAsking.value = true
  haptic('tap')
}

async function delist() {
  const l = listing.value
  if (!l || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api.delistListing(l.id)
    delisted.value = true
    delistAsking.value = false
    haptic('success')
    /* 下架走的是同一塊 .result、同一個位置，症狀也會一模一樣 */
    await revealResult()
    /* 沒有 track()：GaEvent 的白名單住在 lib/ga.ts，那支不在這次的改動範圍內，
       為了埋一個點去動共用型別不值得 —— 之後要埋再一起加。 */
  } catch (e) {
    error.value = e instanceof Error ? e.message : '下架失敗'
    delistAsking.value = false
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="container page">
    <header class="head">
      <RouterLink :to="{ name: 'market' }" class="back">← 市場</RouterLink>
    </header>

    <div v-if="loading" class="sk" aria-hidden="true">
      <div class="skArt"></div>
      <div class="skLine w60"></div>
      <div class="skLine w40"></div>
    </div>

    <div v-else-if="missing || !listing" class="gone">
      <h1>找不到這筆掛單</h1>
      <p class="muted">這筆掛單不存在或已下架。它可能已經被買走，或是賣家把卡收回去了。</p>
      <RouterLink :to="{ name: 'market' }" class="btn primary">回市場看看</RouterLink>
    </div>

    <template v-else>
      <div class="hero">
        <CardArt
          class="art"
          :image="listing.card.image" :alt="listing.card.name"
          :art-id="listing.card.artId"
        />
        <span class="lane" :class="lane">{{ lane === 'vault' ? '庫內轉移' : '需寄送' }}</span>
        <!-- 跟列表上同一顆標記、同一個位置（左上通道、右上自己的）——
             從列表點進來的人不用重新辨認一次 -->
        <OwnerTag v-if="isMine" class="heroMine" label="我的掛單" />
      </div>

      <!-- 一張連續的面板，內部用細分隔線分段。
           原本是「卡片資訊 / 賣家 / 通道說明 / 交易保護」各自一個有間距的圓角盒，
           四塊各自浮著，讀起來像四張不相干的卡片疊在一起，而不是一個商品頁。
           層級改由間距與字級分出來，不是靠「每段包一個盒子」。
           面板是實心底：站上的環狀底紋是畫在 body 上的，
           低對比的小字（市值那一行）直接壓在上面會被紋路吃掉。 -->
      <section class="panel">
        <!-- 擺在面板的第一段而不是頁尾：使用者的閱讀順序是「卡圖 → 這是什麼 → 多少錢」，
             「這張是你自己掛的」必須在他開始評估價格之前就到位，否則他會先在心裡
             把這筆當成一筆可以買的交易，再被推翻。 -->
        <div v-if="isMine" class="seg mineSeg">
          <strong class="mineTitle">這是你上架的卡</strong>
          <p class="mineNote">
            自己的掛單不能自己買。想把卡收回來就按下面的「下架」——
            卡會回到你的卡冊，可以出貨、回收，或重新用別的價格上架。
          </p>
        </div>

        <div class="seg lead">
          <h1 class="name">{{ listing.card.name }}</h1>
          <div class="priceRow">
            <strong class="mono p">{{ listing.price.toLocaleString() }}</strong>
            <span class="u">點</span>
            <span class="tag" :class="diffPct <= 0 ? 'good' : 'over'">
              {{ diffPct <= 0 ? '' : '+' }}{{ diffPct }}%
            </span>
          </div>
          <p class="ref mono">賣家標示參考價 {{ refPriceText(listing.card.refPrice) }} · 上架於 {{ listing.listedAt }}</p>
        </div>

        <!-- 通道說明緊貼價格：它講的是「這筆交易的性質」，跟價格是同一組資訊。
             錢會怎麼流要講在按下去之前，不是在爭議發生之後。 -->
        <div class="seg laneSeg" :class="lane">
          <strong class="laneTitle">{{ lane === 'vault' ? '庫內轉移，成交即過戶' : '需寄送，點數先託管' }}</strong>
          <p class="cnote">
            {{ lane === 'vault'
              ? '卡在保管庫，成交立刻過戶到你名下，直接收進卡冊，不需要等寄送。'
              : '點數先凍結，你確認收貨或 7 天後才放款給賣家。卡由賣家實體寄出，收到之前它還不會出現在你的卡冊裡。' }}
          </p>
        </div>

        <!-- 寄存剩餘天數。緊接在通道說明後面：兩者講的是同一件事的兩半 ——
             「成交即過戶」講的是卡會變成你的，這一塊講的是那張卡已經放了多久。
             只有庫內轉移會有這一塊（見 script 的說明）。 -->
        <div v-if="stash" class="seg stashSeg" :class="stashUrgent ? 'urgent' : 'calm'">
          <strong class="stashTitle">{{ stashTitle }}</strong>
          <p class="cnote">{{ stashBody }}</p>
        </div>

        <!-- 卡況與賣家排在同一份清單裡：對買家來說「這是什麼卡」跟
             「這是誰在賣」是同一個問題的兩半，沒有理由分成兩個區塊 -->
        <dl class="seg facts">
          <div class="fact">
            <dt>鑑定</dt>
            <dd><CertTag :card="listing.card" /></dd>
          </div>
          <div class="fact">
            <dt>卡號</dt>
            <dd class="mono">{{ [listing.card.setCode, listing.card.cardNo].filter(Boolean).join(' ') || '—' }}</dd>
          </div>
          <div class="fact">
            <dt>語言</dt>
            <dd>{{ listing.card.language === 'JP' ? '日文版' : '英文版' }}</dd>
          </div>
          <div class="fact">
            <dt>參考市值</dt>
            <dd class="mono">{{ refPriceText(listing.card.refPrice) }}</dd>
          </div>
          <div class="fact">
            <dt>賣家</dt>
            <dd>
              <!-- 自己的掛單就直說是自己，不要讓他對著自己的代號想「這人是誰」 -->
              <span v-if="isMine" class="who">
                <strong>{{ listing.sellerName }}</strong>
                <span class="who-me">你</span>
              </span>
              <SellerChip v-else-if="seller" :seller="seller" />
              <!-- 玩家掛的卡沒有賣家審核等級可查，就只講事實：這是個人賣家 -->
              <span v-else class="who">
                <strong>{{ listing.sellerName }}</strong>
                <span class="who-tier">個人賣家</span>
              </span>
            </dd>
          </div>
        </dl>

        <TradeGuard class="seg guardSeg" />
      </section>

      <!-- 成交之後：明確告訴他卡（或錢）現在在哪裡。
           三種結果互斥，共用同一個 ref —— 成交後由 revealResult() 把它捲到眼前。
           去處那顆鍵不放在這裡：它住在下面那條結果列，那條是 sticky 的，
           使用者往回捲去看卡圖時下一步仍然跟著他。同一個畫面上放兩顆
           一模一樣的「看這筆訂單」只會讓人猶豫該按哪一顆。 -->
      <div v-if="done === 'vault'" ref="resultEl" class="result ok" role="status">
        <strong>已買下 {{ listing.card.name }}</strong>
        <p>卡片已經過戶到你名下，收進卡冊了。正在帶你過去…</p>
      </div>

      <div v-else-if="done === 'ship'" ref="resultEl" class="result ok" role="status">
        <strong>{{ listing.price.toLocaleString() }} 點已凍結</strong>
        <p>
          這筆走託管：點數是凍結不是扣款，錢還是你的（所以頭部的餘額不會變少）。
          賣家出貨、你確認收貨或 7 天驗收期滿之後才會放款給賣家。
          卡收到之前不會進卡冊，進度都在訂單頁上。
        </p>
      </div>

      <div v-if="delisted" ref="resultEl" class="result ok" role="status">
        <strong>已下架 {{ listing.card.name }}</strong>
        <p>
          這張卡已經從市場收回，回到你的卡冊了。想重新賣就再上架一次，
          價格可以重新設定。
        </p>
      </div>

      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <!-- 成交／下架之後，這條列不消失，就地換成結果列。
           原本 `!done` 把整條移除，畫面上唯一的變化就是「按鈕不見了」——
           而那正是「壞掉」的長相。位置不變是刻意的：他剛剛按的那顆鍵在這裡，
           答案就該出現在這裡。 -->
      <div v-if="outcome" class="bar card doneBar">
        <span class="sum">
          <template v-if="outcome === 'ship'">
            <strong class="mono">{{ listing.price.toLocaleString() }}</strong> 點已凍結，還沒扣款
          </template>
          <template v-else-if="outcome === 'vault'">已過戶進你的卡冊</template>
          <template v-else>已從市場收回，卡回到你的卡冊</template>
        </span>
        <RouterLink v-if="outcome === 'ship'" :to="{ name: 'orders' }" class="btn primary">
          看這筆訂單
        </RouterLink>
        <RouterLink
          v-else
          :to="{ name: 'cards', query: outcome === 'vault' ? boughtQuery : undefined }"
          class="btn primary"
        >去我的卡冊</RouterLink>
      </div>

      <!-- 待命的結帳列，兩種狀態：待命（餘額＋買下）與確認（金額＋取消／確定）。
           確認態改由 BottomActionBar 接手，所以這條在確認時要讓開，不然畫面上
           會疊出兩條列。窄螢幕用 visibility 藏而不是拿掉：它是 sticky、佔著
           版面高度，直接移除會讓整頁往上跳一截，而浮出的那條是 fixed 補不回來。
           寬螢幕相反 —— 確認列就地接在同一個位置，這條要真的讓出流內空間。 -->
      <div
        v-else-if="!asking || !wide"
        class="bar card" :class="{ ghost: asking }"
        :aria-hidden="asking || undefined"
      >
        <p v-if="sold" class="soldOut">這張已經被買走了。</p>

        <!-- 自己的掛單：這個位置本來是「買下」。賣家點進自己的卡真正想做的不是買，
             是把它收回來或改價，所以同一個位置直接給下架 ——
             一顆按不下去的灰色「買下」仍然是在說「這裡本來可以買」。 -->
        <template v-else-if="isMine">
          <span class="sum">
            你掛 <strong class="mono">{{ listing.price.toLocaleString() }}</strong> 點，等買家上門
          </span>
          <button type="button" class="btn primary mineBtn" @click="askDelist">下架收回</button>
        </template>

        <template v-else-if="!auth.isLoggedIn">
          <span class="sum">要登入才能購買</span>
          <RouterLink
            :to="{ name: 'landing', query: { redirect: route.fullPath } }"
            class="btn primary"
          >登入後購買</RouterLink>
        </template>

        <template v-else-if="!canAfford">
          <span class="sum">
            餘額不足，可動用 <strong class="mono">{{ wallet.available.toLocaleString() }}</strong> 點
          </span>
          <RouterLink :to="{ name: 'topup' }" class="btn primary">去儲值</RouterLink>
        </template>

        <template v-else>
          <span class="sum">
            餘額 <strong class="mono">{{ wallet.shown.toLocaleString() }}</strong> 點
          </span>
          <button type="button" class="btn primary" @click="ask">
            買下 · {{ listing.price.toLocaleString() }} 點
          </button>
        </template>
      </div>

      <!-- 確認態。只在真的要確認時才存在，所以已售出、找不到掛單、成交之後
           都不會浮出一條空列。max-width 跟 .page 同寬，寬螢幕上才不會拉成
           橫貫整個視窗的一條。 -->
      <BottomActionBar
        :open="!done && !delisted && confirming"
        label="購買確認"
        :inline="wide"
        :max-width="560"
        :gap="12"
        :spacer="150"
      >
        <p class="cq">
          用 <strong class="mono">{{ listing.price.toLocaleString() }}</strong> 點買下？
          餘額將剩 <span class="mono">{{ (wallet.shown - listing.price).toLocaleString() }}</span> 點。
          <span class="cqLane">{{ lane === 'vault' ? '成交立刻過戶進卡冊。' : '點數凍結，等收貨才放款。' }}</span>
          <!-- 快到期的話在**按下確定的那一刻**再講一次。上面那一塊在頁面流裡，
               使用者完全可能捲過去就忘了；這一行跟金額在同一句話裡，躲不掉。 -->
          <span v-if="stashUrgent" class="cqStash">{{ stashTitle }}，買下不會重新計算。</span>
        </p>
        <div class="crow">
          <button type="button" class="btn" :disabled="busy" @click="confirming = false">取消</button>
          <button type="button" class="btn primary" :disabled="busy" @click="buy">
            {{ busy ? '處理中…' : '確定買下' }}
          </button>
        </div>
      </BottomActionBar>

      <!-- 下架確認。用同一支 BottomActionBar：兩種確認在同一個位置、同一個高度出現，
           而且兩者互斥（買家永遠看不到下架、賣家永遠看不到購買），不會疊在一起。 -->
      <BottomActionBar
        :open="!delisted && delistAsking"
        label="下架確認"
        :inline="wide"
        :max-width="560"
        :gap="12"
        :spacer="150"
      >
        <p class="cq">
          把 <strong>{{ listing.card.name }}</strong> 從市場收回？
          <span class="cqLane">
            卡會回到你的卡冊，{{ lane === 'vault' ? '仍然保管在庫內' : '仍然在你手上' }}；之後可以出貨、回收，或用別的價格重新上架。
          </span>
        </p>
        <div class="crow">
          <button type="button" class="btn" :disabled="busy" @click="delistAsking = false">取消</button>
          <button type="button" class="btn primary mineBtn" :disabled="busy" @click="delist">
            {{ busy ? '處理中…' : '確定下架' }}
          </button>
        </div>
      </BottomActionBar>
    </template>
  </div>
</template>

<style scoped>
/* 讓位只留一份：底部導覽的安全區已經由全域頁尾算過（見 App.vue），
   這裡再加一次會在頁面下緣多出一段捲得到卻空無一物的黑。
   88px 是留給下面那條 sticky 購買列的活動空間，跟安全區無關。 */
.page { padding-top: 18px; padding-bottom: 88px; max-width: 560px; }

.head { display: flex; align-items: center; margin-bottom: 12px; }
.back { font-size: 13px; color: var(--muted); text-decoration: none; min-height: 44px; display: inline-flex; align-items: center; }
@media (hover: hover) { .back:hover { color: var(--ink); } }

/* 卡圖：置中、限寬。滿版在 393px 上會高到 550px，把價格與通道說明
   整個推到第一屏外，而那兩件事才是這一頁存在的理由。 */
.hero { position: relative; width: min(62%, 240px); margin: 0 auto 16px; }
.art { display: block; width: 100%; aspect-ratio: 5 / 7; border-radius: var(--radius); overflow: hidden; background: var(--surface-2); }
.art :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.lane {
  position: absolute; left: 8px; top: 8px;
  font-size: 10.5px; font-weight: 700; line-height: 1;
  padding: 5px 9px; border-radius: var(--pill);
  letter-spacing: .02em;
  backdrop-filter: blur(6px);
}
.lane.vault { background: rgba(22, 130, 90, .82); color: #fff; }
.lane.ship { background: rgba(10, 10, 14, .66); color: rgba(255, 255, 255, .92); }

/* ---- 一體的面板 ----
   overflow: hidden 讓最後一段（交易保護）的圓角被面板裁掉，
   四段才會像同一張紙的四個部分，而不是紙上再貼一張紙。 */
.panel {
  margin-top: 4px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--line-soft);
  overflow: hidden;
}
/* 內距統一、分隔線齊頭：段與段之間只有一條線，沒有間距，
   層級改由字級與留白分出來 */
.seg { padding: 15px 16px; }
.seg + .seg { border-top: 1px solid var(--line); }

.name { font-size: 20px; line-height: 1.35; margin: 0; letter-spacing: -.02em; }
.priceRow { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.p { font-size: 30px; font-weight: 700; letter-spacing: -.03em; }
.u { font-size: 13px; color: var(--muted); }
.tag { font-size: 11.5px; font-weight: 700; padding: 3px 9px; border-radius: var(--pill); }
.tag.good { background: var(--ok); color: #06210f; }
.tag.over { background: var(--surface-3); color: var(--muted); }
.ref { font-size: 12px; color: var(--muted); margin: 5px 0 0; }

/* 通道那一段給一點底色 —— 它是這筆交易的性質，不是可看可不看的補充。
   底色壓在面板裡而不是自己一個盒子，所以左右仍然齊頭 */
.laneSeg.vault { background: var(--ok-wash); }
.laneTitle { display: block; font-size: 13.5px; letter-spacing: -.01em; }
.laneSeg.vault .laneTitle { color: var(--ok-ink); }
.cnote { font-size: 12.5px; line-height: 1.75; color: var(--muted); margin: 4px 0 0; }
/* 寄存剩餘天數。兩種語氣共用版面，只換底色與字色 ——
   換版面的話「剩 88 天」與「剩 1 天」會長得像兩種不同的東西，
   而它們是同一件事的兩端。 */
.stashSeg.calm { background: var(--info-wash); }
.stashSeg.urgent { background: var(--warn-wash); }
.stashTitle { display: block; font-size: 13.5px; letter-spacing: -.01em; }
.stashSeg.calm .stashTitle { color: var(--info-ink); }
.stashSeg.urgent .stashTitle { color: var(--warn-ink); }
.stashSeg.calm .cnote { color: color-mix(in srgb, var(--info-ink) 74%, var(--muted)); }
.stashSeg.urgent .cnote { color: color-mix(in srgb, var(--warn-ink) 78%, var(--muted)); }
.cqStash { display: block; margin-top: 3px; color: var(--warn-ink); font-weight: 600; }
.laneSeg.vault .cnote { color: color-mix(in srgb, var(--ok-ink) 78%, var(--muted)); }

/* 卡況與賣家共用一份清單。右欄要 minmax(0, 1fr)：grid 子元素預設是
   min-width: auto，長鑑定編號會把整列（連同整頁）撐出視窗 */
.facts { margin: 0; display: grid; gap: 10px; }
.fact { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 12px; align-items: center; }
.fact dt { font-size: 12.5px; color: var(--muted); }
.fact dd { font-size: 13px; margin: 0; min-width: 0; overflow-wrap: anywhere; }

.who { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.who strong { font-size: 13px; font-weight: 600; }
.who-tier {
  flex: none; font-size: 10.5px; font-weight: 600;
  padding: 2px 8px; border-radius: var(--pill);
  background: var(--surface-2); color: var(--muted);
}

/* 交易保護是面板的最後一段。它自己帶邊框、圓角與下方留白（那是給
   市場列表用的），在這裡要拆掉，才不會在一體的面板裡又冒出一個盒子。 */
.panel :deep(.guard) {
  margin: 0; border: none; border-radius: 0;
  background: transparent;
  padding: 15px 16px;   /* 跟其他段落同一個內距，分隔線才齊頭 */
}

/* ---- 自己的掛單 ----
   顏色跟市場列表上的標記同一組（--info-ink）：藍色在這一頁一律代表「這是你的」，
   跟紅（買下）、綠（庫內轉移）、金（鑑定）都分得開。
   不用 --accent 是因為那已經是「買下」那顆鍵的顏色。 */
.heroMine { position: absolute; right: 8px; top: 8px; max-width: calc(100% - 16px); }

.mineSeg { background: var(--info-wash); }
.mineTitle { display: block; font-size: 13.5px; letter-spacing: -.01em; color: var(--info-ink); }
.mineNote {
  font-size: 12.5px; line-height: 1.75; margin: 4px 0 0;
  color: color-mix(in srgb, var(--info-ink) 74%, var(--muted));
}

/* 賣家那一列的「你」：跟 who-tier 同一個形狀，只是換成自己的顏色 */
.who-me {
  flex: none; font-size: 10.5px; font-weight: 700;
  padding: 2px 8px; border-radius: var(--pill);
  background: var(--info-ink); color: var(--bg);
}

/* 下架鍵借 .btn.primary 的形狀，但換掉強調色 —— 這條列上不會有「買下」，
   讓它維持紅色會讓人以為那是成交鍵 */
.mineBtn { background: var(--info-ink); color: var(--bg); border-color: transparent; }
@media (hover: hover) {
  .mineBtn:hover { background: color-mix(in srgb, var(--info-ink) 86%, var(--ink)); box-shadow: var(--shadow); }
}
.mineBtn:focus-visible { outline-color: var(--info-ink); }

.result {
  display: grid; justify-items: start; gap: 8px;
  margin-top: 14px; padding: 14px;
  border-radius: var(--radius);
}
.result.ok { background: var(--ok-wash); color: var(--ok-ink); }
.result strong { font-size: 14.5px; }
.result p { margin: 0; font-size: 12.5px; line-height: 1.7; }

.err {
  margin: 14px 0 0; padding: 11px 14px; border-radius: var(--radius);
  background: var(--danger-wash); color: var(--danger-ink);
  font-size: 13px; font-weight: 600;
}

.bar {
  /* 手機上底部導覽是在的（這頁沒設 chrome: none），只避開安全區的話
     這條列的下半截會被導覽蓋掉 —— 而它是整個購買流程的送出鍵。
     取 max：手機的 --nav-total 已含安全區，桌機是 0 才輪到 --safe-b
     （同 NotifyBell 與 SellListingPage 的寫法）。算式跟 BottomActionBar
     同源，兩種狀態的列才會停在同一個高度。 */
  position: sticky; bottom: calc(12px + max(var(--nav-total, 0px), var(--safe-b, 0px)));
  display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
  padding: 12px 14px; margin-top: 16px;
  background: var(--surface);
  box-shadow: var(--shadow);
}
/* min-width: 0 —— flex 子元素預設不縮到比內容窄，少了它長餘額會把按鈕擠出去 */
.sum { flex: 1; min-width: 0; font-size: 12.5px; color: var(--muted); }
.sum strong { color: var(--ink); font-size: 15px; }
.bar .btn { flex: none; }
.soldOut { margin: 0; font-size: 13px; color: var(--muted); }

/* 確認態讓待命列讓開時仍佔著版面高度，見 template 的說明 */
.ghost { visibility: hidden; }

/* 結果列：跟待命列同一個位置、同一個形狀，只換底色與內容。
   綠底是全站「這件事成了」的顏色（跟上面那塊 .result.ok 同一組），
   跟紅色的「買下」分得開 —— 不換色的話它看起來還像一顆可以再按一次的結帳列。 */
.doneBar { background: var(--ok-wash); }
.doneBar .sum, .doneBar .sum strong { color: var(--ok-ink); }

/* 確認列的內容現在住在 BottomActionBar 裡，那是個一般的區塊容器，
   不再靠外層的 flex-wrap 換行 */
.cq { min-width: 0; margin: 0 0 10px; font-size: 12.5px; line-height: 1.75; }
.cq strong { font-size: 15px; }
.cqLane { display: block; color: var(--muted); }
.crow { display: flex; gap: 8px; }
.crow .btn { flex: 1; min-width: 0; }

.gone { text-align: center; padding: 48px 0; display: grid; justify-items: center; gap: 10px; }
.gone h1 { font-size: 19px; margin: 0; }
.gone p { margin: 0; font-size: 13.5px; line-height: 1.7; max-width: 30ch; }
.gone .btn { margin-top: 6px; }

.sk { display: grid; justify-items: center; gap: 10px; }
.skArt { width: min(62%, 240px); aspect-ratio: 5 / 7; border-radius: var(--radius); background: var(--surface-2); }
.skLine { height: 14px; border-radius: 7px; background: var(--surface-2); }
.skLine.w60 { width: 60%; }
.skLine.w40 { width: 40%; }
@media (prefers-reduced-motion: no-preference) {
  .skArt, .skLine { animation: pulse 1.4s ease-in-out infinite alternate; }
}
@keyframes pulse { to { opacity: .55; } }

@media (max-width: 720px) {
  .name { font-size: 18px; }
  .p { font-size: 26px; }
}
</style>
