# 不透過 PSA 官方 API，還能怎麼驗鑑定編號

> ## ⚠️ 這份文件現在是歷史紀錄，不是現況
>
> **平台後來的決定是：完全不驗。** PSA 查證整組移除（`server/src/psa.ts`、
> `routes/psa.ts`、`src/lib/psa.ts`、`PsaBadge.vue` 全刪，migration 029 刪掉快取表）。
> 現在賣家填的鑑定編號**不會跟任何外部來源比對**，捏造的編號會被收下。
> 唯一還在運作的防線是**編號唯一性**（`prizes_cert_alive`，`unique(grader, cert_no)`）——
> 那擋的是一卡多賣，不是造假。見 `docs/open-issues.md` 的 X-1。
>
> 下面提到的 `docs/psa-api-access.md` **已刪除**，本文對它的引用是斷的。
>
> 本文保留的價值是研究結論本身（法律風險、第三方管道、產業實務），
> 以及第 3 點那個「純數字 + 長度 7–9 + 上限」的離線過濾器 ——
> 那一條**至今仍未實作**，而且是移除查證之後唯一還算便宜的補救方向。


調查日期：2026-08-27。方法：WebSearch / WebFetch（未使用瀏覽器自動化、未註冊任何帳號、未嘗試繞過任何存取控制、未大量抓取）。
前提文件：`docs/psa-api-access.md`（PSA Public API 全端點 403、Alt 內部端點不採用、BGS/SGC/CGC 無公開 API，這三件事本文不重查）。
**本文只做研究，沒有改任何一行程式碼。**

> 免責：以下法律段落是我整理公開資料的結果，**不是法律意見**。要上線前請找律師看過。

---

## 結論（先看這裡）

1. **「自動化查 psacard.com」這條路，在台灣要直接劃掉。** 不是因為技術做不到，是因為它同時踩到兩件事：Collectors.com 使用條款逐字禁止 `robot, spider, scraper or other automated means`（該條款明文涵蓋 PSA 與 psacard.com），而 PSA 前面還架了 Cloudflare（**連 `/robots.txt` 都對非瀏覽器 client 回 403**，我實測過）。台灣的 Lawsnote 一審判決（新北地院 111 年度智訴字第 8 號，2025-06-24）認定「違反網站公告使用規範的大量自動下載」構成刑法 359 條「無故取得他人電磁紀錄」，判 4 年。**技術上做得到 ≠ 可用**，這句話在台灣有具體判例，不是抽象警告。

2. **合法的外部管道只剩「付費第三方」，而且沒有一家是 PSA 授權轉售。** Parse.bot（$30/mo 起）、TCGAPIs（£199/mo 起才有無限 PSA Checker）、GemRate Partner API（價格未公開）三家裡，**只有 GemRate 在行銷文案上明說「partner 可以把 cert 細節顯示給買家看」**。其餘兩家的「能不能顯示給終端使用者」我都查不到。付費不是買到授權，是**把合規責任外包**——服務商一旦被 PSA 掐掉，你的功能當天就斷。

3. **PSA cert number 沒有 check digit（查不到任何校驗結構，推論為沒有），但它是流水號，所以有一個 100% 離線、今天就能上線、零法律風險的擋法**：純數字 + 長度 7–9 位 + **上限**。cert 號從 1 開始單調發放，2024-11 才進入 9 位數（跨過 100,000,000），2026-08 下旬約在 **1.737 億**。任何超過上限的輸入必假。這一條就能擋掉相當比例的「隨便打一串數字」。

4. **必須先接受一個事實：就算 cert 查得到，也不代表卡是真的。** 偽造者的標準做法是**從公開的成交照片抄真實 cert 號**，印在假標籤上、裝一張同球員同卡的假卡。eBay 自己的說明就寫著「驗證 cert 號並不能消除風險」。所以「接上一個查得到的 API」根本不是這個問題的解答——**驗證的重心應該放在「賣家給的照片 vs. PSA 官方照片」的人眼對照**，而 PSA 從 2023-01 起替所有送鑑的卡拍了官方掃描照，這件事是免費的、公開的、只要一條超連結就能用。

5. **整個產業沒有人靠 API 驗貨，全部靠實體中介檢驗。** eBay（$250 以上單張鑑定卡送 PSA 實體檢查殼與標籤）、メルカリ（2024-10 起トレカ出品原則自動帶入「あんしん鑑定」，第三方鑑定士出貨前實體驗，1,700 日圓由買家付）、SNKRDUNK（出貨前鑑定）、Whatnot（完全不驗，純事後爭議處理）。**你的規模現在該對標的是 Whatnot 那一端**：上架時做便宜的自動過濾 + 高價品人工審 + 事後爭議兜底。

---

## 方案 A：自動化抓 `psacard.com/cert/{n}`

**可行性**：技術上仍然可行（真實 headless 瀏覽器可以過 Cloudflare 的 managed challenge），但這件事本身就是本方案被否決的理由，不是優點。我在調查中**沒有嘗試**通過該挑戰。

**成本**：伺服器 + headless 瀏覽器維護，每次查詢秒級延遲；PSA 隨時可以再收緊。

**法律與條款風險：這是全文風險最高的一項，建議直接排除。**

- **條款層**：Collectors Universe 的 Terms of Use 明文涵蓋 PSA、PSA/DNA、psacard.com，並禁止：
  > use any robot, spider, scraper or other automated means to access our Services for any purpose

  同一段還禁止 `bypass our robot exclusion headers, interfere with the working of our Services`。
  來源：https://www.collectors.com/Home/TermsOfUse
- **技術層**：我用一般 HTTP client（含正常瀏覽器 UA）請求 `https://www.psacard.com/robots.txt`，得到 **403 + Cloudflare managed challenge 頁**。也就是說 PSA 用技術手段擋掉了非瀏覽器存取，**連 robots.txt 本身都拿不到**（Internet Archive 當日「Temporarily Offline」，備份也調不出來——見「查不到的」一節）。
- **台灣的判例層（關鍵）**：
  - 臺灣新北地方法院 **111 年度智訴字第 8 號**，2025-06-24 宣判。七法（Lawsnote）以爬蟲自動下載法源法律網的法規沿革 98,068 筆、法規內容 102,520 筆、法規附件 130,936 筆，經認定違反著作權法第 91 條與**刑法第 359 條無故取得他人電磁紀錄罪**；郭榮彥 4 年、謝復雅 2 年、公司罰金 150 萬元，連帶賠償逾 1 億 545 萬元。
  - 司法院新聞稿的犯罪事實敘述裡，明白把「**告訴人公告週知之使用規範禁止將內容存檔、複製、重製**」寫進去，作為「無故」的判斷基礎之一。
    來源：https://www.judicial.gov.tw/tw/cp-1888-1350821-0ca41-1.html
  - 律師分析指出，法院引用最高法院見解，把「無故」定義為「無正當理由、未經許可、無處分權限、**違反本人意思、逾越授權範圍**等各種情況」；並對比美國 CFAA 的辦案指引要求技術限制必須「以電腦程式碼或系統設定的方式建立……而不是僅透過合約、服務條款或員工內規來設立」。**換句話說，台灣的入罪門檻比美國低：光是違反使用條款就可能被算進「無故」。**
    來源：https://www.bnext.com.tw/article/83734/the-thoughts-on-lawsnote's-judgement
  - 補充兩點以免誤讀：(a) 這是**一審**判決，尚未確定；(b) 該案有「直接商業競爭對手 + 大規模重製有著作權的編輯著作」這兩個加重情節，跟「查一個編號存不存在」在情節上差很多。**但 PSA 這個情境同時具備「條款禁止」與「技術阻擋」兩項**，比 Lawsnote 案的事實還不利。〔推論〕

**實作難度**：中（要維護反偵測），**但這不是難度問題，是要不要的問題。不要。**

---

## 方案 B：官方／半官方的替代查詢管道（Set Registry、Pop Report、公開 dataset）

**可行性：低到不可行。**

- **Population Report**（https://www.psacard.com/Pop）是**按「卡種（spec）」統計的張數分布**，回答的是「這張卡有幾張拿到 PSA 10」，**它裡面根本沒有 cert number**。所以它**在結構上就不可能拿來驗編號**——這是本次調查最明確的一個否定答案。
- **Set Registry** 是收藏家登錄自己藏品的功能，資料在登入牆後、且是使用者自行輸入，不是可查詢的權威編號索引。
- **公開 CSV / dump**：**不存在**。搜到的所有「PSA 資料集」（Apify 的 `lulzasaur/psa-pop-scraper`、GitHub 的 `ChrisMuir/psa-scrape`、`brad-newman/fetch-psa-api`）**全部是爬蟲或 API 用戶端的產出，不是 PSA 發布的資料集**。用它們等於方案 A 換人執行，法律風險不變（甚至因為「明知是爬來的」而更難主張善意）。
  來源：https://apify.com/lulzasaur/psa-pop-scraper 、https://github.com/ChrisMuir/psa-scrape

**成本 / 風險 / 難度**：不適用——沒有東西可以接。

---

## 方案 C：付費第三方聚合 API

三家值得列，但**沒有一家能證明自己是 PSA 授權的合法轉售**。

### C-1. Parse.bot（psacard.com API wrapper）

- **是什麼**：自承是「an independent, maintained REST wrapper over public data」——**白話說就是代客爬 psacard.com**，並在來源改版時自動修復。
- **涵蓋**：9 個端點，cert lookup（grade、subject、year、brand、pop、images）、pop report、price guide、成交紀錄；**支援一次批次 200 個 cert**。
- **價格**：Free $0 / 200 credits（5 req/min）、Hobby $30 / 1,000、Developer $100 / 5,000、Team $300 / 20,000、Company $1,000 / 100,000。多數端點 1 次呼叫 1 credit。
- **條款是否允許顯示給終端使用者**：**頁面上完全沒有寫。查不到。**
- **風險**：資料來源就是 PSA 公開頁面，**PSA 一旦處理 Parse.bot，你的功能同日中斷**。另外，你雖然沒有直接存取 PSA，但你明知資料是爬來的——這在「善意第三方」的主張上是弱點。〔推論〕
- 來源：https://parse.bot/marketplace/e4bff78d-ff22-4603-b9d3-e3cbb455544e/psacard-com-api

### C-2. TCGAPIs（PSA Certificate Checker）

- **涵蓋**：回傳 subject（球員／角色）、brand、year、card number、grade、grade description、category、population、label type，以及 cert 圖片連結。
- **價格**：Hobby £99/mo（10,000 calls，**不含**無限 PSA Checker）、**Business £199/mo（50,000 calls + unlimited PSA Checker API calls）**、Unlimited £499/mo。另有免登入的公開 demo，**每天 5 次**。
- **條款是否允許顯示給終端使用者**：**定價頁與文件頁都沒有寫。查不到**，要寫信問 `admin@tcgapis.com`。
- **風險**：資料同樣不是 PSA 授權來源（未見任何授權聲明）；£199/mo 對現階段的池量而言偏貴。
- 來源：https://tcgapis.com/pricing 、https://tcgapis.com/psa-checker

### C-3. GemRate Partner API（三家裡最值得寫信問的一家）

- **是什麼**：跨 PSA / BGS / SGC / CGC 的統一 pop report，每日更新，有 universal ID 做跨鑑定商對映。
- **關鍵差異**：它的 Partner 頁面**直接把「顯示給買家」寫進賣點**——`partners can show populations, gem rates, and cert details across PSA, BGS, SGC, and CGC to increase buyer confidence and conversion`。這是三家裡**唯一**把終端顯示寫成預期用途的。
- **價格 / 條款 / 是否真的支援單 cert 查詢**：**查不到**（`/partner` 與 `/faq` 兩頁對 WebFetch 都回 403）。要直接聯絡。
- **另一個好處**：它同時涵蓋 BGS / SGC / CGC，而那三家**連公開網頁 API 都沒有**。如果你未來要開放 BGS 卡上架，這是唯一一個可能一次解決的來源。
- 來源：https://www.gemrate.com/partner 、https://www.gemrate.com/universal-search

### C-4. Apify `psa-pop-scraper`

**不建議。** 它就是託管爬蟲，法律屬性等同方案 A。列在這裡只是為了說明「它不是資料授權方案」。

**整體評語**：付費第三方**不是把風險消除，是把風險移到服務商身上**，而且移得不乾淨（你仍在顯示來源不明的 PSA 資料）。若要走，**先寫信取得書面的「可顯示給終端使用者」確認**再接。

---

## 方案 D：影像辨識 API（不碰 PSA、卻能抓「編號與卡片對不上」）

這是本次調查中**最被低估的一條**，因為它繞開了整個「查 PSA 資料庫」的問題。

**做法**：賣家上架時本來就要傳鑑定卡照片。把照片丟給 slab label OCR，讀出**鑑定商 / 分數 / 卡名 / cert 號**，跟賣家在表單裡輸入的欄位比對；**不一致就攔下來人工審**。

- **Ximilar** 的 `/v2/slab_id` 端點會讀 slab 標籤並回傳 `grade, name, grade company, certification number`；`slab_grade` 會先偵測卡與標籤位置。支援 PSA、Beckett、CGC、TAG、SGC、ACE。
  來源：https://docs.ximilar.com/collectibles/recognition 、https://www.ximilar.com/services/visual-ai-for-collectibles/
- 另有 **PreGradeCards Slab Label Reader**（同類服務，OCR for graded cards）。
  來源：https://pregradecards.com/services/slab-reader

**可行性**：高。它驗的是「**賣家自己給的照片跟賣家自己打的字對不對得上**」，這正是你要擋的第二種問題（編號與卡片對不上），而且**完全不需要 PSA 的資料**。

**成本**：credit 制，**單價查不到**（Ximilar 定價頁只給 credit 計算機，沒有 `slab_id` 的每次單價）。每張卡只需要跑一次（結果可以永久快取），量不會大。

**法律與條款風險：低。** 處理的是使用者上傳到你自己平台的圖片，沒有碰任何第三方受條款保護的資料。要注意的只有個資／圖片授權那一般性條款。

**實作難度**：中低。一個 HTTP 呼叫 + 欄位比對 + 不一致時走既有的 `CERT_MISMATCH` 流程（那條路 `server/src/psa.ts` 已經有了，只是換一個訊號來源）。

**它擋不住什麼**：賣家拿別人的真卡照片來上架（盜圖）。這要靠方案 F 的 proof shot 補。

---

## 方案 E：完全不靠外部 API 的本地驗證

### E-1. 編號格式與上限檢查（**今天就能做，零成本，零風險**）

先講最重要的事實判斷：

- **PSA cert number 沒有公開的 check digit。** 我找遍 PSA 官方說明、第三方教學（figoca、PreGradeCards、slabox、packz、CardGrade）與收藏家論壇，**沒有任何一處提到校驗位或校驗演算法**；所有第三方工具的驗證方式都是「打 API 或查頁面」，沒有任何一個提供離線校驗器。**〔推論：沒有 check digit〕** 這意味著**光憑數學無法判斷單一編號真假**——你只能做範圍與格式的排除。
- **但它是流水號。** 收藏家整理的區段（非官方）：`00000001–00xxxxxx` 早期 1991 年代 → `1xxxxxxx–2xxxxxxx` 90 年代中後期 → `5xxxxxxx–6xxxxxxx` 疫情熱潮與積壓期 → `7xxxxxxx–8xxxxxxx` 2022–2024 → `9xxxxxxx` 2024–2025 → `100000000+` 為 9 位數時代。**9 位數是 2024-11 才首次出現。**
  來源：https://forums.collectors.com/discussion/1123446/certification-number-and-grading-period 、https://www.blowoutforums.com/showthread.php?t=1600238
- **目前的上限**：社群使用者於 2026-08 下旬回報 cert 號「sitting in the 173,730,000 range」。**這是社群估算，不是 PSA 官方數字。**
  來源：https://www.elitefourum.com/t/when-was-my-psa-card-graded-a-visual-guide-to-the-timeline-of-psa-certification-numbers-1991-2026/60160

**可以做的規則**（保守，寧可放過不要誤殺）：

| 規則 | 判定 | 理由 |
|---|---|---|
| 非純數字、含空白／符號 | 擋 | PSA cert 一律純數字 |
| 長度 > 9 | 擋 | 9 位數是 2024-11 才開始，10 位還沒到 |
| 數值 > 200,000,000 | 擋 | 目前約 1.737 億，留約 15% 餘裕，設成可調環境變數 |
| 數值 = 0 或前導零之外全為同一數字（`11111111`、`12345678`、`99999999`） | 標記高風險，不硬擋 | 亂打的典型樣態；但理論上可能真的存在，所以走人工 |
| 長度 < 7 | 標記高風險 | 是 1991–1993 年的極早期卡，真的有，但在台灣抽卡池出現的機率極低 |

**成本**：0。**風險**：0。**難度**：極低（一個純函式 + 單元測試，不需要任何網路）。

### E-2. 用 cert 區間推年份 —— **明確不建議當作驗證規則**

很多人會想：既然是流水號，那就能用「這張 1999 年的卡怎麼會有 2024 年的編號」來抓假。**這個推論不可靠，我實際查證後認為不能用**：

- 早期（1991–2008）「有大量 `3XXXXXXX`、`4XXXXXXX`、`8XXXXXXX`、`9XXXXXXX` 的 cert 是跟最早期的送件一起產生的」，本來就不按時間順序。
- 2020–2022 的積壓造成大亂序，「積壓的訂單有時包含比當下落後將近 1,000 萬號的 cert」。
- **重鑑（reholder）會給新號**：一張 1999 年的卡在 2026 年重新裝殼，就會拿到 2026 年的號。這是完全正常的。
- 原文自己下的結論：cert 號「**不是判斷何時產生的決定性答案**」。
  來源：https://www.elitefourum.com/t/when-was-my-psa-card-graded-a-visual-guide-to-the-timeline-of-psa-certification-numbers-1991-2026/60160

**結論：區間對照只能當「風險分數」的弱訊號（例如：卡片年份與編號區段落差極大 → 分數 +1，累積到門檻才人工審），絕對不能當硬擋規則。**

### E-3. 平台內交叉比對（**今天就能做，零成本，效果被低估**）

你已經有 unique index，那擋的是「同一個池裡重複」。真正有價值的是**跨池、跨賣家、跨時間**的比對：

1. **全站 cert 歷史索引**：任何曾經上架過的 cert 都留一筆（含賣家、時間、當時填的卡片資訊、池狀態），**即使池已結束**。
2. **同一 cert、不同賣家** → 幾乎必有一方有問題（卡被賣掉後轉手是可能的，所以是**人工審**不是硬擋）。這正好對應到「偽造者抄公開 cert 號」的攻擊樣態——**而且你平台自己的歷史資料就是最好的偵測面**。
3. **同一 cert、同一賣家、但這次填的卡片資訊不一樣** → 直接擋，這是明確的矛盾。
4. **新賣家短時間內大量不同 cert** → 風險分數，優先人工審。
5. **編號密集連號**（例如一次上架 10 張連續編號）→ 這其實**可能是真的**（同一批送鑑會拿到連號），所以是**降低**風險而不是提高。反過來說，「宣稱來自不同來源卻剛好連號」才可疑。

**成本**：0（一張表 + 幾個查詢）。**風險**：0。**難度**：低。

### E-4. Proof shot（實體照片 + 手寫紙條）

**業界怎麼做**：

- **歐美卡圈的 timestamp 慣例**：拍照時把寫著「平台名 + 使用者名 + 當日日期」的手寫紙條放在卡旁邊一起入鏡，用來證明「這張卡此刻真的在你手上」。這在 Reddit 的交易版（r/PKMNTCGTrades）是行之有年的社群規範——**但我沒有抓到規則原文**（Reddit 對本次工具不可讀），所以這一條列為**慣例陳述，不是可引用的來源**。
- **メルカリ** 對 PSA 鑑定品出品的要求是「詳細な画像」與明確的狀態說明，強調 PSA 只代表「通過評分標準」不等於完美品。
  來源：https://toreka-cycler.com/pokemoncard/pokeka-mercal/psa_real
- 日本市場已明確把「**すり替え詐欺**（照片是真品、寄出的是別的東西）」列為主要詐騙型態之一，這正是 proof shot 要防的。
  來源：https://pokeca-bank.com/column/replacement-psa/ 、https://cheetah-daka.info/2769/

**建議的具體要求**（自己就能訂，不需要任何外部依賴）：

1. slab **正面標籤特寫**：cert 號 + 條碼 + 分數必須清晰可讀（同時餵給方案 D 的 OCR）。
2. slab **整體正面 + 背面**（背面新標籤有 QR）。
3. **手寫紙條合照**：紙條上寫平台名 + 賣家 ID + 當日日期，與 slab 同框。
4. 照片一律**存原檔**（含 EXIF），出爭議時是證據。

**注意 QR 的陷阱**：新標籤背面的 QR 只是編碼成 cert 驗證頁的連結，**掃得開不代表是真品**，因為偽造者可以直接複製真標籤上的 QR。QR 的價值只有「免打字」。
來源：https://www.slabox.app/en/blog/psa-cert-number-lookup-guide

**成本**：0 開發成本，成本落在賣家的摩擦上。**風險**：0。**難度**：低（上傳流程已存在）。

### E-5. 把 PSA 官方頁面當「給買家看的連結」而不是「給機器讀的資料源」（**今天就能做**）

這是**零條款風險**的做法，而且你已經做了一半（`PsaBadge.vue` 已經連到 `psacard.com/cert/{certNo}`）。可以再放大它的效果：

- **PSA 從 2023 年 1 月起，替所有送鑑的卡（Economy 級以上）拍官方正反面掃描照，免費公開在 cert 頁上。**
  來源：https://onlygreats.com/2023/09/16/psa-image-scans-for-cards/
- 所以對 **2023 年後鑑定的卡**（台灣抽卡池裡的主流），買家點一下連結就能看到 **PSA 拍的那張卡本身**，跟賣家上傳的照片做人眼對照。**這比任何 API 回傳的文字欄位都有說服力**——因為它能抓到「cert 是真的但卡是假的」這種 API 抓不到的情況。
- 在池頁把這件事**寫成使用者看得懂的一句話**（例如「點此看 PSA 官方拍攝的這張卡，請與上方照片對照」），就是產品層面最划算的一步。

**成本 / 風險 / 難度**：0 / 0 / 極低（文案 + 已有的連結）。

### E-6. 人工審核

**什麼時候需要**：業界的分界線一律是**金額**，不是規模。

- **eBay**：單張鑑定卡 **$250 以上**才進 Authenticity Guarantee（實體送 PSA 檢查殼與標籤）。低於門檻的完全不驗。
- **メルカリ**：反過來，2024-10 起**トレカ出品原則全面**帶入「あんしん鑑定」，但**鑑定費 1,700 日圓由買家負擔**（不是平台吸收）。
- **你的情況**〔推論〕：抽卡池的獎品價值分布是長尾，**建議用「單張獎品市值 ≥ X」+「風險分數 ≥ Y」兩個條件的聯集**進人工審，X 一開始可以設得高（例如 NT$5,000），觀察一週的實際筆數再往下調。

**成本估算**〔推論，沒有可引用的來源〕：一張卡的人工審 = 看 3 張照片 + 點開 PSA cert 頁對照 + 比對賣家填的欄位，熟手約 1–2 分鐘。若每天 20 張需審，約 40 分鐘/天，一個人可以兼著做到每天 100–200 張。**也就是說在你需要專職審核人力之前，還有很長一段路**——這段路上該投資的是「把該審的挑出來」（E-1 + E-3 + D），不是「審得更快」。

---

## 方案 F：其他平台實際上怎麼處理

| 平台 | 上架時驗 cert？ | 實際做法 |
|---|---|---|
| **eBay** | **否** | 靠 Authenticity Guarantee：單張鑑定卡 $250 以上，實體先送第三方（鑑定卡由 PSA）檢查**殼與標籤**是否遭竄改／偽造，通過才轉寄買家。接受 PSA / SGC / CGC / BGS 四家。PSA 若發現假殼，會**停用該 cert** 並通知賣家。eBay 自己的說明明白寫著「驗證 cert 號**不能**消除風險，犯罪者會用公開來源取得的真實 cert 號偽造標籤」。 |
| **Whatnot** | **否**（找不到任何上架前驗證的公開說明） | 純事後：買家申訴 → Whatnot 審查（含買家申訴歷史）→ 美國賣家可能被要求把貨寄到 Whatnot 倉庫檢驗 → **判定前一定給賣家提出真品證明的機會** → 判定為假則買家全額退款、向賣家追償全額（含稅與運費）。 |
| **メルカリ（日本）** | **否，但出貨前一定驗** | 2024-10 起トレカ出品時**預設自動帶入「あんしん鑑定」**：賣家先寄到鑑定中心，第三方鑑定士（IVA）實體檢驗，通過才貼標籤寄給買家；不通過則**自動取消交易、全額退款**。單張／未開封 BOX **1,700 日圓，由買家負擔**。註明：**只受理 PSA 的鑑定殼**，其他鑑定商的殼不處理。 |
| **SNKRDUNK（日本）** | 否，出貨前驗 | 同樣是「寄到平台先鑑定卡與殼，再轉寄買家」的中介模式。 |
| **日本オリパ** | 幾乎不驗 | 監理壓力完全在**景品表示法**（機率與獎品的不實表示），不在 cert 驗證。2024-10 修法後不實表示可直接刑責，已有業者被課徵金 780 萬日圓 + 停業 6 個月的案例。 |
| **台灣（蝦皮 / 露天 / 卡拍拍 / 皮卡屋）** | **查不到任何一家公開說明驗證流程** | 露天推「卡牌交易所」串接 eBay 日本 PSA 卡直送（等於把驗貨責任外包給來源）。皮卡屋是查價 SaaS，不做交易（見 `docs/competitor-pikawu.md`）。 |

來源：
https://www.ebay.com/authenticity-guarantee/tradingcards 、
https://help.whatnot.com/hc/en-us/articles/360061604031-Counterfeit-Policy-and-Restricted-Branded-Items-Policy 、
https://www.itmedia.co.jp/news/articles/2410/15/news137.html 、
https://help.jp.mercari.com/guide/articles/1499/ 、
https://note.com/cardfesta/n/n8b5db6eeeba0 、
https://www.ikedasomeya.com/insight/26467 、
https://corp.pchome.tw/psa10頂級鑑定卡這裡買！露天市集「卡牌交易所」串/

**這張表最重要的一列是 Whatnot**：一個估值數十億美元、以卡牌直播拍賣為主業的平台，**在鑑定卡上架時什麼都不驗**。這說明「上架即時驗證」不是這個產業的必要條件，**爭議處理流程才是**。

---

## 查不到的

以下每一項我都實際找過，找不到就是找不到，不推測：

1. **`psacard.com/robots.txt` 的內容**——Cloudflare 對非瀏覽器 client 直接 403（實測），Internet Archive 當日回「Temporarily Offline」（實測），CDX 索引只有 1999–2001 的 404 紀錄。我沒有嘗試通過 Cloudflare 挑戰。
2. **PSA cert number 是否真的沒有 check digit**——沒有任何來源提到校驗結構，我推論為沒有，但**這是「查無」不是「證無」**。
3. **PSA 官方目前發到第幾號**——只有社群估算（2026-08 約 1.737 億），PSA 從未公布。
4. **TCGAPIs / Parse.bot 的條款是否允許把資料顯示給終端使用者**——兩家的公開頁面都沒寫。
5. **GemRate Partner API 的價格、條款、是否支援單一 cert 查詢**——`/partner` 與 `/faq` 對 WebFetch 都回 403。
6. **Ximilar `slab_id` 的每次呼叫單價**——只找到 credit 計算機，沒有公開單價。
7. **r/PKMNTCGTrades 的 timestamp 規則原文**——Reddit 對本次工具不可讀。timestamp 慣例的存在是我從多方轉述得知，**沒有一手來源**。
8. **Whatnot 是否對鑑定卡有任何上架前檢查**——找遍說明中心只找到事後的 Counterfeit Policy。〔推論：沒有〕
9. **任何台灣平台公開的鑑定卡驗證流程**——蝦皮、露天、卡拍拍都查不到。
10. **PSA API End User Agreement 全文**——沿用 `docs/psa-api-access.md` 第 6 節的結論，仍在登入牆後。
11. **人工審核的業界人力成本數字**——沒有任何平台公布過，第 E-6 節的估算是我的推論。

---

## 建議：依「今天就能做」到「需要外部依賴」排序

### 第 0 層：今天就能做，不用等任何人，零成本零風險

| # | 做什麼 | 擋掉什麼 | 難度 |
|---|---|---|---|
| **1** | **cert 格式 + 上限檢查**（純數字、長度 7–9、值 ≤ 2 億、上限做成可調環境變數） | 隨便打一串數字的絕大多數樣態 | 極低（純函式） |
| **2** | **全站 cert 歷史索引 + 跨賣家重複告警**（不只現有池的 unique index） | 抄公開 cert 號的攻擊樣態；同一賣家自我矛盾的填寫 | 低 |
| **3** | **池頁文案把「PSA 官方照片對照」講清楚**（2023 年後的卡都有官方掃描照，一條超連結的事） | 「cert 是真的但卡是假的」——這是 API 抓不到、只有人眼能抓的一類 | 極低（文案） |
| **4** | **明訂 proof shot 規則**（標籤特寫 + 正反面 + 手寫紙條含平台名/賣家ID/日期，原檔留存） | 盜圖上架、すり替え | 低 |
| **5** | **風險分數 + 人工審門檻**（金額 ≥ X 或分數 ≥ Y 才審；X 先設高再往下調） | 把有限的人力用在對的地方 | 低 |

**這五件事合起來，就已經覆蓋了你原本想用 PSA API 解決的絕大部分問題，而且沒有任何一項需要等 PSA、等法務、等預算。**

### 第 1 層：小額外部依賴，風險低

| # | 做什麼 | 成本 | 備註 |
|---|---|---|---|
| **6** | **slab 標籤 OCR**（Ximilar `/v2/slab_id`）比對「照片上的 cert / 分數 / 卡名」vs「賣家填的」 | credit 制，單價查不到 | **這是唯一能真正自動抓「編號與卡片對不上」的手段**，而且完全不碰 PSA 的條款。接進既有的 `CERT_MISMATCH` 分支即可 |

### 第 2 層：要花錢、要先問清楚條款

| # | 做什麼 | 成本 | 先決條件 |
|---|---|---|---|
| **7** | **寫信給 GemRate 問 Partner API** | 未知 | 三家裡唯一把「顯示 cert 細節給買家」寫成預期用途的；且一次涵蓋 BGS/SGC/CGC |
| **8** | Parse.bot（$30/mo 起）或 TCGAPIs（£199/mo 起） | $30–£199/mo | **務必先取得書面的「可顯示給終端使用者」確認**再接。兩家的資料都是 PSA 公開頁面的衍生，PSA 一動作就會斷 |

### 第 3 層：不做

| # | 為什麼 |
|---|---|
| 自行爬 `psacard.com/cert` / 繞 Cloudflare / 用 Apify 託管爬蟲 | Collectors.com 條款逐字禁止 + 技術阻擋 + 台灣 Lawsnote 判例。**期望收益遠低於風險** |
| 用 cert 區間推年份當硬擋規則 | 早期亂序 + 積壓亂序 + 重鑑給新號，來源自己說「不是決定性答案」 |
| 期待 PSA 官方 API 核准 | 零筆成功紀錄（見 `docs/psa-api-access.md`）。信可以寫，但**不要把任何排程掛在它身上** |

### 如果只做一件事

**做第 1 項（格式 + 上限檢查）。** 它是一個純函式、不需要網路、不需要任何人核准、可以在一小時內寫完並測完，卻能立刻擋掉「隨便打一串數字」這個你最想擋的行為的大部分。現有的 `server/src/psa.ts` 已經有 `invalid_format` 這條分支（原本要靠 PSA 回 `IsValidRequest:false` 才會走到），**把它改成本地就能判定，等於在 API 全 403 的今天就恢復了一半的防護**——而且 PSA 哪天核准了，這層檢查還是該留著，因為它省下配額。

---

## 附錄：一句話回答你的五個問題

1. **官方查詢頁有沒有合法的自動化方式？** 沒有——Collectors.com 條款逐字禁止 robot/spider/scraper 且明文涵蓋 PSA，PSA 又用 Cloudflare 實際擋住（連 robots.txt 都拿不到），在台灣 Lawsnote 判例下「違反公告使用規範的自動下載」已被一審認定構成刑法 359 條。
2. **有沒有官方/半官方的替代查詢管道？** 沒有——Pop Report 是按卡種統計、**結構上根本不含 cert number**，Set Registry 在登入牆後且是使用者自填，公開 CSV/dump 不存在（市面上所有「資料集」都是爬蟲產物）。
3. **付費第三方？** 有三家（Parse.bot $30/mo 起、TCGAPIs £199/mo 起才無限、GemRate 價格未公開），**沒有一家是 PSA 授權轉售**，其中只有 GemRate 明說 partner 可以把 cert 細節顯示給買家。
4. **不靠外部 API 能做什麼？** 很多——cert **沒有 check digit**（查無，推論沒有）但是流水號，所以「純數字 + 長度 7–9 + 值 ≤ 2 億」今天就能擋掉大半亂打；再加上全站 cert 歷史的跨賣家重複偵測、proof shot（手寫紙條合照）、以及把 2023 年後 PSA 官方掃描照的連結講清楚讓買家自己對照，效果比接 API 更貼近真正的風險。
5. **其他平台怎麼做？** 沒有人在上架時查 API——eBay 是 $250 以上實體送 PSA 檢查殼、メルカリ 是トレカ出品原則全面走出貨前第三方實體鑑定（1,700 日圓買家付）、Whatnot 完全不驗只做事後爭議與賣家追償、台灣各平台則查不到任何公開的驗證流程。
