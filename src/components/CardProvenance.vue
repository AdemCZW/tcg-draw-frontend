<script setup lang="ts">
/**
 * 這張卡的來歷。
 *
 * ── 為什麼這是這個站最難被複製的一塊 ────────────────────────────────
 * 同業的卡冊（皮卡屋、呼卡、Cardex Go、卡拍拍的收藏冊）都是**使用者自己
 * 打字填的**：你說你有一張 PSA 10 噴火龍，沒有人查證。那是一份試算表。
 *
 * 這裡每一張卡都指得出來源，而且**外人查得到**：
 *   抽來的 → 哪一池、第幾籤、哪一天，而那一池的籤序開獎後任何人都能
 *            自己重算（shared/fairness.ts）。不需要相信我們。
 *   登記的 → 鑑定機構與編號，編號本身可以到鑑定機構的官網查。
 *   買來的 → 取得時間跟抽出時間不同，代表這張卡轉過手。
 *
 * 差別不是功能，是「宣稱」跟「可查證」。而那個差別只有握著交易紀錄的
 * 平台做得出來 —— 純工具型的卡冊 App 永遠補不上。
 *
 * ── 一條界線：顯示事件，不顯示人 ────────────────────────────────────
 * 轉手過的卡，前一手是誰是**別人的個資**。這個站在別處已經守過同一條線：
 * routes/orders.ts 的 /listings/:id/stash 只回「實體是不是還在別人手上」
 * 這個布林值、不回是誰，理由寫在那支的註解裡。公開的開獎動態也只給
 * 遮罩過的代號。這裡照同一條規則：講事件與日期，不講人。
 *
 * 價格也不講。單一一張卡的轉手價鏈會把賣家的利潤攤在下一個買家面前，
 * 那會讓人不敢上架。行情要做的話應該是「這一款卡的成交彙總」，
 * 跟個別的卡分開，兩者是不同的產品。
 */
import { computed } from 'vue'
import type { UserPrize } from '@/types/models'
import { FAIRNESS_UI } from '@/lib/config'

const props = defineProps<{ prize: UserPrize }>()

/** 帶時區的 ISO 直接切前 10 碼會在 UTC+8 的深夜差一天，所以走本地格式化 */
function day(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* 判斷用 origin 一個欄位，不用 pool_id 有沒有值去反推 ——
   021 之前的列 origin 是回填的，但 pool_id 一直都有，反推會判錯。

   三態不是兩態：**origin 缺值的時候什麼都不要斷言**。
   舊後端還沒部署、或舊資料沒有這一欄時，硬分成「抽來的／登記的」
   兩種，就會對一張明明是抽中的卡說「由持有人登記進卡冊」——
   而這一整塊的價值就是「講出來的每一句都查得到」。
   講少一句沒有損失，講錯一句就把整塊毀了。 */
type Origin = 'draw' | 'upload' | 'unknown'
const originKind = computed<Origin>(() => {
  const o = props.prize.origin
  if (o === 'draw' || o === 'seed') return 'draw'
  if (o === 'upload') return 'upload'
  return 'unknown'
})

/* 轉過手：取得時間跟抽出時間不同。這兩個時間戳在同一手持有的卡上相同，
   差異本身就是「換過主人」的證據，不需要另外存一個旗標。
   比對到「日」而不是毫秒：同一天內的抽中與過戶不該被講成轉手。 */
const changedHands = computed(() => {
  const w = day(props.prize.wonAt)
  const a = day(props.prize.acquiredAt)
  return !!w && !!a && w !== a
})

const certText = computed(() => {
  const g = (props.prize.grader ?? '').trim()
  const n = (props.prize.certNo ?? '').trim()
  if (!g || g === 'RAW') return null
  return n ? `${g} #${n}` : g
})
</script>

<template>
  <section class="prov">
    <h4 class="pt">這張卡的來歷</h4>

    <ol class="chain">
      <!-- 抽來的：唯一一條可以被外人重算驗證的來源，所以講得最細 -->
      <li v-if="originKind === 'draw'">
        <span class="when mono">{{ day(prize.wonAt) }}</span>
        <span class="what">
          從<b>{{ prize.poolTitle || '一個抽選池' }}</b>抽出<template
            v-if="prize.seat != null">，第 <b class="mono">{{ prize.seat }}</b> 籤</template>。
        </span>
      </li>

      <!-- 自己登記的：沒有進過任何池，賞別與籤位對它不成立 -->
      <li v-else-if="originKind === 'upload'">
        <span class="when mono">{{ day(prize.wonAt) }}</span>
        <span class="what">由持有人登記進卡冊。</span>
      </li>

      <!-- 來源不明（舊資料或舊後端）：只講日期，不猜是哪一種。
           猜錯的成本比少講一句高太多。 -->
      <li v-else>
        <span class="when mono">{{ day(prize.wonAt) }}</span>
        <span class="what">進入卡冊。</span>
      </li>

      <li v-if="changedHands">
        <span class="when mono">{{ day(prize.acquiredAt) }}</span>
        <span class="what">在站內轉手，成為現持有人的卡。</span>
      </li>
    </ol>

    <!-- 鑑定編號另外一行：它不是「什麼時候發生的事」，是「這張卡是什麼」。
         混進上面的時間軸會讓人以為登記編號是一次交易。 -->
    <p v-if="certText" class="cert">
      鑑定編號 <b class="mono">{{ certText }}</b>
      <span class="muted">．可到鑑定機構官網查證</span>
    </p>

    <!-- 這一句是整塊的重點。籤序開獎後任何人可以自己重算，
         所以「這張卡真的是從那一池抽出來的」不需要相信平台。
         FAIRNESS_UI 關著的時候不給連結，但仍然把機制講出來 ——
         那是事實，不是一顆按鈕的附屬品。 -->
    <p v-if="originKind === 'draw'" class="verify muted">
      這一池的籤序在開賣前就封存了，開獎後任何人都能自己重算、
      逐籤比對 ——<strong>這件事不需要相信我們</strong>。
      <RouterLink
        v-if="FAIRNESS_UI && prize.poolId"
        :to="{ name: 'fairness-pool', params: { poolId: prize.poolId } }"
        class="vgo"
      >自己驗算這一池</RouterLink>
    </p>
  </section>
</template>

<style scoped>
.prov { display: grid; gap: 8px; min-width: 0; }
.pt { margin: 0; font-size: 12.5px; font-weight: 700; color: var(--ink); }

/* 時間軸。左邊一條線串起事件，不用圖示 —— 事件本身就是內容，
   圖示在 12px 的字級上只會變成雜訊。 */
.chain {
  list-style: none; margin: 0; padding: 0 0 0 14px;
  display: grid; gap: 8px;
  border-inline-start: 2px solid var(--line);
  min-width: 0;
}
.chain li {
  display: grid; gap: 2px; min-width: 0;
  font-size: 12px; line-height: 1.6;
}
.when { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
.what { color: var(--muted); overflow-wrap: anywhere; }
.what b { color: var(--ink); font-weight: 700; }

.cert {
  margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted);
  min-width: 0; overflow-wrap: anywhere;
}
.cert b { color: var(--ink); }

.verify {
  margin: 0; font-size: 11.5px; line-height: 1.65;
  min-width: 0; overflow-wrap: anywhere;
}
.verify strong { color: var(--ink); }
/* 觸控高度給滿 44，視覺上仍是一行小字 —— 它是延伸閱讀不是主要動作 */
.vgo {
  display: inline-flex; align-items: center; min-height: 44px;
  margin-top: 2px; font-weight: 700; color: var(--accent);
  text-decoration: underline; text-underline-offset: 3px;
}
</style>
