<script setup lang="ts">
/**
 * 「這筆錢現在在誰手上、下一步誰做什麼它才會動。」
 *
 * ── 為什麼要有這一塊 ──────────────────────────────────────────────
 * 兩條交易路徑（抽卡池結算、市場託管訂單）在畫面上都已經講得出「走到哪一步」，
 * 但沒有一處回答得了使用者真正在問的那一句：**我的點數現在在哪裡**。
 * 賣家看到「等你寄出」不會自動連到「所以我還沒拿到錢」；買家看到「已寄出」
 * 也不知道自己的點數是還鎖著、還是已經付出去了。
 * 那個空白的代價不對稱：賣家以為錢已經進來就不急著寄，逾期被記違約；
 * 買家以為錢已經付掉就不敢按申訴。
 *
 * ── 為什麼兩條路共用同一支 ────────────────────────────────────────
 * 兩邊的規則不一樣（時限、罰則、有沒有保證金），但**骨架是同一個**：
 *   1 買家已付 → 2 等賣家寄出 → 3 鑑賞／驗收期 → 4 結束
 * 骨架相同就該只有一份。使用者只要學一次「第二段是卡在賣家手上」，
 * 之後不管看的是池還是市場都讀得懂。差異全部收在文案裡，不再開第二個元件 ——
 * 兩份會分岔，而分岔的那一份講的會是別條路的規則。
 *
 * ── 文案為什麼要分角色 ────────────────────────────────────────────
 * 同一個 awaiting_ship，賣家要聽到的是「你寄出前這筆不會入帳」，
 * 買家要聽到的是「你的點數還在平台保管」。用一套中性描述蓋過去的話，
 * 兩邊都會讀成「跟我沒關係」。這跟兩頁既有的 POOL_UI / MARKET_UI 是同一個做法：
 * 中性版留在 shared，站在誰那一側的版本寫在看得到的地方。
 *
 * ── 已經發生的事實 vs 還會發生的事 ───────────────────────────────
 * 逾期、爭議、退款這幾種結局一律用完成式寫（「已經退還買家」），而且第四段的
 * 名字會跟著結局換（已入帳／已退款／已取消）。寫成「會退還買家」的話，
 * 使用者會以為自己還有時間補救 —— 那時候錢早就動完了。
 *
 * 時限的數字一律從 shared 的常數推，不在文案裡寫死。
 * 不用 emoji：色塊與線條在各家系統上長得一樣，emoji 不會。
 */
import { computed } from 'vue'
import {
  POOL_INSPECT_MS, POOL_SHIP_DEADLINE_MS, POOL_VAULT_ACCEPT_MS,
  type SettlementStatus
} from '@/shared/pool-settlement'
import {
  DAY, HOUR, DELIVER_DEADLINE, INSPECT_WINDOW, SHIP_DEADLINE
} from '@/shared/escrow'
import type { OrderStatus } from '@/shared/domain'

const props = defineProps<{
  /** 哪一條路。決定第三段叫鑑賞期還是驗收期，以及罰則怎麼寫 */
  src: 'pool' | 'market'
  /** 看的人是誰。同一個狀態兩側講的話不一樣 */
  side: 'buyer' | 'seller'
  status: SettlementStatus | OrderStatus
  /** 池是票金、市場是貨款 */
  amount: number
  /** 市場訂單的賣家保證金。池那條路沒有，傳 0 或不傳 */
  deposit?: number
  /**
   * 「票金已入帳，但卡還沒寄」（F-5）。狀態是 released 卻仍欠一張卡 ——
   * 只看 status 會講成「這筆結束了」，而它其實還掛著一個逾期記違約的期限。
   */
  owesCard?: boolean
}>()

/* 兩套規則的天數／小時數，從常數推 */
const POOL_SHIP_H = Math.round(POOL_SHIP_DEADLINE_MS / HOUR)
const POOL_INSPECT_D = Math.round(POOL_INSPECT_MS / DAY)
const POOL_ACCEPT_D = Math.round(POOL_VAULT_ACCEPT_MS / DAY)
const MK_SHIP_H = Math.round(SHIP_DEADLINE / HOUR)
const MK_DELIVER_D = Math.round(DELIVER_DEADLINE / DAY)
const MK_INSPECT_D = Math.round(INSPECT_WINDOW / DAY)

/** 錢的去向。tone 只有三種：還鎖著、進了該進的地方、出了事 */
type Tone = 'hold' | 'ok' | 'bad'

interface Cell { k: string; v: string }
interface Flow {
  /** 走到第幾段（1–4）。第 4 段一到就是已經結束的事實 */
  stage: 1 | 2 | 3 | 4
  /** 錢現在在哪，一個短語。長句留給下面那行 */
  where: string
  tone: Tone
  /** 站在看的人那一側的完整說明 */
  line: string
  /**
   * 「你不寄就拿不到」那一條。只有賣家還欠一張卡時才有值 ——
   * 它是這整塊存在的主要理由，所以獨立一行、獨立上色，不混進上面那段。
   */
  gate: string
  /** 第四段的名字跟著結局換 */
  endLabel: string
  money: Cell[]
}

const amt = computed(() => props.amount.toLocaleString())
const dep = computed(() => (props.deposit ?? 0).toLocaleString())

/* 抽卡池。held 是「買家還沒申請出貨」，它跟 awaiting_ship 的差別在賣家該不該
   現在就寄 —— 兩者都停在第一、二段，但講的話完全不同。 */
function poolFlow(): Flow {
  const s = props.status as SettlementStatus
  const seller = props.side === 'seller'
  switch (s) {
    case 'held':
      return {
        stage: 1, where: '平台保管中', tone: 'hold', endLabel: '完成',
        line: seller
          ? `買家還沒申請出貨，這 ${amt.value} 點票金凍結在平台。他一旦申請，就要你寄出才會入帳；${POOL_ACCEPT_D} 天內都沒申請則自動入你的帳。`
          : `你的 ${amt.value} 點票金凍結在平台。卡還在你的保管庫，你申請出貨之後賣家才需要寄。`,
        gate: '',
        money: [
          { k: '凍結在平台', v: `${amt.value} 點` },
          { k: seller ? '完成後入你的帳' : '完成後付給賣家', v: `${amt.value} 點` }
        ]
      }
    case 'awaiting_ship':
      return {
        stage: 2, where: '平台保管中', tone: 'hold', endLabel: '完成',
        line: seller
          ? `買家已經申請出貨，票金還凍結在平台。`
          : `等賣家寄出，你的 ${amt.value} 點還在平台保管，他現在拿不到。`,
        gate: seller
          ? `你寄出之前，這 ${amt.value} 點不會入你的帳。超過 ${POOL_SHIP_H} 小時沒寄，票金退還買家並記你一次違約。`
          : `賣家超過 ${POOL_SHIP_H} 小時沒寄出，這筆票金全額退回你的帳戶。`,
        money: [
          { k: '凍結在平台', v: `${amt.value} 點` },
          { k: seller ? '寄出並完成後入帳' : '完成後付給賣家', v: `${amt.value} 點` }
        ]
      }
    case 'shipped':
      return {
        stage: 3, where: '平台保管中', tone: 'hold', endLabel: '完成',
        line: seller
          ? `你已寄出，票金仍凍結在平台。買家確認收貨、或 ${POOL_INSPECT_D} 天鑑賞期滿，才會入你的帳。`
          : `賣家已寄出，你的 ${amt.value} 點仍由平台保管。你確認收貨、或 ${POOL_INSPECT_D} 天鑑賞期滿，才付給賣家。`,
        gate: '',
        money: [
          { k: '凍結在平台', v: `${amt.value} 點` },
          { k: seller ? '鑑賞期滿後入帳' : '鑑賞期滿後付給賣家', v: `${amt.value} 點` }
        ]
      }
    case 'released':
      return {
        stage: 4, where: seller ? '已入你的帳' : '已付給賣家',
        tone: props.owesCard ? 'hold' : 'ok', endLabel: seller ? '已入帳' : '已付款',
        line: seller
          ? `這 ${amt.value} 點票金已經入帳，變成可動用的點數。`
          : `這 ${amt.value} 點票金已經付給賣家，交易結束。`,
        /* F-5：錢進來了，卡還欠著。這一行不能少 —— 少了它，這一列在畫面上
           看起來就是「已完成」，而它其實還有一個逾期會記違約的出貨期限。 */
        gate: props.owesCard
          ? (seller
            ? '票金雖然已經入帳，這張卡你還沒寄出。逾期仍記你一次違約，票金不會因此退回買家。'
            : '賣家的票金已經入帳，但這張卡還沒寄出 —— 他逾期未寄會被記一次違約。')
          : '',
        money: [{ k: seller ? '已入你的帳' : '已付給賣家', v: `${amt.value} 點` }]
      }
    case 'refunded':
      return {
        stage: 4, where: '已退還買家', tone: 'bad', endLabel: '已退款',
        line: seller
          ? `你沒有在期限內寄出，這 ${amt.value} 點票金已經退還買家，並記了你一次違約。`
          : `賣家逾期未寄，這 ${amt.value} 點票金已經全額退回你的帳戶。`,
        gate: '',
        money: [{ k: seller ? '已退還買家' : '已退回你的帳戶', v: `${amt.value} 點` }]
      }
    case 'recycled':
      return {
        stage: 4, where: '票金已取消', tone: 'bad', endLabel: '已取消',
        line: seller
          ? `買家接受了買回價，卡回到你手上，這 ${amt.value} 點票金已經取消，不會入帳。`
          : `你接受了買回價，這 ${amt.value} 點票金已經取消，改以買回的點數入帳。`,
        gate: '',
        money: [{ k: '票金已取消', v: `${amt.value} 點` }]
      }
  }
}

/* 市場託管。跟池最大的差別是賣家另外押了一筆保證金 ——
   逾期未寄不只拿不到貨款，還會賠掉那一筆，所以它要出現在畫面上。 */
function marketFlow(): Flow {
  const s = props.status as OrderStatus
  const seller = props.side === 'seller'
  const hasDep = (props.deposit ?? 0) > 0
  /* 保證金那一格的內容只有三種結局，抽出來免得七個分支各寫一次 */
  const depCell = (state: 'lock' | 'take' | 'free'): Cell[] =>
    hasDep
      ? [{
        k: seller ? '你的保證金' : '賣家保證金',
        v: state === 'lock' ? `${dep.value} 點凍結中`
          : state === 'take' ? `${dep.value} 點已沒收`
            : `${dep.value} 點已解除`
      }]
      : []

  switch (s) {
    case 'escrowed':
      return {
        stage: 2, where: '凍結在託管', tone: 'hold', endLabel: '完成',
        line: seller
          ? `買家的 ${amt.value} 點貨款已經凍結在託管裡，你現在還拿不到。`
          : `等賣家寄出，你的 ${amt.value} 點還凍結在託管裡，他拿不走。`,
        gate: seller
          ? `你寄出之前，這 ${amt.value} 點不會放款給你。超過 ${MK_SHIP_H} 小時沒寄，訂單自動取消、貨款全額退還買家${hasDep ? `，並沒收你 ${dep.value} 點保證金` : ''}。`
          : `賣家超過 ${MK_SHIP_H} 小時沒寄出，這筆全額退回你的帳戶${hasDep ? '，他的保證金也會被沒收' : ''}。`,
        money: [
          { k: '凍結在託管', v: `${amt.value} 點` },
          ...depCell('lock')
        ]
      }
    case 'shipped':
      return {
        stage: 3, where: '凍結在託管', tone: 'hold', endLabel: '完成',
        line: seller
          ? `你已寄出，貨款仍凍結在託管。買家按下「我已收到」、或 ${MK_DELIVER_D} 天視同送達再過 ${MK_INSPECT_D} 天驗收期滿，才放款給你。`
          : `賣家已寄出，你的 ${amt.value} 點還鎖著。你按下「我已收到」的那一刻才放款給他。`,
        money: [
          { k: '凍結在託管', v: `${amt.value} 點` },
          ...depCell('lock')
        ],
        gate: ''
      }
    case 'delivered':
      return {
        stage: 3, where: '凍結在託管', tone: 'hold', endLabel: '完成',
        line: seller
          ? `已視同送達，${MK_INSPECT_D} 天驗收期跑著，貨款仍凍結。期滿沒有爭議就放款給你。`
          : `已視同送達，${MK_INSPECT_D} 天驗收期。期滿自動放款給賣家 —— 在那之前你都還可以申訴。`,
        money: [
          { k: '凍結在託管', v: `${amt.value} 點` },
          ...depCell('lock')
        ],
        gate: ''
      }
    case 'disputed':
      return {
        stage: 3, where: '凍結・爭議中', tone: 'bad', endLabel: '待裁決',
        line: seller
          ? `買家提出爭議，這 ${amt.value} 點維持凍結，兩邊都拿不到，等平台裁決。`
          : `你提出了爭議，這 ${amt.value} 點維持凍結，兩邊都拿不到。判你就全額退回，判賣家就放款給他。`,
        money: [
          { k: '凍結・兩邊都拿不到', v: `${amt.value} 點` },
          ...depCell('lock')
        ],
        gate: ''
      }
    case 'completed':
      return {
        stage: 4, where: seller ? '已入你的帳' : '已放款給賣家', tone: 'ok',
        endLabel: seller ? '已入帳' : '已放款',
        line: seller
          ? `這 ${amt.value} 點貨款已經放款入你的帳。`
          : `這 ${amt.value} 點已經放款給賣家，不再鎖在託管裡。`,
        money: [
          { k: seller ? '已入你的帳' : '已放款給賣家', v: `${amt.value} 點` },
          ...depCell('free')
        ],
        gate: ''
      }
    case 'refunded':
      return {
        stage: 4, where: '已退還買家', tone: 'bad', endLabel: '已退款',
        line: seller
          ? `爭議裁決判買家，這 ${amt.value} 點貨款已經退還買家${hasDep ? `，你的 ${dep.value} 點保證金已被沒收` : ''}。`
          : `爭議判你，這 ${amt.value} 點已經全額退回你的帳戶。`,
        money: [
          { k: seller ? '已退還買家' : '已退回你的帳戶', v: `${amt.value} 點` },
          ...depCell('take')
        ],
        gate: ''
      }
    case 'cancelled':
      return {
        stage: 4, where: '已退還買家', tone: 'bad', endLabel: '已取消',
        line: seller
          ? `你沒有在期限內寄出，這筆已經自動取消：${amt.value} 點貨款全額退還買家${hasDep ? `，你的 ${dep.value} 點保證金已被沒收` : ''}。`
          : `賣家逾期未寄，這筆已經自動取消，${amt.value} 點全額退回你的帳戶。`,
        money: [
          { k: seller ? '已退還買家' : '已退回你的帳戶', v: `${amt.value} 點` },
          ...depCell('take')
        ],
        gate: ''
      }
  }
}

const flow = computed<Flow>(() => (props.src === 'pool' ? poolFlow() : marketFlow()))

/** 四段的名字。第二段刻意兩側不同 —— 責任在誰身上是這一塊最重要的資訊 */
const steps = computed(() => [
  props.side === 'buyer' ? '你已付款' : '買家已付',
  props.side === 'seller' ? '等你寄出' : '等賣家寄出',
  props.src === 'pool' ? '鑑賞期' : '驗收期',
  flow.value.endLabel
])

/** 走過的段落填實、現在那段標出來、還沒到的留空 */
function stateOf(i: number) {
  const n = i + 1
  const st = flow.value.stage
  return n < st ? 'done' : n === st ? 'now' : 'todo'
}

/* 讀屏拿到的是一句完整的話，不是四個孤立的詞。
   進度條本身 aria-hidden —— 四個標籤逐字唸出來對聽的人沒有意義。 */
const srLine = computed(() =>
  `點數狀態：${flow.value.where}。${flow.value.line}${flow.value.gate ? ' ' + flow.value.gate : ''}`)
</script>

<template>
  <section class="pf" :class="flow.tone" :aria-label="srLine">
    <div class="pfHead">
      <span class="pfH">點數現在在哪裡</span>
      <span class="pfWhere">{{ flow.where }}</span>
    </div>

    <!-- 四段骨架。兩條路共用同一個形狀，使用者只要學一次 -->
    <ol class="pfRail" aria-hidden="true">
      <li v-for="(s, i) in steps" :key="i" :class="stateOf(i)">
        <span class="pfBar"></span>
        <span class="pfLb">{{ s }}</span>
      </li>
    </ol>

    <p class="pfLine" aria-hidden="true">{{ flow.line }}</p>

    <!-- 「你不寄就拿不到」。獨立一行、獨立上色：這是整塊存在的主要理由，
         混進上面那段就會被當成補充說明讀過去 -->
    <p v-if="flow.gate" class="pfGate" aria-hidden="true">{{ flow.gate }}</p>

    <!-- 金額。兩欄格線，minmax(0,1fr) 讓七位數也縮得下去 -->
    <ul class="pfMoney" aria-hidden="true">
      <li v-for="c in flow.money" :key="c.k">
        <span class="pfK">{{ c.k }}</span>
        <b class="pfV mono">{{ c.v }}</b>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* 訂單卡裡的一塊，不是主角：底色只比卡片深一階，不加邊框、不加陰影。
   左緣的色帶是唯一的顏色，因為「錢在誰手上」是這塊唯一要一眼看出的事。 */
.pf {
  margin-top: 10px; padding: 10px 11px;
  background: var(--surface-2); border-radius: var(--radius);
  min-width: 0;
}
.pf.hold { box-shadow: inset 2px 0 0 var(--gold); }
.pf.ok { box-shadow: inset 2px 0 0 var(--ok); }
.pf.bad { box-shadow: inset 2px 0 0 var(--danger); }

.pfHead {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; min-width: 0;
}
.pfH { font-size: 11px; color: var(--muted); flex: none; }
/* 短語不折行、但也不准把整列撐爆：超長時自己收成省略號 */
.pfWhere {
  min-width: 0; max-width: 60%;
  font-size: 11px; font-weight: 700; line-height: 1.4;
  padding: 3px 9px; border-radius: var(--pill);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: var(--surface-3); color: var(--muted);
}
.pf.hold .pfWhere { background: var(--warn-wash); color: var(--gold); }
.pf.ok .pfWhere { background: var(--ok-wash); color: var(--ok-ink); }
.pf.bad .pfWhere { background: var(--danger-wash); color: var(--danger-ink); }

/* 四段等寬。橫排而不是像買家那塊直排：這裡只有四個詞，直排會多長 80px，
   而它是配角。等寬也讓「現在在第幾段」用位置就看得出來。 */
.pfRail {
  list-style: none; margin: 9px 0 0; padding: 0;
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px;
}
.pfRail li { min-width: 0; }
.pfBar { display: block; height: 4px; border-radius: var(--pill); background: var(--surface-3); }
.pfRail .done .pfBar { background: var(--ok); }
.pfRail .now .pfBar { background: var(--gold); }
.pf.bad .pfRail .now .pfBar { background: var(--danger); }
.pfLb {
  display: block; margin-top: 4px;
  font-size: 10px; line-height: 1.35; color: var(--faint);
  /* 「等賣家寄出」在 393px 上是一欄 80px，五個字剛好要折兩行 ——
     折就折，但不准溢出，也不准把兄弟欄擠掉 */
  overflow-wrap: anywhere;
}
.pfRail .done .pfLb { color: var(--muted); }
.pfRail .now .pfLb { color: var(--ink); font-weight: 600; }

.pfLine {
  font-size: 11.5px; line-height: 1.75; color: var(--muted);
  margin: 9px 0 0; min-width: 0; overflow-wrap: anywhere;
}

/* 這一行用 warn 不用 danger：賣家沒做錯事，只是還沒做。
   紅字會讀成「已經出事了」，而真正出事的那幾種狀態走的是 .pf.bad。 */
.pfGate {
  margin: 8px 0 0; padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--warn-wash); color: var(--warn-ink);
  font-size: 11.5px; line-height: 1.7; min-width: 0; overflow-wrap: anywhere;
}
.pf.bad .pfGate { background: var(--danger-wash); color: var(--danger-ink); }

.pfMoney {
  list-style: none; margin: 9px 0 0; padding: 0;
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px;
}
.pfMoney li {
  min-width: 0; padding: 7px 9px;
  background: var(--surface); border-radius: 12px;
}
.pfK { display: block; font-size: 10.5px; line-height: 1.4; color: var(--muted); overflow-wrap: anywhere; }
.pfV { display: block; margin-top: 2px; font-size: 13px; color: var(--ink); overflow-wrap: anywhere; }

/* 只有一格時不要拉成半寬孤兒 —— 讓它佔滿整列 */
.pfMoney li:only-child { grid-column: 1 / -1; }
</style>
