<script setup lang="ts">
/**
 * 單池驗算。
 *
 * 這一頁原本是壞的，而且壞的方式最糟：它會對**每一個誠實照做的使用者**
 * 顯示「不一致。若本池已 reveal，請保留截圖並聯繫客服。」
 *
 * 原因是雜湊的輸入對不上。commitOf() 算的是 server seed 這串 hex
 * **解碼後的原始位元組**的 SHA-256；而這一頁做的是
 * `new TextEncoder().encode(輸入字串)` —— 雜湊的是 hex **字面文字**。
 * 兩者輸入不同，雜湊不可能相同。它還要人把「server seed + 籤序」貼在一起，
 * 但承諾只涵蓋 server seed。
 *
 * 對一個賣點就是「你可以自己驗」的平台，這比沒有驗算頁還糟 ——
 * 它主動產出我們在作弊的證據。
 *
 * 改成呼叫 shared/fairness.ts 裡本來就寫好的 verifyReveal()：
 * 那支會完整檢查三件事（commit 對得上、重算的籤序跟公布的一致、
 * 獎品數量跟宣告的相符），而且前後端共用同一份程式碼。
 *
 * 資料一律從 /v1/pools/:id/reveal 直接抓、在瀏覽器裡算。使用者不必貼任何東西 ——
 * 要人手動複製貼上本身就是一道會讓多數人放棄的門檻，而且貼錯了看起來就像作弊。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { usePoolStore } from '@/stores/pools'
import { verifyReveal, commitOf, commitV2, manifestHashOf, type Reveal } from '@/shared/fairness'
import { API_URL, MOCK } from '@/lib/config'
import { track } from '@/lib/ga'

const route = useRoute()
const pools = usePoolStore()
const pool = computed(() => pools.byId(String(route.params.poolId)))

const loading = ref(false)
const err = ref('')
interface SeatRow { seat: number; prizeId: string; takenAt: number | null }
const reveal = ref<Reveal & {
  clientSeedSource?: string; manifestHash?: string | null; seats?: SeatRow[]
} | null>(null)
const result = ref<{ ok: boolean; reason?: string; version: 1 | 2 | 3 | 4 } | null>(null)
/** 自己重算出來的 commit，跟開賣前公布的並排給使用者看 */
const recomputed = ref('')

async function run() {
  const p = pool.value
  if (!p) return
  track('click_verify_pool')
  loading.value = true
  err.value = ''
  result.value = null
  try {
    if (MOCK) {
      err.value = '展示模式沒有連後端，無法取得已公布的 seed。'
      return
    }
    const res = await fetch(`${API_URL}/v1/pools/${p.id}/reveal`)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      err.value = d.message ?? '取不到公布資料'
      return
    }
    const r = await res.json() as Reveal & {
      clientSeedSource?: string; manifestHash?: string | null; seats?: SeatRow[]
    }
    reveal.value = r
    /* 重算 commit 的方式要跟這個池的版本一致，否則會在畫面上並排兩個
       必然不一樣的雜湊，看起來像出事了 */
    recomputed.value = r.manifest
      ? await commitV2(r.serverSeed, await manifestHashOf(r.manifest, r.manifestVersion ?? 2))
      : await commitOf(r.serverSeed)
    result.value = await verifyReveal(r)
  } catch {
    err.value = '連線失敗，請稍後再試'
  } finally {
    loading.value = false
  }
}

/* 把籤位、獎品清單、抽走時間接起來。
   清單缺項時退回 prizeId —— 寧可顯示得醜，也不要因為一項對不上就整段消失。 */
const history = computed(() => {
  const r = reveal.value
  if (!r?.seats?.length) return []
  const byId = new Map((r.manifest ?? []).map(m => [m.prizeId, m]))
  return r.seats.map(s => {
    const m = byId.get(s.prizeId)
    return {
      seat: s.seat,
      tier: m?.tier ?? '—',
      name: m?.name ?? s.prizeId,
      takenAt: s.takenAt
    }
  })
})

/* 摘要只列最高的兩個賞別。250 格的池全部攤開沒有人看得完，
   而大家真正想確認的是「大獎在哪、什麼時候出的」。 */
const topHits = computed(() =>
  history.value.filter(h => h.tier === 'LAST' || h.tier === 'A').slice(0, 12))

const fmt = (ms: number) =>
  new Date(ms).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

// 已開獎的池直接算給他看，不用等他按
onMounted(async () => {
  await pools.ensureLoaded()
  if (pool.value?.status === 'revealed') run()
})
</script>

<template>
  <div class="container page" v-if="pool">
    <h1>驗算：{{ pool.title }}</h1>

    <div class="card box">
      <p class="intro">
        這一頁在<strong>你的瀏覽器裡</strong>重跑一次洗牌，不經過我們的伺服器。
        開賣前公布的 commit 要對得上、重算的籤序要跟公布的完全一樣、
        獎品數量要跟宣告的相符 —— 三件事都成立才算通過。
      </p>

      <p v-if="pool.status !== 'revealed'" class="muted note">
        本池尚未開獎。server seed 會在完抽後公開，屆時這一頁才算得動。
      </p>

      <template v-else>
        <button class="btn primary" :disabled="loading" @click="run">
          {{ loading ? '重算中…' : '重新驗算' }}
        </button>

        <p v-if="err" class="bad" role="alert">{{ err }}</p>

        <template v-if="result">
          <p v-if="result.ok" class="ok" role="status">
            通過。<template v-if="result.version === 4">籤序、<strong>獎品內容（含每一張卡的版本）</strong>與<strong>宣告的買回價</strong>都跟開賣前的承諾一致</template><template v-else-if="result.version === 3">籤序、<strong>獎品內容</strong>與<strong>宣告的買回價</strong>都跟開賣前的承諾一致</template><template v-else-if="result.version === 2">籤序<strong>與獎品內容</strong>都跟開賣前的承諾一致</template><template v-else>籤序與開賣前的承諾一致</template>，沒有被更動過。
          </p>
          <p v-else class="bad" role="alert">
            不一致：{{ result.reason }}。請保留這個畫面並聯繫客服。
          </p>
        </template>

        <!-- 版本差在哪要講清楚。v1 的池只保證籤序沒被動，
             獎品內容換掉是抓不到的 —— 那是事實，不該讓使用者以為驗過就萬無一失 -->
        <p v-if="result && result.version === 1" class="muted note">
          這是舊版承諾的池：只涵蓋籤序，不涵蓋「每個獎項是哪張卡」。
          之後開的池會把獎品清單一起綁進承諾，換掉任何一張卡都會讓驗算不一致。
        </p>

        <!-- 承諾涵蓋的獎品清單。這是 v2 真正多出來的東西：
             它就是開賣前宣告的內容，被改過就驗不過。
             v3 再多綁一個買回價 —— 賣家有義務履行的金額也鎖在承諾裡。 -->
        <details v-if="reveal?.manifest?.length" class="man">
          <summary>承諾涵蓋的獎品清單（{{ reveal.manifest.length }} 項）</summary>
          <ul>
            <li v-for="m in reveal.manifest" :key="m.prizeId">
              <span class="c-tier mono">{{ m.tier }}</span>
              <span class="c-name">{{ m.name }}</span>
              <span class="mono muted">×{{ m.total }}</span>
              <span v-if="m.certNo" class="mono muted">#{{ m.certNo }}</span>
              <span v-if="m.refPrice" class="mono muted">參考 {{ m.refPrice.toLocaleString() }}</span>
              <!-- 買回價是這份清單裡唯一一個「賣家有義務履行」的金額。
                   v3 的池才有，而它進了雜湊 —— 開賣後偷改會被上面的驗算抓到。 -->
              <span v-if="m.buyback != null" class="mono buyb">買回 {{ m.buyback.toLocaleString() }}</span>
            </li>
          </ul>
        </details>

        <!-- 排出履歷。
             在「大獎真的在池裡」這件事上，它比雜湊更直接：
             一般人看不懂 SHA-256，但看得懂「第 47 號在 8/12 開出了噴火龍」。
             日本業者用的就是這一套，而它其實比 commit-reveal 更有說服力 ——
             因為它證明的是結果，不是過程。 -->
        <section v-if="history.length" class="hist">
          <h2>排出履歷</h2>
          <p class="muted note">
            每一格開出什麼、什麼時候被抽走。沒有標示時間的是這一池收攤時還沒賣掉的籤。
            這裡不顯示是誰抽到的。
          </p>

          <ul class="top">
            <li v-for="h in topHits" :key="h.seat">
              <span class="mono seat">#{{ h.seat }}</span>
              <span class="tier">{{ h.tier }}</span>
              <span class="nm">{{ h.name }}</span>
              <span class="mono when">{{ h.takenAt ? fmt(h.takenAt) : '未售出' }}</span>
            </li>
          </ul>

          <details>
            <summary>全部 {{ history.length }} 格</summary>
            <ul class="all">
              <li v-for="h in history" :key="h.seat" :class="{ unsold: !h.takenAt }">
                <span class="mono seat">#{{ h.seat }}</span>
                <span class="tier">{{ h.tier }}</span>
                <span class="nm">{{ h.name }}</span>
                <span class="mono when">{{ h.takenAt ? fmt(h.takenAt) : '未售出' }}</span>
              </li>
            </ul>
          </details>
        </section>

        <dl v-if="reveal">
          <dt>開賣前公布的 commit</dt>
          <dd class="mono">{{ reveal.commitHash }}</dd>
          <dt>你的瀏覽器重算出來的</dt>
          <dd class="mono" :class="{ same: recomputed === reveal.commitHash.toLowerCase() }">{{ recomputed }}</dd>
          <dt>server seed（開獎後才公開）</dt>
          <dd class="mono">{{ reveal.serverSeed }}</dd>
          <dt>外部亂數來源</dt>
          <dd class="mono">{{ reveal.clientSeedSource || '—' }}</dd>
          <dt>籤數</dt>
          <dd class="mono">{{ reveal.publishedSequence.length }}</dd>
          <dt v-if="reveal.manifestHash">獎品清單雜湊</dt>
          <dd v-if="reveal.manifestHash" class="mono">{{ reveal.manifestHash }}</dd>
        </dl>

        <p class="muted note">
          不信任這一頁？公布的資料全部來自
          <code>/v1/pools/{{ pool.id }}/reveal</code>，你可以自己抓下來，
          用任何一套 SHA-256 與 HMAC 的實作重跑一次。
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.hist { border-top: 1px solid var(--line-soft); padding-top: 14px; }
.hist h2 { font-size: 15px; margin: 0 0 6px; }
.hist ul { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.hist li { display: flex; align-items: center; gap: 9px; font-size: 12.5px; }
.hist li.unsold { opacity: .45; }
.hist .seat { flex: none; color: var(--muted); min-width: 46px; }
.hist .tier {
  flex: none; padding: 1px 7px; border-radius: 999px;
  background: var(--surface-3); color: var(--muted); font-size: 11px;
}
.hist .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist .when { flex: none; color: var(--faint); font-size: 11.5px; }
.hist details { margin-top: 12px; }
.hist summary { cursor: pointer; color: var(--muted); font-size: 12.5px; padding: 6px 0; }
.hist .all { max-height: 420px; overflow-y: auto; overscroll-behavior: contain; }

.man { font-size: 12.5px; }
.man summary { cursor: pointer; color: var(--muted); padding: 6px 0; }
.man ul { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.man li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.man .c-tier {
  flex: none; padding: 1px 7px; border-radius: 999px;
  background: var(--surface-3); color: var(--muted); font-size: 11px;
}
.man .buyb { color: var(--accent); }
.c-name { flex: 1; min-width: 0; }

.page { padding-top: 40px; padding-bottom: 72px; max-width: 680px; }
h1 { font-size: 20px; margin: 0 0 18px; }
.box { padding: 20px; display: grid; gap: 12px; }
.intro { font-size: 13.5px; line-height: 1.75; color: var(--muted); margin: 0; }
.intro strong { color: var(--ink); }
dl { margin: 0; }
dt { font-size: 11.5px; color: var(--faint); margin-top: 8px; }
dd { margin: 0; font-size: 12px; word-break: break-all; color: var(--muted); }
dd.same { color: var(--ok); }
.ok { color: var(--ok); font-size: 14px; margin: 0; font-weight: 600; }
.bad { color: var(--danger); font-size: 14px; margin: 0; font-weight: 600; }
.note { font-size: 12.5px; line-height: 1.7; margin: 0; }
code { font-size: 11.5px; padding: 1px 5px; border-radius: 5px; background: var(--surface-3); }
</style>
