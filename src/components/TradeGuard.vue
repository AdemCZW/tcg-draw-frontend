<script setup lang="ts">
/**
 * 交易保護說明。
 *
 * 刻意不做成獨立的規則頁：規則頁沒有人會點進去看，而爭議發生時
 * 「我不知道有這條」就是最常見的抗辯。所以規則出現在它真正有用的時刻 ——
 * 逛市場的時候看到摘要，要買的時候看到這筆會被鎖多少、多久放款。
 *
 * 完整條文收在 <details> 裡，同一個畫面就能展開，不用換頁。
 */
defineProps<{ open?: boolean }>()
</script>

<template>
  <section class="guard" aria-labelledby="guardTitle">
    <header class="gh">
      <span class="shield" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" /></svg>
      </span>
      <div>
        <h2 id="guardTitle">交易保護</h2>
        <p class="sub">錢先鎖在平台，賣家收不到；出問題退你點數</p>
      </div>
    </header>

    <div class="lanes">
      <div class="lane vault">
        <span class="lt">庫內轉移</span>
        <p>卡還在保管庫，成交即完成過戶。<strong>沒有運送，也沒有被騙的空間。</strong></p>
      </div>
      <div class="lane ship">
        <span class="lt">需寄送</span>
        <p>卡在賣家手上。點數全額凍結，<strong>確認收貨後才放款</strong>給賣家。</p>
      </div>
    </div>

    <details :open="open">
      <summary>需寄送的完整規則</summary>
      <div class="rules">
        <ol class="flow">
          <li><b>下單</b>：點數 100% 凍結，賣家一點都拿不到</li>
          <li><b>出貨</b>：賣家須上傳可查證的物流單號與含鑑定編號的出貨照，否則無法標記出貨</li>
          <li><b>送達</b>：物流簽收後進入 7 天驗收期</li>
          <li><b>放款</b>：你確認收貨，或 7 天期滿自動放款</li>
        </ol>

        <table class="tt">
          <caption class="sr">時限</caption>
          <tbody>
            <tr><th scope="row">賣家未出貨</th><td><b>72 小時</b>自動取消退款</td></tr>
            <tr><th scope="row">物流查無送達</th><td><b>14 天</b>自動退款</td></tr>
            <tr><th scope="row">送達後驗收</th><td><b>7 天</b>，期滿自動放款</td></tr>
          </tbody>
        </table>

        <p class="warn">
          <b>要申請退款必須附開箱影片</b> —— 未剪輯、從封箱狀態開始、拍到面單與鑑定編號。
          買東西不強制錄影，但沒有影片無法受理索賠。
        </p>
        <p class="fine">
          鑑定卡每個殼有唯一編號，出貨與退貨都要拍到編號，
          「寄出的是不是同一張」因此可以查證，不會變成各說各話。
          站外交易不在保護範圍內。
        </p>
      </div>
    </details>
  </section>
</template>

<style scoped>
.guard {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 16px 16px 14px;
  margin-bottom: 20px;
}
.gh { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
.shield {
  flex: none; width: 34px; height: 34px;
  display: grid; place-items: center;
  border-radius: 10px;
  background: var(--ok-wash); color: var(--ok);
}
.shield svg {
  width: 19px; height: 19px;
  fill: none; stroke: currentColor; stroke-width: 1.9;
  stroke-linecap: round; stroke-linejoin: round;
}
h2 { font-size: 15px; margin: 0 0 2px; }
.sub { font-size: 12.5px; line-height: 1.6; color: var(--muted); margin: 0; }

.lanes { display: grid; gap: 8px; margin-bottom: 12px; }
@media (min-width: 540px) { .lanes { grid-template-columns: 1fr 1fr; } }
.lane {
  border-radius: 10px;
  padding: 11px 13px;
  background: var(--surface);
  box-shadow: inset 2px 0 0 var(--line);
}
.lane.vault { box-shadow: inset 2px 0 0 var(--ok); }
.lane.ship { box-shadow: inset 2px 0 0 var(--accent); }
.lt { display: block; font-size: 12px; font-weight: 700; margin-bottom: 3px; }
.lane.vault .lt { color: var(--ok); }
.lane.ship .lt { color: var(--accent); }
.lane p { font-size: 12.5px; line-height: 1.65; color: var(--muted); margin: 0; }
.lane strong { color: var(--ink); font-weight: 600; }

details { border-top: 1px solid var(--line); padding-top: 10px; }
summary {
  font-size: 13px; font-weight: 600; color: var(--ink);
  cursor: pointer; list-style: none;
  display: flex; align-items: center; gap: 6px;
  min-height: 32px;
}
summary::-webkit-details-marker { display: none; }
summary::before {
  content: ''; width: 6px; height: 6px; flex: none;
  border-right: 1.8px solid var(--muted); border-bottom: 1.8px solid var(--muted);
  transform: rotate(-45deg); transition: transform .18s ease;
  margin-left: 2px;
}
details[open] summary::before { transform: rotate(45deg); }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }

.rules { padding: 6px 0 2px; }
.flow { margin: 0 0 12px; padding-left: 20px; }
.flow li { font-size: 12.5px; line-height: 1.7; color: var(--muted); margin-bottom: 5px; }
.flow b { color: var(--ink); }

.tt { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
.tt th, .tt td {
  font-size: 12.5px; line-height: 1.6; text-align: left;
  padding: 7px 0; border-bottom: 1px solid var(--line);
  font-weight: 400; color: var(--muted);
}
.tt tr:last-child th, .tt tr:last-child td { border-bottom: none; }
.tt th { white-space: nowrap; padding-right: 14px; }
.tt td b { color: var(--ink); font-variant-numeric: tabular-nums; }

.warn {
  font-size: 12.5px; line-height: 1.7; margin: 0 0 10px;
  color: var(--muted);
  background: var(--warn-wash, var(--surface-3));
  border-radius: 8px; padding: 10px 12px;
}
.warn b { color: var(--ink); }
.fine { font-size: 12px; line-height: 1.7; color: var(--muted); margin: 0; }

.sr {
  position: absolute; width: 1px; height: 1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
}
</style>
