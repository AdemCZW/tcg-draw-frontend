<script setup lang="ts">
/**
 * 池 · 驗證 —— 承諾雜湊、托管、驗算入口。
 * 這是「不需要信任我們」的材料。獨立成一頁，是因為它值得一個安靜的位置：
 * 塞在獎項表下面的第四個區塊，沒有人會讀。
 *
 * ── 文案為什麼重寫 ────────────────────────────────────────────────────
 * 舊標題是「這一池的結果不需要你信任我們」—— 那是英文 trust-less 的直譯。
 * 中文讀起來像在替一個還沒被指控的事情辯解，而且它講的是「我們」，
 * 不是使用者關心的事。使用者關心的只有三句話：
 *   1. 這一池的結果什麼時候就定了（開賣前）
 *   2. 為什麼平台事後改不了（改了對不上已公布的雜湊）
 *   3. 他自己可以怎麼確認（連到驗算頁）
 * 所以標題改成講第 1 件事，說明講第 2 件，按鈕是第 3 件。
 *
 * FAIRNESS_UI 關著的時候（見 lib/config.ts）：**整塊留著，只收兩個連結**。
 *
 * 為什麼不整塊（或整個 tab）收掉：這一頁裝的不只有驗算入口 ——
 * 承諾雜湊、client seed 來源、還有托管聲明（那是錢的保障，跟公平性是兩回事）。
 * 整塊收掉等於把這幾樣一起藏了，而後端根本沒停過，等於自己把揭露拿掉。
 *
 * 新的說明句子刻意停在「任何人都能自己重算一次」這個**機制事實**上，
 * 不再停在「你可以去按那顆按鈕」。這樣同一句話在開關兩種狀態下都讀得通，
 * 不必再為了開關另外養一句話 —— 舊版那兩句 v-if/v-else 的差別只有結尾，
 * 而那個結尾之所以要換，正是因為它指向一顆可能不在畫面上的按鈕。
 */
import type { Pool } from '@/types/models'
import CommitHashBox from '@/components/CommitHashBox.vue'
import EscrowNotice from '@/components/EscrowNotice.vue'
import { FAIRNESS_UI } from '@/lib/config'
import { isRevealed } from '@/lib/pool-status'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="pf">
    <!-- 已開獎與未開獎講的不是同一件事，所以連標題都要換：
         種子還封著的時候，能保證的是「已經定了、改不動」；
         種子公開之後，才輪得到「你現在就能自己算一次」。
         把後面那句提前講，就是在畫面上開一張兌現不了的支票。 -->
    <p class="claim">
      這一池的籤序，<strong>開賣前就已經排定</strong>
    </p>
    <p v-if="isRevealed(pool)" class="how muted">
      決定籤序的那組亂數（server seed）已經公開了。拿它重算一次 SHA-256，
      必須等於開賣前就公布的那串 commit hash —— 對得上，代表這組亂數沒被換過；
      再用它重跑一次洗牌，就能逐一比對每一個籤位開出什麼。這件事不必問我們，算過就知道。
    </p>
    <p v-else class="how muted">
      決定籤序的那組亂數在開賣前就封了起來，當時只公布它的指紋（下方的 commit hash）。
      封存之後我們自己也改不動：動了任何一個字，指紋就對不上。
      完抽開獎後那組亂數會整組公開，屆時任何人都能自己重算一次籤序、逐一比對。
    </p>
    <CommitHashBox :pool="pool" />
    <EscrowNotice :pool="pool" />
    <!-- 「自己驗算」只在種子真的公開了（revealed）之後才成立。
         以前的條件是 `status === 'open'`，於是還沒開賣的池（committed）
         與抽完但種子還沒公開的池（sold_out）都掛上「自己驗算這一池 →」，
         按進去看到的卻是「本池尚未開獎」—— 那是一顆按了會落空的按鈕。
         沒得算的時候仍然給連結，但字要講對：進去看的是材料，不是答案。
         按鈕下面那一行說的是「按下去會看到什麼」，因為這兩個字面
         （驗算／材料）對沒讀過機制的人來說一樣抽象。 -->
    <template v-if="FAIRNESS_UI">
      <RouterLink :to="{ name: 'fairness-pool', params: { poolId: pool.id } }" class="btn verify">
        {{ isRevealed(pool) ? '自己驗算這一池 →' : '看這一池公布了什麼 →' }}
      </RouterLink>
      <p class="hint muted">
        {{
          isRevealed(pool)
            ? '在你自己的瀏覽器裡重算一次，不經過我們的伺服器；結果會逐籤列給你看。'
            : '可以先看這一池已經公布的承諾資料；種子在開獎後才會補上，那時候同一頁就能算。'
        }}
      </p>
      <RouterLink :to="{ name: 'fairness' }" class="more muted">這套機制怎麼運作：完整說明</RouterLink>
    </template>
  </div>
</template>

<style scoped>
/* 收起連結後最後一個子元素是 EscrowNotice，grid 的 gap 不會留下多餘的尾巴 */
.pf { display: grid; gap: 14px; justify-items: start; min-width: 0; }
.pf > * { min-width: 0; }
.claim { margin: 0; font-size: 16px; }
.claim strong { color: var(--accent); }
.how { margin: -6px 0 2px; font-size: 13.5px; line-height: 1.62; max-width: 60ch; }
.verify { width: 100%; max-width: 420px; }
/* 貼著上面那顆按鈕（負的 margin-top 吃掉 grid 的 gap），讀起來才是按鈕的註腳
   而不是另起一段 */
.hint { margin: -8px 0 0; font-size: 12.5px; line-height: 1.55; max-width: 52ch; }
.more { font-size: 13px; text-decoration: underline; text-underline-offset: 3px; }
</style>
