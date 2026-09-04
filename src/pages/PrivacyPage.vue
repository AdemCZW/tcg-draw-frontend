<script setup lang="ts">
/**
 * 隱私權政策。
 *
 * 跟 TermsPage 一樣：每一條都從程式碼與資料庫結構寫出來，依據列在
 * 頁面最後的摺疊區。個資法（個人資料保護法）第 8 條要求告知蒐集目的、
 * 類別、利用期間、地區、對象與方式，以及當事人的權利 —— 所以這一頁
 * 的骨架就照那幾件事排，不是照通用範本。
 *
 * 三個刻意的決定：
 *
 * 1) 「收集哪些資料」寫到**欄位**，不寫「您的個人資料」這種話。
 *    欄位清單直接對應 server/migrations 裡的 schema。
 *
 * 2) 保存期限**沒有全部答得出來**。已經有機制的（登入紀錄、寄存期）照實寫；
 *    沒有機制的（上傳的檔案、通知、關閉帳號後的處理）標成 ⟨待填⟩ 並說明
 *    「目前沒有自動刪除」。編一個「保存 5 年」出來是最糟的做法：
 *    那會變成一個沒有人在執行的承諾。
 *
 * 3) 「賣家會看到買家的姓名、電話、地址」寫在最顯眼的位置，並且說明
 *    範圍限定的條件。這是這個平台對使用者最有感的一次資料揭露。
 */

const TOC = [
  { id: 'p-what', title: '一、我們收集哪些資料' },
  { id: 'p-why', title: '二、為什麼收，以及怎麼用' },
  { id: 'p-who', title: '三、誰看得到' },
  { id: 'p-keep', title: '四、保存多久' },
  { id: 'p-third', title: '五、第三方服務' },
  { id: 'p-rights', title: '六、你的權利' },
  { id: 'p-storage', title: '七、Cookie 與瀏覽器儲存' },
  { id: 'p-minor', title: '八、未成年人' },
  { id: 'p-secure', title: '九、安全措施與我們做不到的事' },
  { id: 'p-change', title: '十、政策變更' }
]

type Group = { name: string; note: string; fields: { f: string; d: string }[] }

/** 逐欄位的清單。欄位名稱用資料庫實際的名字，不另外翻譯成模糊的說法 */
const DATA: Group[] = [
  {
    name: '帳號',
    note: '註冊時建立，沒有這些就沒有帳號。',
    fields: [
      { f: 'email', d: 'Email 註冊時填。LINE 註冊不會取得，除非你之後自己設定密碼' },
      { f: 'password_hash', d: '密碼的雜湊值。我們沒有你的原始密碼，也無法還原' },
      { f: 'name / display_name', d: '站上顯示的名稱。得獎動態、賣家名稱、訂單上顯示的都是這一個' },
      { f: 'handle / member_no', d: '系統產生的會員編號' },
      { f: 'role', d: '一般會員或管理員' },
      { f: 'created_at', d: '註冊時間' }
    ]
  },
  {
    name: '第三方登入',
    note: 'LINE 登入時建立。',
    fields: [
      { f: 'provider', d: '登入來源（line）' },
      { f: 'provider_uid', d: 'LINE 給的使用者識別碼。我們沒有申請 Email 權限，所以不會拿到你的 LINE 電子郵件' }
    ]
  },
  {
    name: '出貨與聯絡資料',
    note: '全部選填，註冊時不會逼你填。要出貨時才需要，沒填就寄不出去。',
    fields: [
      { f: 'real_name', d: '收件人本名。跟顯示名稱分開存，因為你多半不想讓市場上的人看到本名' },
      { f: 'phone', d: '物流聯絡電話' },
      { f: 'address_zip / address_city / address_line1', d: '預設收件地址的郵遞區號、縣市、詳細地址' },
      { f: 'birthday', d: '生日。條款寫明未滿 18 歲須監護人同意，這是那一條的依據' },
      { f: 'shipments.address', d: '每一次申請出貨時填的收件資訊，整包存在那一筆出貨申請上。允許單次覆寫預設地址，所以它跟上面的欄位可能不一樣' }
    ]
  },
  {
    name: '交易紀錄',
    note: '你每一次抽選、買賣、出貨都會留下紀錄。這些是交易本身，不能刪。',
    fields: [
      { f: 'points_ledger', d: '點數的每一次增減、原因與來源參照。只能追加，不能修改也不能刪除' },
      { f: 'orders', d: '訂單：卡片內容、金額、保證金、買賣雙方的 id 與顯示名稱、狀態與各個時間戳' },
      { f: 'orders.tracking / carrier', d: '物流單號與物流商' },
      { f: 'orders.dispute_reason / has_unboxing_video', d: '你開爭議時填的理由，以及有沒有附開箱影片' },
      { f: 'prizes', d: '你抽到或登記進卡冊的卡：卡片資料、賞別、狀態、取得時間、寄存到期時間' },
      { f: 'topups', d: '儲值紀錄：金額、點數、金流服務商與其交易編號。目前金流尚未接通' },
      { f: 'trade_offers', d: '對別人卡冊出的價、收到的價與結果' },
      { f: 'notifications', d: '發給你的站內通知，含標題、內文與連結' }
    ]
  },
  {
    name: '上傳的檔案',
    note: '檔案本身不經過我們的伺服器，瀏覽器用限時網址直接傳到物件儲存（見第五節）。資料庫只存檔案的位置、格式與大小。',
    fields: [
      { f: 'pool-cover', d: '池的封面圖' },
      { f: 'ship-photo', d: '出貨前的卡片與包裝照片' },
      { f: 'unbox-video', d: '開爭議時附的開箱影片' },
      { f: 'seller-doc', d: '賣家審核用的證件。這一類是敏感度最高的，只有客服看得到' },
      { f: 'avatar', d: '頭像' },
      { f: 'ticket-doc', d: '客服工單的附件' }
    ]
  },
  {
    name: '公開聯絡表單',
    note: '「聯絡客服」那一頁（不需要登入）送出時建立。這一類的特別之處是'
      + '**送出的人多半沒有帳號**，所以這幾個欄位是我們對他唯一知道的事。',
    fields: [
      { f: 'contact_messages.topic', d: '你選的主題（登入不了、帳號、訂單、檢舉、個資、其他）' },
      { f: 'contact_messages.name', d: '你填的稱呼。不是本名，也不會拿去跟任何帳號比對' },
      { f: 'contact_messages.email', d: '你填的 Email。**這是回覆你的唯一管道** —— 本站沒有寄自動信的功能，是客服本人寫信給你' },
      { f: 'contact_messages.body', d: '你寫的訊息內文。這張表單不能附加檔案，所以只有文字' },
      { f: 'contact_messages.user_id', d: '送出時如果你剛好登入著，會記下你的帳號，客服因此可以對照你的訂單與卡冊。沒登入就是空的' },
      { f: 'contact_messages.ip_hash', d: '來源網路位址的**雜湊值，不是位址本身**。加了站台密鑰，無法反查回位址；只用來擋機器人灌訊息' },
      { f: 'contact_messages.fingerprint', d: '主題＋Email＋內文的雜湊。只用來認出「同一則被連按兩下送出兩次」' },
      { f: 'contact_messages.handled_by / handled_note', d: '哪位客服處理的、他寫下的處理紀錄' }
    ]
  },
  {
    name: '技術與安全紀錄',
    note: '這一類不是你主動提供的，是使用系統時產生的。',
    fields: [
      { f: 'login_attempts', d: '登入失敗的計數，索引鍵是你的 IP 位址或 Email。純粹用來擋密碼暴力猜測' },
      { f: 'admin_actions', d: '後台每一次動作的稽核紀錄：哪個管理員、對誰、做了什麼、備註' },
      { f: 'idempotency', d: '重複送出的防呆記錄，避免同一個動作成立兩次' }
    ]
  }
]

/** 第三方。方向欄位很重要：是「我們送出去」還是「你的瀏覽器直接連過去」 */
const THIRD = [
  {
    who: 'LINE（LY Corporation）', use: '第三方登入',
    what: '我們向 LINE 要求的權限只有 profile 與 openid，取得的是使用者識別碼與暱稱。刻意不申請 Email 權限。',
    dir: '我們送出'
  },
  {
    who: 'drand', use: '抽選的外部亂數',
    what: '取得公開隨機信標的輪次值。這是單向讀取，不送出任何資料，也跟使用者無關。',
    dir: '我們讀取'
  },
  {
    who: 'Railway', use: '後端伺服器與資料庫的託管',
    what: '上表所有存在資料庫裡的資料，實際存放在 Railway 的基礎設施上。',
    dir: '存放於此'
  },
  {
    who: 'Cloudflare R2', use: '上傳檔案的物件儲存',
    what: '所有上傳的圖片與影片存放於此。瀏覽器用我們簽發的限時網址直傳（上傳連結 10 分鐘、私密讀取連結 1 小時有效），檔案的位元組不經過我們的伺服器。',
    dir: '你的瀏覽器直連'
  },
  {
    who: 'GitHub Pages', use: '網站前端的靜態託管',
    what: '你打開本站時，瀏覽器向 GitHub 取得網頁檔案，GitHub 因此會取得你的 IP 位址與瀏覽器資訊。',
    dir: '你的瀏覽器直連'
  },
  {
    who: 'Google Fonts', use: '網頁字型',
    what: '字型由 fonts.googleapis.com 與 fonts.gstatic.com 載入，Google 因此會取得你的 IP 位址與瀏覽器資訊。',
    dir: '你的瀏覽器直連'
  },
  {
    who: 'TCGdex', use: '卡片目錄與卡圖',
    what: '卡片資料與卡圖由 api.tcgdex.net 與 assets.tcgdex.net 載入，該服務因此會取得你的 IP 位址與瀏覽器資訊。查詢內容是卡片，不含會員資料。',
    dir: '你的瀏覽器直連'
  }
]

/** 瀏覽器本機儲存。key 用實際的字串，方便你自己去開發者工具看 */
const STORAGE = [
  { k: 'vd.token', where: 'localStorage', d: '登入憑證。有效期 30 天，內容只有你的使用者 id' },
  { k: 'vd.user', where: 'localStorage', d: '帳號基本資料的快取，重整頁面時不用重新登入' },
  { k: 'vd.haptics', where: 'localStorage', d: '觸覺回饋的開關，跟身分無關' },
  { k: 'vd.lastResult', where: 'sessionStorage', d: '最近一次的開卡結果，重整後結果頁還能顯示。分頁關掉就消失' },
  { k: 'vd_orders_v1 / vd_orders_offset', where: 'localStorage', d: '僅在未連接後端的示範模式使用，正式站不會寫入' }
]
</script>

<template>
  <div class="container page doc">
    <header class="dh">
      <p class="eyebrow">隱私權政策</p>
      <h1>我們收了你哪些資料，以及誰看得到</h1>
      <p class="lede">
        這一頁寫到欄位層級，不寫「您的個人資料」這種概括說法。
        沒有寫進來的資料就是我們沒有收。答不出來的（例如某些保存期限），
        會直接說我們還沒有訂，而不是編一個數字。
      </p>
    </header>

    <div class="blank" role="note">
      <p class="bt">⟨待填⟩ 個資的蒐集者與聯絡窗口</p>
      <p>依個人資料保護法，蒐集者的身分必須明確揭露。以下由營運者填寫：</p>
      <ul>
        <li>公司／商號名稱：⟨待填⟩</li>
        <li>統一編號：⟨待填⟩</li>
        <li>營業地址：⟨待填⟩</li>
        <li>負責人：⟨待填⟩</li>
        <li>個資聯絡信箱（行使下方第六節權利的窗口）：⟨待填⟩</li>
      </ul>
      <p class="blankNow">
        <b>在那個信箱補齊之前，有一條真的送得到的路：</b>
        <RouterLink :to="{ name: 'contact' }">聯絡客服</RouterLink>那一頁不需要登入，
        主題選「個資與隱私」即可。它會直接進到客服的後台佇列，客服再用 email 回覆你。
      </p>
    </div>

    <div class="hard">
      <p class="bt2">先講最重要的一件事</p>
      <p>
        <b>你申請出貨時，賣家會看到你的真實姓名、電話與收件地址。</b>
        他必須看到才寄得出去。系統做的是把這件事限制在最小範圍：
        只有那一筆交易的賣家看得到、只在他的出貨義務還沒結束時看得到、
        而且收件人必須就是那張卡當下的擁有者，對不上就一個欄位都不給。
        詳細條件寫在第三節。
      </p>
    </div>

    <nav class="toc" aria-label="目錄">
      <p class="tt">目錄</p>
      <ol>
        <li v-for="s in TOC" :key="s.id"><a :href="`#${s.id}`">{{ s.title }}</a></li>
      </ol>
    </nav>

    <section id="p-what">
      <h2>一、我們收集哪些資料</h2>
      <article v-for="g in DATA" :key="g.name" class="grp">
        <h3>{{ g.name }}</h3>
        <p class="what">{{ g.note }}</p>
        <div class="tw">
          <table>
            <thead><tr><th>欄位</th><th>是什麼</th></tr></thead>
            <tbody>
              <tr v-for="x in g.fields" :key="x.f">
                <td class="m">{{ x.f }}</td><td>{{ x.d }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
      <p>
        <b>我們不收集的：</b>身分證字號、金融帳號、信用卡號（金流尚未接通；日後接通時，
        卡號由金流服務商處理，不會進入本站的資料庫）、生物特徵、精確定位、
        通訊錄或裝置上的其他檔案。<b>本站也沒有安裝任何廣告追蹤程式</b>（見第七節）。
      </p>
    </section>

    <section id="p-why">
      <h2>二、為什麼收，以及怎麼用</h2>
      <div class="tw">
        <table>
          <thead><tr><th>目的</th><th>用到哪些資料</th></tr></thead>
          <tbody>
            <tr><td class="k">辨識你的身分</td><td>帳號欄位、第三方登入識別碼、登入憑證</td></tr>
            <tr><td class="k">記錄點數與交易</td><td>點數帳本、訂單、抽選與卡片紀錄、儲值紀錄</td></tr>
            <tr><td class="k">把卡寄到你手上</td><td>真實姓名、電話、地址、出貨申請、物流單號</td></tr>
            <tr><td class="k">處理爭議與客服</td><td>訂單與其時間戳、出貨照、開箱影片、爭議理由、工單與附件</td></tr>
            <tr><td class="k">審核賣家資格</td><td>賣家證件、賣家等級與審核紀錄</td></tr>
            <tr><td class="k">通知你有時限的事</td><td>站內通知（不寄 Email，也不發簡訊）</td></tr>
            <tr><td class="k">防止盜用與濫用</td><td>登入失敗計數（IP 與 Email）、重複送出防呆記錄、後台稽核紀錄</td></tr>
            <tr><td class="k">履行法定義務</td><td>交易與金流紀錄，於法令要求的範圍內保存</td></tr>
          </tbody>
        </table>
      </div>
      <p>
        <b>我們不會把你的資料賣給任何人，也不會用來投放廣告或做行銷側寫。</b>
        利用地區為中華民國境內及第五節所列服務所在地。
      </p>
    </section>

    <section id="p-who">
      <h2>三、誰看得到</h2>

      <h3 class="sh3">賣家（在出貨義務存續期間）</h3>
      <p>賣家在需要寄卡給你的時候，會看到你的<b>真實姓名、電話、郵遞區號、縣市與詳細地址</b>。範圍由三個條件同時限制：</p>
      <ul class="bullets">
        <li><b>只有那一筆交易的賣家</b>看得到，其他賣家看不到。</li>
        <li>
          <b>只在出貨義務還活著的時候</b>看得到 —— 訂單處於鎖點、運送中、驗收中或爭議中，
          或是抽選卡的結算還在等出貨。義務結束了就沒有理由繼續持有你的住址，寄完了也不必再看。
        </li>
        <li>
          <b>收件人必須就是那張卡當下的擁有者。</b>卡如果在市場上轉手過，
          對不上就一個欄位都不給 —— 給一份可能屬於前一個主人的地址，比不給更危險。
        </li>
      </ul>
      <p>這三個條件寫在資料庫查詢本身，不是撈回來之後再過濾的。此外賣家也會看到你的顯示名稱與會員編號，那是為了讓他把包裹對上訂單。</p>

      <h3 class="sh3">其他會員</h3>
      <ul class="bullets">
        <li>市場、得獎動態、賣家頁與訂單上顯示的是你的<b>顯示名稱</b>，不是本名。這兩個欄位是刻意分開的。</li>
        <li>
          <b>公開卡冊預設是關閉的。</b>你自己打開之後，系統會給你一個分享網址，
          任何拿到那個網址的人不用登入就看得到你卡冊裡的卡與你的顯示名稱。隨時可以關掉。
        </li>
        <li>你對別人的卡出價時，對方會看到是誰出的價。</li>
      </ul>

      <h3 class="sh3">平台的管理員與客服</h3>
      <p>
        處理客服工單、賣家審核與爭議裁決時，客服看得到你的完整會員檔案：
        Email、顯示名稱、真實姓名、電話、地址、生日、點數餘額、卡片、訂單、出貨與帳本明細。
        <b>後台的每一次動作都會寫進稽核紀錄</b>（哪個管理員、對誰、做了什麼），這條紀錄本身不可修改。
      </p>

      <h3 class="sh3">其他情形</h3>
      <ul class="bullets">
        <li>第五節所列的服務提供者，在提供該服務所必要的範圍內。</li>
        <li>依法院、檢警或主管機關的合法要求。</li>
        <li>沒有其他情形。我們不做資料交換、不賣名單。</li>
      </ul>
    </section>

    <section id="p-keep">
      <h2>四、保存多久</h2>
      <p>照實回答，包含我們還沒有訂出期限的部分。</p>
      <div class="tw">
        <table>
          <thead><tr><th>資料</th><th>保存期間</th></tr></thead>
          <tbody>
            <tr><td class="k">點數帳本</td><td>永久。這本帳只能追加，不能修改也不能刪除 —— 你的餘額是它的加總，刪掉任何一列都會讓餘額變成錯的</td></tr>
            <tr><td class="k">訂單與交易紀錄</td><td>永久保存，含已結案的訂單。這是交易憑證，也是日後申訴的依據</td></tr>
            <tr><td class="k">卡片的寄存</td><td>抽到之後 <b class="t">90 天</b>；到期前 <b class="t">14 天</b>會先通知你</td></tr>
            <tr><td class="k">登入失敗紀錄</td><td>自動清除：登入成功即刪除；未清除的登入紀錄約 1 小時後、註冊紀錄約 48 小時後由排程刪除</td></tr>
            <tr><td class="k">鑑定機構與鑑定編號</td><td>永久，跟著那一張卡片紀錄走。<b>這是你自己填的值，我們不會送去任何外部機構查證，也不保留任何查證結果</b>（查證功能已整組移除）。編號永久保留的理由是唯一性：同一組機構＋編號站上只能有一筆有效登記，紀錄刪掉就擋不住第二次登記</td></tr>
            <tr>
              <td class="k">上傳的檔案</td>
              <td class="todo">
                <b>⟨待填⟩</b>　資料表留了保存期限欄位，但<b>目前沒有任何程式在寫入它，也沒有自動刪除的排程</b> ——
                也就是說出貨照、開箱影片與賣家證件目前是無限期保存的。期限必須訂出來並實作。
              </td>
            </tr>
            <tr>
              <td class="k">公開聯絡表單的訊息</td>
              <td>
                客服標記處理完成之後 <b class="t">180 天</b>，由排程自動刪除
                （這一條有真的在跑，不是承諾）。
                <b>還沒處理完的不會自動刪除</b> —— 沒回覆完就刪掉等於把提問的人丟掉，
                而且未處理的訊息會一直掛在後台佇列上，不會被忘記。
              </td>
            </tr>
            <tr>
              <td class="k">站內通知</td>
              <td class="todo"><b>⟨待填⟩</b>　目前沒有清除機制，通知會一直留著。</td>
            </tr>
            <tr>
              <td class="k">關閉帳號之後</td>
              <td class="todo">
                <b>⟨待填⟩</b>　<b>系統目前沒有自助關閉帳號或刪除資料的功能。</b>
                要停用帳號請走客服工單，由人工處理；哪些欄位刪除、哪些因交易與稅務需要保留、保留多久，都還沒有訂。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section id="p-third">
      <h2>五、第三方服務</h2>
      <p>
        「方向」這一欄的意思是：<b>我們送出</b>代表資料由我們的伺服器傳給對方；
        <b>你的瀏覽器直連</b>代表你打開網頁時瀏覽器自己去連，對方因此會知道你的 IP 位址，
        這一段我們無從代為遮蔽。
      </p>
      <div class="tw">
        <table>
          <thead><tr><th>服務</th><th>用途</th><th>方向</th><th>牽涉什麼</th></tr></thead>
          <tbody>
            <tr v-for="t in THIRD" :key="t.who">
              <td class="k">{{ t.who }}</td>
              <td>{{ t.use }}</td>
              <td class="dir">{{ t.dir }}</td>
              <td>{{ t.what }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        這些服務的伺服器不一定在中華民國境內，使用本站即表示你了解資料會傳輸至境外。
        各服務自身的隱私政策由該服務提供者負責。
      </p>
    </section>

    <section id="p-rights">
      <h2>六、你的權利</h2>
      <p>依個人資料保護法第 3 條，關於你的個人資料，你可以：</p>
      <ul class="bullets">
        <li>查詢或請求閱覽</li>
        <li>請求製給複製本</li>
        <li>請求補充或更正</li>
        <li>請求停止蒐集、處理或利用</li>
        <li>請求刪除</li>
      </ul>
      <p><b>現在就可以自己做的：</b></p>
      <ul class="bullets">
        <li>會員資料頁可以隨時查看與修改顯示名稱、真實姓名、電話、地址與生日。</li>
        <li>公開卡冊可以隨時關閉。</li>
        <li>錢包頁可以看到點數的每一筆進出。</li>
        <li>訂單頁與出貨頁可以看到你所有的交易與其狀態。</li>
      </ul>
      <p><b>目前需要人工處理的：</b>製給複製本（資料匯出）、停止利用、刪除、關閉帳號。
        站上還沒有自助的匯出或刪除功能，請開客服工單，或寄到上方 ⟨待填⟩ 的個資聯絡信箱。</p>
      <p>
        <b>進不去帳號也一樣可以行使這些權利。</b>
        客服工單要登入才開得了，而「忘記密碼」本身就是需要找我們的理由之一 ——
        本站刻意沒有自助的忘記密碼流程。這種情況請用
        <RouterLink :to="{ name: 'contact' }">聯絡客服</RouterLink>那一頁（不需要登入），
        主題選「個資與隱私」或「登入不了」。那張表單收的欄位、誰看得到、留多久，
        就寫在它自己那一頁上，也列在本頁第一節與第四節。
      </p>
      <p class="warnbox">
        <b>有兩件事我們必須先講清楚，免得你以為刪得掉：</b>
        點數帳本與交易紀錄<b>不會因為你的請求而刪除</b> ——
        帳本是只能追加的結構，刪掉一列會讓餘額錯掉；訂單牽涉另一方的權益與可能的稅務義務。
        我們能做的是刪除或去識別化<b>不影響帳務完整性</b>的欄位（例如真實姓名、電話、地址、生日）。
      </p>
    </section>

    <section id="p-storage">
      <h2>七、Cookie 與瀏覽器儲存</h2>
      <p>
        <b>本站不使用 Cookie。</b>登入狀態不是用 Cookie 維持的，而是存在瀏覽器的
        localStorage 與 sessionStorage 裡。以下是全部的項目，你可以自己在瀏覽器的
        開發者工具裡逐一查看：
      </p>
      <div class="tw">
        <table>
          <thead><tr><th>名稱</th><th>存在哪</th><th>做什麼</th></tr></thead>
          <tbody>
            <tr v-for="s in STORAGE" :key="s.k">
              <td class="m">{{ s.k }}</td><td class="dir">{{ s.where }}</td><td>{{ s.d }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        清除瀏覽器資料會把上述項目一起清掉，效果等同登出。這些資料只留在你的裝置上。
      </p>
      <p class="warnbox">
        <b>關於分析工具，說得精確一點：</b>程式碼裡準備了 Google Analytics 4 的事件埋點
        （例如「進入大廳」「抽卡成功」），<b>但網頁並沒有載入任何分析程式</b>，
        所以目前一個事件都沒有真的送出去。日後若啟用，送出的只有事件名稱本身、
        <b>不帶任何參數</b>，也不會夾帶你的會員資料。啟用時我們會更新這一節。
      </p>
    </section>

    <section id="p-minor">
      <h2>八、未成年人</h2>
      <p>
        未滿 18 歲須經法定代理人同意才能使用本站，這一條寫在
        <RouterLink :to="{ name: 'terms' }">會員條款</RouterLink>第三節。
        生日欄位是選填的，<b>系統目前沒有年齡驗證的流程</b>，我們把這件事直說。
        法定代理人若發現未成年人未經同意使用本站並留下個人資料，
        可以透過客服工單要求我們停止利用並刪除。
      </p>
    </section>

    <section id="p-secure">
      <h2>九、安全措施與我們做不到的事</h2>
      <ul class="bullets">
        <li>密碼以雜湊儲存，我們沒有你的原始密碼。</li>
        <li>登入失敗會依 Email 與 IP 兩個維度分別限制次數，防止密碼被暴力猜測。</li>
        <li>賣家證件、出貨照與開箱影片屬於非公開檔案，讀取要另外簽發限時網址（1 小時），沒有固定的公開連結。</li>
        <li>個資的揭露條件寫在資料庫查詢裡而不是應用層的過濾，減少「新增欄位時忘了濾」的風險。</li>
        <li>後台每一次動作都留稽核紀錄。</li>
      </ul>
      <p class="warnbox">
        沒有任何系統可以保證絕對安全。本站目前<b>沒有雙因素驗證</b>，
        登入憑證的有效期是 30 天。請不要重複使用其他網站的密碼，
        也不要在公用裝置上保持登入。
      </p>
    </section>

    <section id="p-change">
      <h2>十、政策變更</h2>
      <p>
        本政策修改時會在站內公告。若修改涉及蒐集目的或揭露對象的實質變更，
        我們會在你下次登入時另行告知。
      </p>
    </section>

    <details class="src">
      <summary>條文依據（給維護者對照用）</summary>
      <div class="tw">
        <table>
          <thead><tr><th>段落</th><th>依據</th></tr></thead>
          <tbody>
            <tr><td>一・帳號欄位</td><td class="m">server/migrations/001_init.sql:8-14；002_core.sql:5-7；008_member_no.sql:14</td></tr>
            <tr><td>一・第三方登入欄位、不要 Email 權限</td><td class="m">server/migrations/002_core.sql:11-18；server/src/routes/line.ts:8-9, 65</td></tr>
            <tr><td>一・出貨與聯絡欄位</td><td class="m">server/migrations/006_profile.sql:1-19</td></tr>
            <tr><td>一・出貨申請的地址</td><td class="m">server/migrations/002_core.sql:195-206</td></tr>
            <tr><td>一・訂單欄位</td><td class="m">server/migrations/001_init.sql:49-80；009_ship_evidence.sql:15-16</td></tr>
            <tr><td>一・點數帳本只能追加</td><td class="m">server/migrations/001_init.sql:1-30</td></tr>
            <tr><td>一・儲值欄位</td><td class="m">server/migrations/002_core.sql:25-38</td></tr>
            <tr><td>一・檔案的六種用途</td><td class="m">server/migrations/002_core.sql:42-54；server/src/routes/files.ts:58</td></tr>
            <tr><td>一・登入失敗紀錄以 IP／Email 為鍵</td><td class="m">server/migrations/004_rate_limit.sql:8-12</td></tr>
            <tr><td>一・後台稽核欄位</td><td class="m">server/migrations/003_oauth_admin.sql:13-22</td></tr>
            <tr><td>三・賣家可見欄位與三個限制條件</td><td class="m">server/src/routes/sellers.ts:183-217</td></tr>
            <tr><td>三・顯示名稱與本名分開</td><td class="m">server/migrations/006_profile.sql:5-8</td></tr>
            <tr><td>三・公開卡冊預設關閉、分享網址</td><td class="m">server/migrations/007_social.sql:10-15；src/router/index.ts（/u/:slug）</td></tr>
            <tr><td>三・客服可見的完整檔案</td><td class="m">server/src/routes/admin.ts:417-436</td></tr>
            <tr><td>一・公開聯絡表單的欄位、IP 只存雜湊</td><td class="m">server/migrations/037_contact.sql；server/src/routes/contact.ts（hashIp）</td></tr>
            <tr><td>四・聯絡訊息處理完 180 天刪除、未處理不刪</td><td class="m">server/src/routes/contact.ts（sweepContact、CONTACT_KEEP_DAYS）；server/src/index.ts 的五分鐘掃描</td></tr>
            <tr><td>四・寄存 90 天、到期前 14 天提醒</td><td class="m">server/src/pools-service.ts:21, 520</td></tr>
            <tr><td>四・登入紀錄自動清除的窗</td><td class="m">server/src/rate-limit.ts:23, 34, 105-125</td></tr>
            <tr><td>四・鑑定編號永久保存、無查證結果可存</td><td class="m">server/migrations/029_remove_psa_cache.sql（刪除快取表）；server/src/preflight.ts:44（唯一性索引）</td></tr>
            <tr><td>四・檔案保存期限未實作（欄位存在但無人寫入）</td><td class="m">server/migrations/002_core.sql:52-53（files.expires_at）；全庫查無寫入或刪除的程式</td></tr>
            <tr><td>四・無帳號刪除功能</td><td class="m">server/src/routes/auth.ts（查無刪除端點）</td></tr>
            <tr><td>五・LINE 權限範圍</td><td class="m">server/src/routes/line.ts:8-9, 65</td></tr>
            <tr><td>五・drand</td><td class="m">src/shared/fairness.ts:7；src/lib/pool-status.ts:51-57</td></tr>
            <tr><td>五・Railway</td><td class="m">server/src/env.ts:6, 19；server/src/rate-limit.ts:9-11</td></tr>
            <tr><td>五・Cloudflare R2 與限時網址</td><td class="m">server/src/r2.ts:1-33</td></tr>
            <tr><td>五・GitHub Pages</td><td class="m">index.html:31；scripts/seo.mjs:1-21</td></tr>
            <tr><td>五・Google Fonts</td><td class="m">index.html:36-37, 68, 72</td></tr>
            <tr><td>五・TCGdex</td><td class="m">index.html:40-41；src/lib/tcgdex.ts:15, 80</td></tr>
            <tr><td>七・localStorage 與 sessionStorage 的鍵</td><td class="m">src/lib/http.ts:11；src/stores/auth.ts:17；src/lib/haptics.ts:22；src/stores/pools.ts:10；src/stores/orders.ts:73-75</td></tr>
            <tr><td>七・GA4 埋點存在但未載入</td><td class="m">src/lib/ga.ts:47-51；index.html（查無 gtag 載入）</td></tr>
            <tr><td>九・密碼雜湊、雙維度限流</td><td class="m">server/src/routes/auth.ts:69-97；server/src/rate-limit.ts:16-35</td></tr>
            <tr><td>九・非公開檔案的限時讀取網址</td><td class="m">server/src/r2.ts:31-33；server/src/routes/files.ts:100-121</td></tr>
            <tr><td>九・登入憑證有效期 30 天、無雙因素</td><td class="m">server/src/auth.ts:15-21</td></tr>
          </tbody>
        </table>
      </div>
    </details>

    <footer class="df">
      <p>
        <b>這份文件的狀態：</b>本政策是依本平台程式碼與資料庫結構的實際行為草擬的版本，
        目的是讓揭露內容與系統做的事一致。<b>它尚未經過法律專業人士審閱，
        正式營運前應由律師審閱並依實際營運主體修訂。</b>
      </p>
      <p class="upd">最後更新：2026-08-31</p>
    </footer>
  </div>
</template>

<style scoped>
/* 版面與 TermsPage／TradeProtectionPage 同一套骨架 */
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
p b, li b, td b { color: var(--ink); font-weight: 700; }
a { color: var(--accent); }

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
  font-size: 13.5px; line-height: 1.9; color: var(--ink); font-family: var(--font-mono);
}
/* ⟨待填⟩ 底下的那條出路。跟上面的清單分開一段 ——
   它講的不是「還沒填」，而是「在填好之前你現在就可以做什麼」。
   連結補到 44px 觸控高，負外距抵銷視覺影響（同全站頁尾連結的做法）。 */
.blankNow { margin: 12px 0 0 !important; padding-top: 10px; border-top: 1px solid var(--accent); }
.blankNow a { display: inline-block; padding: 13px 2px; margin: -13px 0; }

.hard {
  background: var(--surface-2); border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0; padding: 16px 18px; margin: 16px 0 4px;
}
.hard p { font-size: 14px; margin: 0; max-width: none; }
.bt2 {
  font-family: var(--font-mono); font-size: 11px; letter-spacing: .1em;
  color: var(--accent-soft); margin: 0 0 8px !important;
}

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

.grp { margin: 18px 0 22px; }
.grp h3 { margin-bottom: 6px; }
.what { font-size: 13.5px; margin-bottom: 4px; }

.bullets { margin: 0 0 12px; padding-left: 20px; max-width: 62ch; }
.bullets li { font-size: 14px; line-height: 1.85; color: var(--muted); margin-bottom: 10px; }

.warnbox {
  background: var(--warn-wash); border-left: 3px solid var(--warn);
  border-radius: 0 var(--radius) var(--radius) 0;
  padding: 14px 16px; margin: 14px 0; font-size: 13.5px; max-width: none;
}

.tw { overflow-x: auto; background: var(--surface); border-radius: var(--radius-lg); margin: 12px 0; }
table { border-collapse: collapse; width: 100%; min-width: 420px; font-size: 13.5px; }
th, td { padding: 11px 14px; text-align: left; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
th { background: var(--surface-2); font-size: 12px; color: var(--muted); font-weight: 700; white-space: nowrap; }
td { color: var(--muted); }
tr:last-child td { border-bottom: none; }
td.k { color: var(--ink); font-weight: 700; }
td.t, b.t {
  font-family: var(--font-mono); font-variant-numeric: tabular-nums;
  color: var(--gold); font-weight: 700; white-space: nowrap;
}
td.dir { color: var(--faint); font-size: 12px; white-space: nowrap; }
td.m { font-family: var(--font-mono); font-size: 11.5px; color: var(--faint); }
/* 還沒訂出期限的列要看得出來，不能跟已經有答案的混在一起 */
td.todo { background: var(--warn-wash); color: var(--warn-ink); }
td.todo b { color: var(--warn-ink); }

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
