<script setup lang="ts">
/**
 * 承諾雜湊方塊 —— 開賣前公布的 commit hash 與 client seed 來源。
 *
 * 只收「驗證本池 →」那個連結，整塊留著（見 lib/config.ts 的 FAIRNESS_UI）。
 * 判準是「收起來之後還讀不讀得通」：這一塊的本體是那兩筆揭露的資料，
 * 標題加一份 dl 自己就完整 —— 雜湊照樣印在畫面上，想自己比對的人抄得走。
 * 收掉整塊反而是把後端從沒停過的承諾也一起藏起來，那才是說謊。
 *
 * ── 為什麼每一列都多一句中文 ──────────────────────────────────────────
 * 英文術語不能拿掉：commit hash、client seed 是驗算時真的要照著對的欄位名，
 * 翻成中文反而讓人對不上驗算頁與 drand 那邊看到的字。
 * 但只印術語等於只給懂的人看 —— 一般玩家看不出這兩串字跟自己有什麼關係。
 * 所以術語留著，每一列底下補一句「它是什麼、為什麼你要在意」。
 *
 * client seed 那一句刻意不寫死「一定是 drand」：示範資料是 `fixture:` 開頭，
 * 真的池才是 `drand:輪次編號`。文案寫死會讓示範畫面自己說謊。
 */
import type { Pool } from '@/types/models'
import { FAIRNESS_UI } from '@/lib/config'
defineProps<{ pool: Pool }>()
</script>

<template>
  <div class="fair card">
    <div class="head">
      <div class="titles">
        <span class="lbl display">Provably Fair</span>
        <!-- 英文標題本身就是一個術語。中文副標不是翻譯，是把它換成一句
             使用者能判斷「這跟我有關嗎」的話 -->
        <span class="sub muted">可驗證的公平抽選：下面兩筆資料在開賣前就公布了</span>
      </div>
      <RouterLink v-if="FAIRNESS_UI" :to="`/fairness/${pool.id}`" class="verify">驗證本池 →</RouterLink>
    </div>
    <dl>
      <dt>Commit hash<span class="dt-zh">開賣前公布的封存指紋</span></dt>
      <dd class="mono hash">{{ pool.commitHash }}</dd>
      <dd class="note">
        開獎後公布的那組亂數，重算一次 SHA-256 必須等於這一串。
        這串字從開賣前就沒動過，所以籤序也動不了。
      </dd>
      <dt>Client seed<span class="dt-zh">洗牌用的另一半亂數，不由我們產生</span></dt>
      <dd class="mono">{{ pool.clientSeedSource }}</dd>
      <dd class="note">
        正式的池鎖定 drand（League of Entropy）某個<b>還沒發生</b>的輪次
        （顯示成 <span class="mono">drand:</span> 加輪次編號）。
        那個值在我們承諾的當下全世界都還不知道，所以我們挑不到對自己有利的籤序。
      </dd>
      <!-- 承諾版本值得單獨列一行：v2 起把整份獎品清單綁進承諾，
           v1 只綁種子 —— 差別是「開賣後偷換獎品驗不驗得到」，
           那正是使用者會在意的事（見 shared/fairness.ts 的 commitOf 註解）。
           版本不明（欄位是 null）就整列不畫：沒把握的事寧可不說，
           說錯一句會讓上面兩列一起失去可信度。 -->
      <template v-if="pool.commitVersion">
        <dt>承諾範圍<span class="dt-zh">v{{ pool.commitVersion }}</span></dt>
        <dd v-if="pool.commitVersion >= 2" class="note">
          這一池的承諾除了亂數，還綁進了整份獎品清單。開賣後只要動到任何一個獎項的
          卡片、鑑定編號或宣告的買回價，驗算就會對不上。
        </dd>
        <dd v-else class="note">
          舊制的池：承諾只綁亂數，驗得出籤序沒被動過，但驗不到獎品內容有沒有被換。
        </dd>
      </template>
    </dl>
  </div>
</template>

<style scoped>
.fair { padding: 16px 18px; }
/* space-between 在只剩標籤一個子元素時就等於靠左，收起連結不會留下空洞 */
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.head > * { min-width: 0; }
.titles { display: grid; gap: 2px; }
.lbl { font-size: 12px; background: var(--holo); -webkit-background-clip: text; background-clip: text; color: transparent; }
.sub { font-size: 11.5px; line-height: 1.5; }
.verify { font-size: 12.5px; color: var(--holo-a); flex: none; }
dl { margin: 0; }
dt { font-size: 11.5px; color: var(--faint); margin-top: 10px; }
/* 中文說明跟英文欄位名同一行，窄螢幕自己折行 —— 分成兩行會讓 dl 看起來
   像有兩倍的欄位 */
.dt-zh { color: var(--muted); }
.dt-zh::before { content: " · "; }
dd { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
/* 雜湊要能整串複製，也要在任何寬度下折得掉 */
.hash { overflow-wrap: anywhere; }
.mono { overflow-wrap: anywhere; }
.note { margin-top: 3px; font-size: 11.5px; line-height: 1.55; color: var(--faint); max-width: 56ch; }
.note b { color: var(--muted); font-weight: 600; }
</style>
