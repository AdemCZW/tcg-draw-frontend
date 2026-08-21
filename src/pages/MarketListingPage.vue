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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/lib/api'
import { deliveryOf } from '@/shared/domain'
import type { Listing, Seller } from '@/types/models'
import { useWalletStore } from '@/stores/wallet'
import { useAuthStore } from '@/stores/auth'
import { useOrdersStore } from '@/stores/orders'
import CardArt from '@/components/CardArt.vue'
import CertTag from '@/components/CertTag.vue'
import SellerChip from '@/components/SellerChip.vue'
import TradeGuard from '@/components/TradeGuard.vue'
import { haptic } from '@/lib/haptics'
import { track } from '@/lib/ga'

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

onMounted(async () => {
  try {
    const l = await api.getListing(id.value)
    listing.value = l
    missing.value = !l
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
const buyable = computed(() => !!listing.value && !sold.value && auth.isLoggedIn && canAfford.value)

/* 導去卡冊的計時器要收乾淨：使用者可能在這 1.4 秒內自己按了按鈕或返回，
   讓一個已經卸載的頁面再導一次會把他從別的地方拽走。 */
let jump: ReturnType<typeof setTimeout> | null = null
/* 剛買到的那張卡在卡冊裡的 id。自動導頁與手動點按鈕走的是同一個目的地，
   兩邊都要帶著它，否則手動點過去就少了標記。 */
const boughtStashId = ref<string | undefined>()
const boughtQuery = computed(() => (boughtStashId.value ? { new: boughtStashId.value } : undefined))
onBeforeUnmount(() => { if (jump) clearTimeout(jump) })

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
  } catch (e) {
    error.value = e instanceof Error ? e.message : '購買失敗'
    // 被別人先買走了：把畫面改成已售出，不要讓他一直按同一顆會失敗的鍵
    if (String(error.value).includes('sold')) listing.value = { ...l, status: 'sold' }
    confirming.value = false
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
          :cert-no="listing.card.certNo" :art-id="listing.card.artId"
        />
        <span class="lane" :class="lane">{{ lane === 'vault' ? '庫內轉移' : '需寄送' }}</span>
      </div>

      <!-- 一張連續的面板，內部用細分隔線分段。
           原本是「卡片資訊 / 賣家 / 通道說明 / 交易保護」各自一個有間距的圓角盒，
           四塊各自浮著，讀起來像四張不相干的卡片疊在一起，而不是一個商品頁。
           層級改由間距與字級分出來，不是靠「每段包一個盒子」。
           面板是實心底：站上的環狀底紋是畫在 body 上的，
           低對比的小字（市值那一行）直接壓在上面會被紋路吃掉。 -->
      <section class="panel">
        <div class="seg lead">
          <h1 class="name">{{ listing.card.name }}</h1>
          <div class="priceRow">
            <strong class="mono p">{{ listing.price.toLocaleString() }}</strong>
            <span class="u">點</span>
            <span class="tag" :class="diffPct <= 0 ? 'good' : 'over'">
              {{ diffPct <= 0 ? '' : '+' }}{{ diffPct }}%
            </span>
          </div>
          <p class="ref mono">市值 {{ listing.card.refPrice.toLocaleString() }} 點 · 上架於 {{ listing.listedAt }}</p>
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
            <dd class="mono">{{ listing.card.refPrice.toLocaleString() }} 點</dd>
          </div>
          <div class="fact">
            <dt>賣家</dt>
            <dd>
              <SellerChip v-if="seller" :seller="seller" />
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

      <!-- 成交之後：明確告訴他卡（或錢）現在在哪裡 -->
      <div v-if="done === 'vault'" class="result ok" role="status">
        <strong>已買下 {{ listing.card.name }}</strong>
        <p>卡片已經過戶到你名下，收進卡冊了。正在帶你過去…</p>
        <RouterLink :to="{ name: 'cards', query: boughtQuery }" class="btn primary">去看我的卡冊</RouterLink>
      </div>

      <div v-else-if="done === 'ship'" class="result ok" role="status">
        <strong>{{ listing.price.toLocaleString() }} 點已凍結</strong>
        <p>
          這筆走託管：點數是凍結不是扣款，錢還是你的。賣家出貨、你確認收貨
          或 7 天驗收期滿之後才會放款給賣家。卡收到之前不會進卡冊。
        </p>
        <RouterLink :to="{ name: 'orders' }" class="btn primary">看這筆訂單</RouterLink>
      </div>

      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <!-- 購買列。sticky 而不是 fixed：這一頁的祖先有轉場用的 transform，
           fixed 的定位基準會被它改掉（見專案裡其他頁的同樣處理）。 -->
      <div v-if="!done" class="bar card">
        <p v-if="sold" class="soldOut">這張已經被買走了。</p>

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

        <template v-else-if="!confirming">
          <span class="sum">
            餘額 <strong class="mono">{{ wallet.shown.toLocaleString() }}</strong> 點
          </span>
          <button type="button" class="btn primary" @click="ask">
            買下 · {{ listing.price.toLocaleString() }} 點
          </button>
        </template>

        <template v-else>
          <p class="cq">
            用 <strong class="mono">{{ listing.price.toLocaleString() }}</strong> 點買下？
            餘額將剩 <span class="mono">{{ (wallet.shown - listing.price).toLocaleString() }}</span> 點。
            <span class="cqLane">{{ lane === 'vault' ? '成交立刻過戶進卡冊。' : '點數凍結，等收貨才放款。' }}</span>
          </p>
          <div class="crow">
            <button type="button" class="btn" :disabled="busy" @click="confirming = false">取消</button>
            <button type="button" class="btn primary" :disabled="busy" @click="buy">
              {{ busy ? '處理中…' : '確定買下' }}
            </button>
          </div>
        </template>
      </div>
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
.p { font-size: 30px; font-weight: 800; letter-spacing: -.03em; }
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

.result {
  display: grid; justify-items: start; gap: 8px;
  margin-top: 14px; padding: 14px;
  border-radius: var(--radius);
}
.result.ok { background: var(--ok-wash); color: var(--ok-ink); }
.result strong { font-size: 14.5px; }
.result p { margin: 0; font-size: 12.5px; line-height: 1.7; }
.result .btn { margin-top: 4px; }

.err {
  margin: 14px 0 0; padding: 11px 14px; border-radius: var(--radius);
  background: var(--danger-wash); color: var(--danger-ink);
  font-size: 13px; font-weight: 600;
}

.bar {
  /* 手機上底部導覽是在的（這頁沒設 chrome: none），只避開安全區的話
     這條列的下半截會被導覽蓋掉 —— 而它是整個購買流程的送出鍵。
     取 max：手機的 --nav-total 已含安全區，桌機是 0 才輪到 --safe-b
     （同 NotifyBell 與 SellListingPage 的寫法）。 */
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

.cq { flex: 1 1 100%; min-width: 0; margin: 0; font-size: 12.5px; line-height: 1.75; }
.cq strong { font-size: 15px; }
.cqLane { display: block; color: var(--muted); }
.crow { display: flex; flex: 1 1 100%; gap: 8px; }
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
