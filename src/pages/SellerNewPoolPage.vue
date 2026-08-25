<script setup lang="ts">
/*
 * 賣家開池。
 *
 * 核心是「上架前就把經濟算清楚」，而算的是**保底回饋率**
 * ＝ Σ(宣告買回價 × 數量) ÷ 票收，不是賣家標示的市值。
 * 分子換成「他有義務付出去的錢」之後，這個數字不需要外部價格資料就是誠實的
 * —— 灌高等於承諾多賠（換分子的完整理由見 src/shared/economics.ts）。
 *
 * 買回價**按賞別填**，一個賞別一個絕對金額（A 賞 3000、D 賞 120 這樣）。
 *
 * 為什麼不是比率、也不是每張卡一個：
 *   - 比率要有基準，而唯一的基準是賣家自填的市值 —— 那是循環論證，
 *     正是這次要擺脫的東西。
 *   - 每張卡一格在資料上是對的（存進資料庫的確實是每個獎品的絕對金額），
 *     但要賣家在一個 250 籤的池上填 250 次不現實。
 *   - 同一個賞別裡的卡價值本來就相近 —— 那正是分賞別的意義。
 *
 * 某一張在該賞別裡特別貴的時候可以**單獨覆寫**，那是例外不是常態，
 * 所以放在展開的細節裡，不佔主要版面。
 *
 * 「參考價」那一欄還在但**變成選填**：它已經不參與任何計算，
 * 強迫賣家填一個沒有外部依據的數字只會製造一個看起來像官方行情的假資料。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSellerStore } from '@/stores/sellers'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/http'
import { MOCK } from '@/lib/config'
import { usePoolStore } from '@/stores/pools'
import { computeEconomics } from '@/lib/economics'
import { BUYBACK_MIN, BUYBACK_MAX } from '@/lib/recycle'
import { buybackValid } from '@/shared/recycle'
import { FLOOR_RATIO_LABEL, FLOOR_RATIO_MEANING } from '@/shared/economics'
import type { PoolMode, Tier } from '@/types/models'
import PoolModeBadge from '@/components/PoolModeBadge.vue'

const router = useRouter()
const sellers = useSellerStore()
const pools = usePoolStore()
sellers.ensureLoaded()
pools.ensureLoaded()

const me = computed(() => sellers.me)

/* ---- 賣家身分 ----
   這一頁原本只有一段「尚未通過身分驗證，請完成實名與金流帳戶驗證」加一顆
   「回首頁」—— 但平台上根本沒有申請的地方，sellers 資料列只有 seed 產得出來。
   等於叫使用者去做一件做不到的事。現在真的接上 /v1/seller/apply。

   MOCK 模式仍然讀 sellers store：那是展示用的假資料，把它換成「你不是賣家」
   會讓沒有後端時連開池表單都看不到。 */
const remote = ref<{ seller: { tier: string } | null; verification: { status: string; note: string | null } | null } | null>(null)
const loadingSeller = ref(!MOCK)
onMounted(async () => {
  if (MOCK) return
  try { remote.value = await api.sellerStatus() }
  catch { remote.value = { seller: null, verification: null } }
  finally { loadingSeller.value = false }
})

const tier = computed(() => MOCK ? (me.value?.tier ?? null) : (remote.value?.seller?.tier ?? null))
const canList = computed(() => !!tier.value && tier.value !== 'pending')
const isPending = computed(() => tier.value === 'pending')

/* ---- 申請成為賣家 ---- */
const apply = reactive({ name: '', origin: 'personal' as 'personal' | 'merchant', bio: '' })
const applyBusy = ref(false)
const applyErr = ref('')
const applyOk = ref(false)
const canApply = computed(() => apply.name.trim().length >= 2 && !applyBusy.value)

async function submitApply() {
  if (!canApply.value) return
  applyBusy.value = true
  applyErr.value = ''
  try {
    await api.applySeller({ name: apply.name.trim(), origin: apply.origin, bio: apply.bio.trim() })
    remote.value = await api.sellerStatus()
    applyOk.value = true
  } catch (e) {
    applyErr.value = e instanceof ApiError ? e.message : '申請失敗，請稍後再試'
  } finally {
    applyBusy.value = false
  }
}

/* 玩法。目前只有 muteki（無敵賞）是真的能用的：pools-service.ts 完全沒有讀
   pools.mode，抽卡一律照籤位發獎 —— 那就是無敵賞的規則。所以
     - classic / shitei 開得出來的話，賣的是後端不存在的規則（經典賞宣傳的
       「抽走最後一籤額外得最後賞」一行都沒有），那是對買家的不實陳述
   （連莊／競標原本也列在這裡，已經整組移除 —— 它們後端零實作，前端卻有完整
   的頁面會把人導進去，留著只是把死路做得更像活路。）
   讓賣家選得到等於讓他開一個對玩家壞掉的池，所以先鎖住，但仍然列出來 ——
   藏起來的話賣家不會知道之後會有這些玩法。後端補上模式邏輯後把 enabled 打開即可
   （同時要放寬建池 API 的 enum 與資料庫的 check，見 migration 016）。
   muteki 排在第一個：它是現在唯一開得出來的，預設選項不該還要往下找。 */
const MODES: { m: PoolMode; enabled: boolean }[] = [
  { m: 'muteki', enabled: true },
  { m: 'classic', enabled: false },
  { m: 'shitei', enabled: false }
]
const TIERS: Tier[] = ['A', 'B', 'C', 'D', 'LAST', 'BUST']

const form = reactive({
  title: '',
  mode: 'muteki' as PoolMode,
  ticketPrice: 300,
  shiteiTier: 'A' as Tier,
  /* 買回價的賞別預設。一個賞別一個絕對金額 —— 沒有基準、沒有比率。
     預設值刻意讓保底回饋率落在合理區間，賣家一開表單看到的就是一個過得了的池；
     留空的話第一眼看到的是一個被擋下的表單。
     只有實際用到的賞別需要有值（下面的 tiersUsed）。 */
  tierBuyback: { A: 4800, B: 1500, C: 500, D: 36, LAST: 6000, BUST: 36 } as Record<Tier, number>,
  /* buyback 這一格是**覆寫**：null = 照這個賞別的預設走。
     不預先幫他從參考價算 —— 那會讓「宣告」變成「系統推導」，
     而整個改動的重點就是這個數字必須是他自己按下去的。 */
  prizes: [
    { tier: 'A' as Tier, name: '', qty: 1, unitValue: 8000 as number | null, buyback: null as number | null },
    { tier: 'D' as Tier, name: '', qty: 59, unitValue: 60 as number | null, buyback: null as number | null }
  ]
})

/** 這個池實際用到哪幾個賞別。沒用到的賞別不必填買回價，也不該擋住送出 */
const tiersUsed = computed(() => [...new Set(form.prizes.map(p => p.tier))])

/** 解析成每個獎品的絕對金額：個別覆寫優先，否則吃該賞別的預設 */
const resolved = computed(() =>
  form.prizes.map(p => p.buyback ?? form.tierBuyback[p.tier] ?? 0))

/** 這個池最差的賞別保底買回多少。池頁那句人話文案就是這個數字 */
const worstBuyback = computed(() => {
  const vs = resolved.value.filter(v => v > 0)
  return vs.length ? Math.min(...vs) : 0
})

const busy = ref(false)
const error = ref('')

const econ = computed(() =>
  computeEconomics(
    form.mode,
    form.prizes.map((p, i) => ({ tier: p.tier, qty: p.qty, unitValue: p.unitValue ?? 0, buyback: resolved.value[i]! })),
    form.ticketPrice,
    { shiteiTier: form.shiteiTier }
  )
)
const blocked = computed(() => econ.value.verdict === 'mint' || econ.value.verdict === 'predatory')
const nameMissing = computed(() => form.prizes.some(p => p.tier !== 'BUST' && !p.name.trim()))
/* 解析後每一項都要落在上下限內。爆賞也要 —— 爆賞發的是保底卡，
   那張卡一樣會被抽到、一樣可以被買回，沒有理由把它排除在承諾之外。
   檢查解析後的值而不是輸入格：漏填的賞別預設會解析成 0，一樣被這裡擋下。 */
const buybackBad = computed(() => resolved.value.some(v => !buybackValid(v)))
const valid = computed(() =>
  !!form.title.trim() && form.ticketPrice > 0 && econ.value.seatCount > 0 &&
  !nameMissing.value && !buybackBad.value && !blocked.value
)

function addPrize() {
  form.prizes.push({ tier: 'C', name: '', qty: 1, unitValue: 500, buyback: null })
}
function removePrize(i: number) {
  if (form.prizes.length > 1) form.prizes.splice(i, 1)
}

async function submit() {
  if (!valid.value || !me.value) return
  error.value = ''
  busy.value = true
  try {
    const pool = await pools.createPool({
      sellerId: me.value.id,
      title: form.title.trim(),
      mode: form.mode,
      ticketPrice: form.ticketPrice,
      shiteiTier: form.mode === 'shitei' ? form.shiteiTier : undefined,
      /* 送出去的是**解析後的絕對金額**，不是「賞別預設 + 覆寫」這組規則。
         存規則的話，事後改一次賞別預設就等於回頭改寫已經公布的承諾。 */
      prizes: form.prizes.map((p, i) => ({
        tier: p.tier, name: p.name.trim() || '爆賞', qty: p.qty,
        unitValue: p.unitValue, buyback: resolved.value[i]!
      }))
    })
    router.push({ name: 'pool', params: { id: pool.id } })
  } catch {
    error.value = '開池失敗，請稍後再試'
  } finally { busy.value = false }
}
</script>

<template>
  <div class="container page">
    <h1 class="display">開一個新的池</h1>

    <div v-if="loadingSeller" class="gate card"><p class="muted">確認賣家身分中…</p></div>

    <!-- 審核中：講清楚在等什麼、通過之前能做什麼，不要只寫「審核中」讓人乾等 -->
    <div v-else-if="isPending" class="gate card">
      <p class="big">申請已送出，等待審核</p>
      <p class="muted">
        平台不開放匿名上架，這是保護玩家不被詐騙的第一道防線。
        審核通過後這一頁就會變成開池表單，通過時你會收到站內通知。
      </p>
      <p v-if="remote?.verification?.status === 'rejected'" class="muted warnLine">
        上次送出的證件被退回{{ remote.verification.note ? '：' + remote.verification.note : '' }}。
        補件後會重新審核。
      </p>
      <RouterLink :to="{ name: 'home' }" class="btn">先去逛逛</RouterLink>
    </div>

    <!-- 還不是賣家：直接給申請表，不要給死路。
         不沿用 .gate —— 那個 class 是 text-align: center + justify-items: center，
         給一段說明文字用剛好，塞進表單就變成標籤置中、輸入框不撐開、
         身分那兩顆擠在中間看不出是可以選的。表單要自己的排版。 -->
    <div v-else-if="!canList" class="apply card">
      <header class="applyHead">
        <h2>先申請成為賣家</h2>
        <p>開池等於向別人收錢，平台要知道收錢的是誰。送出後由平台審核，通過才能開池。</p>
      </header>

      <p v-if="applyOk" class="okLine">申請已送出，審核結果會用站內通知告訴你。</p>

      <template v-else>
        <label class="af">
          <span class="afLabel">賣家名稱<i>必填</i></span>
          <input v-model="apply.name" type="text" placeholder="會顯示在池卡與訂單上" maxlength="30">
          <span class="afHint">兩個字以上。之後買家在市場與訂單上看到的就是這個名字。</span>
        </label>

        <div class="af">
          <span class="afLabel">身分</span>
          <!-- 分段控制：兩顆等寬、選中的填色。原本是兩顆小膠囊擠在置中的一行，
               看起來像兩個標籤而不是一組互斥選項 -->
          <div class="seg" role="radiogroup" aria-label="身分">
            <button
              type="button" role="radio" :aria-checked="apply.origin === 'personal'"
              class="segBtn" :class="{ on: apply.origin === 'personal' }"
              @click="apply.origin = 'personal'"
            >
              個人
              <small>自己的收藏</small>
            </button>
            <button
              type="button" role="radio" :aria-checked="apply.origin === 'merchant'"
              class="segBtn" :class="{ on: apply.origin === 'merchant' }"
              @click="apply.origin = 'merchant'"
            >
              商家
              <small>有店面或營業登記</small>
            </button>
          </div>
        </div>

        <label class="af">
          <span class="afLabel">簡介<i class="opt">選填</i></span>
          <input v-model="apply.bio" type="text" placeholder="例：主營朱紫系列鑑定卡" maxlength="60">
        </label>

        <p v-if="applyErr" class="warnLine">{{ applyErr }}</p>

        <button type="button" class="btn primary applyBtn" :disabled="!canApply" @click="submitApply">
          {{ applyBusy ? '送出中…' : '送出申請' }}
        </button>
        <!-- 按鈕變灰時要講為什麼。使用者看到一顆按不動的鈕，第一個念頭是「壞了」 -->
        <p v-if="!canApply && !applyBusy" class="afWhy">填好賣家名稱才能送出。</p>
      </template>
    </div>

    <form v-else class="layout" @submit.prevent="submit">
      <div class="main">
        <section class="card block">
          <h2>基本設定</h2>
          <label class="field">
            <span>池名稱</span>
            <input v-model="form.title" type="text" placeholder="例如：朱紫 SAR 精選 第 2 彈" />
          </label>

          <span class="field-label">玩法</span>
          <p class="modeNote">目前開放無敵賞。經典賞與指定賞還在做，開放後會在這裡解鎖。</p>
          <div class="modes">
            <button
              v-for="o in MODES" :key="o.m" type="button"
              class="mode-btn" :class="{ on: form.mode === o.m, off: !o.enabled }"
              :disabled="!o.enabled"
              :title="o.enabled ? '' : '這個玩法還沒開放'"
              @click="o.enabled && (form.mode = o.m)"
            ><PoolModeBadge :mode="o.m" /></button>
          </div>
          <PoolModeBadge :mode="form.mode" detailed class="mode-rule" />

          <div class="row2">
            <label class="field">
              <span>每抽價格（點）</span>
              <input v-model.number="form.ticketPrice" type="number" min="1" step="10" />
            </label>
            <label v-if="form.mode === 'shitei'" class="field">
              <span>指定賞賞別</span>
              <select v-model="form.shiteiTier">
                <option v-for="t in ['A','B','C','D']" :key="t" :value="t">{{ t }} 賞</option>
              </select>
            </label>
          </div>
        </section>

        <section class="card block">
          <div class="block-head">
            <h2>獎項配置</h2>
            <span class="chip">共 {{ econ.seatCount }} 籤</span>
          </div>

          <!-- 買回價：一個賞別一個絕對金額。
               這一塊放在獎項表**之前** —— 它是主要的填法，逐項覆寫才是例外。 -->
          <section class="tierBuy">
            <h3>買回價（依賞別）</h3>
            <p class="tbNote muted">
              你答應照這個價把卡買回來的金額，<strong>開賣前鎖死、開賣後改不了</strong>
              （它被寫進公平性承諾的雜湊裡）。玩家按下接受時，這筆錢直接從你這個池的保留額出。
              同一個賞別的卡價值本來就相近，所以填一個絕對金額就好，<strong>不需要任何基準</strong>。
            </p>
            <div class="tbGrid">
              <label v-for="t in tiersUsed" :key="t" class="tbCell">
                <span class="tbLbl">{{ t === 'BUST' ? '爆賞' : t === 'LAST' ? '最後賞' : t + ' 賞' }}</span>
                <input
                  v-model.number="form.tierBuyback[t]" type="number"
                  :min="BUYBACK_MIN" :max="BUYBACK_MAX" step="10"
                  :class="{ missing: !buybackValid(form.tierBuyback[t] ?? 0) }"
                />
              </label>
            </div>
            <p class="tbLine">
              買家會看到：<strong class="mono">{{ form.ticketPrice.toLocaleString() }} 點一抽，最差的賞別保底買回 {{ worstBuyback.toLocaleString() }} 點</strong>
            </p>
          </section>

          <div class="prize-head">
            <span>賞別</span><span>卡片名稱</span><span>數量</span><span>參考價/張</span><span>買回價/張</span><span></span>
          </div>
          <div v-for="(p, i) in form.prizes" :key="i" class="prize-row">
            <select v-model="p.tier" aria-label="賞別">
              <option v-for="t in TIERS" :key="t" :value="t">{{ t === 'BUST' ? '爆賞' : t === 'LAST' ? '最後賞' : t + ' 賞' }}</option>
            </select>
            <input
              v-model="p.name" type="text"
              :placeholder="p.tier === 'BUST' ? '（爆賞不需卡片）' : '卡片名稱'"
              :disabled="p.tier === 'BUST'"
              :class="{ missing: p.tier !== 'BUST' && !p.name.trim() }"
            />
            <!-- 手機把表頭藏起來了（欄寬不夠），所以每一格自己要說得出自己是什麼。
                 少了 placeholder 的話手機上是三個一模一樣的數字框。 -->
            <input v-model.number="p.qty" type="number" min="1" aria-label="數量" placeholder="數量" />
            <!-- 參考價選填：空著就是「賣家沒有標示」，畫面上顯示「未標示」。
                 不要退回成 0 —— 0 讀起來是「這張卡不值錢」。 -->
            <input
              v-model.number="p.unitValue" type="number" min="0" step="10"
              :disabled="p.tier === 'BUST'" aria-label="參考價（選填）" placeholder="參考價（選填）"
            />
            <!-- 這一格是**覆寫**，不是必填：空著就照該賞別的預設走。
                 placeholder 直接顯示會套用的金額，讓「空著會發生什麼」看得見。 -->
            <input
              v-model.number="p.buyback" type="number" :min="BUYBACK_MIN" :max="BUYBACK_MAX" step="10"
              aria-label="買回價（留空照賞別預設）"
              :placeholder="(form.tierBuyback[p.tier] ?? 0).toLocaleString()"
              :class="{ missing: !buybackValid(resolved[i] ?? 0), over: p.buyback != null }"
            />
            <button type="button" class="del" :disabled="form.prizes.length <= 1" @click="removePrize(i)" aria-label="刪除這列">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <button type="button" class="btn add" @click="addPrize">＋ 新增賞別</button>

          <!-- 兩欄的意義完全不同，而且很容易被當成同一件事。講清楚 -->
          <p class="hint muted twoCols">
            <strong>參考價</strong>是你自己標示的市場行情，<strong>選填</strong>，
            只顯示給買家看、<strong>不構成承諾</strong>，也不參與任何金額計算。
            空著的話買家看到的是「未標示」。<br>
            <strong>買回價</strong>那一格是<strong>覆寫</strong>：空著就照上面該賞別的金額走，
            只有某一張在同賞別裡特別貴的時候才需要單獨填。
            每張 {{ BUYBACK_MIN.toLocaleString() }} 點起跳。
          </p>

          <p v-if="form.mode === 'muteki'" class="hint muted">
            無敵賞的「最後賞」就是籤池裡的一張獎品，它跟其他賞別一樣佔一個籤位，
            所有賞別的數量加總必須剛好等於總籤數。抽走最後一籤沒有額外贈獎。
          </p>
          <p v-else-if="form.mode === 'classic' || form.mode === 'shitei'" class="hint muted">
            「最後賞」是額外贈獎，不佔籤位；其餘賞別的數量加總就是總籤數。
          </p>
        </section>
      </div>

      <aside class="side">
        <div class="card econ" :class="econ.verdict">
          <h2>經濟試算</h2>
          <div class="ratio">
            <span class="mono big-num">{{ econ.ratio.toFixed(1) }}%</span>
            <span class="muted lbl">{{ FLOOR_RATIO_LABEL }}</span>
          </div>
          <p class="verdict">{{ econ.message }}</p>
          <p class="meaning muted">{{ FLOOR_RATIO_MEANING }}</p>

          <dl class="figures">
            <div><dt>買回價總額</dt><dd class="mono">{{ econ.floorValue.toLocaleString() }}</dd></div>
            <div><dt>預期票收</dt><dd class="mono">{{ econ.revenue.toLocaleString() }}</dd></div>
          </dl>
        </div>

        <div class="card fair">
          <h2>公平性</h2>
          <p class="muted">
            按下開池時，系統會把 {{ econ.seatCount }} 支籤的順序預先洗好並封存，
            公布 SHA-256 commit hash。完抽後公開種子，任何人都能驗算。
            <strong>你自己也無法在開賣後更動籤序。</strong>
          </p>
        </div>

        <p v-if="nameMissing" class="err">請填寫所有卡片名稱</p>
        <p v-if="buybackBad" class="err">
          每個用到的賞別都要有買回價，範圍 {{ BUYBACK_MIN.toLocaleString() }} – {{ BUYBACK_MAX.toLocaleString() }} 點
        </p>
        <p v-if="blocked" class="err">{{ FLOOR_RATIO_LABEL }}不合格，無法開池</p>
        <p v-if="error" class="err">{{ error }}</p>
        <button type="submit" class="btn primary go" :disabled="!valid || busy">
          {{ busy ? '封存籤序中…' : '開池上架' }}
        </button>
      </aside>
    </form>
  </div>
</template>

<style scoped>
/* ---- 賣家申請表 ---- */
.apply { padding: 20px; max-width: 460px; margin: 0 auto; }
.applyHead { margin-bottom: 18px; }
.applyHead h2 { font-size: 18px; margin: 0 0 6px; }
.applyHead p { margin: 0; font-size: 13px; line-height: 1.75; color: var(--muted); }

.af { display: block; margin-bottom: 16px; }
.afLabel {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; font-weight: 600; color: var(--ink); margin-bottom: 6px;
}
.afLabel i {
  font-style: normal; font-size: 10.5px; font-weight: 700;
  padding: 1px 6px; border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent);
}
.afLabel i.opt { background: var(--surface-3); color: var(--muted); }
/* 輸入框撐滿。這一頁其他地方的 input 是在窄側欄裡，所以沒設寬度 —— 這裡要自己給 */
.af input { width: 100%; padding: 11px 12px; font-size: 16px; border-radius: 10px; }
.afHint { display: block; margin-top: 5px; font-size: 11.5px; line-height: 1.6; color: var(--faint); }

.seg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.segBtn {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 11px 8px; min-width: 0;
  border: 1px solid var(--line); border-radius: 12px;
  background: var(--surface-2); color: var(--muted);
  font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
}
.segBtn small { font-size: 10.5px; font-weight: 400; }
.segBtn.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-color: var(--accent); color: var(--accent);
}

.applyBtn { width: 100%; margin-top: 4px; }
.afWhy { margin: 8px 0 0; font-size: 12px; color: var(--muted); text-align: center; }
.okLine { font-size: 13.5px; line-height: 1.75; color: var(--ok); margin: 0; }

.modeNote { font-size: 12.5px; line-height: 1.65; color: var(--muted); margin: 0 0 8px; }
.mode-btn.off { opacity: .38; cursor: not-allowed; }

.originRow { display: flex; gap: 8px; margin-bottom: 12px; }
.warnLine { font-size: 13px; line-height: 1.7; color: #fcd34d; margin: 8px 0; }
.okLine { font-size: 13.5px; line-height: 1.7; margin: 10px 0 0; }

.page { padding-top: 28px; padding-bottom: 72px; }
h1 { font-size: 28px; margin: 0 0 20px; }
h2 { font-size: 15px; margin: 0 0 12px; }
.gate { padding: 30px; text-align: center; display: grid; gap: 12px; justify-items: center; }
.gate .big { font-size: 19px; font-weight: 600; margin: 0; }
.gate p { max-width: 460px; margin: 0; }

.layout { display: grid; grid-template-columns: 1fr 300px; gap: 22px; align-items: start; }
.block { padding: 18px; }
.block + .block { margin-top: 18px; }
.block-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.block-head h2 { margin: 0; }

.field { display: grid; gap: 4px; margin-bottom: 14px; }
.field > span, .field-label { font-size: 12px; font-weight: 600; color: var(--muted); }
.field-label { display: block; margin-bottom: 6px; }
input, select {
  padding: 8px 10px; font-size: 14px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface); color: var(--ink);
  min-width: 0;
}
input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
input:disabled { background: var(--surface-2); color: var(--faint); }
input.missing { border-color: var(--danger); }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.modes { display: flex; flex-wrap: wrap; gap: 8px; }
.mode-btn {
  padding: 3px; border: 2px solid transparent; border-radius: 999px;
  background: none; opacity: .5;
}
.mode-btn.on { opacity: 1; border-color: var(--line); background: var(--accent-wash); }
.mode-rule { display: block; margin: 10px 0 16px; }

.prize-head, .prize-row {
  /* minmax(0, …) 不是 1fr：grid 子元素預設 min-width: auto，
     長卡名會把整列撐爆（見 docs/HANDOFF.md 2.1） */
  display: grid; grid-template-columns: 88px minmax(0, 1fr) 60px 84px 84px 32px;
  gap: 8px; align-items: center;
}
.prize-head { font-size: 11.5px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
.prize-row { margin-bottom: 8px; }
.del {
  display: grid; place-items: center;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface); color: var(--muted);
  padding: 8px 0;
}
.del svg { width: 15px; height: 15px; }
.del:hover:not(:disabled) { color: var(--danger); border-color: var(--danger); }
.del:disabled { opacity: .3; cursor: not-allowed; }
.add { width: 100%; margin-top: 4px; }
.tierBuy {
  margin: 0 0 16px; padding: 14px;
  border: 1px solid var(--line-soft); border-radius: 12px;
  background: var(--surface-2);
}
.tierBuy h3 { font-size: 13.5px; margin: 0 0 6px; }
.tbNote { font-size: 12px; line-height: 1.7; margin: 0 0 12px; }
.tbNote strong { color: var(--ink); }
/* auto-fit + minmax(0, …)：賞別數量會變，而 grid 子元素預設 min-width: auto
   會讓輸入框撐破容器（見 docs/HANDOFF.md 2.1） */
.tbGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.tbCell { display: grid; gap: 4px; min-width: 0; }
.tbLbl { font-size: 11.5px; font-weight: 600; color: var(--muted); }
.tbCell input { width: 100%; min-width: 0; }
.tbLine { font-size: 12.5px; line-height: 1.7; margin: 12px 0 0; color: var(--muted); }
.tbLine strong { color: var(--ink); }
/* 有覆寫的那一格標出來 —— 否則它跟「空著吃預設」長得一模一樣 */
.prize-row input.over { border-color: var(--accent); }

.hint { font-size: 12px; margin: 12px 0 0; line-height: 1.55; }
.twoCols { line-height: 1.75; }
.twoCols strong { color: var(--ink); }

.side { position: sticky; top: 76px; display: grid; gap: 14px; }
.econ { padding: 16px; }
.econ.ok { background: var(--ok-wash); }
.econ.thin { background: var(--warn-wash); }
.econ.mint, .econ.predatory { background: var(--danger-wash); }
.ratio { display: flex; align-items: baseline; gap: 8px; }
.big-num { font-size: 34px; font-weight: 600; }
.econ.ok .big-num { color: var(--ok); }
.econ.thin .big-num { color: var(--warn); }
.econ.mint .big-num, .econ.predatory .big-num { color: var(--danger); }
.lbl { font-size: 12px; font-weight: 600; }
.verdict { font-size: 12.5px; font-weight: 600; margin: 8px 0 0; line-height: 1.5; }
.meaning { font-size: 11.5px; margin: 6px 0 0; line-height: 1.6; }
.figures { display: grid; gap: 6px; margin: 12px 0 0; padding-top: 10px; border-top: 1px dashed var(--line); }
.figures div { display: flex; justify-content: space-between; font-size: 12.5px; }
dt { color: var(--muted); font-weight: 600; }
dd { margin: 0; font-weight: 600; }
.fair { padding: 14px 16px; }
.fair p { font-size: 12px; margin: 0; line-height: 1.6; }
.go { width: 100%; padding: 13px 0; font-size: 15px; }
.err { color: var(--danger); font-size: 12.5px; font-weight: 600; margin: 0; }

@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .side { position: static; }
}
@media (max-width: 720px) {
  .page { padding-top: 20px; padding-bottom: 40px; }
  h1 { font-size: 21px; }
  .row2 { grid-template-columns: 1fr; }
  .prize-head { display: none; }
  /* 手機一列變三行：
       1  賞別 ｜ 卡名        ｜ ✕
       2  數量 ｜ 參考價
       3  買回價（整行，它是這一列最重要的數字，不跟別的擠） */
  .prize-row {
    grid-template-columns: 88px minmax(0, 1fr) 32px;
    gap: 8px 8px; padding: 10px; margin-bottom: 10px;
    border: 1px solid var(--line-soft); border-radius: 10px;
  }
  .prize-row > select { grid-row: 1; grid-column: 1; }
  .prize-row > input:nth-of-type(1) { grid-row: 1; grid-column: 2; }   /* 卡名 */
  .prize-row > input:nth-of-type(2) { grid-row: 2; grid-column: 1; }   /* 數量 */
  .prize-row > input:nth-of-type(3) { grid-row: 2; grid-column: 2 / 4; } /* 參考價 */
  .prize-row > input:nth-of-type(4) { grid-row: 3; grid-column: 1 / 4; } /* 買回價 */
  .del { grid-row: 1; grid-column: 3; }
}
</style>
