<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/lib/api'
import type { Tier, UserPrize } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import ValueCurve from '@/components/ValueCurve.vue'
import { useWalletStore } from '@/stores/wallet'
import { recycleQuote, RECYCLE_RATE } from '@/lib/recycle'
import { track } from '@/lib/ga'
import { share, shareUrl } from '@/lib/social'
import { ApiError, http } from '@/lib/http'
import { MOCK } from '@/lib/config'
import { useAuthStore } from '@/stores/auth'

const wallet = useWalletStore()
const auth = useAuthStore()
const prizes = ref<UserPrize[]>([])
onMounted(async () => { prizes.value = await api.myPrizes() })

/* ---- 收藏總覽 ----
   卡冊原本是一長串扁平清單，看不出「我收了多少、值多少」。
   對抽卡的人來說那是這一頁最想知道的事，所以拉到最上面。
   已回收的不計入市值 —— 卡已經交還平台了，還算進總值是騙自己。

   排版上只認一件事：這一區有一個主角（收藏總值），其餘都是配角。
   前一版把「持有 / 市值 / 最高價」三個並排成同樣份量的欄，於是三個都不是重點，
   而且「持有 3 張」在 375px 底下被折成「持有 / 3 / 張」三行 ——
   數字與單位被拆開就不再是一個量詞了。現在數字與單位鎖在同一個 inline 行內，
   配角則降級成一行小字，靠層級而不是靠並排來分主次。 */
const owned = computed(() => prizes.value.filter(p => p.status !== 'recycled'))
const totalValue = computed(() => owned.value.reduce((s, p) => s + p.card.refPrice, 0))
const bestCard = computed(() =>
  owned.value.reduce<UserPrize | null>((b, p) => (!b || p.card.refPrice > b.card.refPrice ? p : b), null))

/* 賞別分佈。這是既有資料算得出來、又是別處看不到的一項 ——
   狀態的分佈底下的分頁已經標了數字，再放一次只是重複。
   賞別則只散落在每張卡的膠囊上，要自己數才知道「我這冊是靠一張 A 賞撐起來的
   還是整體都不錯」。用一條堆疊條 + 一行圖例，佔不到 40px。 */
const TIER_ORDER: Tier[] = ['A', 'B', 'C', 'D', 'LAST', 'BUST']
const TIER_LABEL: Record<Tier, string> = {
  A: 'A 賞', B: 'B 賞', C: 'C 賞', D: 'D 賞', LAST: '最後賞', BUST: '爆賞'
}
const tierMix = computed(() =>
  TIER_ORDER
    .map(t => ({ tier: t, n: owned.value.filter(p => p.tier === t).length }))
    .filter(r => r.n > 0))
/* 顏色只是「一眼看比例」的輔助，識別靠的是圖例上的文字。
   賞別色是既有品牌權杖（TierBadge 一路用到底），D 賞刻意是灰的，
   在色覺檢測下 C 賞與 D 賞的分離度偏低 —— 所以每一段都必須有文字圖例，
   不能只靠顏色講話。也因此那條堆疊條對讀屏是 aria-hidden：
   它講的事情圖例已經用文字講完，讀兩次只是噪音。 */

/* ---- 狀態分頁 ----
   寄存中要出貨、待出貨要等、已出貨是歷史 —— 三種狀態的下一步動作完全不同，
   混在同一張清單裡每張卡都要重新判斷「這張現在能做什麼」。 */
type Tab = 'all' | UserPrize['status']
const tab = ref<Tab>('all')
const TABS: { k: Tab; label: string }[] = [
  { k: 'all', label: '全部' },
  { k: 'stashed', label: '寄存中' },
  { k: 'listed', label: '市場販售中' },
  { k: 'ship_requested', label: '待出貨' },
  { k: 'shipped', label: '已出貨' },
  { k: 'recycled', label: '已回收' }
]
const countOf = (k: Tab) => k === 'all' ? prizes.value.length : prizes.value.filter(p => p.status === k).length
const tabs = computed(() => TABS.filter(t => countOf(t.k) > 0))
const shown = computed(() => tab.value === 'all' ? prizes.value : prizes.value.filter(p => p.status === tab.value))

/* 卡圖上的膠囊放不下「市場販售中」五個字（兩欄格線下整張卡才 145px 寬），
   而那裡本來就只需要回答「這張現在動不動得了」。
   完整名稱留在上面的分頁 TABS，兩邊講的是同一件事 */
const statusShort: Record<UserPrize['status'], string> = {
  stashed: '寄存中',
  listed: '販售中',
  ship_requested: '待出貨',
  shipped: '已出貨',
  recycled: '已回收'
}

/* ---- 一張卡佔多高 ----
   前一版每張卡是「卡圖 + 賞別 + 狀態 + 卡名 + 鑑定 + 寄存期限 + 三顆通欄按鈕」
   直式疊下來，375px 上單張 490px —— 比半個螢幕還高，六張要捲四個螢幕。
   而且格線的列高由最高的那張決定，只有一張是寄存中時，其餘每張都陪著空 250px。

   壓縮的原則是分兩類：
   「隨時要看到的」＝ 賞別、狀態、卡名、市值 → 疊回卡圖上（卡圖本來就在，不額外佔高度）
   「決定要不要動它時才需要的」＝ 鑑定編號、寄存期限、三個動作 → 收進展開區
   一次只展開一張，收合時把該卡的定價表單與回收確認一起關掉，
   否則下次展開會停在上次的半途，看起來像自己跳出來的。 */
const openCard = ref<string | null>(null)
/* wonAt 是帶時區的 ISO 字串，直接切前 10 碼會在 UTC+8 的深夜差一天。
   解析不了就原樣回傳 —— 卡冊上少一個好看的日期，比顯示 Invalid Date 好。 */
function wonDay(iso: string) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function toggleCard(id: string) {
  const next = openCard.value === id ? null : id
  openCard.value = next
  if (next !== id) { sellFor.value = null; confirming.value = null }
}

/* ---- 申請出貨 ----
   這段原本是假的：只把本地物件的 status 改掉，從來沒有打後端。
   在 API 模式下按了畫面會變、重新整理就打回原形，而後台的出貨清單
   永遠收不到東西 —— 使用者以為自己申請了，平台這邊什麼也沒有。

   做成多選是因為這一頁本來就寫著「寄存中的卡可合併出貨（省運費）」。
   一張一張送會產生多張出貨單，那句話就變成謊話。 */
const shipOpen = ref(false)
const shipPick = ref<string[]>([])
const shipBusy = ref(false)
const shipErr = ref('')
/* 出貨與上架共用同一個提示槽。兩個各自 position: fixed 在同一個位置，
   接連做兩件事就會疊在一起看不清楚 —— 同一時間只該有一則。 */
const toast = ref('')
function flash(msg: string) {
  toast.value = msg
  setTimeout(() => { if (toast.value === msg) toast.value = '' }, 5000)
}

const stashed = computed(() => prizes.value.filter(p => p.status === 'stashed'))

const addr = ref({ name: '', phone: '', zip: '', city: '', line1: '' })
const addrReady = computed(() =>
  addr.value.name.trim().length >= 2 &&
  addr.value.phone.trim().length >= 8 &&
  addr.value.city.trim().length >= 2 &&
  addr.value.line1.trim().length >= 4)

/* 收件資料從會員資料帶過來，讓人不用每次重打。
   但仍然可以改 —— 「這次要寄到哪」跟「我的預設地址」是兩件事
   （後端 prizes.ts 的註解也是這樣說的）。 */
async function openShip(p: UserPrize) {
  track('click_ship_request')
  shipErr.value = ''
  shipPick.value = [p.id]
  shipOpen.value = true
  if (MOCK) return
  try {
    const r = await http<{ profile: {
      realName?: string | null; phone?: string | null
      addressZip?: string | null; addressCity?: string | null; addressLine1?: string | null
    } }>('/v1/auth/profile')
    const q = r.profile
    addr.value = {
      name: q.realName ?? '', phone: q.phone ?? '',
      zip: q.addressZip ?? '', city: q.addressCity ?? '', line1: q.addressLine1 ?? ''
    }
  } catch { /* 帶不出來就讓使用者自己填，不要因此擋住出貨 */ }
}

function toggleShipPick(id: string) {
  const i = shipPick.value.indexOf(id)
  if (i === -1) shipPick.value.push(id)
  else shipPick.value.splice(i, 1)
}

async function submitShip() {
  if (!addrReady.value || !shipPick.value.length || shipBusy.value) return
  shipBusy.value = true
  shipErr.value = ''
  try {
    const ids = [...shipPick.value]
    await api.shipPrizes(ids, {
      name: addr.value.name.trim(), phone: addr.value.phone.trim(),
      zip: addr.value.zip.trim() || undefined,
      city: addr.value.city.trim(), line1: addr.value.line1.trim()
    })
    // 以伺服器為準重讀，不要自己猜狀態 —— 這正是先前那個 bug 的成因
    prizes.value = await api.myPrizes()
    flash(`已送出 ${ids.length} 張的出貨申請，平台處理後會通知你。`)
    shipOpen.value = false
    shipPick.value = []
    track('ship_request_success')
  } catch (e) {
    shipErr.value = e instanceof ApiError ? e.message : '申請失敗，請稍後再試'
  } finally {
    shipBusy.value = false
  }
}

/* ---- 上架出售 ----
   api.createListing() 一直都在，但整個前端沒有任何地方呼叫它 ——
   使用者拿到卡之後只有「出貨」跟「回收」兩條路，賣不掉。
   市場頁上看得到別人的掛單，自己卻上不了架。 */
const sellFor = ref<string | null>(null)
const sellPrice = ref<number | null>(null)
const sellBusy = ref(false)
const sellErr = ref('')

function askSell(p: UserPrize) {
  sellFor.value = sellFor.value === p.id ? null : p.id
  sellErr.value = ''
  // 預設帶市值，讓人有個錨點；覺得不合理再自己改
  sellPrice.value = p.card.refPrice || null
}

async function submitSell(p: UserPrize) {
  const price = sellPrice.value
  if (!price || price <= 0 || sellBusy.value) return
  sellBusy.value = true
  sellErr.value = ''
  try {
    await api.createListing({
      prizeId: p.id, card: p.card, price,
      sellerName: auth.user?.name || auth.user?.handle || '我'
    })
    prizes.value = await api.myPrizes()
    flash(`「${p.card.name}」已上架，售價 ${price.toLocaleString()} 點`)
    sellFor.value = null
  } catch (e) {
    sellErr.value = e instanceof ApiError ? e.message : '上架失敗'
  } finally {
    sellBusy.value = false
  }
}

/* 回收是不可逆的（卡片交還平台換點數），所以一定要有一段確認，
   而且確認畫面要把「換多少點」和「點數不能提現」同時講清楚。
   用行內展開而不是 window.confirm —— 原生對話框放不下這些資訊。 */
const confirming = ref<string | null>(null)
const justRecycled = ref<{ id: string; points: number } | null>(null)

function askRecycle(p: UserPrize) {
  track('click_recycle')
  confirming.value = confirming.value === p.id ? null : p.id
}

async function doRecycle(p: UserPrize) {
  const q = recycleQuote(p.card)
  if (!q.eligible) return
  try {
    // mock 直接入點；API 模式由後端結算（規則同一份 shared/recycle.ts）並回最新錢包
    const r = await api.recyclePrize(p.id, q.points, `回收 ${p.card.name}`)
    p.status = 'recycled'
    confirming.value = null
    justRecycled.value = { id: p.id, points: r.points }
    setTimeout(() => { justRecycled.value = null }, 4000)
    track('recycle_success')
  } catch (e) {
    alert(e instanceof Error ? e.message : '回收失敗')
  }
}

/* ---- 公開卡冊 / 分享連結 ----
   公開卡冊等於把持有內容攤開給任何拿到連結的人看（連鑑定編號都看得到），
   而連結一旦貼進群組就收不回來。所以這一區的原則是：後果寫在動作旁邊，
   不要藏進說明頁 —— 使用者按下開關前就該知道會被看到什麼。

   收回的手段只有兩個，兩個都會讓舊網址立刻失效：關掉公開、或換一組新連結。
   換連結是「分享錯對象」時唯一還能繼續分享給對的人的補救方式，
   所以做成需要確認的動作，而不是一顆按了就換的按鈕。 */
const shareOn = ref(false)
const shareSlug = ref<string | null>(null)
const shareBusy = ref(false)
const shareErr = ref('')
const copied = ref(false)
const askRotate = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

const shareLink = computed(() => (shareSlug.value ? shareUrl(shareSlug.value) : ''))

onMounted(async () => {
  try {
    const s = await share.get()
    shareOn.value = s.public
    shareSlug.value = s.slug
  } catch {
    /* 讀不到分享設定就當作沒公開。這一區壞掉不該蓋掉卡冊本身，
       所以不在這裡顯示錯誤 —— 真的要改設定時 set() 會再報一次 */
  }
})

async function toggleShare() {
  if (shareBusy.value) return
  const next = !shareOn.value
  shareBusy.value = true
  shareErr.value = ''
  askRotate.value = false
  try {
    const s = await share.set(next)
    shareOn.value = s.public
    shareSlug.value = s.slug
    copied.value = false
  } catch (e) {
    shareErr.value = e instanceof ApiError ? e.message : '設定失敗，請稍後再試。'
  } finally {
    shareBusy.value = false
  }
}

async function rotateLink() {
  shareBusy.value = true
  shareErr.value = ''
  try {
    // rotate=true：後端換一組新代號，舊網址當場失效
    const s = await share.set(true, true)
    shareOn.value = s.public
    shareSlug.value = s.slug
    askRotate.value = false
    copied.value = false
  } catch (e) {
    shareErr.value = e instanceof ApiError ? e.message : '換連結失敗，請稍後再試。'
  } finally {
    shareBusy.value = false
  }
}

async function copyLink() {
  if (!shareLink.value) return
  try {
    await navigator.clipboard.writeText(shareLink.value)
    copied.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied.value = false }, 2400)
  } catch {
    /* 非 HTTPS 或使用者拒絕權限時 clipboard 會直接 reject。
       與其安靜地失敗，不如叫人自己長按複製 —— 網址本來就完整顯示在上面 */
    shareErr.value = '這個瀏覽器不允許自動複製，請長按上面的網址手動複製。'
  }
}
</script>

<template>
  <div class="container page">
    <h1>我的卡冊</h1>

    <!-- 收藏總覽：這一頁最想被回答的問題就是「我收了多少、值多少」。
         一個主角（總值）+ 三個配角（張數、賞別分佈、最高價）+ 一張成長曲線 -->
    <section v-if="owned.length" class="overview card">
      <p class="ovLabel">收藏總值</p>
      <div class="ovHero">
        <!-- 數字與單位鎖在同一個 inline 盒子裡，永遠不會被折成兩行 -->
        <p class="ovVal">
          <strong class="ovNum">{{ totalValue.toLocaleString() }}</strong><span class="ovUnit">點</span>
        </p>
        <p class="ovHold">持有 <b class="mono">{{ owned.length }}</b> 張</p>
      </div>

      <!-- 賞別分佈。段與段之間留 2px 底色縫，不畫外框 —— 邊框是多餘的墨水。
           只有一種賞別時整條都是同一色，那條長方形不含任何資訊，
           下面那行圖例已經把話講完了，所以直接不畫 -->
      <div v-if="tierMix.length > 1" class="mixBar" aria-hidden="true">
        <span
          v-for="m in tierMix" :key="m.tier"
          class="seg" :class="`t-${m.tier.toLowerCase()}`"
          :style="{ flexGrow: m.n }"
        ></span>
      </div>
      <ul class="mixKey">
        <li v-for="m in tierMix" :key="m.tier">
          <span class="kd" :class="`t-${m.tier.toLowerCase()}`" aria-hidden="true"></span>
          {{ TIER_LABEL[m.tier] }}<b class="mono">{{ m.n }}</b><span class="sr-only">張</span>
        </li>
      </ul>

      <!-- 只有一張卡時「最高價」就是總值本身，再列一次是廢話 -->
      <p class="ovBest" v-if="bestCard && owned.length > 1">
        <span class="bLabel">最高價</span>
        <span class="kd" :class="`t-${bestCard.tier.toLowerCase()}`" aria-hidden="true"></span>
        <span class="bName">{{ bestCard.card.name }}</span>
        <span class="bVal mono">{{ bestCard.card.refPrice.toLocaleString() }}</span>
      </p>

      <!-- 成長曲線。放在總覽裡而不是另開一張卡：它回答的是同一個問題的時間版本 -->
      <ValueCurve class="ovCurve" :prizes="owned" />
    </section>

    <!-- 公開卡冊：連結會被貼進群組，收不回來，所以每個動作的後果就寫在按鈕旁邊 -->
    <section v-if="prizes.length" class="share card">
      <div class="shareTop">
        <div class="shareHead">
          <strong class="shareTitle">公開卡冊</strong>
          <p class="shareWhy">
            打開之後，任何拿到連結的人<strong>不必登入、不必有帳號</strong>就能看到你卡冊裡的
            每一張卡：卡名、賞別、參考價，以及 <strong>PSA / BGS 鑑定編號</strong>。
            鑑定編號可以在鑑定機構官網反查，等於把這幾張卡的來歷一起公開。
            你也不會知道誰看過。
          </p>
        </div>
        <button
          type="button" role="switch" :aria-checked="shareOn"
          class="sw" :class="{ on: shareOn }"
          :disabled="shareBusy"
          @click="toggleShare"
        >
          <span class="track" aria-hidden="true"><span class="knob"></span></span>
          <span class="sr-only">公開卡冊</span>
        </button>
      </div>

      <div v-if="shareOn && shareLink" class="shareBody">
        <div class="linkRow">
          <span class="link mono">{{ shareLink }}</span>
          <button type="button" class="btn sm" @click="copyLink">{{ copied ? '已複製' : '複製連結' }}</button>
        </div>
        <p v-if="copied" class="got" role="status">連結已複製，可以直接貼到 LINE 或訊息裡。</p>

        <p class="warn">
          把上面的開關關掉之後，這條連結會<strong>立刻失效</strong>：
          已經分享出去的人再點，只會看到「這本卡冊已改成不公開」。
        </p>

        <div class="acts">
          <RouterLink
            class="btn sm"
            :to="{ name: 'public-cardbook', params: { slug: shareSlug } }"
          >預覽別人看到的樣子</RouterLink>
          <button type="button" class="btn sm" :disabled="shareBusy" @click="askRotate = !askRotate">
            換一組新連結
          </button>
        </div>

        <!-- 換連結是不可逆的，跟回收一樣用行內確認：後果要跟按鈕在同一個畫面 -->
        <div v-if="askRotate" class="confirm">
          <p class="warn">
            換新之後，<strong>現在這條舊連結會立刻失效</strong> ——
            已經貼在群組、私訊裡的舊網址，任何人再點都只會看到「找不到卡冊」。
            分享錯對象時，這是唯一能把卡冊收回來、又還能繼續分享給對的人的方法。
          </p>
          <div class="acts">
            <button type="button" class="btn primary sm" :disabled="shareBusy" @click="rotateLink">
              確認換新連結
            </button>
            <button type="button" class="btn sm" :disabled="shareBusy" @click="askRotate = false">取消</button>
          </div>
        </div>
      </div>

      <p v-if="shareErr" class="shareErr" role="alert">{{ shareErr }}</p>
    </section>

    <p class="muted note">寄存中的卡可合併出貨（省運費），寄存期限 90 天。</p>

    <div v-if="!prizes.length" class="empty card">
      <p>卡冊還是空的。</p>
      <RouterLink :to="{ name: 'home' }" class="btn primary">去抽第一張</RouterLink>
    </div>

    <!-- 狀態分頁：三種狀態的下一步動作完全不同，分開才不用每張卡重新判斷 -->
    <div v-if="tabs.length > 1" class="tabs" role="tablist">
      <button
        v-for="t in tabs" :key="t.k"
        type="button" role="tab" :aria-selected="tab === t.k"
        class="tab" :class="{ on: tab === t.k }"
        @click="tab = t.k; openCard = null"
      >{{ t.label }}<span class="tabN mono">{{ countOf(t.k) }}</span></button>
    </div>

    <div class="grid">
      <div v-for="p in shown" :key="p.id" class="item card" :class="{ dim: p.status === 'recycled' }">
        <!-- 賞別、狀態、卡名、市值全部疊回卡圖上：卡圖本來就佔著這塊面積，
             把字放上去等於不花額外高度。可讀性靠底部的漸層遮罩撐 -->
        <Tilt3D :max="10" radius="12px">
          <CardArt :image="p.card.image" :alt="p.card.name" :tier="p.tier" :cert-no="p.card.certNo" :art-id="p.card.artId" />
          <div class="scrim">
            <div class="sTags">
              <TierBadge :tier="p.tier" />
              <span class="sChip">{{ statusShort[p.status] }}</span>
            </div>
            <div class="sMain">
              <strong class="sName">{{ p.card.name }}</strong>
              <span class="sVal mono">{{ p.card.refPrice.toLocaleString() }}</span>
            </div>
          </div>
        </Tilt3D>

        <p v-if="justRecycled?.id === p.id" class="got" role="status">
          已入帳 <strong class="mono">+{{ justRecycled.points.toLocaleString() }}</strong> 點
        </p>

        <!-- 寄存中才有動作可做，收成一顆按鈕；其餘狀態只留一行取得日期，
             讓每一列的高度不會被「有按鈕的那張」整列撐高 -->
        <button
          v-if="p.status === 'stashed'"
          type="button" class="more" :class="{ on: openCard === p.id }"
          :aria-expanded="openCard === p.id" :aria-label="`${p.card.name} 的操作`"
          @click="toggleCard(p.id)"
        >
          <span>{{ openCard === p.id ? '收起' : '操作' }}</span>
          <span class="chev" aria-hidden="true"></span>
        </button>
        <p v-else class="meta mono">取得 {{ wonDay(p.wonAt) }}</p>

        <div v-if="openCard === p.id && p.status === 'stashed'" class="body">
          <!-- 鑑定編號與寄存期限：決定要不要出貨／回收時才需要，所以收在這裡 -->
          <CertTag :card="p.card" />
          <span class="mono muted exp">寄存至 {{ p.stashExpiresAt }}</span>

          <div class="acts">
            <button class="btn primary sm" @click="openShip(p)">申請出貨</button>
            <button class="btn sm" @click="askSell(p)">上架出售</button>
            <button
              class="btn sm" @click="askRecycle(p)"
              :disabled="!recycleQuote(p.card).eligible"
              :title="recycleQuote(p.card).reason"
            >
              回收 +{{ recycleQuote(p.card).points.toLocaleString() }} 點
            </button>
          </div>

          <!-- 上架表單。定價預設帶市值當錨點，但一定讓人改得動 —— 市值只是參考 -->
          <div v-if="sellFor === p.id" class="confirm">
            <label class="sellRow">
              <span>售價（點）</span>
              <input v-model.number="sellPrice" type="number" inputmode="numeric" min="1">
            </label>
            <p class="muted fine">
              上架後這張卡會鎖在市場上，賣出前不能出貨也不能回收。買家下單即成交，
              點數直接入帳（卡片在保管庫，不需要寄送）。
            </p>
            <p v-if="sellErr" class="warn">{{ sellErr }}</p>
            <div class="acts">
              <button class="btn sm" @click="sellFor = null">取消</button>
              <button
                class="btn primary sm"
                :disabled="!sellPrice || sellPrice <= 0 || sellBusy"
                @click="submitSell(p)"
              >{{ sellBusy ? '上架中…' : '確認上架' }}</button>
            </div>
          </div>

          <!-- 回收確認：不可逆，所以把報價與提現限制一次講完 -->
          <div v-if="confirming === p.id" class="confirm">
            <dl class="quote">
              <div><dt>卡片市值</dt><dd class="mono">{{ p.card.refPrice.toLocaleString() }}</dd></div>
              <div><dt>回收率</dt><dd class="mono">{{ Math.round(RECYCLE_RATE * 100) }}%</dd></div>
              <div class="tot">
                <dt>你會拿到</dt>
                <dd class="mono">+{{ recycleQuote(p.card).points.toLocaleString() }} 點</dd>
              </div>
            </dl>
            <p class="warn">
              卡片交還平台後<strong>無法取回</strong>。
              點數只能用於站內抽選，<strong>不可提領現金、不可轉讓他人</strong>。
            </p>
            <div class="acts">
              <button class="btn primary sm" @click="doRecycle(p)">確認回收</button>
              <button class="btn sm" @click="confirming = null">取消</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 出貨申請。做成覆蓋層而不是行內展開，是因為它要一次呈現「寄哪幾張」
         跟「寄到哪」兩件事，塞進單張卡片的位置會看不完整。

         Teleport 到 body 是必要的，不是整潔問題：換頁轉場會在 .page 上加
         transform，而**祖先只要有 transform，position: fixed 的定位基準就會
         變成那個祖先而不是視窗** —— 面板會被推出畫面外並被裁掉。
         實機上就是這樣壞的（左半邊整個看不到）。 -->
    <Teleport to="body">
    <div v-if="shipOpen" class="sheetWrap" @click.self="shipOpen = false">
      <div class="sheet card" role="dialog" aria-label="申請出貨">
        <h2>申請出貨</h2>
        <p class="muted fine">勾選要一起寄出的卡。合併成一張出貨單，只算一次運費。</p>

        <ul class="pickList">
          <li v-for="p in stashed" :key="p.id">
            <label>
              <input type="checkbox" :checked="shipPick.includes(p.id)" @change="toggleShipPick(p.id)">
              <span class="pn">{{ p.card.name }}</span>
              <span class="mono muted">{{ p.tier }}</span>
            </label>
          </li>
        </ul>

        <div class="fields">
          <label><span>收件人</span><input v-model="addr.name" type="text" placeholder="真實姓名"></label>
          <label><span>電話</span><input v-model="addr.phone" type="tel" inputmode="tel" placeholder="09xxxxxxxx"></label>
          <label><span>郵遞區號</span><input v-model="addr.zip" type="text" inputmode="numeric" placeholder="選填"></label>
          <label><span>縣市</span><input v-model="addr.city" type="text" placeholder="例：台北市"></label>
          <label class="wide"><span>地址</span><input v-model="addr.line1" type="text" placeholder="區、路、號、樓"></label>
        </div>
        <p class="muted fine">預設帶入會員資料裡的收件資訊，這次要寄別的地方可以直接改。</p>

        <p v-if="shipErr" class="warn">{{ shipErr }}</p>
        <div class="acts">
          <button class="btn sm" @click="shipOpen = false">取消</button>
          <button
            class="btn primary sm"
            :disabled="!addrReady || !shipPick.length || shipBusy"
            @click="submitShip"
          >{{ shipBusy ? '送出中…' : `送出（${shipPick.length} 張）` }}</button>
        </div>
      </div>
    </div>
    </Teleport>

    <!-- 送出後的回饋固定在畫面下方，不隨捲動跑掉。同一時間只有一則。
         同樣要 Teleport —— 理由見上面出貨面板的說明 -->
    <Teleport to="body">
      <p v-if="toast" class="toast" role="status">{{ toast }}</p>
    </Teleport>
  </div>
</template>

<style scoped>
/* ---- 出貨面板 ----
   貼底而不是置中：手機上置中的對話框，鍵盤一彈出來就會把送出鍵推出畫面 */
.sheetWrap {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: flex-end; justify-content: center;
  background: #000a;
  padding: 0;
}
.sheet {
  width: 100%; max-width: min(520px, 100vw);
  /* 保險絲：就算之後有人加了壓不住的內容，也讓它自己橫捲，
     不要把整個面板撐出視窗外被裁掉 */
  overflow-x: hidden;
  max-height: min(88dvh, 720px); overflow-y: auto; overscroll-behavior: contain;
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(18px + var(--safe-b, 0px));
}
.sheet h2 { font-size: 17px; margin: 0 0 6px; }

.pickList { list-style: none; margin: 12px 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.pickList label {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 10px; border-radius: 10px; background: var(--surface-2);
  font-size: 13.5px; cursor: pointer;
}
.pickList .pn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 4px; }
/* min-width: 0 不是可有可無的。grid 子元素預設是 min-width: auto ——
   它不會縮到比「內容的固有寬度」更窄，所以 1fr 根本壓不住裡面的 input：
   實測 393px 的螢幕上每欄該是 175px，實際卻是 206px，整個 .fields
   從 359 撐到 420。而 .sheetWrap 是 justify-content: center，
   溢出的部分左右對半切掉 —— 面板的左半邊直接看不到。
   input 本身也要，因為它自己也是 flex 容器的子元素。 */
.fields label { display: flex; flex-direction: column; gap: 5px; min-width: 0; font-size: 12.5px; color: var(--muted); }
.fields label.wide { grid-column: 1 / -1; }
.fields input { min-width: 0; }
.fields input {
  padding: 10px 11px; font: inherit; font-size: 16px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--field, var(--surface-2)); color: var(--ink);
}
.fields input:focus { outline: none; border-color: var(--gold); }

.sellRow { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.sellRow input {
  flex: 1; min-width: 0;  /* flex 子元素預設也是 min-width: auto，見 .fields 的說明 */ padding: 9px 11px; font: inherit; font-size: 16px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--field, var(--surface-2)); color: var(--ink);
}

/* 送出後的回饋。固定在底部導覽上方，捲動時不會跑掉 */
.toast {
  position: fixed; left: 50%; transform: translateX(-50%);
  bottom: calc(14px + max(var(--nav-total, 0px), var(--safe-b, 0px)));
  z-index: 75; max-width: min(92vw, 460px);
  margin: 0; padding: 11px 15px; border-radius: 12px;
  background: var(--surface-3); color: var(--ink);
  font-size: 13px; line-height: 1.6;
  box-shadow: 0 8px 28px #0007;
}

/* ---- 收藏總覽 ----
   底色維持純 var(--surface)，沒有漸層：曲線的端點靠一圈「底色描邊」跟線分離，
   底下只要有漸層，那圈描邊就會在某個高度對不上底色而露出接縫。 */
.overview {
  display: grid; gap: 12px;
  padding: 16px 18px; margin: 14px 0 10px;
}
.ovLabel {
  margin: 0; font-size: 11.5px; color: var(--faint); letter-spacing: .04em;
}
.ovHero { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: nowrap; }
/* 主角數字。單位是行內元素、不換行，「53,380 點」永遠是一個量詞而不是兩段。
   clamp 讓它在 320px 上自己縮到塞得下，不必等到折行才發現放不下 */
.ovVal { margin: 0; white-space: nowrap; min-width: 0; }
.ovNum {
  font-size: clamp(25px, 7.6vw, 34px);
  font-weight: 800; letter-spacing: -.025em; line-height: 1.05;
  color: var(--gold-deep);
  /* 大字用比例數字：tabular 會讓每個數字都佔 0 的寬度，整串看起來鬆散 */
  font-variant-numeric: proportional-nums;
}
.ovUnit { margin-left: 4px; font-size: 12.5px; color: var(--muted); }
.ovHold { margin: 0; flex: none; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.ovHold b { color: var(--ink); font-weight: 700; font-size: 13.5px; font-variant-numeric: tabular-nums; }

/* 賞別分佈條。2px 的縫是底色本身，不是描邊 —— 描邊會多一圈不是資料的墨水 */
.mixBar {
  display: flex; gap: 2px; height: 8px;
  border-radius: var(--pill); overflow: hidden;
  background: var(--surface);
}
.mixBar .seg { flex-basis: 0; min-width: 4px; }
.seg.t-a { background: var(--tier-a); }
.seg.t-b { background: var(--tier-b); }
.seg.t-c { background: var(--tier-c); }
.seg.t-d { background: var(--tier-d); }
.seg.t-last { background: var(--tier-last); }
.seg.t-bust { background: var(--ink); }

/* 圖例才是識別的主要管道：C 賞的藍與 D 賞的灰在色覺檢測下分離度不足，
   只靠顏色會有人分不出來，所以每一段都配文字 */
.mixKey {
  list-style: none; margin: -2px 0 0; padding: 0;
  display: flex; flex-wrap: wrap; gap: 4px 12px;
  font-size: 11px; color: var(--muted);
}
.mixKey li { display: inline-flex; align-items: center; gap: 5px; }
.mixKey b { font-weight: 600; color: var(--ink); margin-left: 3px; }
.kd { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--tier-d); }
.kd.t-a { background: var(--tier-a); }
.kd.t-b { background: var(--tier-b); }
.kd.t-c { background: var(--tier-c); }
.kd.t-d { background: var(--tier-d); }
.kd.t-last { background: var(--tier-last); }
.kd.t-bust { background: var(--ink); }

.ovBest {
  display: flex; align-items: center; gap: 7px; min-width: 0;
  margin: 0; padding-top: 10px; border-top: 1px solid var(--line-soft);
  font-size: 12.5px;
}
.bLabel { color: var(--faint); font-size: 11.5px; flex: none; }
.bName {
  color: var(--ink); font-weight: 600; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bVal { margin-left: auto; flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }

.ovCurve { padding-top: 10px; border-top: 1px solid var(--line-soft); }

/* ---- 狀態分頁 ---- */
.tabs {
  display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none;
  margin: 4px 0 16px; padding-bottom: 2px;
  -webkit-mask-image: linear-gradient(90deg, #000 0 calc(100% - 24px), transparent);
  mask-image: linear-gradient(90deg, #000 0 calc(100% - 24px), transparent);
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  flex: none; min-height: 44px;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 15px; border-radius: var(--pill);
  border: 1px solid var(--line-soft); background: transparent;
  color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.tab.on { background: var(--ink); color: var(--bg); border-color: transparent; font-weight: 600; }
.tabN { font-size: 11px; opacity: .65; }
.tab.on .tabN { opacity: .8; }
@media (hover: hover) { .tab:not(.on):hover { color: var(--ink); border-color: var(--line); } }

@media (max-width: 720px) {
  .overview { padding: 14px; gap: 11px; }
}


/* ---- 公開卡冊 ---- */
.share { padding: 16px 18px; margin: 0 0 14px; display: grid; gap: 12px; }
.shareTop { display: flex; align-items: flex-start; gap: 12px; }
.shareHead { display: grid; gap: 5px; min-width: 0; }
.shareTitle { font-size: 14px; }
/* 這段警語不縮成灰字小號 —— 它是使用者決定要不要按開關的依據，
   跟標題一樣要讀得下去 */
.shareWhy { margin: 0; font-size: 12px; line-height: 1.65; color: var(--muted); }
.shareWhy strong { color: var(--ink); font-weight: 600; }

/* 開關本體 30px 高，但按鈕撐到 44px 觸控高度（touch.css 的門檻） */
.sw {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 56px; height: 44px; padding: 0; border: 0; background: none; cursor: pointer;
}
.sw:disabled { opacity: .5; cursor: not-allowed; }
.sw .track {
  width: 52px; height: 30px; border-radius: var(--pill);
  background: var(--surface-3); border: 1px solid var(--line);
  position: relative; transition: background .18s, border-color .18s;
}
.sw .knob {
  position: absolute; top: 3px; left: 3px; width: 22px; height: 22px;
  border-radius: 50%; background: var(--muted);
  transition: transform .18s, background .18s;
}
.sw.on .track { background: var(--accent); border-color: transparent; }
.sw.on .knob { transform: translateX(22px); background: #fff; }
.sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--pill); }

.shareBody { display: grid; gap: 10px; }
.linkRow {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 8px 8px 14px;
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px;
}
/* 網址整條顯示出來（不截斷成 …），使用者才能長按複製，也才看得出連結換過了 */
.link { flex: 1; min-width: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.linkRow .btn { flex: none; }
.shareErr { margin: 0; font-size: 12px; color: var(--danger); }
.share .confirm { margin-top: 0; }

@media (max-width: 720px) {
  .share { padding: 14px; }
  .shareWhy { font-size: 11.5px; }
  /* 半寬螢幕塞不下「網址 + 按鈕」並排，網址換行後按鈕再撐滿一行 */
  .linkRow { flex-direction: column; align-items: stretch; padding: 10px; gap: 8px; }
}

.page { padding-top: 36px; padding-bottom: 72px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.note { font-size: 13px; margin: 0 0 22px; }
.empty { padding: 40px; text-align: center; display: grid; gap: 12px; justify-items: center; }
/* align-items: start —— 沒有這行，整列的高度會被「展開中的那一張」拉高，
   旁邊那些沒展開的卡就跟著長出一大塊空白（改版前每一列都在做這件事） */
.grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px; align-items: start;
}
.item { padding: 8px; display: grid; gap: 8px; align-content: start; }
.item.dim { opacity: .55; }

/* ---- 疊在卡圖上的資訊 ----
   卡圖是滿版彩色的：白字放在皮卡丘那種黃底上會整個消失。
   底部鋪一層由透明轉深的遮罩，文字才有固定的對比可以依靠。
   這幾個黑與白是「蓋在照片上的遮罩」不是介面表面色，兩套主題下卡圖都一樣亮，
   所以刻意不走主題權杖 —— CardArt 自己的 .caption 也是同一個道理。
   pointer-events: none 是必要的：不寫的話遮罩會吃掉 Tilt3D 的 pointermove，
   手指滑過卡片下半部就不會傾斜。 */
.scrim {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 28px 8px 8px;
  display: grid; gap: 5px;
  background: linear-gradient(180deg, transparent, rgba(0, 0, 0, .55) 38%, rgba(0, 0, 0, .88));
  pointer-events: none;
}
.sTags { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.sTags :deep(.tier) { font-size: 10px; padding: 2px 8px; }
.sChip {
  font-size: 10px; font-weight: 600; line-height: 1.4;
  padding: 2px 8px; border-radius: var(--pill);
  color: #fff; background: rgba(255, 255, 255, .24);
  white-space: nowrap;
}
.sMain { display: flex; align-items: baseline; gap: 6px; }
.sName {
  flex: 1; min-width: 0; font-size: 12.5px; font-weight: 700; line-height: 1.3;
  color: #fff; text-shadow: 0 1px 3px rgba(0, 0, 0, .75);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sVal {
  flex: none; font-size: 11px; color: rgba(255, 255, 255, .85);
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 3px rgba(0, 0, 0, .75);
}

/* ---- 展開鈕 ----
   三顆通欄按鈕收成一顆。44px 是 touch.css 的觸控門檻，
   在兩欄格線下這顆是整張卡唯一要按的東西，寧可給滿。 */
.more {
  width: 100%; min-height: 44px; padding: 0 10px;
  display: flex; align-items: center; justify-content: center; gap: 7px;
  border: 1px solid var(--line); border-radius: var(--pill);
  background: var(--surface-2); color: var(--ink);
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.more.on { background: var(--ink); color: var(--bg); border-color: transparent; }
.more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chev {
  width: 7px; height: 7px; flex: none;
  border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
  transform: translateY(-2px) rotate(45deg);
  transition: transform .18s;
}
.more.on .chev { transform: translateY(2px) rotate(-135deg); }
/* 不能操作的卡沒有按鈕，改放取得日期 —— 剛好也是曲線圖上的橫軸 */
.meta { margin: 0; min-height: 20px; display: flex; align-items: center; font-size: 11px; color: var(--faint); }

.body { display: grid; gap: 8px; padding: 2px 2px 4px; justify-items: start; }
strong { font-size: 14px; }
.exp { font-size: 11.5px; }
.acts { display: flex; gap: 8px; margin-top: 4px; }
.btn.sm { padding: 6px 12px; font-size: 12.5px; }

.got {
  margin: 0; font-size: 12.5px; color: var(--ok);
  font-weight: 600;
}
.got strong { color: var(--ok); }

/* 回收確認 —— 撐滿卡片寬度，讓報價與警語不被擠成兩欄 */
.confirm {
  justify-self: stretch;
  margin-top: 6px; padding: 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  display: grid; gap: 10px;
}
.quote { margin: 0; display: grid; gap: 5px; font-size: 12.5px; }
.quote div { display: flex; justify-content: space-between; gap: 10px; }
.quote dt { color: var(--muted); }
.quote dd { margin: 0; }
.quote .tot {
  padding-top: 6px; border-top: 1px dashed var(--line);
  font-weight: 600;
}
.quote .tot dd { color: var(--ok); }
.warn { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--muted); }
.warn strong { color: var(--danger); font-weight: 600; }
.confirm .acts { margin-top: 0; }
.confirm .acts .btn { flex: 1; }

@media (max-width: 720px) {
  .page { padding-top: 22px; padding-bottom: 40px; }
  h1 { font-size: 19px; }
  .note { font-size: 12px; margin: 0 0 16px; }
  .grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .item { padding: 6px; gap: 6px; }
  .body { gap: 6px; padding: 2px 0 2px; }
  strong { font-size: 12.5px; line-height: 1.35; }
  /* 半寬卡片只剩約 145px，卡名要再降一階才不會每一張都被截成「桃夕…」 */
  .sName { font-size: 11.5px; }
  .sVal { font-size: 10px; }
  .scrim { padding: 24px 7px 7px; gap: 4px; }
  .exp { font-size: 10.5px; }
  /* 半寬放不下並排按鈕。grid 的水平拉伸要用 justify-self（align-self 是垂直軸） */
  .acts { flex-direction: column; justify-self: stretch; gap: 6px; }
  .btn.sm { width: 100%; padding: 9px 6px; font-size: 12px; }

  /* 兩欄格線下每張卡內容區只剩約 115px，報價的標籤與數字並排會被折成四行。
     改成標籤在上、數字在下，數字本身禁止換行。 */
  .confirm { padding: 10px; }
  .quote div { flex-direction: column; align-items: flex-start; gap: 0; }
  .quote dt { font-size: 11px; }
  .quote dd { white-space: nowrap; font-size: 13px; }
  .quote .tot dd { font-size: 15px; }
}
</style>
