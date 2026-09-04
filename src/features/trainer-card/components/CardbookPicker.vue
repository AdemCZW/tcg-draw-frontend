<script setup lang="ts">
/**
 * 從自己的卡冊挑一張卡（訓練家卡 P2）。
 *
 * ── 為什麼是挑卡而不是拍卡 ───────────────────────────────────────────
 * 使用者拍板：「暫時只需要有上傳卡片就可以製作，選擇自己要的生成一張」。
 * 卡冊裡的卡我們**已經有圖了** —— 再叫使用者把同一張卡拍一次，是把一件
 * 我們做得比他好的事丟回去給他做。
 *
 * ── 這一支不判斷「有沒有資格」──────────────────────────────────────
 * 資格（登入 + 卡冊有卡）由另一條線的 GET /v1/trainer-card/eligibility 負責。
 * 這裡只做一件事：把卡冊列出來、讓人挑一張、回報那張卡的圖是哪一種來源。
 * 端點上線後，這支換成吃它回傳的 cards 即可，挑選與分類的邏輯一行都不用改。
 *
 * ── 卡冊是空的時候 ───────────────────────────────────────────────────
 * 空狀態不能只說「沒有卡」—— 那是死路。這裡直接給下一步：去登記一張卡。
 */
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/lib/api'
import type { UserPrize } from '@/types/models'
import { classifyCardArt, type CardArtSource } from '../card-source'

const emit = defineEmits<{ pick: [prize: UserPrize, source: CardArtSource] }>()

/** 一張可以挑的卡 = 卡冊的一列 + 我們真的取得到的那份圖 */
interface Choice { prize: UserPrize; source: CardArtSource }

const loading = ref(true)
/** 讀不到卡冊（未登入、離線）跟「卡冊是空的」是兩件事，訊息也不一樣 */
const loadError = ref('')
const choices = ref<Choice[]>([])
/** 有列在卡冊、但我們拿不到圖的張數。要講出來，不然使用者會覺得卡不見了 */
const skipped = ref(0)
const chosen = ref<string>('')

onMounted(async () => {
  try {
    /* limit 60：這是一個用看的挑法，一次給滿一屏多一點就夠。
       之後真的有人卡冊上百張再加載入更多 —— 現在加是替不存在的問題寫程式。 */
    const page = await api.myPrizes({ limit: 60 })
    const list: Choice[] = []
    for (const prize of page.items) {
      /* 已經不在使用者手上的卡不列：回收與退還的卡他早就沒有了，
         列出來只會讓他挑到一張「我的卡」而其實不是。 */
      if (prize.status === 'recycled' || prize.status === 'refunded') continue
      const source = classifyCardArt(prize.card)
      if (!source) { skipped.value++; continue }
      list.push({ prize, source })
    }
    choices.value = list
  } catch {
    loadError.value = '卡冊讀不出來。可能是還沒登入，或是連線出了狀況。'
  } finally {
    loading.value = false
  }
})

function choose(c: Choice) {
  chosen.value = c.prize.id
  emit('pick', c.prize, c.source)
}
</script>

<template>
  <div class="picker">
    <p v-if="loading" class="hint" role="status">正在讀你的卡冊…</p>

    <p v-else-if="loadError" class="warn" role="alert">{{ loadError }}</p>

    <!-- 空狀態：講得出下一步，而不是「沒有卡」四個字 -->
    <div v-else-if="!choices.length" class="empty">
      <p class="lead">你的卡冊裡還沒有卡，所以還做不出訓練家卡。</p>
      <p class="hint">先去登記一張你手上的實體卡，登記完回到這裡就挑得到了。</p>
      <RouterLink class="btn primary" to="/me/cards/upload" data-testid="tc-empty-upload">
        去登記一張卡
      </RouterLink>
    </div>

    <template v-else>
      <ul class="grid" data-testid="tc-card-grid">
        <li v-for="c in choices" :key="c.prize.id">
          <button
            type="button" class="tile" :class="{ on: chosen === c.prize.id }"
            :data-source="c.source.kind" :data-prize="c.prize.id"
            :aria-pressed="chosen === c.prize.id"
            @click="choose(c)"
          >
            <!-- 這裡刻意不用 CardArt：那支會自己去 TCGdex 搜卡名當退路，
                 而「退到哪一張圖」正是我們要判斷的東西 —— 讓它自己去找，
                 畫面上的圖就可能不是等一下真的合成進成品的那一張。
                 這裡顯示的就是 classifyCardArt() 決定的那個網址，看到什麼就合成什麼。 -->
            <img :src="c.source.url" :alt="c.prize.card.name" loading="lazy" />
            <span class="nm">{{ c.prize.card.name }}</span>
            <span v-if="c.source.rectify" class="tag">要對齊四角</span>
          </button>
        </li>
      </ul>
      <p v-if="skipped" class="hint">
        另外 {{ skipped }} 張卡沒有可用的圖，這裡不列出來。
      </p>
    </template>
  </div>
</template>

<style scoped>
.picker { display: grid; gap: 12px; min-width: 0; }

.grid {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
}

/* 整塊卡就是熱區（遠大於 44px）。用 grid 而不是絕對定位，
   卡名長短不會把圖擠掉。 */
.tile {
  width: 100%; min-height: 44px; padding: 6px;
  display: grid; gap: 6px; justify-items: center;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--line); border-radius: 12px;
  cursor: pointer; touch-action: manipulation;
}
.tile.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.tile img {
  width: 100%; aspect-ratio: 63 / 88; object-fit: contain;
  border-radius: 6px; background: var(--field); display: block;
}
.nm {
  font-size: 11px; line-height: 1.35; color: var(--muted); text-align: center;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.tag {
  font-size: 10px; line-height: 1.4; padding: 1px 6px;
  border-radius: var(--pill); background: var(--surface-3); color: var(--faint);
}

.empty {
  display: grid; gap: 10px; justify-items: start;
  padding: 16px; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius);
}
.empty .btn { text-decoration: none; }

.lead { margin: 0; color: var(--text); line-height: 1.7; font-size: 14px; }
.hint { margin: 0; color: var(--faint); font-size: 12.5px; line-height: 1.6; }
.warn { margin: 0; color: var(--warn-ink); font-size: 13px; line-height: 1.7; }

/* .btn 是頁面層給的樣式，scoped 進不來 —— 這裡只補空狀態那顆的最小尺寸 */
.btn.primary {
  min-height: 48px; padding: 12px 18px; border-radius: var(--pill);
  background: var(--accent); color: var(--on-accent);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 600; border: 0;
}
</style>
