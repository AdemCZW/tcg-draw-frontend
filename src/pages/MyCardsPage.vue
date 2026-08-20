<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/lib/api'
import type { UserPrize } from '@/types/models'
import CardArt from '@/components/CardArt.vue'
import Tilt3D from '@/components/Tilt3D.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import { useWalletStore } from '@/stores/wallet'
import { recycleQuote, RECYCLE_RATE } from '@/lib/recycle'
import { track } from '@/lib/ga'
import { share, shareUrl } from '@/lib/social'
import { ApiError } from '@/lib/http'

const wallet = useWalletStore()
const prizes = ref<UserPrize[]>([])
onMounted(async () => { prizes.value = await api.myPrizes() })

/* ---- 收藏總覽 ----
   卡冊原本是一長串扁平清單，看不出「我收了多少、值多少」。
   對抽卡的人來說那是這一頁最想知道的事，所以拉到最上面。
   已回收的不計入市值 —— 卡已經交還平台了，還算進總值是騙自己。 */
const owned = computed(() => prizes.value.filter(p => p.status !== 'recycled'))
const totalValue = computed(() => owned.value.reduce((s, p) => s + p.card.refPrice, 0))
const bestCard = computed(() =>
  owned.value.reduce<UserPrize | null>((b, p) => (!b || p.card.refPrice > b.card.refPrice ? p : b), null))

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

const statusLabel: Record<UserPrize['status'], string> = {
  stashed: '寄存中',
  listed: '市場販售中',
  ship_requested: '待出貨',
  shipped: '已出貨',
  recycled: '已回收'
}

function requestShip(p: UserPrize) {
  track('click_ship_request')
  p.status = 'ship_requested'
  track('ship_request_success')
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

    <!-- 收藏總覽：這一頁最想被回答的問題就是「我收了多少、值多少」 -->
    <section v-if="owned.length" class="overview card">
      <div class="ovCell">
        <span class="ovLabel">持有</span>
        <strong class="ovNum mono">{{ owned.length }}</strong>
        <span class="ovUnit">張</span>
      </div>
      <div class="ovCell">
        <span class="ovLabel">市值合計</span>
        <strong class="ovNum mono val">{{ totalValue.toLocaleString() }}</strong>
      </div>
      <div class="ovBest" v-if="bestCard">
        <span class="ovLabel">最高價</span>
        <span class="ovBestRow">
          <TierBadge :tier="bestCard.tier" />
          <strong>{{ bestCard.card.name }}</strong>
        </span>
      </div>
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
        @click="tab = t.k"
      >{{ t.label }}<span class="tabN mono">{{ countOf(t.k) }}</span></button>
    </div>

    <div class="grid">
      <div v-for="p in shown" :key="p.id" class="item card" :class="{ dim: p.status === 'recycled' }">
        <Tilt3D :max="14">
          <CardArt :image="p.card.image" :alt="p.card.name" :tier="p.tier" :cert-no="p.card.certNo" :art-id="p.card.artId" :caption="`${p.card.setCode.toUpperCase()} · ${p.card.cardNo}`" />
        </Tilt3D>
        <div class="body">
          <div class="row"><TierBadge :tier="p.tier" /><span class="chip">{{ statusLabel[p.status] }}</span></div>
          <strong>{{ p.card.name }}</strong>
          <CertTag :card="p.card" />
          <span class="mono muted exp" v-if="p.status === 'stashed'">寄存至 {{ p.stashExpiresAt }}</span>

          <p v-if="justRecycled?.id === p.id" class="got" role="status">
            已入帳 <strong class="mono">+{{ justRecycled.points.toLocaleString() }}</strong> 點
          </p>

          <div class="acts" v-if="p.status === 'stashed'">
            <button class="btn primary sm" @click="requestShip(p)">申請出貨</button>
            <button
              class="btn sm" @click="askRecycle(p)"
              :disabled="!recycleQuote(p.card).eligible"
              :title="recycleQuote(p.card).reason"
            >
              回收 +{{ recycleQuote(p.card).points.toLocaleString() }} 點
            </button>
          </div>

          <!-- 回收確認：不可逆，所以把報價與提現限制一次講完 -->
          <div v-if="confirming === p.id && p.status === 'stashed'" class="confirm">
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
  </div>
</template>

<style scoped>
/* ---- 收藏總覽 ---- */
.overview {
  display: flex; align-items: center; gap: 26px; flex-wrap: wrap;
  padding: 16px 18px; margin: 14px 0 10px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent 70%),
    var(--surface);
}
.ovCell { display: grid; gap: 2px; }
.ovLabel { font-size: 11.5px; color: var(--faint); letter-spacing: .04em; }
.ovNum { font-size: 26px; font-weight: 800; letter-spacing: -.02em; line-height: 1.1; }
.ovNum.val { color: var(--gold, #d8b25a); }
.ovUnit { font-size: 11.5px; color: var(--muted); }
.ovBest { display: grid; gap: 4px; margin-left: auto; min-width: 0; }
.ovBestRow { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ovBestRow strong { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

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
  .overview { gap: 18px; padding: 14px; }
  .ovNum { font-size: 22px; }
  .ovBest { margin-left: 0; width: 100%; }
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
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
.item { padding: 12px; }
.item.dim { opacity: .5; }
.body { display: grid; gap: 8px; padding: 12px 4px 4px; justify-items: start; }
.row { display: flex; gap: 8px; align-items: center; }
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
  .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .item { padding: 8px; }
  .body { gap: 6px; padding: 9px 2px 2px; }
  .row { flex-wrap: wrap; gap: 5px; }
  strong { font-size: 12.5px; line-height: 1.35; }
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
