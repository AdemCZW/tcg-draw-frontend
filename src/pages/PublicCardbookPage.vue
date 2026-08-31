<script setup lang="ts">
/**
 * 公開卡冊（分享連結 /u/:slug）。
 *
 * 這頁刻意不掛 requiresAuth —— 分享連結的意義就是能貼進 LINE 群組給沒帳號的人看，
 * 整頁鎖登入等於讓分享功能失去意義。擋登入的是「提出交易」那一個動作：
 * 看卡冊跟出價是兩件事，前者是展示、後者有金錢意義。
 *
 * 這頁被轉貼出去之後，多數人是在 LINE 內建瀏覽器第一次看到 VaultDraw，
 * 所以上半部先回答「這是誰、收了幾張、有多少能談」，再進卡片格線。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { share, offers, type PublicCard } from '@/lib/social'
import { useKeyboardInset } from '@/composables/useKeyboardInset'
import { ApiError } from '@/lib/http'
import { useAuthStore } from '@/stores/auth'
import { useInfiniteList } from '@/composables/useInfiniteList'
import CardArt from '@/components/CardArt.vue'
import TierBadge from '@/components/TierBadge.vue'
import CertTag from '@/components/CertTag.vue'
import ListSentinel from '@/components/ListSentinel.vue'
import type { Tier } from '@/types/models'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

/* 卡冊本身是分批載入的（別人的收藏可能有幾百張，一次全塞進格線的是卡圖不是資料）。
   持有人與總覽只有第一批帶回來，所以存在列表之外 —— 它們不隨捲動改變。 */
type Owner = { name: string; handle: string }
type Summary = { count: number; tradable: number; totalValue: number }
const owner = ref<Owner | null>(null)
const summary = ref<Summary | null>(null)

/* 錯誤存兩份：message 給人看，code 決定畫面長什麼樣。
   這頁最常見的「錯誤」不是壞掉，而是連結還在群組裡流傳、但持有人已經關掉公開，
   那種情況要講成一句人話，不能丟一個通用的失敗訊息讓人以為是網站壞了。 */
const err = ref('')
const errCode = ref('')

const list = useInfiniteList<PublicCard>(async (cursor, signal) => {
  const slug = String(route.params.slug ?? '')
  const page = await share.view(slug, { cursor, signal })
  // 第一批才帶持有人與總覽；後續批次不動它們，免得換頁時頭部閃一下
  if (!cursor) { owner.value = page.owner; summary.value = page.summary ?? null }
  return { items: page.items, nextCursor: page.nextCursor }
})

/* 用 watch 而不是 onMounted：從一本卡冊的連結直接點到另一本時元件會被重用，
   onMounted 不會再跑一次，畫面會停在上一個人的卡片。
   reset() 會把游標歸零、清空既有卡片，並且讓上一本還在飛的請求作廢 ——
   沒有這一步，慢回來的舊卡冊會蓋到新卡冊上。 */
watch(() => route.params.slug, s => {
  if (typeof s !== 'string' || !s) return
  owner.value = null
  summary.value = null
  err.value = ''
  errCode.value = ''
  list.reset()
}, { immediate: true })

/* 列表的錯誤要分兩種看待：第一批失敗＝整頁打不開（連結失效、卡冊關閉），
   要用整頁的錯誤畫面把話講清楚；載到一半失敗只是這一批沒拿到，
   由 ListSentinel 給一顆重試鍵就好，已經看到的卡片不該消失。 */
watch(list.error, msg => {
  if (!msg || owner.value) return
  const e = list.lastError.value
  errCode.value = e instanceof ApiError ? e.code : ''
  err.value = msg
})

const loading = computed(() => list.loading.value && !list.ready.value)
const prizes = list.items
const tradableCount = computed(() => summary.value?.tradable ?? 0)
const totalValue = computed(() => summary.value?.totalValue ?? 0)
const totalCount = computed(() => summary.value?.count ?? prizes.value.length)
// 頭像沒有實際圖檔，用名字第一個字 + 由 handle 推出的色相，至少每個人長得不一樣
const initial = computed(() => (owner.value?.name ?? '?').trim().slice(0, 1) || '?')
const avatarHue = computed(() => hueOf(owner.value?.handle ?? ''))
// 模板 ref 名稱要跟這個變數一致，composable 才拿得到哨兵元素
const sentinelRef = list.sentinel

function hueOf(seed: string) {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/* API 的 tier 是字串（後端之後可能加新賞別），TierBadge 與 CardArt 吃的是列舉。
   不認得的一律當 D 賞畫出來 —— 一個沒見過的字串不該讓整頁掛掉。
   空值（null／undefined／''）例外：自己登記進卡冊的卡沒有賞別，
   那不是「沒見過的賞別」，要照實回 null（畫成「未分級」），
   當成 D 賞會把「沒有等級」講成「最低等級」。 */
const TIERS: Tier[] = ['A', 'B', 'C', 'D', 'LAST', 'BUST']
const asTier = (t: string | null | undefined): Tier | null =>
  (t ? (TIERS.includes(t as Tier) ? (t as Tier) : 'D') : null)


/* 公開卡冊沒有實拍圖欄位，CardArt 會依序拿 certNo（PSA 實拍）→ artId（官方卡圖），
   都查不到才落到漸層佔位卡。佔位色相由 id 推出來，否則整面格線會是同一個顏色。 */
const artSeed = (p: PublicCard) => `placeholder:${hueOf(p.id)}`

/* ---- 提出交易 ----
   出價要登入、看卡冊不用。沒登入就把人送去登入頁並用 redirect 記住現在這頁，
   登入完回得來 —— 不然使用者要重新去 LINE 裡把那條連結翻出來。
   redirect 的寫法跟 router/index.ts 的 beforeEach 守衛一致，是同一個約定。

   表單做成貼底的覆蓋層，不是就地展開。就地展開是錯的，而且是量得出來的錯：
   卡片格線一格只有 115px 寬，表單長在裡面會把整張卡往下推 300 多px，
   而頁面不會跟著捲 —— 實測在 393×852 上按中段的卡，「送出出價」落在
   視窗下方 56px、按最上面那張更糟（下方 106px），使用者填完金額之後
   畫面上沒有任何可以按的東西，只能以為「填完就自動送出了」。
   軟鍵盤再吃掉約 300px，就地展開在手機上沒有任何補救空間。

   覆蓋層跟 MyCardsPage 的出貨／回收面板是同一套（.sheetWrap / .sheet /
   .sheetFoot）：貼底、自己捲、動作列黏在面板下緣。兩處同一種模式，
   使用者只要學一次。CSS 是複製過來的 —— 這兩頁之外沒有第三個使用者，
   現在抽成共用元件只是多一層間接。 */
const offerFor = ref<PublicCard | null>(null)
/* string | number 不是隨手寫的：v-model 綁在 <input type="number"> 上時
   Vue 會自己把值轉成數字，清空時又給回空字串 —— 只標成 string 的話，
   任何字串方法在使用者打第一個字的當下就會炸掉（實測 .trim() 就是這樣壞的）。 */
const points = ref<string | number>('')
const message = ref('')
const sending = ref(false)
const offerErr = ref('')
const sentFor = ref<string | null>(null)

/* 送出鍵按不下去的理由。跟出貨面板同一個寫法：講出缺的是哪一項、
   連門檻一起講 —— 只說「還差 點數」的話，打了 0 還是灰的時候等於沒說。 */
const offerBlockWhy = computed(() => {
  if (sending.value) return ''
  const raw = String(points.value ?? '').trim()
  if (!raw) return '還差：要出多少點。'
  const pts = Math.floor(Number(raw))
  if (!Number.isFinite(pts) || pts <= 0) return '還差：點數要是大於 0 的整數。'
  return ''
})
const offerReady = computed(() => !offerBlockWhy.value)

function askOffer(p: PublicCard) {
  // 已上架的卡要走市場，不能私下出價
  if (!p.tradable) return
  if (!auth.isLoggedIn) {
    router.push({ name: 'landing', query: { redirect: route.fullPath } })
    return
  }
  offerErr.value = ''
  points.value = ''
  message.value = ''
  offerFor.value = p
  /* 覆蓋層是 aria-modal，焦點要進去，不然按 Tab 會走到它背後那些讀不到的東西。
     聚焦面板本身而不是金額框：在手機上直接聚焦輸入框會馬上叫出鍵盤，
     使用者還沒看清楚自己在對哪一張卡出價，畫面就先少了一半。 */
  void nextTick(() => document.getElementById('offerSheet')?.focus())
}

function closeOffer() { offerFor.value = null }

async function submitOffer() {
  const p = offerFor.value
  if (!p || sending.value) return
  const pts = Math.floor(Number(points.value))
  // 按鈕已經擋掉了，這裡是最後一道 —— 表單也可能被 Enter 送出
  if (!Number.isFinite(pts) || pts <= 0) { offerErr.value = '請先填寫要出多少點。'; return }
  sending.value = true
  offerErr.value = ''
  try {
    await offers.create(p.id, pts, message.value.trim())
    offerFor.value = null
    // 成功訊息不設定時器自動消失：出價是有金錢意義的動作，
    // 使用者要能確認「我剛剛真的送出去了」，並且從這裡走到收發匣
    sentFor.value = p.id
  } catch (e) {
    offerErr.value = e instanceof ApiError ? e.message : '送出失敗，請稍後再試。'
  } finally {
    sending.value = false
  }
}

function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && offerFor.value) closeOffer()
}

/* 軟鍵盤讓位（--kb）。原本這裡跟 MyCardsPage 各存一份，
   LoginMethods 加入之後搬進 composable —— 理由寫在 useKeyboardInset.ts。 */
useKeyboardInset()

onMounted(() => window.addEventListener('keydown', onEsc))
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
</script>

<template>
  <div class="container page">
    <p v-if="loading" class="state muted">載入卡冊中…</p>

    <!-- 錯誤畫面。兩種情況要分開講：連結本身不存在 vs 卡冊改成不公開 -->
    <section v-else-if="err" class="state card gone">
      <template v-if="errCode === 'CARDBOOK_PRIVATE'">
        <h1>這本卡冊已經改成不公開</h1>
        <p class="muted">
          持有人把卡冊關回私人了，連結還在，但內容已經看不到。
          如果是朋友傳給你的，可以請他重新打開分享，或給你一條新連結。
        </p>
      </template>
      <template v-else-if="errCode === 'NOT_FOUND'">
        <h1>找不到這個卡冊</h1>
        <p class="muted">
          這條分享連結不存在。可能是網址被截斷，或是持有人換過一組新連結 ——
          換新之後舊的會立刻失效。
        </p>
      </template>
      <template v-else>
        <h1>暫時打不開這本卡冊</h1>
        <p class="muted">{{ err }}</p>
      </template>
      <RouterLink :to="{ name: 'home' }" class="btn primary">看看有什麼可以抽</RouterLink>
    </section>

    <template v-else-if="owner">
      <!-- 持有人 + 總覽。這頁會被轉貼，第一眼要回答「這是誰、收了什麼」 -->
      <header class="hero card">
        <div class="who">
          <span class="avatar" :style="{ '--h': avatarHue }" aria-hidden="true">{{ initial }}</span>
          <div class="whoText">
            <h1>{{ owner.name }}</h1>
            <p class="handle mono">{{ owner.handle }}</p>
          </div>
        </div>

        <dl class="stats">
          <div>
            <!-- 整本卡冊的張數，不是已經捲出來的張數 —— 後者會隨著捲動一直長大 -->
            <dt>收藏</dt>
            <dd class="mono">{{ totalCount }}<span class="unit">張</span></dd>
          </div>
          <div v-if="totalValue > 0">
            <dt>市值合計</dt>
            <dd class="mono val">{{ totalValue.toLocaleString() }}</dd>
          </div>
          <div>
            <dt>可談交易</dt>
            <dd class="mono">{{ tradableCount }}<span class="unit">張</span></dd>
          </div>
        </dl>

        <p class="lead muted">
          這是 {{ owner.name }} 在 VaultDraw 的公開卡冊。
          <template v-if="tradableCount">
            標示「可提出交易」的卡片可以直接出價，出價要先登入；看卡冊不用。
          </template>
          <template v-else>
            目前沒有可以私下出價的卡片。
          </template>
        </p>
      </header>

      <p v-if="list.ready.value && !prizes.length && !list.error.value" class="state card">
        <span class="muted">這本卡冊目前還沒有卡片。</span>
      </p>

      <div class="grid">
        <article v-for="p in prizes" :key="p.id" class="item card">
          <CardArt
            :image="artSeed(p)"
            :alt="p.card.name"
            :tier="asTier(p.tier)"
            :cert-no="p.card.certNo"
            :art-id="p.card.artId"
          />
          <div class="body">
            <TierBadge :tier="asTier(p.tier)" />
            <strong class="name">{{ p.card.name ?? '未命名卡片' }}</strong>
            <!-- CertTag 判斷的是 grader/grade 而不是證號，所以公開卡冊拿不到
                 certNo 也不會被誤標成生卡（見 CertTag.vue 的說明） -->
            <CertTag :card="p.card" />
            <span v-if="p.card.value" class="price mono">參考價 {{ p.card.value.toLocaleString() }}</span>

            <!-- 送出後保留在卡片上，並給一個走到收發匣的出口 -->
            <p v-if="sentFor === p.id" class="sent" role="status">
              出價已送出，等對方回覆。
              <RouterLink v-if="auth.isLoggedIn" :to="{ name: 'offers' }" class="sentLink">查看交易邀約</RouterLink>
            </p>

            <button
              v-if="p.tradable"
              type="button" class="btn sm act primary"
              @click="askOffer(p)"
            >提出交易</button>
            <!-- 已上架的卡不給出價入口，而不是給一顆按不動的按鈕：
                 直接說清楚要去哪裡才買得到 -->
            <p v-else class="locked">市場販售中 · 這張要到市場買，不走私下出價</p>
          </div>
        </article>
      </div>

      <!-- 哨兵擺在格線外面當兄弟節點：塞進 grid 裡的話它會佔掉一格，
           而且 grid 子元素預設 min-width: auto，長錯誤訊息會把整欄撐開 -->
      <ListSentinel
        ref="sentinelRef"
        :loading="list.loading.value"
        :done="list.done.value"
        :error="list.error.value"
        :manual="list.manual.value"
        :empty="!prizes.length"
        done-text="已經是全部的卡片了"
        @retry="list.retry()"
        @more="list.load()"
      />
    </template>

    <!-- 出價面板。Teleport 到 body 不是整潔問題：換頁轉場會在頁面容器上加
         transform，而**祖先只要有 transform，position: fixed 的定位基準就會
         變成那個祖先而不是視窗**（docs/HANDOFF.md 2.2）——
         面板會被推出畫面外並被裁掉。MyCardsPage 的出貨面板踩過這一顆。
         關法三種：點遮罩、取消鍵、Esc。 -->
    <Teleport to="body">
      <div v-if="offerFor" class="sheetWrap" @click.self="closeOffer">
        <form
          id="offerSheet" class="sheet card hasFoot"
          role="dialog" aria-modal="true" aria-label="提出交易" tabindex="-1"
          @submit.prevent="submitOffer"
        >
          <h2>提出交易</h2>
          <!-- 對哪一張卡出價要寫在面板裡：面板蓋住了卡片格線，
               不寫的話使用者要關掉面板才確認得了自己選的是哪一張 -->
          <p class="muted fine">{{ offerFor.card.name ?? '未命名卡片' }}<span
            v-if="offerFor.card.value" class="fyi">參考價 {{ offerFor.card.value.toLocaleString() }}</span></p>

          <label class="fld">
            <span class="lb">你要出多少點</span>
            <input
              v-model="points" type="number" min="1" step="1" inputmode="numeric"
              class="in mono" placeholder="例如 12000"
            />
          </label>
          <label class="fld">
            <span class="lb">留言（可不填）</span>
            <textarea v-model="message" class="in ta" rows="2" maxlength="120" placeholder="想說的話，例如願意加卡交換"></textarea>
          </label>
          <p class="hint">送出後對方會收到通知，接受或婉拒都會再通知你。</p>

          <!-- 動作列黏在面板下緣。就地展開的版本把送出鍵推到視窗下方 56–106px，
               黏底之後不管視窗多矮、鍵盤彈不彈，它都在同一個位置 -->
          <div class="sheetFoot">
            <p v-if="offerErr" class="errLine" role="alert">{{ offerErr }}</p>
            <!-- 灰按鈕一定要說得出理由，跟出貨面板同一個位置、同一個寫法 -->
            <p v-if="offerBlockWhy" id="offerWhy" class="blockWhy" role="status">{{ offerBlockWhy }}</p>
            <div class="acts">
              <button
                type="submit" class="btn primary sm"
                :disabled="!offerReady || sending"
                :aria-describedby="offerBlockWhy ? 'offerWhy' : undefined"
              >{{ sending ? '送出中…' : '送出出價' }}</button>
              <button type="button" class="btn sm" :disabled="sending" @click="closeOffer">取消</button>
            </div>
          </div>
        </form>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page { padding-top: 32px; padding-bottom: 72px; }

.state {
  display: grid; gap: 12px; justify-items: center; text-align: center;
  padding: 44px 24px;
}
.state h1 { font-size: 20px; margin: 0; }
.state p { margin: 0; font-size: 13.5px; line-height: 1.7; max-width: 34em; }
.gone { margin-top: 24px; }

/* ---- 持有人 ---- */
.hero {
  padding: 20px; margin-bottom: 18px;
  display: grid; gap: 16px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--accent) 9%, transparent), transparent 72%),
    var(--surface);
}
.who { display: flex; align-items: center; gap: 13px; min-width: 0; }
.avatar {
  flex: none; width: 52px; height: 52px; border-radius: 50%;
  display: grid; place-items: center;
  font-size: 22px; font-weight: 700; color: var(--ink);
  background:
    radial-gradient(120% 120% at 30% 15%, hsl(var(--h) 62% 42%), transparent 70%),
    hsl(calc(var(--h) + 40) 45% 26%);
  box-shadow: inset 0 0 0 1px var(--line);
}
.whoText { min-width: 0; }
h1 { font-size: 21px; margin: 0; line-height: 1.25; overflow-wrap: anywhere; }
.handle { font-size: 12px; color: var(--faint); margin: 3px 0 0; letter-spacing: .04em; }

.stats { display: flex; gap: 28px; flex-wrap: wrap; margin: 0; }
.stats dt { font-size: 11.5px; color: var(--faint); letter-spacing: .04em; }
.stats dd { margin: 2px 0 0; font-size: 24px; font-weight: 800; letter-spacing: -.02em; line-height: 1.1; }
.stats dd.val { color: var(--gold); }
.unit { font-size: 11.5px; font-weight: 500; color: var(--muted); margin-left: 3px; }
.lead { margin: 0; font-size: 12.5px; line-height: 1.7; }

/* ---- 卡片格線 ---- */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
.item { padding: 12px; }
.body { display: grid; gap: 8px; padding: 12px 4px 4px; justify-items: start; }
.name { font-size: 14px; line-height: 1.35; }
.price { font-size: 11.5px; color: var(--gold-deep); }
.act { justify-self: stretch; margin-top: 2px; }
.btn.sm { padding: 7px 12px; font-size: 12.5px; }

.locked {
  margin: 2px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--faint);
}
.sent {
  margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--ok); font-weight: 600;
}
.sentLink { color: var(--ok); text-decoration: underline; }

/* ---- 出價面板 ----
   跟 MyCardsPage 的出貨／回收覆蓋層同一套視覺與行為：貼底、自己捲、
   動作列黏在面板下緣。這裡是複製過去的一份，兩處要一起改。
   （目前只有這兩個使用者，抽成共用元件只是多一層間接。） */
.sheetWrap {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: flex-end; justify-content: center;
  background: var(--scrim);
  /* 下緣讓給軟鍵盤（--kb 由 syncKeyboardInset() 寫進根節點，預設 0） */
  bottom: var(--kb, 0px);
}
.sheet {
  width: 100%; max-width: min(520px, 100vw);
  /* 保險絲：內容壓不住時讓它自己橫捲，不要把面板撐出視窗外被裁掉 */
  overflow-x: hidden;
  /* 88% 而不是 88dvh：.sheetWrap 的高度已經扣掉鍵盤了，
     dvh 量的是整個視窗，鍵盤彈出時算出來的面板會比放得下的還高 */
  max-height: min(88%, 720px); overflow-y: auto; overscroll-behavior: contain;
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(18px + var(--safe-b, 0px));
  display: grid; gap: 10px; align-content: start; min-width: 0;
}
.sheet:focus-visible { outline: none; }
.sheet h2 { font-size: 17px; margin: 0; }
.sheet .fine { margin: -4px 0 2px; font-size: 12.5px; line-height: 1.5; }
.fyi { margin-left: 8px; font-size: 11.5px; color: var(--faint); }

/* 底部內距搬進 .sheetFoot，sticky 的 bottom: 0 才貼得到面板真正的下緣，
   不然會浮在 18px 內距上面、露出一條會捲動的縫 */
.sheet.hasFoot { padding-bottom: 0; }
.sheetFoot {
  position: sticky; bottom: 0; z-index: 1;
  /* 負的左右外距讓它撐滿面板寬度，那條分隔線才切得斷、
     看得出「上面會捲、下面不會」 */
  margin: 2px -16px 0;
  padding: 10px 16px calc(12px + var(--safe-b, 0px));
  border-top: 1px solid var(--line);
  background: var(--surface);
  display: grid; gap: 8px; min-width: 0;
}
/* 灰按鈕的理由。用 --warn-ink 不用 --danger：使用者沒做錯事，
   只是還沒填完，紅字會讀成「出錯了」 */
.blockWhy {
  margin: 0; min-width: 0;
  font-size: 12.5px; line-height: 1.55; color: var(--warn-ink);
  overflow-wrap: anywhere;
}
.fld { display: grid; gap: 5px; min-width: 0; }
.lb { font-size: 11.5px; color: var(--muted); }
.in {
  width: 100%; padding: 10px 12px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--field); color: var(--ink);
  font-size: 15px; /* 小於 16px 時 iOS Safari 會自動放大整頁 */
  font-family: inherit;
}
.in.mono { font-family: var(--font-mono); }
.in:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ta { resize: vertical; line-height: 1.5; }
.hint { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--faint); }
.errLine { margin: 0; font-size: 12px; color: var(--danger); }
.acts { display: flex; gap: 8px; }
.acts .btn { flex: 1; }

@media (max-width: 720px) {
  .page { padding-top: 20px; padding-bottom: 40px; }
  .hero { padding: 16px; gap: 13px; }
  .avatar { width: 44px; height: 44px; font-size: 19px; }
  h1 { font-size: 18px; }
  .stats { gap: 18px; }
  .stats dd { font-size: 20px; }
  /* 兩欄格線：每張卡的內容區只剩約 115px，按鈕一律撐滿、不並排。
     minmax(0, 1fr) 不是可有可無：1fr 等同 minmax(auto, 1fr)，
     只要某一格的內容固有寬度超過軌道，那一格就會被撐開、隔壁被擠扁
     （HANDOFF 2.1） */
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .item { padding: 8px; min-width: 0; }
  .body { gap: 6px; padding: 9px 2px 2px; min-width: 0; }
  .name { font-size: 12.5px; }
  .btn.sm { width: 100%; padding: 9px 6px; font-size: 12px; }
  /* 面板的寬度是整個視窗，不是 115px 的卡片格 —— 上面那條為了塞進格子
     而降到 12px 的字級不該跟進來，而且這兩顆要吃滿 44px 觸控門檻 */
  .sheet .btn.sm { padding: 11px 12px; font-size: 13.5px; min-height: 44px; }
  .acts { flex-direction: column; }
}
</style>
