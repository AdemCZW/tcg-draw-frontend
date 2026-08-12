<script setup lang="ts">
// 單池驗算：瀏覽器端 SHA-256（Web Crypto），使用者可貼上 reveal 後的序列自行比對
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { usePoolStore } from '@/stores/pools'
import { track } from '@/lib/ga'

const route = useRoute()
const pools = usePoolStore()
const pool = computed(() => pools.byId(String(route.params.poolId)))

const input = ref('')
const computedHash = ref('')
const match = ref<null | boolean>(null)

onMounted(() => pools.ensureLoaded())

async function verify() {
  track('click_verify_pool')
  const data = new TextEncoder().encode(input.value.trim())
  const buf = await crypto.subtle.digest('SHA-256', data)
  computedHash.value = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  match.value = computedHash.value === pool.value?.commitHash
}
</script>

<template>
  <div class="container page" v-if="pool">
    <h1>驗算：{{ pool.title }}</h1>
    <div class="card box">
      <label class="lbl" for="seed-input">貼上 reveal 公布的 server seed + 籤序</label>
      <textarea id="seed-input" v-model="input" rows="5" class="mono" placeholder="revealed payload…"></textarea>
      <button class="btn primary" @click="verify" :disabled="!input.trim()">計算 SHA-256</button>
      <dl v-if="computedHash">
        <dt>你算出的 hash</dt>
        <dd class="mono">{{ computedHash }}</dd>
        <dt>開賣前公布的 commit hash</dt>
        <dd class="mono">{{ pool.commitHash }}</dd>
      </dl>
      <p v-if="match === true" class="ok" role="status">一致——籤序未被更動。</p>
      <p v-if="match === false" class="bad" role="status">不一致。若本池已 reveal，請保留截圖並聯繫客服。</p>
      <p v-if="pool.status !== 'revealed'" class="muted note">本池尚未完抽，seed 會在完抽後公開。</p>
    </div>
  </div>
</template>

<style scoped>
.page { padding-top: 40px; padding-bottom: 72px; max-width: 680px; }
h1 { font-size: 20px; margin: 0 0 18px; }
.box { padding: 20px; display: grid; gap: 12px; }
.lbl { font-size: 13px; color: var(--muted); }
textarea {
  width: 100%; resize: vertical;
  background: #0d1420; color: var(--text);
  border: 1px solid var(--line); border-radius: 8px;
  padding: 10px; font-size: 12.5px;
}
textarea:focus-visible { outline: 2px solid var(--holo-a); }
dl { margin: 0; }
dt { font-size: 11.5px; color: var(--faint); margin-top: 8px; }
dd { margin: 0; font-size: 12px; word-break: break-all; color: var(--muted); }
.ok { color: var(--ok); font-size: 14px; margin: 0; }
.bad { color: var(--danger); font-size: 14px; margin: 0; }
.note { font-size: 12.5px; margin: 0; }
</style>
