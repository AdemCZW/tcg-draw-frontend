<script setup lang="ts">
// 賣家開池。核心是「上架前就把經濟算清楚」——還元率超過 100% 或
// 低於 55% 都擋下，避免賣家開賠本池、或開對玩家過苛的池砸平台招牌。
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSellerStore } from '@/stores/sellers'
import { usePoolStore } from '@/stores/pools'
import { computeEconomics } from '@/lib/economics'
import type { PoolMode, Tier } from '@/types/models'
import PoolModeBadge from '@/components/PoolModeBadge.vue'

const router = useRouter()
const sellers = useSellerStore()
const pools = usePoolStore()
sellers.ensureLoaded()
pools.ensureLoaded()

const me = computed(() => sellers.me)
const canList = computed(() => me.value && me.value.tier !== 'pending')

const MODES: PoolMode[] = ['classic', 'shitei', 'muteki', 'battle', 'niboichi', 'streak', 'auction']
const TIERS: Tier[] = ['A', 'B', 'C', 'D', 'LAST', 'BUST']

const form = reactive({
  title: '',
  mode: 'classic' as PoolMode,
  ticketPrice: 300,
  shiteiTier: 'A' as Tier,
  auctionSeats: 3,
  prizes: [
    { tier: 'A' as Tier, name: '', qty: 1, unitValue: 8000 },
    { tier: 'D' as Tier, name: '', qty: 59, unitValue: 60 }
  ]
})

const busy = ref(false)
const error = ref('')

const econ = computed(() =>
  computeEconomics(
    form.mode,
    form.prizes.map(p => ({ tier: p.tier, qty: p.qty, unitValue: p.unitValue })),
    form.ticketPrice,
    { shiteiTier: form.shiteiTier, auctionSeats: form.auctionSeats }
  )
)
const blocked = computed(() => econ.value.verdict === 'loss' || econ.value.verdict === 'predatory')
const nameMissing = computed(() => form.prizes.some(p => p.tier !== 'BUST' && !p.name.trim()))
const valid = computed(() =>
  !!form.title.trim() && form.ticketPrice > 0 && econ.value.seatCount > 0 && !nameMissing.value && !blocked.value
)

function addPrize() {
  form.prizes.push({ tier: 'C', name: '', qty: 1, unitValue: 500 })
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
      auctionSeats: form.mode === 'auction' ? form.auctionSeats : undefined,
      prizes: form.prizes.map(p => ({ tier: p.tier, name: p.name.trim() || '爆賞', qty: p.qty, unitValue: p.unitValue }))
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

    <div v-if="!canList" class="gate card">
      <p class="big">尚未通過身分驗證</p>
      <p class="muted">
        平台不開放匿名上架。完成實名與金流帳戶驗證後才能開賣——
        這是保護玩家不被詐騙的第一道防線。
      </p>
      <RouterLink to="/" class="btn">回首頁</RouterLink>
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
          <div class="modes">
            <button
              v-for="m in MODES" :key="m" type="button"
              class="mode-btn" :class="{ on: form.mode === m }"
              @click="form.mode = m"
            ><PoolModeBadge :mode="m" /></button>
          </div>
          <PoolModeBadge :mode="form.mode" detailed class="mode-rule" />

          <div class="row2">
            <label class="field">
              <span>{{ form.mode === 'streak' ? '入場費（點）' : '每抽價格（點）' }}</span>
              <input v-model.number="form.ticketPrice" type="number" min="1" step="10" />
            </label>
            <label v-if="form.mode === 'shitei'" class="field">
              <span>指定賞賞別</span>
              <select v-model="form.shiteiTier">
                <option v-for="t in ['A','B','C','D']" :key="t" :value="t">{{ t }} 賞</option>
              </select>
            </label>
            <label v-if="form.mode === 'auction'" class="field">
              <span>最後幾支轉競標</span>
              <input v-model.number="form.auctionSeats" type="number" min="1" max="10" />
            </label>
          </div>
        </section>

        <section class="card block">
          <div class="block-head">
            <h2>獎項配置</h2>
            <span class="chip">共 {{ econ.seatCount }} 籤</span>
          </div>

          <div class="prize-head">
            <span>賞別</span><span>卡片名稱</span><span>數量</span><span>市值/張</span><span></span>
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
            <input v-model.number="p.qty" type="number" min="1" aria-label="數量" />
            <input v-model.number="p.unitValue" type="number" min="0" step="10" :disabled="p.tier === 'BUST'" aria-label="市值" />
            <button type="button" class="del" :disabled="form.prizes.length <= 1" @click="removePrize(i)" aria-label="刪除這列">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <button type="button" class="btn add" @click="addPrize">＋ 新增賞別</button>

          <p v-if="form.mode === 'streak'" class="hint muted">
            連莊爆賞必須放「爆賞」籤，玩家抽到就該輪歸零。爆賞越少玩家越容易連莊，
            但你的還元率會飆高——右側會即時算給你看。
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
            <span class="muted lbl">還元率</span>
          </div>
          <p class="verdict">{{ econ.message }}</p>

          <dl class="figures">
            <div><dt>獎池總值</dt><dd class="mono">{{ econ.prizeValue.toLocaleString() }}</dd></div>
            <div><dt>預期票收</dt><dd class="mono">{{ econ.revenue.toLocaleString() }}</dd></div>
            <div v-if="econ.worstCaseRatio !== undefined">
              <dt>玩家最佳策略</dt><dd class="mono">{{ econ.worstCaseRatio.toFixed(1) }}%</dd>
            </div>
          </dl>

          <p v-if="econ.worstCaseRatio !== undefined" class="hint muted">
            連莊玩法無法直接相除——玩家爆掉時獎品不發出。此處以蒙地卡羅模擬各種
            收手策略，取玩家能拿到的最高值作為你的風險上限。
          </p>
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
        <p v-if="blocked" class="err">還元率不合格，無法開池</p>
        <p v-if="error" class="err">{{ error }}</p>
        <button type="submit" class="btn primary go" :disabled="!valid || busy">
          {{ busy ? '封存籤序中…' : '開池上架' }}
        </button>
      </aside>
    </form>
  </div>
</template>

<style scoped>
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
  display: grid; grid-template-columns: 96px 1fr 72px 96px 32px;
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
.hint { font-size: 12px; margin: 12px 0 0; line-height: 1.55; }

.side { position: sticky; top: 76px; display: grid; gap: 14px; }
.econ { padding: 16px; }
.econ.ok { background: var(--ok-wash); }
.econ.thin { background: var(--warn-wash); }
.econ.loss, .econ.predatory { background: var(--danger-wash); }
.ratio { display: flex; align-items: baseline; gap: 8px; }
.big-num { font-size: 34px; font-weight: 600; }
.econ.ok .big-num { color: var(--ok); }
.econ.thin .big-num { color: var(--warn); }
.econ.loss .big-num, .econ.predatory .big-num { color: var(--danger); }
.lbl { font-size: 12px; font-weight: 600; }
.verdict { font-size: 12.5px; font-weight: 600; margin: 8px 0 0; line-height: 1.5; }
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
  .prize-row {
    grid-template-columns: 96px 1fr 32px;
    gap: 8px 8px; padding: 10px; margin-bottom: 10px;
    border: 1px solid var(--line-soft); border-radius: 10px;
  }
  .prize-row > input:nth-of-type(1) { grid-column: 2 / 3; }
  .prize-row > input:nth-of-type(2) { grid-column: 1 / 2; }
  .prize-row > input:nth-of-type(3) { grid-column: 2 / 4; }
  .del { grid-row: 1; grid-column: 3; }
}
</style>
