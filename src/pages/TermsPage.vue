<script setup lang="ts">
/**
 * 會員條款。
 *
 * 這一頁的每一條規則都是從**程式碼實際的行為**寫出來的，不是抄範本。
 * 依據逐條列在頁面最後的「條文依據」摺疊區裡，格式是「檔案:行」。
 * 改動系統行為（時限、門檻、金額）時要回來對一次 —— 條款寫錯的後果比
 * UI 寫錯嚴重：那是對外的承諾。
 *
 * 幾個刻意的決定：
 *
 * 1) 公司資訊留空。營業人名稱、統編、地址、負責人、客服信箱、管轄法院
 *    這些我們無從得知，編一份出來比留白危險得多。用 .blank 區塊標成
 *    ⟨待填⟩，正式營運前必須補齊。
 *
 * 2) 查不到依據的一律不寫。典型例：站上沒有任何年齡驗證的程式碼
 *    （users.birthday 選填，auth.ts 只驗日期合不合理），所以第三節寫的是
 *    「我們目前不驗證」，而不是假裝有一道閘門。
 *
 * 3) 頁尾那句「本文件由程式行為草擬，正式營運前應由法律專業人士審閱」
 *    不可以拿掉。這份文件沒有經過律師。
 *
 * 走 chrome: 'full'（跟 /trade-protection 不同）—— 頁尾的連結指到這裡，
 * 讀完要回得去。版面沿用 TradeProtectionPage 的 .doc 骨架。
 */

/** 目錄。id 同時是 <section> 的錨點，兩邊只有這一份來源 */
const TOC = [
  { id: 't-who', title: '一、這份條款是誰跟誰的約定' },
  { id: 't-account', title: '二、帳號' },
  { id: 't-age', title: '三、年齡' },
  { id: 't-points', title: '四、點數' },
  { id: 't-draw', title: '五、抽選' },
  { id: 't-fair', title: '六、公平性承諾' },
  { id: 't-prize', title: '七、抽到之後的四條路' },
  { id: 't-buyback', title: '八、買回價是賣家的承諾' },
  { id: 't-pool-ship', title: '九、抽選卡的出貨與結算' },
  { id: 't-market', title: '十、市場的託管交易' },
  { id: 't-dispute', title: '十一、爭議處理' },
  { id: 't-default', title: '十二、違約與帳號處置' },
  { id: 't-notify', title: '十三、我們會主動通知你的事' },
  { id: 't-limits', title: '十四、我們沒有提供的事' },
  { id: 't-change', title: '十五、條款變更與準據法' }
]

/** 抽選卡（池）這條路的時限。數字全部來自 shared/pool-settlement.ts 的常數 */
const POOL_TIMERS = [
  { at: '抽到卡之後一直沒申請出貨', t: '14 天', then: '視為接受寄存保管，票金釋放給賣家。你之後仍然可以申請出貨，賣家的出貨義務不會消失' },
  { at: '你申請出貨後，賣家要寄出', t: '72 小時', then: '逾期票金退還給你，並記賣家一次違約' },
  { at: '賣家寄出後的鑑賞期', t: '7 天', then: '期滿票金釋放給賣家' },
  { at: '卡片留在保管庫的寄存期', t: '90 天', then: '到期前 14 天會先通知你' },
  { at: '池的販售期限', t: '預設 14 天，最長 90 天', then: '到期只停止販售，已抽出的卡照樣走完出貨與鑑賞期' }
]

/** 市場託管訂單的時限。數字全部來自 shared/escrow.ts 的常數 */
const MARKET_TIMERS = [
  { at: '下單後，賣家要出貨', t: '72 小時', then: '自動取消、全額退款給買家、沒收賣家保證金' },
  { at: '出貨後的送達期', t: '14 天', then: '期滿視同送達，接著進入 7 天驗收期（不是自動退款）' },
  { at: '送達後的驗收期', t: '7 天', then: '期滿自動放款給賣家' },
  { at: '開爭議後雙方補件', t: '48 小時', then: '逾期由平台依現有證據裁決，系統不會自動判給任何一方' }
]

/** 賣家保證金比例。來自 escrow.ts 的 depositFor()，只用在市場託管訂單 */
const DEPOSIT = [
  { who: '已完成訂單少於 10 筆', rate: '10%' },
  { who: '10 至 49 筆', rate: '5%' },
  { who: '50 筆以上', rate: '2%' }
]
</script>

<template>
  <div class="container page doc">
    <header class="dh">
      <p class="eyebrow">會員條款</p>
      <h1>使用 VaultDraw 之前，請先讀完這一份</h1>
      <p class="lede">
        這份條款寫的是這個平台實際會怎麼做：點數是什麼、抽選怎麼決定、
        誰欠你什麼、什麼時候錢會動、出了問題怎麼判。
        每一條都對得上系統的實際行為，沒有寫進來的事就是我們沒有承諾。
      </p>
    </header>

    <div class="blank" role="note">
      <p class="bt">⟨待填⟩ 營運主體資訊</p>
      <p>
        以下欄位必須由營運者填寫後才能對外正式適用。我們不代填，也不猜：
      </p>
      <ul>
        <li>公司／商號名稱：⟨待填⟩</li>
        <li>統一編號：⟨待填⟩</li>
        <li>營業地址：⟨待填⟩</li>
        <li>負責人：⟨待填⟩</li>
        <li>客服聯絡信箱：⟨待填⟩</li>
        <li>合意管轄法院：⟨待填⟩</li>
      </ul>
    </div>

    <nav class="toc" aria-label="目錄">
      <p class="tt">目錄</p>
      <ol>
        <li v-for="s in TOC" :key="s.id"><a :href="`#${s.id}`">{{ s.title }}</a></li>
      </ol>
    </nav>

    <section id="t-who">
      <h2>一、這份條款是誰跟誰的約定</h2>
      <p>
        這份條款是<b>你</b>與<b>平台營運者</b>（上方待填欄位所指的主體）之間的約定。
        你註冊帳號、或在未註冊的狀態下瀏覽本站，就表示你接受這份條款。
      </p>
      <p>
        站上另外有兩份文件跟這一份一起適用，內容衝突時以本條款為準：
        <RouterLink :to="{ name: 'privacy' }">隱私權政策</RouterLink>（我們怎麼處理你的個人資料）與
        <RouterLink :to="{ name: 'trade-protection' }">交易保護機制</RouterLink>（託管交易每一步的完整規格）。
      </p>
      <p>
        還有一件事要先講清楚：<b>平台不是抽選的賣方，也不是市場上的賣方。</b>
        開池的人（以下稱賣家）才是。平台提供的是撮合、點數帳本、託管與爭議裁決，
        獎品的所有權、出貨義務與買回承諾都在賣家身上。
      </p>
    </section>

    <section id="t-account">
      <h2>二、帳號</h2>
      <ul class="bullets">
        <li>註冊方式有兩種：Email 加密碼，或 LINE 登入。兩者可以綁在同一個帳號上。</li>
        <li>會員編號由系統產生，不是你選的；顯示名稱可以自己改。</li>
        <li>密碼只以雜湊形式保存，我們看不到你的原始密碼，也無法替你查出來。</li>
        <li>
          <b>連續登入失敗會被暫時鎖住。</b>同一個 Email 在 15 分鐘內失敗 8 次、
          或同一個 IP 在 15 分鐘內失敗 40 次就會被擋一段時間；同一個 IP 一天最多註冊 5 個帳號。
          這是防止密碼被暴力猜測，不是懲罰。
        </li>
        <li>帳號不可轉讓、不可出借。用別人的帳號交易，我們一律認帳號的名義人。</li>
      </ul>
    </section>

    <section id="t-age">
      <h2>三、年齡</h2>
      <p>
        <b>未滿 18 歲須經法定代理人（監護人）同意才能使用本站。</b>
        本站涉及付費抽選與金額交易，這是使用的前提條件。
      </p>
      <p>
        誠實地說明我們目前做到什麼程度：會員資料裡有一個<b>選填</b>的生日欄位，
        系統只檢查它是不是一個合理的日期（不能是未來、不能早於 1900 年），
        <b>目前沒有任何年齡驗證或身分證明的流程</b>。
        也就是說，這一條現在靠的是你的誠實與監護人的同意，不是系統的閘門。
        我們把這件事寫出來，而不是讓你以為有一道不存在的防線。
      </p>
    </section>

    <section id="t-points">
      <h2>四、點數</h2>
      <p>點數是站內的記帳單位。這一節是整份條款裡最不可以模糊的一節。</p>
      <div class="hard">
        <p><b>點數只能在站內使用。</b>用途只有三種：抽選、在市場上買卡、支付站內費用。</p>
        <p><b>點數不可以換回現金，也沒有任何提領管道。</b>系統沒有提領功能，
          不是「還沒做」，是刻意不做 —— 一旦點數可以換回現金，抽選就會落入刑法第 266 條
          賭博罪所稱的財物對價關係。這條線我們不會跨。</p>
        <p><b>點數不可以轉讓給其他會員。</b>沒有點數贈與、互轉或代儲的功能，
          任何宣稱可以代為轉點的行為都不是本站提供的。</p>
      </div>
      <ul class="bullets">
        <li>儲值時的兌換比例是 1 元新臺幣兌 1 點。</li>
        <li>
          點數的每一次增減都寫進一本<b>只能追加、不能修改也不能刪除</b>的帳本，
          你的餘額是那本帳的加總，不是一個可以被單獨改動的數字。錢包頁看到的每一筆都可以對回來源。
        </li>
        <li>
          抽選付出去的點數會先記在賣家名下的「保留額」——
          賣家看得到、但動不了，要等第九節的條件成立才會變成可動用。
        </li>
        <li>
          <b>金流尚未接通。</b>截至本條款版本，儲值端點還沒有接上任何金流服務商，
          站上流通的點數來自平台發放與 LINE 註冊禮。實際開始收款時，
          退款與發票相關的約定會另行補上（見第十五節）。
        </li>
      </ul>
    </section>

    <section id="t-draw">
      <h2>五、抽選</h2>
      <p>
        一個池由賣家建立，內容包含：標題、票價、獎品清單（每一張卡的賞別、數量、
        卡號、系列、版本）、每個賞別的買回價，以及販售到期日。賞別由高至低是 A、B、C、D。
      </p>
      <ul class="bullets">
        <li>每次可以抽 1、3、5 或 10 支。</li>
        <li><b>籤位是你自己點選的</b>，不是系統隨機指派給你。但每一個籤位對應到哪一個獎品，在開賣前就已經固定（見第六節）。</li>
        <li>抽中的卡直接進入你的卡冊。</li>
        <li><b>沒有保底、沒有天井。</b>抽再多次也不保證出大獎。</li>
        <li><b>「最後賞」沒有額外加碼。</b>抽走最後一支籤拿到的就是那個籤位原本的獎品，不會另外贈獎。</li>
        <li><b>賣家可以抽自己的池。</b>錢從他自己流到自己，不會憑空產生點數。但賣家的自抽<b>不計入公開顯示的剩餘籤數</b>，避免用假熱度誘導其他人跟進。</li>
        <li>池到期、售罄或賣家提前關池，都只是<b>停止販售</b>。已經抽出去的卡照常走完出貨與鑑賞期；沒被抽走的籤位，那些卡回到賣家手上。大獎有沒有被抽到不影響這件事。</li>
        <li><b>平台抽成目前是 0%。</b>每個池建立當下會把當時的費率寫進該池，之後調整費率不會回頭改已經開賣的池 —— 票已經賣出去了，事後改抽成等於片面改約。</li>
      </ul>
    </section>

    <section id="t-fair">
      <h2>六、公平性承諾</h2>
      <p>這一節是我們對「抽選沒有被動手腳」提出的具體承諾。它可以被你自己驗算，不需要相信我們的說法。</p>
      <ol class="steps">
        <li>建立池的時候，伺服器產生一組隨機種子，並公開<b>那組種子的雜湊值</b>（種子本身先不公開）。</li>
        <li>
          那個雜湊值同時涵蓋<b>整份獎品清單</b>：每一項的獎品編號、賞別、張數、卡名、系列代號、
          卡號、鑑定機構、鑑定分數、鑑定編號、參考市值、<b>買回價</b>與<b>卡片版本</b>。
        </li>
        <li>
          洗牌用的外部亂數取自 <b>drand</b>（一個公開的分散式隨機信標）的<b>未來輪次</b> ——
          鎖定的是大約兩分鐘之後才會產生的那一輪，開池的當下那個數字還不存在，
          所以賣家沒辦法反覆試到對自己有利的結果。這也是為什麼池會有一小段「等開賣」的狀態。
        </li>
        <li>池結束後，伺服器公開原本的種子。任何人都可以在自己的瀏覽器重算一次籤序，跟公布的比對。</li>
      </ol>
      <p>由此得出三個承諾：</p>
      <ul class="bullets">
        <li><b>籤序在開賣前就決定好了</b>，開賣之後只是查表，我們沒有能力在你點下去的當下改變結果。</li>
        <li><b>開賣後偷換卡會被抓到。</b>把大師球鏡面換成同一組卡號的普卡也算 —— 卡片版本是承諾的一部分。</li>
        <li><b>開賣後偷偷調降買回價會被抓到。</b>買回價同樣寫進承諾。</li>
      </ul>
      <p>
        驗算工具就在站上（每個池都有自己的驗算頁），計算全部在你的瀏覽器裡完成。
        目前入口暫時收起來，但功能與網址都是通的。
      </p>
    </section>

    <section id="t-prize">
      <h2>七、抽到之後的四條路</h2>
      <div class="tw">
        <table>
          <thead><tr><th>選擇</th><th>結果</th></tr></thead>
          <tbody>
            <tr><td class="k">留在保管庫</td><td>卡放在你的卡冊裡，寄存期 90 天，到期前 14 天會通知你</td></tr>
            <tr><td class="k">申請出貨</td><td>賣家把實體卡寄給你，時限見第九節</td></tr>
            <tr><td class="k">賣回給賣家</td><td>用賣家事先宣告的買回價換回點數，見第八節</td></tr>
            <tr><td class="k">上架到市場</td><td>賣給其他會員，成交所得是點數，見第十節</td></tr>
          </tbody>
        </table>
      </div>
      <p>
        <b>平台不代管實體卡。</b>卡由賣家直接寄給你，系統不知道賣家手上實際有沒有那張卡。
        「保管庫」是所有權的登記狀態，不是我們有一個實體倉庫替你保管。
      </p>
    </section>

    <section id="t-buyback">
      <h2>八、買回價是賣家的承諾，不是平台的</h2>
      <div class="hard">
        <p>
          <b>買回價由開池的賣家宣告，履行義務也在賣家身上。</b>
          你按下接受，點數就從那個賣家的帳戶出來，不是從平台出來。
        </p>
        <p>
          <b>平台不會買回自己送出的獎品。</b>這在台灣是明文禁止的
          （電子遊戲場業管理條例第 14 條），而且平台掏錢回收等於印鈔票 ——
          賣家可以把買回價喊高再自己回收。
        </p>
      </div>
      <ul class="bullets">
        <li><b>買回價在你抽之前就看得到</b>，寫在池的獎品清單上，而且已經封存進第六節的承諾裡，開賣後改不了。</li>
        <li>單張買回價最低 10 點，最高 1,000 萬點（上限是防手滑多打幾個零，不是經濟門檻）。</li>
        <li>
          <b>整池的買回價總和不可以超過票收。</b>系統在開池時就擋下來 ——
          否則「把整池抽光再全部賣回」會賺錢，那是一台印鈔機。
          站上把這個比值叫做<b>保底回饋率</b>：達到或超過 100% 直接擋、低於 25% 也擋（等於幾乎沒有保底）、
          90% 以上放行但會提醒賣家自己可能倒貼。
        </li>
        <li>
          <b>「保底回饋率」不是平均回本率。</b>它的意思是「整池都被買回時，最少拿得回票收的多少」，是下限。
        </li>
        <li>賣家標示的「參考市值」<b>沒有外部依據</b>，是他自己填的，也<b>不參與任何金額計算</b>，只是顯示用。真正有約束力的數字是買回價。</li>
        <li>你接受買回後，卡回到賣家手上（本來就還沒寄出），賣家不必再為那張卡出貨。</li>
      </ul>
    </section>

    <section id="t-pool-ship">
      <h2>九、抽選卡的出貨與結算</h2>
      <p>
        賣家<b>不是在你抽卡的當下</b>拿到錢。票金先記成他的「保留額」，
        逐一張卡各自結算，不必等整池抽完。以下時限由系統自動執行。
      </p>
      <div class="tw">
        <table>
          <thead><tr><th>節點</th><th>時限</th><th>時間到會發生什麼</th></tr></thead>
          <tbody>
            <tr v-for="t in POOL_TIMERS" :key="t.at">
              <td>{{ t.at }}</td><td class="t">{{ t.t }}</td><td>{{ t.then }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="warnbox">
        <b>一個你應該知道的例外：</b>如果票金已經因為 14 天寄存確認期滿而釋放給賣家，
        你之後才申請出貨、而賣家逾期沒寄，<b>那筆票金不會退還給你</b> ——
        它已經依規則結算完畢。這種情況剩下的手段是替賣家記一次違約，
        並由客服介入處理。想拿實體卡就早點申請出貨，這是這條規則的實際意義。
      </p>
      <p>
        賣家寄出時要填物流單號。中華郵政的單號會做檢查碼驗證（真正驗得出打錯字），
        黑貓、7-11、全家、萊爾富、蝦皮只驗長度與字元集，選「其他」則完全不驗證。
        <b>單號在這條路上是給你追蹤用的憑據，不是放款條件。</b>
      </p>
    </section>

    <section id="t-market">
      <h2>十、市場的託管交易</h2>
      <p>市場上的卡分兩條路，兩條的規則完全不同。</p>
      <div class="lanes">
        <div class="lane vault">
          <span class="lt">庫內轉移</span>
          <h3>卡沒有離開保管庫</h3>
          <p>交易是一筆資料庫異動：扣買家點數、加賣家點數、改所有權，同一個交易內完成，全成功或全失敗。</p>
          <p><b>沒有運送、沒有驗收期、沒有保證金、沒有爭議流程。</b></p>
        </div>
        <div class="lane ship">
          <span class="lt">實體出貨</span>
          <h3>卡已經在賣家手上</h3>
          <p>付款與交付之間有時間差，所以走託管：買家的點數 100% 凍結（凍結不是扣款），賣家的保證金同步凍結。</p>
          <p><b>以下時限與保證金只適用這一條路。</b></p>
        </div>
      </div>

      <h3 class="sh3">時限</h3>
      <div class="tw">
        <table>
          <thead><tr><th>節點</th><th>時限</th><th>時間到會發生什麼</th></tr></thead>
          <tbody>
            <tr v-for="t in MARKET_TIMERS" :key="t.at">
              <td>{{ t.at }}</td><td class="t">{{ t.t }}</td><td>{{ t.then }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="warnbox">
        <b>沉默的預設方向是「放款」，不是「退款」。</b>
        出貨後 14 天查無送達會<b>視同送達</b>並接著跑 7 天驗收期，
        期滿放款給賣家 —— 買家什麼都不按，最長 21 天後訂單完成。
        真的沒收到卡就要主動開爭議；不動作不會替你把錢要回來。
      </p>
      <p>買家在賣家標記出貨後就可以按「我已收到」或開爭議，不必等系統顯示送達。</p>

      <h3 class="sh3">賣家保證金</h3>
      <p>
        保證金是<b>另外一筆押品</b>，不是從貨款裡切一塊 —— 貨款一律 100% 凍結。
        比例依賣家已完成的訂單數遞減，並且有<b>絕對值上限 5,000 點</b>
        （不設上限的話高單價卡會被門檻直接擋死）。
      </p>
      <div class="tw">
        <table>
          <thead><tr><th>賣家紀錄</th><th>保證金</th></tr></thead>
          <tbody>
            <tr v-for="d in DEPOSIT" :key="d.who"><td>{{ d.who }}</td><td class="t">{{ d.rate }}</td></tr>
          </tbody>
        </table>
      </div>
      <p>賣家逾期未出貨，訂單自動取消、買家全額退款、<b>賣家的保證金被沒收</b>。</p>
    </section>

    <section id="t-dispute">
      <h2>十一、爭議處理</h2>
      <ul class="bullets">
        <li>買家在賣家出貨後到驗收期結束前都可以開爭議，<b>開爭議必須附完整未剪輯的開箱影片</b>。一般交易不強制錄影，但要索賠就必須舉證。</li>
        <li>開爭議後訂單凍結，雙方有 <b>48 小時</b>補件。</li>
        <li>
          <b>補件期滿系統不會自動判決。</b>那一刻的意義只是「平台可以依現有證據處理了」，
          裁決一律由人做 —— 自動判會把一次判斷錯誤放大成規模。
        </li>
        <li>裁決依<RouterLink :to="{ name: 'trade-protection' }">交易保護機制</RouterLink>頁面上事前公開的判定表進行，不做個案自由心證。</li>
        <li>退貨時退回的鑑定編號必須與出貨的編號一致。鑑定卡每個殼有唯一編號，「是不是同一張」是可以查證的事實。</li>
        <li>裁決結果會同時通知買賣雙方，並記入帳號紀錄。</li>
        <li>結案後仍保留有限的申訴管道，但門檻限縮到「涉及詐欺且有新事證」，否則結案狀態會失去意義。</li>
      </ul>
      <p>
        遇到問題的正式管道是站內的客服工單。工單、爭議與後台的每一次處分都會留下稽核紀錄。
      </p>
    </section>

    <section id="t-default">
      <h2>十二、違約與帳號處置</h2>
      <ul class="bullets">
        <li><b>賣家逾期未出貨</b>：票金退還買家（或在第九節那個例外情況下不退），並記一次違約。</li>
        <li><b>違約累計滿 3 次，不能再開新的池。</b></li>
        <li>
          <b>新賣家的第一個池有額度上限</b>：最多 100 支籤、票收總額最多 100,000 點。
          兩條同時檢查，任一條超過就擋。這不是收益風控，是把第一次違約的最大損失壓住 ——
          本站<b>沒有開池保證金</b>，這是替代做法。
          上限在你完成第一個池之後解除；<b>「完成」指那個池的種子已經公布</b> ——
          完抽後揭曉，或到期收攤後揭曉。還在賣、甚至已經賣完但還沒揭曉，都還不算。
        </li>
        <li>賣家身分需要審核，證件審核通過與賣家等級是兩件獨立的事，兩者都會各自通知你。</li>
        <li>
          以下行為我們會停權，必要時保留法律追訴：站外交易（用低價把人引到站外私下匯款）、
          一卡多賣、偽造鑑定殼或盜用他人卡片照片、自買自賣洗評價與洗成交價、
          以多重帳號規避額度或違約累計、代為儲值或轉點。
        </li>
        <li><b>站外交易不受本站任何保護機制保障。</b>錢不經過託管，我們無從介入。</li>
      </ul>
    </section>

    <section id="t-notify">
      <h2>十三、我們會主動通知你的事</h2>
      <p>
        會動到你的錢、你的卡的歸屬、你能不能做某件事，或是你有一個有時限的義務要履行 ——
        這四種事發生時你如果不在場，我們會發站內通知。你自己剛按下按鈕、
        當場就看得到結果的事不會另外通知你，那只會把通知變成流水帳。
      </p>
      <ul class="bullets">
        <li><b>買家會收到</b>：抽中 A 賞或最後賞、賣家已寄出（鑑賞期開始跑）、逾期未出貨已退款、寄存期限將到與已到期、票金已釋放但賣家還沒交卡、爭議裁決結果、卡片因客服接管而轉出。</li>
        <li><b>賣家會收到</b>：有買家申請出貨（你的 72 小時義務開始）、票金已入帳可以動用、逾期未出貨已退款給買家並記違約、買家接受了你的買回價（那張卡不用寄了）、賣家等級變更、證件審核結果、爭議裁決結果。</li>
        <li><b>雙方都會收到</b>：市場訂單的出貨、視同送達、確認收貨、鑑賞期滿自動完成、逾期取消與保證金沒收、開爭議。</li>
        <li>交易邀約的出價、成交、婉拒與連帶作廢也都會通知。</li>
      </ul>
      <p>
        通知只在站內的通知匣，<b>目前沒有 Email 或簡訊推播</b>。
        有時限的義務請以站內通知與訂單頁上的倒數為準。
      </p>
    </section>

    <section id="t-limits">
      <h2>十四、我們沒有提供的事</h2>
      <p>這一節寫的是我們<b>沒有</b>承諾的事。寫出來是為了讓你在爭議發生前就知道，而不是事後才發現。</p>
      <ul class="bullets">
        <li><b>不代管實體卡</b>，也無法確認賣家手上實際有沒有那張卡。</li>
        <li><b>不保證卡片的市場價格</b>。賣家標示的參考市值沒有外部依據，也不參與任何計算。</li>
        <li><b>不保證抽選結果</b>。沒有保底、沒有天井、最後賞沒有加碼。</li>
        <li><b>不提供點數提領、轉讓或兌現</b>，任何情況下都不提供。</li>
        <li><b>不介入站外交易</b>。</li>
        <li>
          <b>物流狀態目前不是自動查詢的。</b>系統驗證的是單號的格式與檢查碼，
          沒有串接任何物流商的 API，所以無法確認「這組單號真的存在、交寄時間也晚於訂單成立」。
          真的沒收到貨，請開爭議讓人工查。
        </li>
        <li><b>鑑定編號的即時查證目前不通。</b>PSA 的查詢 API 在帳號核准前一律拒絕存取，所以現在只查得到我們曾經查證成功並快取起來的編號；查不到的卡會標成待確認，而不是被判定為假卡。</li>
      </ul>
    </section>

    <section id="t-change">
      <h2>十五、條款變更與準據法</h2>
      <ul class="bullets">
        <li>條款修改時會在站內公告。已經開賣的池與已經成立的訂單，適用它成立當下的規則與費率。</li>
        <li>你不同意修改後的條款，可以停止使用並要求關閉帳號；但已成立的交易義務不因此消滅。</li>
        <li>本條款以中華民國法律為準據法。</li>
        <li>因本條款發生爭議時，雙方合意以 ⟨待填⟩ 地方法院為第一審管轄法院。</li>
      </ul>
    </section>

    <details class="src">
      <summary>條文依據（給維護者對照用）</summary>
      <div class="tw">
        <table>
          <thead><tr><th>條款</th><th>依據</th></tr></thead>
          <tbody>
            <tr><td>二・登入失敗門檻 8／40 次・15 分鐘・註冊 5 次／日</td><td class="m">server/src/rate-limit.ts:22-35</td></tr>
            <tr><td>二・密碼雜湊、Email 唯一</td><td class="m">server/src/routes/auth.ts:69-75；server/migrations/002_core.sql:5-7</td></tr>
            <tr><td>三・生日選填、只驗合理性、無年齡驗證</td><td class="m">server/migrations/006_profile.sql:18；server/src/routes/auth.ts:203-208</td></tr>
            <tr><td>四・點數不可提領／轉讓（無提領端點）</td><td class="m">docs/rules.md 第一節；server/src/routes/wallet.ts（僅 GET /）</td></tr>
            <tr><td>四・帳本只能追加、餘額為推導值</td><td class="m">server/migrations/001_init.sql:1-30</td></tr>
            <tr><td>四・金流未接</td><td class="m">docs/notifications-audit.md F3；server/migrations/002_core.sql:25-38</td></tr>
            <tr><td>五・每次抽 1／3／5／10 支</td><td class="m">src/components/DrawPanel.vue:28</td></tr>
            <tr><td>五・自選籤位、無保底、最後賞不加碼、自抽不計入剩餘籤數</td><td class="m">docs/rules.md 第二、三、九節與「還沒定案的事」</td></tr>
            <tr><td>五・抽成 0%、費率寫進池不回溯</td><td class="m">src/shared/pool-settlement.ts:20-26；server/migrations/017_pool_settlement.sql:52</td></tr>
            <tr><td>六・commit-reveal 四個步驟</td><td class="m">src/shared/fairness.ts:1-16, 163-170, 284-319</td></tr>
            <tr><td>六・承諾涵蓋的欄位（含買回價、卡片版本）</td><td class="m">src/shared/fairness.ts:57-95, 113-148</td></tr>
            <tr><td>六・drand 未來輪次、約兩分鐘</td><td class="m">src/lib/pool-status.ts:51-57</td></tr>
            <tr><td>七・寄存 90 天、到期前 14 天提醒</td><td class="m">server/src/pools-service.ts:21, 520</td></tr>
            <tr><td>七・平台不代管實體卡</td><td class="m">docs/rules.md「還沒定案的事」；server/src/routes/sellers.ts:230-233</td></tr>
            <tr><td>八・買回由賣家出、平台不回收</td><td class="m">docs/rules.md 第四節</td></tr>
            <tr><td>八・買回價 10 至 10,000,000 點</td><td class="m">src/shared/pool-settlement.ts:77-78</td></tr>
            <tr><td>八・保底回饋率門檻 100／90／25</td><td class="m">src/shared/economics.ts:48-50, 62-131</td></tr>
            <tr><td>八・參考市值不參與計算</td><td class="m">src/shared/pool-settlement.ts:57-66；src/shared/fairness.ts:67</td></tr>
            <tr><td>九・14 天寄存確認、72 小時出貨、7 天鑑賞</td><td class="m">src/shared/pool-settlement.ts:29, 35, 47, 195-231</td></tr>
            <tr><td>九・池販售期預設 14 天、最長 90 天</td><td class="m">src/shared/pool-settlement.ts:53-54</td></tr>
            <tr><td>九・票金已釋放後逾期不退款（只記違約）</td><td class="m">src/shared/pool-settlement.ts:215-245</td></tr>
            <tr><td>九・單號驗證各物流商規則</td><td class="m">src/shared/escrow.ts:146-231；server/src/routes/sellers.ts:230-236</td></tr>
            <tr><td>十・72 小時／14 天／7 天／48 小時</td><td class="m">src/shared/escrow.ts:20-26, 57-89</td></tr>
            <tr><td>十・逾期視同送達再跑 7 天，共 21 天</td><td class="m">src/shared/escrow.ts:67-76, 109-116</td></tr>
            <tr><td>十・買家在 shipped 就能確認或開爭議</td><td class="m">src/shared/escrow.ts:131-144</td></tr>
            <tr><td>十・保證金 10／5／2%、上限 5,000</td><td class="m">src/shared/escrow.ts:28-39</td></tr>
            <tr><td>十一・補件 48 小時、逾期不自動裁決</td><td class="m">src/shared/escrow.ts:26, 91-121</td></tr>
            <tr><td>十一・判定表與開箱影片</td><td class="m">src/pages/TradeProtectionPage.vue:60-101</td></tr>
            <tr><td>十二・違約 3 次停開池</td><td class="m">src/shared/pool-settlement.ts:84-90</td></tr>
            <tr><td>十二・新賣家 100 籤／100,000 點</td><td class="m">src/shared/pool-settlement.ts:92-101, 134-139</td></tr>
            <tr><td>十二・「完成第一個池」的定義（種子已公布）</td><td class="m">src/shared/pool-settlement.ts:103-121</td></tr>
            <tr><td>十三・通知的判準與清單</td><td class="m">docs/notifications-audit.md 全文</td></tr>
            <tr><td>十四・物流未串接 API</td><td class="m">src/shared/escrow.ts:162-167</td></tr>
            <tr><td>十四・PSA 查證 403、只讀快取</td><td class="m">server/src/psa.ts:10-18；server/migrations/020_psa_cert_cache.sql</td></tr>
          </tbody>
        </table>
      </div>
    </details>

    <footer class="df">
      <p>
        <b>這份文件的狀態：</b>本條款是依本平台程式碼的實際行為草擬的版本，
        目的是讓條文與系統做的事一致。<b>它尚未經過法律專業人士審閱，
        正式營運前應由律師審閱並依實際營運主體修訂。</b>
      </p>
      <p class="upd">最後更新：2026-08-31</p>
    </footer>
  </div>
</template>

<style scoped>
/* 版面骨架沿用 TradeProtectionPage 的 .doc —— 站上的長文件應該長一樣。
   安全區與底部導覽的讓位由 App.vue 的頁尾統一處理，這裡不重複計算。 */
.doc { padding-bottom: 48px; }
.dh { padding: 8px 0 22px; border-bottom: 2px solid var(--ink); margin-bottom: 8px; }
.eyebrow {
  font-family: var(--font-mono); font-size: 11.5px; letter-spacing: .14em;
  color: var(--muted); margin: 0 0 10px;
}
h1 { font-size: clamp(24px, 6vw, 34px); line-height: 1.3; margin: 0 0 12px; text-wrap: balance; }
.lede { font-size: 15.5px; line-height: 1.85; color: var(--ink); margin: 0; max-width: 60ch; }

section { padding-top: 26px; scroll-margin-top: 76px; }
h2 {
  font-size: 19px; margin: 22px 0 8px; padding-top: 18px;
  border-top: 1px solid var(--line); text-wrap: balance;
}
section:first-of-type h2 { border-top: none; padding-top: 0; margin-top: 8px; }
h3 { font-size: 15.5px; margin: 0; }
.sh3 { margin: 22px 0 6px; }
p { font-size: 14.5px; line-height: 1.85; color: var(--muted); margin: 0 0 12px; max-width: 62ch; }
p b, li b { color: var(--ink); font-weight: 700; }
a { color: var(--accent); }

/* ⟨待填⟩：這是整頁最需要被看見的東西，所以用強調色的框而不是一段灰字 */
.blank {
  margin: 18px 0 6px; padding: 16px 18px;
  border: 1px solid var(--accent); border-radius: var(--radius-lg);
  background: var(--accent-wash);
}
.bt {
  font-family: var(--font-mono); font-size: 12.5px; font-weight: 700;
  letter-spacing: .06em; color: var(--accent-soft); margin: 0 0 8px; max-width: none;
}
.blank p { font-size: 13.5px; margin: 0 0 8px; }
.blank ul { margin: 0; padding-left: 20px; }
.blank li {
  font-size: 13.5px; line-height: 1.9; color: var(--ink);
  font-family: var(--font-mono);
}

/* 目錄。條目高度 ≥44px —— 手機上這是全頁最常被點的東西 */
.toc { margin: 20px 0 4px; padding: 14px 18px; background: var(--surface); border-radius: var(--radius-lg); }
.tt {
  font-family: var(--font-mono); font-size: 11px; letter-spacing: .12em;
  color: var(--faint); margin: 0 0 2px;
}
.toc ol { margin: 0; padding: 0; list-style: none; }
.toc a {
  display: flex; align-items: center; min-height: 44px;
  font-size: 14px; line-height: 1.5; color: var(--ink); text-decoration: none;
  border-bottom: 1px solid var(--line-soft);
}
.toc li:last-child a { border-bottom: none; }
@media (hover: hover) { .toc a:hover { color: var(--accent); } }

.bullets { margin: 0 0 12px; padding-left: 20px; max-width: 62ch; }
.bullets li { font-size: 14px; line-height: 1.85; color: var(--muted); margin-bottom: 10px; }

.steps { margin: 0 0 12px; padding-left: 22px; max-width: 62ch; }
.steps li { font-size: 14px; line-height: 1.85; color: var(--muted); margin-bottom: 10px; }

/* 紅線：不可以被讀漏的三條 */
.hard {
  background: var(--surface-2); border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0; padding: 16px 18px; margin: 14px 0;
}
.hard p { font-size: 14px; margin: 0; max-width: none; }
.hard p + p { margin-top: 12px; }

.warnbox {
  background: var(--warn-wash); border-left: 3px solid var(--warn);
  border-radius: 0 var(--radius) var(--radius) 0;
  padding: 14px 16px; margin: 14px 0; font-size: 13.5px; max-width: none;
}

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

/* 表格一律可橫向捲動，長字串不撐破版面（手機的 scrollWidth 必須等於 clientWidth） */
.tw { overflow-x: auto; background: var(--surface); border-radius: var(--radius-lg); margin: 14px 0; }
table { border-collapse: collapse; width: 100%; min-width: 420px; font-size: 13.5px; }
th, td { padding: 11px 14px; text-align: left; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
th { background: var(--surface-2); font-size: 12px; color: var(--muted); font-weight: 700; white-space: nowrap; }
td { color: var(--muted); }
tr:last-child td { border-bottom: none; }
td.k { color: var(--ink); font-weight: 700; white-space: nowrap; }
td.t {
  font-family: var(--font-mono); font-variant-numeric: tabular-nums;
  color: var(--gold); font-weight: 700; white-space: nowrap;
}
td.m { font-family: var(--font-mono); font-size: 11.5px; color: var(--faint); }

/* 依據對照表：預設收起來。它是給維護者的，不是給使用者讀的正文 */
.src { margin-top: 30px; }
.src summary {
  display: flex; align-items: center; min-height: 44px;
  font-size: 13px; color: var(--muted); cursor: pointer;
  font-family: var(--font-mono); letter-spacing: .04em;
}
.src table { min-width: 520px; }

.df { margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--line); }
.df p { font-size: 13.5px; color: var(--muted); margin: 0; max-width: 66ch; }
.upd { margin-top: 10px !important; font-family: var(--font-mono); font-size: 11.5px; color: var(--faint); }
</style>
