<script setup lang="ts">
/**
 * 交易保護機制的完整規格頁。
 *
 * 跟市場頁裡的 TradeGuard 分工不同：那個是給買家在下單當下看的摘要，
 * 這一頁是給人「完整看過一遍」用的 —— 商家洽談、對外說明、內部對規格。
 * 所以這裡放的是完整流程與判定表，不是行銷話術。
 *
 * 沒有掛進導覽列：它不是使用者日常會用的功能，是要用連結分享出去的。
 */
type Pair = { risk: string; fix: string }
type Step = { n: string; title: string; what: string; pairs: Pair[] }

const STEPS: Step[] = [
  {
    n: '00', title: '卡片登錄',
    what: '賣家選擇卡片來源。自持卡必須填鑑定機構、鑑定編號、分數、卡名與卡號；系統校驗編號格式，並比對鑑定機構的公開查詢結果是否與填寫內容一致。',
    pairs: [
      { risk: '一卡多賣：同一張卡同時掛在多筆訂單或多個平台', fix: '鑑定編號在系統內唯一 —— 同一個編號同時只能存在一筆有效掛單，資料庫層下唯一性約束' },
      { risk: '假鑑定殼：自製或翻新的偽造壓克力殼', fix: '編號必須在鑑定機構查得到，且卡名與分數相符才准上架' },
      { risk: '盜圖：拿別人的卡照上架，實際手上沒有卡', fix: '要求實拍且編號可辨識；對上傳圖做感知雜湊，比對站內既有圖片與已知官方圖' },
      { risk: '新帳號一次開大量高價假單後消失', fix: '新賣家設單筆金額上限與同時掛單數上限，隨成交紀錄逐步放寬' }
    ]
  },
  {
    n: '01', title: '上架',
    what: '設定售價、運費與承諾出貨天數。系統依賣家等級決定保證金額度。',
    pairs: [
      { risk: '站外交易：用低價把人引到站外私下匯款，這是所有平台最常見的規避手段', fix: '站內訊息過濾電話與通訊軟體 ID；明確標示站外交易不受保護；查證後停權' },
      { risk: '釣魚低價：遠低於市價的掛單吸引下單後失聯', fix: '價格顯著低於市值時不直接公開，先進人工審核佇列' },
      { risk: '保證金把供給擋死：只想賣一張卡的人餘額是 0，被迫先儲值才能上架', fix: '保證金優先從賣家「待放款的其他筆貨款」抵充，其次才要求另外凍結。活躍賣家幾乎無感，只賣一筆就跑的人自然擋得住' }
    ]
  },
  {
    n: '02', title: '下單與鎖點',
    what: '買家下單，貨款與運費 100% 自買家帳戶凍結（凍結不是扣款）；賣家保證金同步凍結；卡片狀態由 available 轉為 reserved；出貨倒數開始。',
    pairs: [
      { risk: '只鎖部分貨款：賣家先入袋大半，不出貨的損失小於詐騙所得，等於沒有託管', fix: '全額凍結，放款前一點都不釋出。「比例」只用在保證金，不用在貨款' },
      { risk: '併發：兩個人同時搶同一張卡，兩筆都成立', fix: '用條件式更新（只有狀態仍是 available 時才能改成 reserved），只有一個人會成功；狀態變更與凍結點數必須在同一個交易內，避免扣了點卻沒鎖到卡' },
      { risk: '下單佔位不付款，把卡卡住不讓別人買', fix: '凍結是下單當下同步完成的，沒有「先下單、後付款」的空窗；凍結失敗即回滾，卡片退回上架中' }
    ]
  },
  {
    n: '03', title: '出貨',
    what: '賣家上傳出貨前照片（正反面、鑑定編號需清晰可辨識）、包裝過程照，以及物流單號。系統即時向物流查詢單號是否真實存在。',
    pairs: [
      { risk: '填假單號或舊單號，拖過驗收期自動放款', fix: '單號必須查得到，且交寄時間晚於訂單成立時間；同一單號不得用於兩筆訂單' },
      { risk: '寄空包裹或寄不相干的輕物', fix: '出貨照必須含可辨識編號；高單價強制保價與本人簽收；若物流提供重量資訊，異常輕重自動標記' },
      { risk: '宣稱已寄出但根本沒交寄', fix: '沒有通過驗證的單號就不能標記為已出貨，系統直接不給按' }
    ]
  },
  {
    n: '04', title: '運送中',
    what: '系統輪詢物流狀態直到顯示簽收。',
    pairs: [
      { risk: '包裹遺失，責任歸屬沒有事先講清楚，變成三方互推', fix: '事前寫明：單號已進入物流系統後遺失，平台先退買家、再向物流與保價求償，不扣賣家保證金；單號從未進入系統則視同未出貨並扣保證金' },
      { risk: '訂單無限期卡在運送中', fix: '14 天查無送達自動退款買家、解除凍結' }
    ]
  },
  {
    n: '05', title: '送達與驗收',
    what: '物流顯示簽收後進入 7 天驗收期。買家可以確認收貨（立即放款）、開爭議（須附開箱影片），或什麼都不做（期滿自動放款）。',
    pairs: [
      { risk: '買家挾持賣家：收到卡後單純不按確認，賣家的錢永遠卡著，還能拿來要脅退款', fix: '期滿自動放款。關鍵在把「不動作」的預設結果從凍結改成放款 —— 買家有意見必須主動開爭議，沉默不再是武器' },
      { risk: '事後編故事索賠：收到貨才宣稱是空盒或假卡', fix: '把舉證義務綁在「開爭議」而不是「交易」上 —— 買賣照常不強制錄影，但要索賠就必須附完整未剪輯的開箱影片。一般交易零摩擦，想索賠的人自己有動機錄' },
      { risk: '代收簽收，買家主張本人未收到', fix: '高單價要求本人簽收；代收爭議一律依物流簽收紀錄認定' }
    ]
  },
  {
    n: '06', title: '爭議判定',
    what: '訂單凍結，雙方 48 小時補件，平台依事前公開的判定表裁決。',
    pairs: [
      { risk: '退貨掉包：買家收到真卡，退回一張假卡或普卡，這是卡片圈最經典的手法', fix: '退貨同樣要單號與開箱錄影，且退回的鑑定編號必須與出貨編號一致。一般商品的掉包無解，因為兩件東西長得一樣；鑑定卡每個殼有唯一編號，「是不是同一張」是可查證的事實' },
      { risk: '裁決被質疑不公，每一起都變成臨時判斷', fix: '判定表在上架與下單時都要看得到；裁決只能套表，不能個案自由心證' },
      { risk: '同一批人反覆用同樣手法', fix: '爭議結果記入帳號紀錄，直接影響保證金等級與金額上限' }
    ]
  },
  {
    n: '07', title: '放款結案',
    what: '解除賣家貨款凍結、扣除手續費、退還保證金，雙方互評。',
    pairs: [
      { risk: '結案後才發現是詐欺', fix: '保留有限的事後申訴管道，但門檻限縮到「詐欺且有新事證」，避免結案狀態失去意義' },
      { risk: '自買自賣洗評價與洗成交價', fix: '偵測同裝置、同儲值來源、關聯帳號之間的成對交易，標記後不計入評價與市價統計' }
    ]
  }
]

const TIMERS = [
  { at: '下單後出貨', t: '72 小時', then: '自動取消、全額退買家、扣賣家保證金' },
  { at: '出貨後送達', t: '14 天', then: '查無送達則自動退買家' },
  { at: '送達後驗收', t: '7 天', then: '自動放款給賣家' },
  { at: '爭議補件', t: '48 小時', then: '依現有證據裁決' },
  { at: '爭議裁決', t: '5 個工作日', then: '對外承諾的處理時間' }
]

const VERDICTS = [
  { photo: 'yes', ship: 'yes', video: 'no', videoText: '無', to: '賣家' },
  { photo: 'yes', ship: 'yes', video: 'yes', videoText: '有，顯示空盒或編號不符', to: '買家' },
  { photo: 'no', ship: 'yes', video: 'yes', videoText: '有', to: '買家' },
  { photo: 'na', ship: 'no', video: 'na', videoText: '—', to: '買家（視同未出貨）' }
] as const
</script>

<template>
  <div class="container page doc">
    <header class="dh">
      <p class="eyebrow">交易安全規格</p>
      <h1>從上架到買家收貨的完整機制</h1>
      <p class="lede">
        每一步發生什麼、每一步該擋掉哪一種手法，
        以及讓「不動作」不會變成武器的時限設計。
      </p>
    </header>

    <section>
      <h2>先分流：兩條通道</h2>
      <p>大多數爭議來自「錢和貨不同時間到位」。卡片如果從頭到尾沒離開保管庫，這個時間差不存在，下面整套流程都不需要。</p>
      <div class="lanes">
        <div class="lane vault">
          <span class="lt">預設路徑</span>
          <h3>庫內轉移</h3>
          <p>卡還在保管庫。交易是一筆資料庫異動：扣買家點數、加賣家點數、改所有權，同一個交易內完成，全成功或全失敗。</p>
          <p><b>沒有運送、沒有驗收期、沒有保證金、沒有爭議。</b>手續費應該最低，用來把使用者導向這條路。</p>
        </div>
        <div class="lane ship">
          <span class="lt">例外路徑</span>
          <h3>實體出貨</h3>
          <p>卡已經被提領到使用者手上，必須實際寄送。付款與交付之間出現時間差，以下所有機制都是為了填這個差。</p>
          <p><b>手續費較高、流程較慢</b>，反映它真實的處理成本與風險。</p>
        </div>
      </div>
    </section>

    <section>
      <h2>實體出貨的狀態機</h2>
      <figure>
        <div class="figbox">
          <svg class="flow" viewBox="0 0 980 320" role="img"
               aria-label="訂單狀態流程：上架中經下單鎖點、出貨、送達到完成，失敗路徑走退款結案，送達後七天內可開爭議">
            <defs>
              <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <polygon class="ah" points="0,1 10,5 0,9" />
              </marker>
              <marker id="ahg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <polygon class="ahg" points="0,1 10,5 0,9" />
              </marker>
              <marker id="ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <polygon class="ahb" points="0,1 10,5 0,9" />
              </marker>
            </defs>

            <rect class="node" x="24" y="100" width="120" height="46" rx="7" />
            <text class="nl" x="84" y="128">上架中</text>
            <rect class="node" x="224" y="100" width="120" height="46" rx="7" />
            <text class="nl" x="284" y="128">已鎖點</text>
            <rect class="node" x="424" y="100" width="120" height="46" rx="7" />
            <text class="nl" x="484" y="128">已出貨</text>
            <rect class="node" x="624" y="100" width="120" height="46" rx="7" />
            <text class="nl" x="684" y="128">已送達</text>
            <rect class="node ok" x="824" y="100" width="130" height="46" rx="7" />
            <text class="nl" x="889" y="128">已完成</text>
            <rect class="node bad" x="409" y="250" width="150" height="46" rx="7" />
            <text class="nl" x="484" y="278">退款結案</text>
            <rect class="node" x="624" y="250" width="140" height="46" rx="7" />
            <text class="nl" x="694" y="278">爭議中</text>

            <line class="e" x1="144" y1="123" x2="218" y2="123" marker-end="url(#ah)" />
            <text class="el" x="184" y="105">下單</text>
            <text class="el" x="184" y="91">凍結 100%</text>

            <line class="e" x1="344" y1="123" x2="418" y2="123" marker-end="url(#ah)" />
            <text class="el" x="384" y="105">上傳單號</text>
            <text class="el" x="384" y="91">72h 內</text>

            <line class="e" x1="544" y1="123" x2="618" y2="123" marker-end="url(#ah)" />
            <text class="el" x="584" y="105">物流簽收</text>

            <line class="e gold" x1="744" y1="123" x2="818" y2="123" marker-end="url(#ahg)" />
            <text class="el gold" x="784" y="105">確認 or</text>
            <text class="el gold" x="784" y="91">7 天自動</text>

            <polyline class="e bad" points="284,146 284,273 403,273" marker-end="url(#ahb)" />
            <text class="el bad" x="276" y="196" text-anchor="end">72h 未出貨</text>

            <line class="e bad" x1="484" y1="146" x2="484" y2="244" marker-end="url(#ahb)" />
            <text class="el bad" x="494" y="200" text-anchor="start">14 天查無送達</text>

            <line class="e" x1="684" y1="146" x2="684" y2="244" marker-end="url(#ah)" />
            <text class="el" x="694" y="196" text-anchor="start">7 天內開爭議</text>
            <text class="el" x="694" y="210" text-anchor="start">＋開箱影片</text>

            <line class="e" x1="624" y1="273" x2="565" y2="273" marker-end="url(#ah)" />
            <text class="el" x="594" y="264">判買家</text>

            <line class="e" x1="764" y1="266" x2="878" y2="152" marker-end="url(#ah)" />
            <text class="el" x="840" y="222" text-anchor="start">判賣家</text>
          </svg>
        </div>
        <figcaption>
          金色那條是整套機制的關鍵：買家不動作時，訂單會自動走向放款，而不是無限期凍結。虛線是失敗路徑。
        </figcaption>
      </figure>
    </section>

    <section>
      <h2>逐步拆解</h2>
      <p class="sub">步驟編號是真實順序，訂單只能依序前進。</p>

      <article v-for="s in STEPS" :key="s.n" class="step">
        <div class="sh"><span class="num">{{ s.n }}</span><h3>{{ s.title }}</h3></div>
        <p class="what">{{ s.what }}</p>
        <div class="pairs">
          <div v-for="(p, i) in s.pairs" :key="i" class="pair">
            <div class="risk"><span class="lab">風險</span>{{ p.risk }}</div>
            <div class="fix"><span class="lab">防範</span>{{ p.fix }}</div>
          </div>
        </div>
      </article>
    </section>

    <section>
      <h2>時限總表</h2>
      <div class="tw">
        <table>
          <thead><tr><th>節點</th><th>時限</th><th>逾期後果</th></tr></thead>
          <tbody>
            <tr v-for="t in TIMERS" :key="t.at">
              <td>{{ t.at }}</td>
              <td class="t">{{ t.t }}</td>
              <td>{{ t.then }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>爭議判定表</h2>
      <p>這張表要在上架與下單時就給雙方看到。它能成立的原因是鑑定編號讓卡片可被唯一識別。</p>
      <div class="tw">
        <table>
          <thead>
            <tr>
              <th>賣家出貨照<br><span class="th2">（編號可辨識）</span></th>
              <th>物流顯示送達</th><th>買家開箱影片</th><th>判給</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(v, i) in VERDICTS" :key="i">
              <td :class="v.photo"><span>{{ v.photo === 'yes' ? '有' : v.photo === 'no' ? '無' : '—' }}</span></td>
              <td :class="v.ship"><span>{{ v.ship === 'yes' ? '有' : '無' }}</span></td>
              <td :class="v.video">{{ v.videoText }}</td>
              <td class="to">{{ v.to }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>貫穿全流程的風控</h2>
      <ul class="bullets">
        <li><b>事件日誌</b>：所有狀態變更與證據上傳都寫成只能追加、不能修改的事件流。爭議發生時，這條事件鏈本身就是證據。</li>
        <li><b>站外交易偵測</b>：訊息內容過濾，以及「大量對話但零成交」的帳號對。</li>
        <li><b>關聯帳號偵測</b>：同裝置、同儲值來源、同收件地址之間的成對交易。</li>
        <li><b>一卡多賣偵測</b>：同一鑑定編號在系統內的所有歷史掛單與所有權變化。</li>
      </ul>
    </section>

    <section>
      <h2>還沒定的三件事</h2>
      <div class="open">
        <p><b>保證金比例。</b>建議新賣家 10%、一般賣家 5%、高信譽或已驗證商家 0–2%，而且一定要設絕對值上限 —— 不設的話高單價卡會被門檻直接擋死。</p>
        <p><b>沒收保證金的條款。</b>點數是使用者用真錢買的，沒有明確約定就扣會有爭議，條款要事前寫死並讓使用者確認。</p>
        <p><b>代管交易款項的法遵定位。</b>替買賣雙方保管交易款項在台灣本身就是受規範的行為。本平台點數不可提領、真錢在儲值時就已入帳，性質接近預付型商品而非代收轉付，但這條界線須由律師確認。</p>
      </div>
    </section>

    <footer class="df">
      本規格涵蓋實體出貨通道。庫內轉移不經過本流程，也不需要保證金與爭議機制。
    </footer>
  </div>
</template>

<style scoped>
.doc { padding-bottom: calc(48px + var(--safe-b)); }
.dh { padding: 8px 0 22px; border-bottom: 2px solid var(--ink); margin-bottom: 8px; }
.eyebrow {
  font-family: var(--font-mono); font-size: 11.5px; letter-spacing: .14em;
  color: var(--muted); margin: 0 0 10px;
}
h1 { font-size: clamp(24px, 6vw, 34px); line-height: 1.3; margin: 0 0 12px; text-wrap: balance; }
.lede { font-size: 15.5px; line-height: 1.85; color: var(--ink); margin: 0; max-width: 60ch; }

section { padding-top: 26px; }
h2 {
  font-size: 19px; margin: 22px 0 8px; padding-top: 18px;
  border-top: 1px solid var(--line); text-wrap: balance;
}
section:first-of-type h2 { border-top: none; padding-top: 0; margin-top: 8px; }
h3 { font-size: 15.5px; margin: 0; }
p { font-size: 14.5px; line-height: 1.85; color: var(--muted); margin: 0 0 12px; max-width: 62ch; }
p b, li b { color: var(--ink); font-weight: 700; }
.sub { font-size: 13px; }

.lanes { display: grid; gap: 12px; margin: 16px 0 6px; }
@media (min-width: 700px) { .lanes { grid-template-columns: 1fr 1fr; } }
.lane { background: var(--surface); border-radius: var(--radius-lg); padding: 18px 20px; }
.lane.vault { box-shadow: inset 3px 0 0 var(--ok); }
.lane.ship { box-shadow: inset 3px 0 0 var(--accent); }
.lt { display: block; font-size: 11px; font-weight: 700; letter-spacing: .06em; margin-bottom: 6px; }
.lane.vault .lt { color: var(--ok); }
.lane.ship .lt { color: var(--accent); }
.lane h3 { margin-bottom: 8px; }
.lane p { font-size: 13.5px; margin-bottom: 8px; }
.lane p:last-child { margin-bottom: 0; }

figure { margin: 18px 0 0; }
.figbox {
  background: var(--surface); border-radius: var(--radius-lg);
  padding: 16px 12px; overflow-x: auto;
}
.flow { display: block; width: 100%; min-width: 720px; height: auto; color: var(--muted); }
.node { fill: var(--surface-2); stroke: currentColor; stroke-width: 1.4; }
.node.ok { fill: var(--ok-wash); stroke: var(--ok); stroke-width: 1.6; }
.node.bad { fill: var(--danger-wash); stroke: var(--danger); stroke-width: 1.4; }
.nl { fill: var(--ink); font-size: 13px; font-weight: 600; text-anchor: middle; }
.el { fill: var(--muted); font-size: 11px; text-anchor: middle; }
.el.gold { fill: var(--gold); font-weight: 700; }
.el.bad { fill: var(--danger); }
.e { stroke: currentColor; stroke-width: 1.5; fill: none; }
.e.gold { stroke: var(--gold); stroke-width: 2.4; }
.e.bad { stroke: var(--danger); stroke-dasharray: 5 4; }
.ah { fill: currentColor; } .ahg { fill: var(--gold); } .ahb { fill: var(--danger); }
figcaption { font-size: 13px; line-height: 1.75; color: var(--muted); margin-top: 10px; max-width: 62ch; }

.step { background: var(--surface); border-radius: var(--radius-lg); padding: 18px 20px; margin: 14px 0; }
.sh { display: flex; gap: 12px; align-items: baseline; margin-bottom: 8px; }
.num {
  font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  color: var(--gold); background: var(--surface-3);
  border-radius: 6px; padding: 2px 8px; flex: none;
}
.what { font-size: 14px; color: var(--ink); margin-bottom: 14px; max-width: none; }
.pairs { display: grid; gap: 10px; }
.pair {
  display: grid; gap: 6px 18px; grid-template-columns: 1fr;
  padding-top: 12px; border-top: 1px dashed var(--line-soft);
}
@media (min-width: 760px) { .pair { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); } }
.pair > div { font-size: 13.5px; line-height: 1.78; color: var(--muted); }
.lab {
  display: block; font-family: var(--font-mono); font-size: 10px;
  letter-spacing: .1em; margin-bottom: 3px;
}
.risk .lab { color: var(--danger); }
.fix .lab { color: var(--ok); }

.tw { overflow-x: auto; background: var(--surface); border-radius: var(--radius-lg); margin: 14px 0; }
table { border-collapse: collapse; width: 100%; min-width: 480px; font-size: 13.5px; }
th, td { padding: 11px 14px; text-align: left; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
th { background: var(--surface-2); font-size: 12px; color: var(--muted); font-weight: 700; white-space: nowrap; }
.th2 { font-weight: 400; font-size: 11px; }
td { color: var(--muted); }
tr:last-child td { border-bottom: none; }
td.t { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--gold); font-weight: 700; white-space: nowrap; }
td.yes span { color: var(--ok); font-weight: 700; }
td.no span { color: var(--danger); font-weight: 700; }
td.to { color: var(--ink); font-weight: 700; white-space: nowrap; }

.bullets { margin: 0; padding-left: 20px; max-width: 62ch; }
.bullets li { font-size: 14px; line-height: 1.8; color: var(--muted); margin-bottom: 8px; }

.open { background: var(--surface-2); border-left: 3px solid var(--gold); border-radius: 0 var(--radius) var(--radius) 0; padding: 16px 18px; }
.open p { font-size: 13.5px; margin: 0; max-width: none; }
.open p + p { margin-top: 10px; }

.df { margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
</style>
