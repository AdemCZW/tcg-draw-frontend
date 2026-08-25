<script setup lang="ts">
/**
 * 沉浸頁的頂部返回列。
 *
 * 選籤牆走 chrome:'none'（不掛全域 header / 底部導覽），
 * 沒有這一條的話使用者會被困在頁面裡。它是唯一的出口，所以要：
 * 一直在頂上（sticky）、讓出瀏海（safe-area）、返回鍵夠大。
 *
 * 返回走 router.back()：這一頁一定是從池詳情進來的，back 就是回去。
 * 有 fallback 是防直接輸網址進來（history 裡沒有上一頁）。
 */
import { useRouter } from 'vue-router'

const props = withDefaults(defineProps<{
  title: string
  /** history 裡沒上一頁時退到哪 */
  fallback?: { name: string; params?: Record<string, string> }
}>(), { fallback: undefined })

const router = useRouter()
/* 不能用 window.history.length 判斷有沒有上一頁：新分頁直接貼網址進來時，
   那張空白起始頁也算一筆，length 是 2，back() 會把人丟回空白頁 —— 而這一條
   是 chrome:'none' 頁面唯一的出口，丟出去就真的困住了。
   Vue Router 的 state.back 只在「上一筆是這個 app 的路由」時才有值。 */
function back() {
  const prev = (router.options.history.state as { back?: string | null } | undefined)?.back
  if (typeof prev === 'string') router.back()
  else if (props.fallback) router.replace(props.fallback)
  else router.replace({ name: 'home' })
}
</script>

<template>
  <header class="ibar">
    <button type="button" class="back" aria-label="返回" @click="back">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <h1 class="t">{{ title }}</h1>
    <div class="right"><slot name="right" /></div>
  </header>
</template>

<style scoped>
.ibar {
  position: sticky; top: 0; z-index: 50;
  /* 右槽 auto：徽章這種內容不能被壓成一欄直排；左槽固定 44 讓標題仍置中偏左一點點是可接受的 */
  display: grid; grid-template-columns: 44px 1fr auto; align-items: center;
  height: calc(52px + var(--safe-t));
  padding: var(--safe-t) 6px 0;
  background: color-mix(in srgb, var(--bg) 84%, transparent);
  backdrop-filter: saturate(180%) blur(14px);
  border-bottom: 1px solid var(--line-soft);
}
.back {
  width: 44px; height: 44px;
  display: grid; place-items: center;
  border: none; background: transparent; color: var(--ink);
  border-radius: 50%; cursor: pointer;
  transition: background .15s, transform .12s;
}
.back svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
@media (hover: hover) { .back:hover { background: var(--surface-2); } }
.back:active { transform: scale(.9); }
.back:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.t { margin: 0; font-size: 15.5px; font-weight: 600; text-align: center; letter-spacing: -.01em; }
.right { display: grid; place-items: center; min-width: 44px; padding-right: 8px; white-space: nowrap; }
</style>
