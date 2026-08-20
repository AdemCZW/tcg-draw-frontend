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
import { verifyReveal, commitOf, type Reveal } from '@/shared/fairness'
import { API_URL, MOCK } from '@/lib/config'
import { track } from '@/lib/ga'

const route = useRoute()
const pools = usePoolStore()
const pool = computed(() => pools.byId(String(route.params.poolId)))

const loading = ref(false)
const err = ref('')
const reveal = ref<Reveal & { clientSeedSource?: string } | null>(null)
const result = ref<{ ok: boolean; reason?: string } | null>(null)
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
    const r = await res.json() as Reveal & { clientSeedSource?: string }
    reveal.value = r
    recomputed.value = await commitOf(r.serverSeed)
    result.value = await verifyReveal(r)
  } catch {
    err.value = '連線失敗，請稍後再試'
  } finally {
    loading.value = false
  }
}

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
        三件事都要成立才算通過：開賣前公布的 commit 對得上、重算的籤序跟公布的完全一樣、
        獎品數量跟開賣前宣告的相符。
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
            通過。籤序與開賣前的承諾一致，沒有被更動過。
          </p>
          <p v-else class="bad" role="alert">
            不一致：{{ result.reason }}。請保留這個畫面並聯繫客服。
          </p>
        </template>

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
