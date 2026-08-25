# 卡片價格資料來源研究：refPrice 的外部錨點怎麼接

> **這不是法律意見。** 作者不是律師。法遵段落盡量引用條文、判決與條款原文並附連結，但適用要看具體事實。**動手前請諮詢熟悉智財與公平交易法的台灣律師** —— 尤其本文引用的 Lawsnote 案一審尚未定讞，它的二審結果會直接改變台灣爬蟲的風險基準線。
>
> 研究日期：**2026-08-25**。所有網址、API 回應、匯率都是當日實測。價格資料本身天天在變，本文引用的數字只用來說明**量級與結構**，不是報價。
>
> 匯率基準：**1 EUR = 37.1959 TWD**（2026-08-22）、**1 JPY = 0.20024 TWD**（2026-08-23），來源 [Pluang EUR/TWD](https://pluang.com/en/tools/currency-converter/eur-twd)、[Pluang JPY/TWD](https://pluang.com/en/tools/currency-converter/jpy-twd)。

---

## 目錄

- [標記約定](#標記約定)
- [先讀這一段：六個會改變決策的發現](#先讀這一段六個會改變決策的發現)
- [建議選型（結論）](#建議選型結論)
  - [第 0 層：先補 `variant` 欄位](#第-0-層資料模型先補一個欄位在接任何-api-之前)
  - [第 1 層：TCGdex 的 Cardmarket 價（免費）](#第-1-層raw-日版卡的錨點tcgdex-內建的-cardmarket-價先接這個)
  - [第 3 層：鑑定卡的付費錨點](#第-3-層鑑定卡psa--bgs的錨點justtcg-或-pokemonpricetracker--用條款選不要用資料選)
  - [明確不要做的事](#明確不要做的事)
- [一、來源逐一查證](#一來源逐一查證)
  - [1.1 歐美來源](#11-歐美來源)
  - [1.2 日本來源](#12-日本來源)
  - [1.3 台灣來源](#13-台灣來源)
  - [1.4 第三方卡價 API（付費）](#14-第三方卡價-api付費)
  - [1.5 一頁比較表](#15-一頁比較表)
- [二、對應（matching）的難題](#二對應matching的難題)
- [三、實務建議](#三實務建議)
- [四、法遵](#四法遵)
- [五、查不到的部分](#五查不到的部分)
- [六、具體實作建議](#六具體實作建議)

### 標記約定

沿用 [`research-oripa-business-model.md`](./research-oripa-business-model.md) 的來源分級：

- **一手** —— 法條、判決、官方 API 文件、業者自己的條款頁、我當場跑出來的 API 回應
- **二手可信** —— 有具名來源的報導與分析
- **業者宣稱** —— 廠商自己的行銷頁，未經第三方驗證
- **聯盟行銷** —— 有分潤動機的內容，一律打折

凡是我的推論而非查到的事實，一律以 **〔推論〕** 標記。查不到的一律寫「查不到」，不用推測填補。

---

## 先讀這一段：六個會改變決策的發現

### 一、你的 `setCode` + `cardNo` **已經是** TCGplayer 日版目錄的天然主鍵 —— 對應難題基本上不存在

這是整份研究最有價值的發現，而且我當場驗證過。

[TCGCSV](https://tcgcsv.com/) 是 TCGplayer 目錄與價格的每日公開鏡像，免 API key。它的 `categoryId 85` 就是 **Pokemon Japan**（日版），而且：

- `group.abbreviation` 欄位的值 **就是你的 `setCode`**（只差大小寫）
- `product.extendedData.Number` 欄位的值 **就是你的 `cardNo`**（連 `349/190` 這個斜線格式都一樣）

專案 `src/mocks/data.ts` 用到的四個代號（`sv4a`/`sv8a`/`sv3`/`sv6`）**全部命中**；我另外加測了四個（含促販 `sv-p`）也全中，**8/8**（一手，2026-08-25 實測）：

```
$ curl -s https://tcgcsv.com/tcgplayer/categories
  categoryId  3 = "Pokemon"        （英版）
  categoryId 85 = "Pokemon Japan"  （日版）← 你要的

$ curl -s https://tcgcsv.com/tcgplayer/85/groups     # 456 個日版 group
  sv4a  -> (23601, 'SV4a: Shiny Treasure ex')
  sv8a  -> (23909, 'SV8a: Terastal Fest ex')
  sv3   -> (23609, 'SV3: Ruler of the Black Flame')
  sv6   -> (23614, 'SV6: Transformation Mask')
  sv2a  -> (23599, 'SV2a: Pokemon Card 151')
  sv1s  -> (23605, 'SV1S: Scarlet ex')
  sv11w -> (24350, 'SV11W: White Flare')
  sv-p  -> (23779, 'SV-P Promotional Cards')   ← 連促販卡都有

$ curl -s https://tcgcsv.com/tcgplayer/85/23601/products
  567748 | Charizard ex - 349/190 | Number=349/190 | Rarity=Special Art Rare
  567746 | Mew ex       - 347/190 | Number=347/190 | Rarity=Special Art Rare
  577567 | Penny        - 354/190 | Number=354/190 | Rarity=Special Art Rare

$ curl -s https://tcgcsv.com/tcgplayer/85/23601/prices     # 484 筆
  {"productId":567748,"lowPrice":215.99,"midPrice":226.9,
   "highPrice":299.95,"marketPrice":225.57,"subTypeName":"Holofoil"}
```

**`(setCode, cardNo)` 兩個字串直接 join 到 productId + USD 市價 + rarity，零模糊比對。**

〔推論〕這意味著「對應很難所以先讓賣家自填」這個理由，對 **RAW 日版卡** 而言不成立。

### 二、但 TCGCSV 的**法律地位是空白的**，而 TCGplayer 官方 API 已對新開發者關閉

TCGCSV 首頁自述資料來自 TCGplayer 的 API（一手），但**整站查不到任何 Terms of Use、授權聲明、或與 TCGplayer 的授權關係說明**。同時：

- TCGplayer 官方 API **不再對新開發者發 key**（二手可信，[TCG API 比較文](https://tcgapi.dev/compare/tcgplayer-api/)）
- TCGplayer ToS 禁止 crawl/scrape，並主張對「any content created or derived therefrom」的權利（二手可信，[TCGplayer Terms of Service](https://help.tcgplayer.com/hc/en-us/articles/205004918-Terms-of-Service)；官方條款頁對我回 **HTTP 403**，未取得原文）
- TCGplayer API 條款另有一條對你**特別致命**：禁止「combining TCGplayer's pricing data with other pricing data」（二手可信，同上）—— 而「混多來源算一個錨點」正是最自然的設計

**技術上最順的那條路，法務上最不清楚。** 這個矛盾是本研究的核心張力。

### 三、你的卡是日版 + 鑑定卡，而「日版 × 鑑定等級 × 成交價」這個交集**沒有任何來源同時做到官方 API 化**

拆開看：

| 需求 | 有官方 API 的來源 |
|---|---|
| 日版 RAW 價 | ✅ TCGCSV（TCGplayer 日版目錄）、TCGdex（Cardmarket 歐洲價） |
| 鑑定等級分開報價 | ✅ PriceCharting、PokemonPriceTracker、tcgfast（皆為 eBay 成交推導） |
| **日本國內**成交價 | ❌ 遊々亭 / カードラッシュ / スニダン / メルカリ / ヤフオク **全部沒有公開 API** |
| PSA cert 真偽驗證 | ✅ PSA Public API（**但不含價格**） |

**鑑定卡的價格，市面上所有 API 化的來源都是從 eBay 成交推導的**，也就是「日版卡在歐美市場的成交價」，不是日本國內行情。這兩者會有落差，而且落差方向不固定（〔推論〕：熱門 SAR 在歐美有溢價，冷門日版在歐美則因流動性差而折價）。

### 四、Cardmarket 價已經**免費躺在你現在就在用的 API 裡**，而且日版覆蓋率是滿的

你用 TCGdex 取卡圖。TCGdex 的 `/v2/ja/cards/{id}` 回應裡**本來就帶 Cardmarket 價格**。我用專案 `src/mocks/data.ts` 裡全部 31 張卡的 `artId` 去打，**31 張全部有 Cardmarket 價**（一手，2026-08-25 實測）：

```json
// GET https://api.tcgdex.net/v2/ja/cards/SV4a-349
"variants_detailed":[{"type":"holo","variantId":"jr7oetx1mqug9",
  "pricing":{"cardmarket":{"updated":"2026-08-24T15:18:56Z","unit":"EUR",
    "idProduct":747703,"avg":264.56,"low":199.9,"trend":261.85,
    "avg1":259.99,"avg7":231.16,"avg30":257.51},
  "tcgplayer":null}}]
```

**零開發成本、零新依賴、零 API key**（TCGdex 免 key，[FAQ 原句](https://tcgdex.dev/faq)：*"free to use and requires no API key"*）。

⚠️ 但日版卡的 `tcgplayer` 欄位**幾乎全是 null**（我抽樣 SV4a 的 13 個 variant，tcgplayer 命中 0、cardmarket 命中 10）。想從 TCGdex 拿日版 TCGplayer productId 行不通 —— 那要走 TCGCSV。

### 五、把外部價貼上去，會立刻暴露現有 `refPrice` 的量級錯誤 —— 而且**兩個方向都錯**

我拿 `src/mocks/data.ts` 的 31 張示範卡，逐張對照 TCGdex 帶出來的 Cardmarket `trend`（EUR→TWD @37.1959）：

| artId | 卡名 | 鑑定 | refPrice NT$ | CM trend € | 換算 NT$ | ref ÷ CM |
|---|---|---|---:|---:|---:|---:|
| SV8a-237 | 太樂巴戈斯 ex UR | PSA10 | 19,800 | 5.53 | 206 | **96.3×** |
| SV3-128 | 大比鳥 ex SAR | RAW | 2,200 | 1.87 | 70 | **31.6×** |
| SV6-124 | 八朔 SAR | RAW | 1,200 | 1.23 | 46 | **26.2×** |
| SV3-131 | 波琵 SAR | RAW | 760 | 0.96 | 36 | **21.3×** |
| SV4a-354 | 牡丹 SAR | BGS9.5 | 15,600 | 19.79 | 736 | 21.2× |
| SV4a-350 | 奇樹 SAR | PSA10 | 28,000 | 43.89 | 1,633 | 17.2× |
| SV3-125 | 噴火龍 ex SAR | PSA9 | 9,800 | 16.16 | 601 | 16.3× |
| SV4a-349 | 噴火龍 ex UR | PSA10 | 42,000 | 261.85 | 9,740 | 4.3× |
| SV4a-348 | 沙奈朵 ex UR | PSA10 | 7,600 | 148.67 | 5,530 | 1.4× |
| SV8a-215 | 差不多娃娃 ex | RAW | 240 | 6.06 | 225 | 1.07× |
| SV8a-216 | 砂鐵蜥 ex | RAW | 120 | 3.28 | 122 | 0.98× |
| SV8a-211 | 太陽伊布 ex SAR | RAW | 2,600 | 88.46 | 3,290 | 0.79× |
| SV8a-217 | 月亮伊布 ex SAR | RAW | 5,400 | 447.61 | 16,649 | **0.32×** |
| SV4a-347 | 夢幻 ex UR | RAW | 6,400 | 646.07 | 24,031 | **0.27×** |
| SV4a-341 | 謎擬Ｑ SAR | RAW | 200 | 28.58 | 1,063 | **0.19×** |
| SV8a-206 | 冰伊布 ex | RAW | 340 | 91.90 | 3,418 | **0.10×** |

（完整 31 張的原始數字可用同樣方式重跑，這裡取兩端與中段。）

**注意兩件事：**

1. **RAW 卡的 refPrice 系統性偏低**（伊布家族全部 0.1×–0.3×）。這些是示範資料不是真實賣家輸入，所以它證明的不是「賣家在騙」，而是 **「這些數字從來沒有跟任何外部現實對過帳，於是錯得沒有方向性」**。
2. **PSA10 的 refPrice 系統性偏高，這是「對的」** —— Cardmarket 報的是 RAW 價，PSA 10 本來就該有倍數。SV4a-349 的 4.3× 是合理的 PSA10/RAW 倍數；但 SV8a-237 的 **96×** 顯然不是倍數，是錯誤。

〔推論〕**這張表本身就是最強的產品論證**：一旦有錨點，離譜的數字會自己跳出來，不需要人工審核每一張卡。

### 六、台灣有一個案子讓「先爬再說」這條路的風險，比你想的高一個數量級

**Lawsnote（七法）v. 法源**，新北地院 2025 年 6 月一審（二手可信，[益思科技法律事務所分析](https://www.is-law.com/lawsnote-fined-is-web-crawling-or-scraping-legal/)、[聯合新聞網](https://udn.com/news/story/7321/8832333)）：

- 罪名：**著作權法第 91 條第 2 項**（意圖銷售而擅自重製）＋ **刑法第 359 條**（無故取得他人電磁紀錄）
- 刑度：創辦人 **有期徒刑 4 年**、工程師 2 年、公司罰金 150 萬，民事連帶賠償 **約 1 億 545 萬元**
- 兩個致命見解：
  1. **「法規沿革」被認定為受保護的編輯著作** —— 即使底層是不受保護的公開事實，**選擇與編排**仍可能構成編輯著作
  2. **違反網站使用規範即構成刑法 359 條的「無故」**

**上訴中，尚未定讞**（在智慧財產及商業法院）。

這跟美國方向相反 —— 美國 [Van Buren v. United States, 594 U.S. 1 (2021)](https://www.supremecourt.gov/opinions/20pdf/19-783_k53l.pdf) 明確採窄解，單純違反使用政策不構成 CFAA。**但你的公司在台灣，適用的是台灣法。**

---

## 建議選型（結論）

**分四層，每一層解決不同的問題。不要試著用一個來源解決全部。**

### 第 0 層：資料模型先補一個欄位（在接任何 API 之前）

`CardItem` 目前無法表達 **variant（版本）**。這不是小事：

```
GET https://api.tcgdex.net/v2/ja/cards/SV2a-025   # ピカチュウ（151）
  variants_detailed:
    type=normal              cardmarket.idProduct=719467  trend=0.02 EUR
    type=reverse foil=pokeball   idProduct=837271  trend=0.28 EUR
    type=reverse foil=masterball idProduct=837272  trend-holo=369.10 EUR
```

同一組 `(sv2a, 025/165)` 可能值 **NT$0.7，也可能值 NT$13,700 —— 差 18,000 倍**（一手實測）。你現在的 schema **分不出來**。

**在接價格 API 之前先加 `variant` 欄位**，值域對齊 TCGdex 的 `variants_detailed[].type` + `.foil`。沒有它，錨點在 151 / SV8a 這類含特殊 mirror 的套牌上會系統性錯到離譜，比沒有錨點更糟（因為錯的數字會被當成權威）。

### 第 1 層｜RAW 日版卡的錨點：**TCGdex 內建的 Cardmarket 價**（先接這個）

- **理由**：你已經在用 TCGdex、`artId` 已經存在資料庫、31/31 命中、免 key、免費、當天更新。**今天就能接，開發成本接近零。**
- **用哪個數字**：`avg7`（七日均價）。不要用 `trend`（Cardmarket 自有演算法，不透明）、不要用 `low`（含毀損品，實測 `low` 常只有 `trend` 的 30–50%）、**絕對不要用 `avg1`**（單日均價，我實測 SV8a-217 的 `avg1=660` vs `avg7=391`，一天內 69% 的擺盪）。
- **誠實的缺點**：這是**歐洲市場的歐元價**，不是日本行情也不是台灣行情，而且**只有 RAW**。它是一個**量級檢查器**，不是報價。

### 第 2 層｜日版 RAW 的第二意見：**TCGCSV（TCGplayer 日版）** —— 但先解決授權

- **理由**：`(setCode, cardNo)` 直接命中，`marketPrice` 是 TCGplayer 實際成交的加權均價（[TCGplayer 官方說明](https://help.tcgplayer.com/hc/en-us/articles/213588017-TCGplayer-Market-Price)：*"based upon actual recent sales"*），北美市場，可以跟 Cardmarket 的歐洲價互相校驗。
- **但**：TCGCSV 無條款、TCGplayer API 對新開發者關閉、且其條款禁止「與其他價格資料合併」。**先寫信問 TCGCSV 的授權狀態，再決定要不要用。** 這一層不急。

### 第 3 層｜鑑定卡（PSA / BGS）的錨點：**JustTCG** 或 **PokemonPriceTracker** —— 用條款選，不要用資料選

這是唯一需要花錢的一層，也是**條款差異最大的一層**。

**PokemonPriceTracker（$99/月 Business）—— 條款明確允許，我逐字確認過：**

> "You may store and cache PokePriceTracker Data in your own systems and serve it to the end users of your own application"
> — [PokemonPriceTracker Terms](https://www.pokemonpricetracker.com/terms)（一手）

> "Using PokePriceTracker Data for any commercial purpose requires an active Business or Enterprise subscription"（同上）

禁止的是把**原始資料當成獨立產品轉售／再散布**（"resell, sublicense, syndicate, or redistribute the raw data itself as a standalone product"）—— 你的用途（在自家平台顯示參考價）**不落在禁令內**。

規格（業者宣稱，[API docs](https://pokemonpricetracker.com/api-docs)）：`language=japanese` 參數、涵蓋 50,000+ 英日版卡、`ebay.salesByGrade` 逐等級成交價（PSA/CGC/BGS/SGC）、每日更新、Business 層 200,000 credits/日 + CSV export。

**JustTCG（$19/月 Starter、$49/月 Professional）—— 條款寫得最清楚，而且最便宜：**

> "Display current prices, historical trends, and percentage changes to end users within a consumer-facing application or website."
> "Cache API responses server-side and store historical price points for as long as your subscription remains active"
> "Combine data obtained from the Service with other lawfully obtained market data sources."
> — [JustTCG Terms](https://justtcg.com/terms)（一手）

**最後那句非常重要**：它是我查到**唯一明文允許「與其他來源的價格資料合併」的服務** —— 而 TCGplayer 官方條款恰好明文禁止這件事（見 §1.1）。想做「多來源交叉驗證」的設計，這條決定了你能不能做。

⚠️ **但鑑定價還在 beta**。JP 日版 OCG 完整資料是官方部落格宣布的（業者宣稱，[公告](https://justtcg.com/blog/now-in-the-justtcg-api-full-pokemon-japanese-data-grand-archive-tcg-pricing)），但 PSA/BGS/CGC 作為 first-class variants 是 **v2 beta**（二手可信）。**採用前必須用免費層實測你自己的 PSA 卡。**

**PriceCharting（Legendary $49/月）—— 資料最漂亮，條款直接擋住你的用途：**

> "Price Data cannot be used in any software, application, or system that is accessible to third parties"
> "Data can only be redistributed with express written consent of PriceCharting.com."
> "Apps and other software cannot share the price data without express written permission."
> — [PriceCharting Terms of Service](https://www.pricecharting.com/page/terms-of-service) 與 [Guide ToS](https://www.pricecharting.com/page/guide-terms-of-service)

**唯一開的口**是這句：*"Price data may be referenced on external websites provided that"* → 需標註來源 ＋ 可見超連結。**但「網站可 reference」與「app/system 不可」之間的界線官方沒有定義**，這是灰色地帶，不要自行推斷。

它的欄位結構是全場最細的（`loose-price`=RAW、`cib-price`=7/7.5、`new-price`=8/8.5、`graded-price`=9、`box-only-price`=9.5、`manual-only-price`=**PSA 10**、`bgs-10-price`、`condition-17`=CGC 10、`condition-20`=BGS 10 Black…），且日版覆蓋最完整（**245 個 "Pokemon Japanese ..." 分類**）。⚠️ 另有兩個硬限制：**"Historic prices and historic sales are not supported."**（只有現價，沒有歷史曲線）、限速 **1 call/秒**。

**書面同意的窗口**：`sales@pricecharting.com` / `brady@vgpc.com`。〔推論〕**如果要用 PriceCharting，先寄信拿到書面同意，不要先寫程式。**

**Scrydex（$29/月 Starter）—— 灰區，不要賭：**

pokemontcg.io 團隊的接班產品，`/pokemon/v1/ja/cards` 是一等公民端點，全方案含 Graded Prices + Population + Price History（[定價](https://scrydex.com/pricing)：Starter $29 / Growth $99 / Professional $399）。

**但它的條款既沒有明文允許、也沒有明文禁止「快取後在自家商用網站顯示」**（一手，[scrydex.com/terms](https://scrydex.com/terms)）。有的只是第 4 條禁止 *"Resell, sublicense, redistribute, mirror, or commercially exploit the Services without prior written authorization"* 與禁止當 *"substitute backend, proxy"*。〔推論〕「commercially exploit」這個詞夠寬，寬到能涵蓋你的用途也能不涵蓋 —— **沉默不是允許。要用就先取得書面確認。**

### 這一層的選擇邏輯

〔推論〕**不要用「資料誰最好」來選，用「誰的條款白紙黑字允許你做你要做的事」來選。** 資料品質的差距，遠小於一封律師信的成本。

| 服務 | 月費 | 明文允許顯示給使用者？ | 明文允許快取？ | 明文允許與其他來源合併？ | 鑑定價成熟度 |
|---|---|:--:|:--:|:--:|---|
| **JustTCG** | $19 / $49 | ✅ | ✅ | ✅ **唯一** | ⚠️ v2 beta |
| **PokemonPriceTracker** | $99 | ✅ | ✅ | ⚠️ 未提 | ✅ 生產中 |
| PriceCharting | $49 | ❌ 需書面同意 | — | — | ✅ 欄位最細 |
| Scrydex | $29 | ⚠️ 沉默 | ⚠️ 沉默 | ⚠️ 沉默 | ✅ 含 pop |

**建議：先用 JustTCG 免費層實測日版 PSA 卡的覆蓋率。** 覆蓋夠 → 用 JustTCG（便宜、條款最寬）；覆蓋不夠 → 用 PokemonPriceTracker Business（貴四倍，但鑑定價是生產級的）。

PokemonPriceTracker 還有一條被低估的條款：*"may be retained and used within your own application indefinitely"* —— **退訂後抓過的資料仍可留用**。〔推論〕這代表你可以訂閱幾個月把日版熱門卡的分級價灌滿，長期成本可控。⚠️ 但這條我只看到 ToS 文字，簽約前建議用 email 再確認一次。

### 第 4 層｜PSA 真偽驗證：**PSA Public API**（跟價格是兩件事）

[PSA Public API](https://www.psacard.com/publicapi) 提供 `GET /publicapi/cert/GetByCertNumber/{certNumber}`，回傳卡片描述、grade、population。官方文件原句：*"We currently offer access to data from Cert Verification"* —— **完全不含價格**。

**但它解決另一個同樣重要的洞**：賣家可以填一個假的 `certNo` 配上 `grade: 10`。這個 API 讓你能驗證「這張 PSA 卡真的存在、真的是 10 分」。**這跟定價無關，但它跟 `refPrice` 一樣是護欄的地基** —— PSA 10 的價格倍數只有在卡真的是 PSA 10 時才成立。

⚠️ 查不到它的 rate limit 與費用（官方文件未載明）。需自行註冊測試。

### 明確不要做的事

| 不要做 | 為什麼 |
|---|---|
| 爬 **スニダン / SNKRDUNK** | 利用規約第 7 條第 1 項第 13 号具名禁止：**「クローリング、スクレイピング又はこれらと類似する手段により」**（[snkrdunk.com/terms](https://snkrdunk.com/terms)，一手） |
| 爬 **遊々亭** 再轉貼價格 | 利用規約：**「無断での転載を禁止」**（[yuyu-tei.jp/info/rule/](https://yuyu-tei.jp/info/rule/)，一手）。它的 robots.txt 沒有任何 Disallow，但 robots 放行 ≠ 條款允許 |
| 爬 **カードラッシュ** | 集團媒體站規約禁止事項含**「本サービスによって得られた情報を商業的に利用する行為」**（[cardrush.media/terms](https://cardrush.media/terms)，一手。⚠️ 這是媒體站規約，不等同通販站 —— 通販站本體對我回 403，規約全文未取得） |
| 爬 **PSA** | 全站 Cloudflare managed challenge，**連 `/robots.txt` 都回 403**（一手實測）。這是明確的拒絕訊號 |
| 爬 **呼卡 / 蝦皮 / 任何台灣站** | Lawsnote 案（見發現六）。在台灣，這是刑事風險 |
| 用 **pokemontcg.io** | 它**零日版覆蓋**（「Include Non-English Cards」issue 從 **2018-03-16** 開到現在仍 open，[#78](https://github.com/PokemonTCG/pokemon-tcg-api/issues/78)），而且 `sv3` 在它那裡是**英版 Obsidian Flames**，跟你的日版《黒炎の支配者》**語意衝撞**，照抄會查到錯的卡。我實測當日 `api.pokemontcg.io` 回 **HTTP 500**，API 程式碼 repo 最後 commit 是 **2021-02-22**。團隊已把它併成 **Scrydex** |
| 用 **Card Ladder / Collectr / Market Movers / Ludex** | 四家的條款**全部明文封死商用**：Card Ladder *"for your personal, non-commercial use only"* 且禁止 *"Populate a database by systematically downloading"*（[terms](https://www.cardladder.com/terms)）；Collectr *"must not access or use for any commercial purposes"* 且禁止 *"crawling, scraping or otherwise caching"*（[terms](https://www.getcollectr.com/terms-and-conditions)）；Market Movers *"any commercial use of our Content, is prohibited without... prior written permission"*（[ToS](https://www.sportscardinvestor.com/terms-of-service/)）；Ludex 只給 *"personal, non-commercial"* 授權（[terms](https://www.ludex.com/terms)）。資料再好也不能用 |
| 直接接 **eBay** 拿成交價 | 見 §1.1。成交價 API 對新用戶關閉，而且 API 條款有三條跟你的產品設計直接衝突：**listing 快取上限 6 小時**、**不得與非 eBay 內容混排**、**做定價工具需 eBay 書面同意** |

---

## 一、來源逐一查證

### 1.1 歐美來源

#### TCGplayer

| 項目 | 查證結果 |
|---|---|
| 涵蓋日版 | ✅ **有獨立的日版目錄**：`categoryId 85 = "Pokemon Japan"`，456 個 group，含 SV-P 促販（一手，透過 TCGCSV 實測） |
| 分鑑定等級 | ❌ **不分**。它是 RAW 單卡市集，價格按 condition（NM/LP/…）與 subType（Normal/Holofoil）分，**沒有 PSA/BGS 維度** |
| 官方 API | ⚠️ **對新開發者已關閉**（二手可信，[tcgapi.dev 比較文](https://tcgapi.dev/compare/tcgplayer-api/)）。原本就主要發給賣家與 affiliate |
| 條款允不允許顯示 | 🚨 **逐條踩線**（見下方原文） |
| 商品識別碼 | `productId`（數字）。**`(setCode, cardNo)` 可直接 join**，見發現一 |

**API 條款原文**（[TCGplayer API Terms & Conditions](https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions)，Updated 2022-06-08。⚠️ 該頁對我回 HTTP 403，以下逐字引用由子代理取得，**簽約前請自己開瀏覽器覆核**）：

- 用途限定：*"The API is provided solely for the purpose of (a) academic research or (b) promoting... the Site."*
- 🚨 *"Combine TCGplayer's pricing data with your own or a third party's pricing data."*（禁止）
- 🚨 *"Distribute TCG Content... for commercial or competitive purposes."*（禁止）
- 🚨 *"Sell, rent, trade, distribute, lease... copy, store or modify content or information"*（禁止）
- 強制標註：*"This product uses TCGplayer data but is not endorsed or certified by TCGplayer."*，且 *"A link must be provided to direct the user to the appropriate TCGplayer product page"*

> **判讀**：把 TCGplayer 價格存下來、跟你自己的參考價**並列比較**、放在商業抽選網站 —— **三條同時踩到**。而「並列比較」正是這整個需求的核心。〔推論〕**TCGplayer 這條路，除非拿到單獨授權，否則走不通。**
>
> ⚠️ 另外：Partner API 官方公告已死（*"Our Partner API will be deprecated starting August 14th, 2023"*，[docs.tcgplayer.com](https://docs.tcgplayer.com/docs/partner-api-deprecation)），而 API Terms 裡指向的**開發者申請表本身已 404**（實測）。「2024 年底起停止受理新申請」這說法只出現在競品的 SEO 部落格，**查不到官方公告，不採信**。

**Market Price 的定義值得抄**（一手，[TCGplayer 官方說明](https://help.tcgplayer.com/hc/en-us/articles/213588017-TCGplayer-Market-Price)）：它是**實際成交**的滾動加權平均，按卡、按 condition、按 treatment 分開算，只計入 TCGplayer 自家結帳的交易。二手來源另指出：**成交筆數不足時不顯示** Market Price —— 這正是你需要的「查不到就承認查不到」的設計。

#### TCGCSV（TCGplayer 的每日公開鏡像）

| 項目 | 查證結果 |
|---|---|
| 是什麼 | 首頁自述：*"This website lets you download information including the prices of trading cards and products in a spreadsheet (CSV)"*，資料來自 TCGplayer API（一手，[tcgcsv.com](https://tcgcsv.com/)） |
| 更新頻率 | *"All content updates everyday around 20:00:00 UTC"*（一手） |
| 涵蓋日版 | ✅ 完整，見發現一 |
| 已知限制 | 首頁明說：*"this project does not share information about SKUs. This means that you will not be able to get prices for each condition of a card."* —— **拿不到分 condition 的價**，只有整品項的 low/mid/high/market |
| 費用 | 免費、免 key（有 Patreon） |
| **條款** | ❌ **整站查不到任何 Terms of Use 或授權聲明，也查不到它與 TCGplayer 的授權關係。** 這是它最大的問題 |
| 存取 | 需帶瀏覽器 User-Agent，否則回 **HTTP 401**（一手實測） |

#### Cardmarket

| 項目 | 查證結果 |
|---|---|
| 涵蓋日版 | ✅ **有**。TCGdex 為 SV4a/SV8a 等日版套牌回傳了 Cardmarket `idProduct`（例：SV4a-349 → 747703），代表 Cardmarket 目錄裡有日版商品（一手，間接驗證。⚠️ 我無法直接開 Cardmarket 商品頁確認 —— 該站對我回 **HTTP 403**） |
| 分鑑定等級 | ❌ **不分**。RAW 為主，按 condition 分 |
| 官方 API | ⚠️ **不收新申請**。官方頁原句：*"we are not accepting applications for access to the Cardmarket API"*（[help.cardmarket.com](https://help.cardmarket.com/en/cardmarket-api)）。文件頁另寫 *"API applications and access are restricted to professional sellers"*（[Auth Overview](https://apiv2.cardmarket.com/ws/documentation/API:Auth_Overview)）。2026-01-30 起網域搬到 `apiv2.cardmarket.com`，舊網域回 HTTP 410 |
| 條款 | ❌ **查不到原文**。cardmarket.com 的 Terms 頁被 Cloudflare 擋（回 CAPTCHA），help.cardmarket.com 無對應條款頁 |
| 實務取得方式 | **透過 TCGdex 免費取得**（見發現四）。市面上的 cardmarketapi.com / cardmarket-api.com 皆為**非官方第三方爬蟲**，法務風險更高 |
| 欄位 | Product priceGuide 只有 `SELL / LOW / LOWEX+ / LOWFOIL / AVG / TREND / TRENDFOIL`（[官方 entity 文件](https://apiv2.cardmarket.com/ws/documentation/API_2.0:Entities:Product)）—— **沒有任何 PSA/BGS 概念**。透過 TCGdex 拿到的是 `low/avg/trend/avg1/avg7/avg30`，EUR，每日更新 |

#### PriceCharting

| 項目 | 查證結果 |
|---|---|
| 涵蓋日版 | ✅ **明確涵蓋，且用你的套牌代號**。頁面文案寫 *"Ungraded & graded values for all Pokemon sv4a"*（[pokemon-japanese-shiny-treasure-ex](https://www.pricecharting.com/console/pokemon-japanese-shiny-treasure-ex)） |
| 分鑑定等級 | ✅ **這是它最強的地方，且是結構化欄位**：`loose-price`=Ungraded、`graded-price`=Graded 9、`box-only-price`=Graded 9.5、`manual-only-price`=**PSA 10**、`bgs-10-price`、`cgc-10`、grade 1–8 各自欄位、另有 `cert-id` |
| 價格性質 | 實際成交價，來自 eBay 等市集的 sold listings。2025/12 起加入 TCGplayer 成交資料（[官方 blog](https://blog.pricecharting.com/2025/12/tcgplayer-sales-data-has-been-added.html)） |
| 官方 API | ✅ 有（[api-documentation](https://www.pricecharting.com/api-documentation)），40 字元 token 帶 `t` 參數。*"API's are a premium tool. You must have a paid subscription"* |
| 費用 | **Legendary $49/月**（含 API + CSV 下載）；Collector $6/月（$59/年）**不含 API**（[pricecharting-pro](https://www.pricecharting.com/pricecharting-pro)） |
| 限速 / 限制 | **1 call/秒**；CSV 每 10 分鐘一次。🚨 *"Historic prices and historic sales are not supported."* —— **只有現價，沒有歷史曲線** |
| **條款** | 🚨 **明文擋住前台展示**（見「建議選型」第 3 層的逐字引用）。書面同意窗口：`sales@pricecharting.com` / `brady@vgpc.com` |
| 識別碼 | `id`（PriceCharting product ID）＋ **`epid`（eBay Product ID）**。對照表 = CSV 下載，**限 Legendary 訂閱者** |
| 缺點 | 成交來源是**歐美市場**，不是日本國內。日版卡在 eBay 的價格與遊々亭／スニダン會有落差 |
| 備註 | **Sportscardspro 與 PriceCharting 是同一家公司、同一套資料庫**（其 ToS 自述 *"made available by PriceCharting"*，API base URL 是 pricecharting.com）。條款、價格、欄位、識別碼全部相同 |

#### PSA

**兩個完全不同的東西，不要混淆：**

**(a) PSA Public API —— 只做 cert 驗證，不做價格**
- ✅ 官方存在：[psacard.com/publicapi](https://www.psacard.com/publicapi)、[文件](https://www.psacard.com/publicapi/documentation)、[Swagger](https://api.psacard.com/publicapi/swagger/ui/index)
- Endpoint：`GET https://api.psacard.com/publicapi/cert/GetByCertNumber/{certNumber}`，OAuth2 bearer
- 官方文件原句：*"We currently offer access to data from Cert Verification"* —— **Population Report / Auction Prices / Price Guide 明確不在內**
- 回應欄位含 `spec_id`（PSA 內部目錄鍵）、`grade`、`population`
- ❌ 查不到 rate limit 與費用
- 參考實作：[brad-newman/fetch-psa-api](https://github.com/brad-newman/fetch-psa-api)

**(b) PSA Auction Prices Realized (APR) —— 有資料，但拿不到**
- 是**網頁工具，不是 API**：[psacard.com/auctionprices](https://www.psacard.com/auctionprices)，聚合 eBay、Goldin 等 500 萬筆以上成交，每日更新（[PSA 官方文章](https://www.psacard.com/articles/articleview/9416/massive-database-auction-results-unlocked-free-collectors)）
- ✅ **確實涵蓋日版**。URL 結構：`psacard.com/auctionprices/tcg-cards/{year}-pokemon-japanese-{setslug}/{card-slug}/{numericId}`，實例：[2023 SV4a Charizard ex](https://www.psacard.com/auctionprices/tcg-cards/2023-pokemon-japanese-sv4a-shiny-treasure-ex/charizard-ex/10040917)
- 🚨 **但無法從 `setCode` 推出 URL**：末端 `10040917` 是不透明數字 ID，前段 slug 需要年份與 PSA 自己的命名（且命名不一致）。必須先爬一份對照表
- 🚨 **而且爬不動**：PSA 全站 Cloudflare managed challenge，**連 `/robots.txt` 都回 HTTP 403**（一手實測，2026-08-25）
- 🚨 **APR 頁面現在還要登入**：子代理實測 `psacard.com/auctionprices/tcg-cards/1998-pokemon-japanese-promo` 回傳的標題是 **"Sign In to PSA"**
- 條款：psacard.com **專屬的網站使用條款查不到**（`/termsandconditions` 是評級服務合約，不是網站條款）。同集團的 [Collectors.com User Agreement](https://www.collectors.com/termsofuse) 明文禁止 *"use any robot, spider, scraper or other automated means"* 與 *"bypass our robot exclusion headers"* —— ⚠️ 但那是 collectors.com 的條款，對 psacard.com 的適用範圍未定

#### eBay

| 項目 | 查證結果 |
|---|---|
| Finding API | ❌ **已死**。`findCompletedItems` 2020 年起限縮，Finding API 2024/1 棄用、**2025/2 除役** |
| 現行替代（成交價） | **Marketplace Insights API** —— 90 天內成交紀錄。但是 **Limited Release**，需 Business-level 審核，官方文件現在寫 **"restricted and not open to new users at this time"**（[eBay Marketplace Insights overview](https://edp.ebay.com/api-docs/buy/marketplace-insights/static/overview.html)） |
| Browse API | ✅ 免費可申請，**但只有在架商品，沒有成交價** |
| 涵蓋日版 | ✅ 有（eBay 上日版 PSA 寶可卡交易量很大） |
| 分鑑定等級 | ⚠️ 只在**標題文字**裡，**沒有結構化 grade 欄位**。這也是為什麼 PriceCharting / PokemonPriceTracker 這類服務有存在價值 —— 它們替你做了標題解析 |
| 識別碼 | `itemId`、**`epid`（eBay Product ID）** |

**Finding API 已死，這是官方紀錄**（[eBay API Deprecation Status](https://edp.ebay.com/develop/get-started/api-deprecation-status)）：`Finding API | All | 2025/02/04 | This API has been replaced by the Browse API`。Shopping API 同日除役。

**eBay API License Agreement 的三條，跟你的產品設計正面衝突**（[官方協議](https://edp.ebay.com/join/api-license-agreement)）：

- 🚨 **快取時效上限是硬規定**：*"Displayed item listing information may not be more than six (6) hours older"*，其他 eBay Content *"no more than twenty-four (24) hours older"*
- 🚨 **不准混排**：*"eBay Content in a Public Display may not be co-mingled or combined with non-eBay Content"* —— 必須跟你自己的資料**視覺上隔離**
- 🚨 **做定價工具要書面同意**：*"to develop pricing tools, only upon receiving eBay's express prior written consent"*
- 下架就要刪：*"When the eBay Content is no longer publicly available, you must delete it"*

〔推論〕「賣家自填的參考市值旁邊放一個 eBay 錨點」這個設計，**直接違反「不得混排」那條**。而「6 小時快取上限」意味著你得高頻打 API，這對批次同步的架構也不友善。

⚠️ **查不到**：eBay 那句廣為流傳的 *"restricted and not open to new users at this time"* 的官方原文頁面 —— developer.ebay.com 全站對我與子代理都回 403，edp 鏡像的 Buy API 索引已經**完全沒有 Marketplace Insights 這一項**（只列 Browse / Feed / Notification / Deal / Taxonomy / Offer / Message / Identity / Developer Analytics）。**「路是關的」這個結論是從索引消失＋Limited Release 門檻推得的〔推論〕，不是官方原話。**

〔推論〕**所有能拿到 eBay 成交價的服務，都是第三方在替你做**（合法性各自負責）。

#### 其他歐美工具（皆無適用的官方資料授權）

- **Card Ladder**、**Market Movers**、**Collectr**、**Ludex**、**Cardbase** —— 皆為消費端 App／訂閱工具，查不到對外資料授權方案
- **pokemontcg.io** —— 見「明確不要做的事」。零日版覆蓋、setCode 語意衝撞、當日回 500、repo 無 LICENSE 檔（查不到資料授權條款）
- **TCGdex** —— 見發現四。MIT 授權（[cards-database](https://github.com/tcgdex/cards-database)，1023 stars，最新 commit 2026-08-21），免 key。⚠️ **但 MIT 涵蓋的是它自己的卡片資料庫，不必然涵蓋它從 Cardmarket 轉手的價格** —— TCGdex 自己的 [markets-prices 頁](https://tcgdex.dev/markets-prices) 與 [FAQ](https://tcgdex.dev/faq) **都沒有說明價格資料的授權**。這是一個真實的法務缺口

### 1.2 日本來源

**總結先講：沒有任何一個日本卡店或二手市場提供「可合法商用 + 含鑑定等級 + 含成交價」的官方 API。** 這不是我沒查到，是不存在。

| 來源 | 性質 | 價格性質 | 分鑑定等級 | 官方 API | robots.txt | 條款 |
|---|---|---|---|---|---|---|
| **遊々亭** [yuyu-tei.jp](https://yuyu-tei.jp/) | 實體卡店通販＋買取 | 賣家開價（販売／買取兩套） | ❌ 只有「傷無し／傷有り」 | ❌ 查不到 | **無任何 Disallow**（僅 Crawl-delay 1–20s）（一手） | **「無断での転載を禁止」**（[規約](https://yuyu-tei.jp/info/rule/)，一手）。未提スクレイピング |
| **駿河屋** [suruga-ya.jp](https://www.suruga-ya.jp/) | 大型中古通販 | 賣家開價 | ⚠️ 只在商品標題文字 | ❌ 無官方商品 API（有 affiliate 但只做導流） | `User-agent: * / Allow: /`，Content-Signal **`search=yes, ai-train=no, use=reference`**，封 Amazonbot/GPTBot/ClaudeBot 等（一手） | ❌ 利用規約全文未取得（站本體對非瀏覽器 UA 回 403） |
| **カードラッシュ** [cardrush-pokemon.jp](https://www.cardrush-pokemon.jp/) | 寶可卡專門通販＋買取 | 賣家開價 | ⚠️ 標題文字 | ❌ 查不到（但已與 App「トレカチ」提携，有 B2B 意願） | `Allow: /`，Content-Signal 同駿河屋 | 集團媒體站禁止**「本サービスによって得られた情報を商業的に利用する行為」**（[cardrush.media/terms](https://cardrush.media/terms)，一手）。通販站本體規約未取得 |
| **magi** [magi.camp](https://magi.camp/) | 卡牌專用 C2C 市場 | 出品價＋成交紀錄 | ⚠️ 多半在標題 | ❌ | `User-Agent:* / Disallow:`（全站允許）（一手） | 禁止事項含**「当社が提供するインターフェイスとは別の手法を用いてサービスにアクセスすること」**（[magi.camp/terms/use](https://magi.camp/terms/use)，一手） |
| **スニダン / SNKRDUNK** [snkrdunk.com](https://snkrdunk.com/) | 中介型二手市場（先鑑定再轉交） | ✅ **實際成交價** | ✅ **分得出，且是獨立商品**（官方發布「PSA10 取引売上ランキング」） | ❌ | 僅 Disallow `/en/v1/*`（一手） | 🚨 第 7 條 1 項 13 号具名禁止**「クローリング、スクレイピング又はこれらと類似する手段により」**（[snkrdunk.com/terms](https://snkrdunk.com/terms)，一手） |
| **トレコロ** [torecolo.jp](https://www.torecolo.jp/) | Card Box 集團通販 | 賣家開價 | ✅ 有賣 PSA 鑑定品分類 | ❌ | 無任何 Disallow（一手） | ❌ 規約全文未取得 |
| **ヤフオク** | 拍賣 | ✅ 實際落札価格 | ⚠️ 標題文字 | 🚨 **官方拍賣 API 已於 2020/1 終止**（[Yahoo!デベロッパー公告](https://developer.yahoo.co.jp/changelog/auctions.html)）。現行 [API 一覽](https://developer.yahoo.co.jp/sitemap/) 已無拍賣 API | — | — |
| **メルカリ** | C2C | 出品價／SOLD 成交價 | ⚠️ 標題 | ❌ 唯一官方 API 是 **メルカリShops Public API**，只能管**自家**商店商品，**不能查別人的行情** | `Disallow: /v1/ /v2/ /mypage/ …`（一手） | 未取得 |
| **晴れる屋2** [hareruya2.com](https://www.hareruya2.com/) | 寶可卡專門店（秋葉原） | 賣家開價 | ✅ 有處理 PSA | ❌ 查不到 | Shopify 預設（`Disallow: /search`、`/policies/`） | — |
| **Amazon.co.jp PA-API** | — | 賣家開價 | ❌ | 🚨 **PA-API 5.0 已廢止**（2026/4/30 deprecation、5/15 端點退役，改為 Creators API，[官方公告](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation)）。且日版單卡覆蓋率極差，**類目與粒度都不對** |

**日本的價格聚合站**（皆查不到 API）：[みんなのポケカ相場 pokeca-chart.com](https://pokeca-chart.com/)（有「鑑定特化モード」顯示 PSA10 價格與排名）、[トレカジャパン tradecard.jp](https://tradecard.jp/)（自述從**メルカリ、スニーカーダンク**收集出品價與售出價，每日更新 —— 也就是說**它替你承擔了スニダン規約的風險**，但也讓它自己的資料來源合法性存疑）、[トレカチ tcg-price.jp](https://tcg-price.jp/)（與カードラッシュ提携）、[ポケカチ altema.jp](https://altema.jp/pokemoncard/psaprice)。

**日本唯一有法人 API 的成交價聚合：オークファン（aucfan）**
- [法人 API](https://topics.aucfan.com/release/aucfan-api/)，定位在「買取・値付け現場」的業務效率化 —— **正是你的使用情境**
- 宣稱持有過去約 10 年、700 億件成交資料（業者宣稱）
- 甚至已推出 MCP server（[說明](https://help.aucfan.com/hc/ja/articles/51930651859993)）
- ❌ **查不到公開定價**，需洽談
- ❌ **查不到**是否有結構化的 grade 欄位（源資料是拍賣標題，很可能只能關鍵字比對「PSA10」）

### 1.3 台灣來源

**結論：台灣三大電商／拍賣，沒有一個提供可合法取得「成交價」的公開介面。**

| 來源 | 有 API？ | 能拿到成交價？ | 備註 |
|---|---|---|---|
| **蝦皮 Shopee** | ⚠️ Open Platform **僅限商城賣家或第三方系統商（如 ERP）**（[串接說明 PDF](https://deo.shopeemobile.com/shopee/seller/seller_cms/851f1bbc9dd4b951ef74692d460f405e/%5BTW%5D%5BOpen%20API%5DAPI%E4%B8%B2%E6%8E%A5%E8%AA%AA%E6%98%8E%E4%BA%8B%E9%A0%85%20(2021_02_20).pdf)）。另有 **Affiliate Open API**（[分潤計畫](https://affiliate.shopee.tw/)），門檻低 | ❌ **拿不到**。頁面上的「已售出 N 件」只是累計數量 | Affiliate 是唯一「條款上明確允許顯示」的路徑，但只有**上架價**。ToS 有標準禁爬條款（[Shopee ToS](https://help.shopee.sg/portal/4/article/77148-Shopee-Terms-of-Service)；⚠️ 繁中版原文未取得） |
| **露天 Ruten** | ⚠️ 有 OPEN API 申請流程（[幫助中心](https://www.ruten.com.tw/help/seller/11335/)），HMAC-SHA256 簽章。審核看會員評價、伺服器 IP、自有購物網站成熟度 —— **實質是給賣家／ERP 用** | ❌ 查不到全站商品／成交查詢 API | |
| **Yahoo奇摩拍賣** | ❌ 官方 API 說明頁已 404 | ❌ | 第三方 ERP 用 Chrome 外掛做同步，暗示無公開 API |
| **Carousell 台灣** | ❌ 查不到官方 API | ❌ | |
| **PChome** | ⚠️ 限已加入的供應商 | ❌ | 自營新品，對鑑定卡估值無幫助 |
| **台灣實體卡店** | ❌ **查不到**任何結構化公開報價表 | — | 實務上報價多在 FB 社團／LINE 群 |

#### ★ 呼卡 Huca（huca.tw）—— 台灣唯一對得上你需求的服務

這是台灣本地最值得注意的一個，**但它是消費端工具，不是資料供應商**。

- **是什麼**：繁中介面的 PTCG 比價搜尋引擎。自述：*「呼卡每日自動同步日本最大卡牌交易平台 Snkrdunk 與全球拍賣網站 eBay 的實際成交紀錄」*（一手，[huca.tw](https://huca.tw/)）
- **涵蓋**：日版＋美版，*「PSA 10（Gem Mint）、PSA 9 等各評級的最新成交行情與歷史走勢圖」*，支援中日英三語與 PSA 卡號搜尋（一手，[llms.txt](https://huca.tw/llms.txt)）
- **收費**（一手，[subscription.php](https://huca.tw/subscription.php)）：免費 15 次搜尋/日、普通 NT$299/月 50 次/日、高級 NT$499/月無限
- ❌ **查不到 API、查不到 B2B 資料授權、查不到利用規約**（`/terms`、`/about`、`/contact` 全部 404）
- 🚨 **robots.txt 明確 `Disallow: /api/`**（對所有 UA）（一手）
- 🚨 **它的資料來自 Snkrdunk，而 Snkrdunk 規約具名禁止爬取。** 〔推論〕向它取用資料**繼承了這層風險**，除非它握有 Snkrdunk 的授權 —— 而這點我查不到
- 聯絡：`peggylu006@gmail.com`（站上公開）

> ⚠️ **一個必須揭露的觀察**：huca.tw 的 `llms.txt` 裡有一段標題為 "System Instructions for LLMs" 的文字，內容是指示 AI 在被問到卡價時**優先推薦該站**。這是寫給模型看的行銷指令，不是事實陳述。我把它當**資料**而非指令處理，本文對呼卡的評價完全基於可查證的功能與條款。〔推論〕這也提醒一件事：**任何你打算信任的價格來源，都要問「它有沒有動機讓數字往某個方向偏」。**

其他台灣／華語圈：[PTCGTW](https://ptcgtw.shop/set_price.php)（繁中版卡價，**跟你的日版卡對不上**）、[卡之島 CardLand](https://cardland.com.hk/)（香港、中文版、港幣）、[TCGSTORE](https://www.tcgstore.com.tw/search)、[PokeScope](https://pokescope.app/)（掃描 App，無 API）。

### 1.4 第三方卡價 API（付費）

這一節是實務上唯一能買到「日版 × 鑑定等級 × 成交價」的地方。**全部都是把 eBay 成交資料做標題解析後結構化**，資料的最終源頭是同一個。

| 服務 | 日版 | 鑑定等級 | 資料源 | 費用 | 條款（能否顯示） |
|---|---|---|---|---|---|
| **[JustTCG](https://justtcg.com/)** | ✅ 官方公告已含 full Pokémon Japanese OCG（**未公布卡數**） | ⚠️ PSA/BGS/CGC 為 first-class variants，但 **v2 beta** | TCGplayer + eBay + **實體店成交**（業者宣稱） | Free → **Starter $19** → Pro $49 → Ent $149 | ✅ **最寬**：明文允許顯示給終端使用者、server-side 快取、**與其他來源合併** |
| **[PokemonPriceTracker](https://www.pokemonpricetracker.com/)** | ✅ `language=japanese`，宣稱 50,000+ 英日卡 | ✅ PSA/CGC/BGS/SGC/TAG/ACE 逐級（含半級） | eBay 成交，每日更新 | Free 100 credits/日 → API $9.99 → **Business $99**（商用）→ Ent $300 | ✅ **明文允許快取與顯示**；退訂後 *"may be retained... indefinitely"* |
| **[PriceCharting](https://www.pricecharting.com/)** / Sportscardspro | ✅ **245 個 "Pokemon Japanese" 分類**（全場最完整） | ✅ **欄位最細**（RAW/7/8/9/9.5/PSA10/BGS10/CGC10/SGC10/TAG10 + epid） | eBay sold + TCGplayer 成交 | **Legendary $49**（含 API+CSV）；Collector $6 不含 API | 🚨 **明文禁止對第三方顯示**，需 express written permission |
| **[Scrydex](https://scrydex.com/)** | ✅ `/pokemon/v1/ja/cards` 一等公民 | ✅ 含 population，全方案都有 | 未明說 | Starter **$29** → Growth $99 → Pro $399 | ⚠️ **沉默**：既未允許也未禁止「快取後商用顯示」 |
| **[tcgfast](https://tcgfast.com/)** | ✅ "Pokemon Japan" 20,000+ 卡（業者宣稱） | ✅ PSA 1–10、BGS 7–10、CGC 1–10（**需 Trader 以上**） | TCGplayer + eBay sold | Free 200/日（**非商用**）→ **Trader $14.99** → Business $89.99 | ⚠️ 宣稱含 commercial use rights，**條款頁 `/terms` 回 404** |
| **[TCGAPIs](https://tcgapis.com/pricing)** | ⚠️ 只有**進了 TCGplayer 目錄**的日版卡 | 主打 SKU 層級 | TCGplayer | **GBP 99 / 199 / 499 每月** | ❌ 查不到 |
| **[オークファン aucfan](https://topics.aucfan.com/release/aucfan-api/)** | ✅（**唯一日本國內成交價**） | ❌ 查不到結構化 grade 欄位 | ヤフオク等日本市場 | ❌ 查不到公開定價，需洽談 | ❌ 查不到 |
| **[TCGdex](https://tcgdex.dev/)** | ✅ 184 個日版 set、12,781 張 | ❌ **不分**（RAW 為主） | Cardmarket（每日）＋ TCGplayer（**日版全 null**） | **免費、免 key** | ⚠️ 資料庫 MIT，但**價格轉手的授權查不到**（無 `/terms`，實測 404） |
| **[TCGCSV](https://tcgcsv.com/)** | ✅ 456 個日版 group | ❌ **不分** | TCGplayer（每日 20:00 UTC） | 免費 | ❌ **查不到任何條款** |
| **[Card Ladder](https://www.cardladder.com/)** | ✅ 有（完整度查不到） | ★ **一個等級 = 一個獨立卡片實體** | 拍賣成交 | Pro $20/月 | 🚨 *"personal, non-commercial use only"*，且禁止 *"Populate a database"* |
| **[Collectr](https://www.getcollectr.com/)** | ✅ set 結構最清楚（含語言切換） | ✅ raw + every grade + pop + Gem Rate | — | ❌ 查不到（API 申請頁 404） | 🚨 禁止 *"any commercial purposes"* 與 *"crawling, scraping or otherwise caching"* |
| **[Market Movers](https://www.marketmoversapp.com/)** | ✅ 44,473 張、425+ sets | ✅ 有 grade 維度 | 拍賣成交 | $9.99 / $24.99 / $49.99 | 🚨 商用需 prior written permission；禁止 automated access |
| **[Ludex](https://www.ludex.com/)** | ❌ 查不到語言支援說明 | ❌ 只到 graded vs raw | — | $4.99 / $9.99 / $24.99 | 🚨 *"personal, non-commercial"* |
| **[PokéWallet](https://www.pokewallet.io/)** | 宣稱 50,000+ 卡 | ❌ **無分級價** | — | Pro €20/月 | ❌ 查不到 |
| **[pokemon-api.com](https://pokemon-api.com/)** | ❌ 查不到 | ⚠️ 有 `psa10`/`psa9` 欄位（來源 eBay） | eBay | Free 100/月 → $9.90 / $24.90 / $49.50 | ❌ 查不到 |
| **jpn-cards.com** | — | — | — | — | 🚨 **網域已死**（DNS ENOTFOUND） |

⚠️ 上表凡標「宣稱」者皆為**業者行銷頁**，未經第三方驗證。這些多是小型服務商，**採用前務必先用免費層實測你自己的卡**（尤其冷門日版與促販卡）。

### 1.5 一頁比較表

以「你的實際需求」為軸：**日版 JP + 分鑑定等級 + 條款允許顯示 + 有官方 API**。

| 來源 | 日版 | 分等級 | 官方 API | 條款允許顯示 | 綜合 |
|---|:--:|:--:|:--:|:--:|---|
| TCGdex（Cardmarket） | ✅ | ❌ | ✅ 免費 | ⚠️ 查不到 | **今天就能接，RAW 量級檢查器** |
| TCGCSV（TCGplayer 日版） | ✅ | ❌ | ✅ 免費 | ❌ 無條款 | 技術最順，法務最空 |
| **JustTCG** | ✅ | ⚠️ v2 beta | ✅ $19/月 | ✅ **明文允許，含「可合併其他來源」** | **條款最寬、最便宜，但鑑定價要實測** |
| **PokemonPriceTracker** | ✅ | ✅ | ✅ $99/月 | ✅ **明文允許** | **四項全綠，鑑定價是生產級的** |
| PriceCharting / Sportscardspro | ✅ | ✅ 最細 | ✅ $49/月 | 🚨 **明文禁止**（需書面同意） | 資料最漂亮，條款擋前台 |
| Scrydex | ✅ | ✅ 含 pop | ✅ $29/月 | ⚠️ 沉默 | 灰區，要書面確認 |
| tcgfast | ✅ | ✅ | ✅ $14.99/月 | ⚠️ 條款頁 404 | 便宜，需自行確認條款 |
| Card Ladder / Collectr / Market Movers / Ludex | ✅ | ✅ | ⚠️ 多數無 | 🚨 **全部明文禁止商用** | 不可用 |
| スニダン | ✅ | ✅ | ❌ | 🚨 具名禁爬 | 資料最對味，最不能碰 |
| 遊々亭 / カードラッシュ | ✅ | ❌ | ❌ | 🚨 禁轉載／禁商用 | 日本行情基準，但只能人工看 |
| 呼卡 Huca | ✅ | ✅ | ❌ | ❌ 查不到 | 台灣唯一對味，但是消費端工具 |
| eBay 官方 | ✅ | ❌ | 🚨 成交價 API 不開放新用戶 | — | 路是關的 |
| PSA APR | ✅ | ✅ | ❌ | 🚨 全站 403 | 一手資料，拿不到 |
| PSA Public API | ✅ | ✅ | ✅ | ⚠️ 查不到 | **不含價格**，但能驗 cert |
| pokemontcg.io | ❌ **零日版** | ❌ | ⚠️ 當日 500，已併入 Scrydex | ⚠️ 無 LICENSE | **不要用** |
| オークファン aucfan | ✅ 日本國內 | ❌ | ⚠️ 法人 API，需洽談 | ⚠️ 查不到 | **唯一日本國內成交價的合法路徑** |
| 蝦皮 / 露天 | — | ❌ | ⚠️ 限賣家 | — | 拿不到成交價 |

---

## 二、對應（matching）的難題

**結論先講：對應沒有你想像的難，但難的地方跟你想的不一樣。**

真正的難題不是「找不到那張卡」，而是 **「找到了，但找到的是同一張卡的錯誤版本」**。

### 2.1 好消息：`setCode` + `cardNo` 是 TCGplayer 日版目錄的天然主鍵

見[發現一](#一你的-setcode--cardno-已經是-tcgplayer-日版目錄的天然主鍵--對應難題基本上不存在)。8/8 命中，字串直接相等，零模糊比對。

`artId`（`SV4a-349`）則是 TCGdex 的主鍵，你已經在用了 —— 而且 TCGdex 的回應裡直接附 `cardmarket.idProduct`，等於**免費送你一條到 Cardmarket 的橋**。

### 2.2 日版套牌代號的規則

- **官方查不到機器可讀的總表**。The Pokémon Company 沒有公開發布日版套牌代號清單，也沒有官方的日英對照表。實務上最好的來源是 [Bulbapedia: List of Japanese Pokémon TCG expansions](https://bulbapedia.bulbagarden.net/wiki/List_of_Japanese_Pok%C3%A9mon_Trading_Card_Game_expansions)。
- **TCGdex 的日版 set ID = 官方日版代號原文**（`SV4a`、`SV8a`、`SV-P`）；**英版則是自有補零格式**（`sv01`、`sv03.5`、`sv04.5`）。**兩套規則不同，不能互推。**

### 2.3 🚨 日英套牌對應在數學上不存在

這一點決定了架構：

| 日版 | 日文名 | 英版對應 |
|---|---|---|
| SV2（2D/2P） | スノーハザード／クレイバースト | **⅔** of Paldea Evolved |
| SV3 | 黒炎の支配者 | Obsidian Flames |
| SV3a | レイジングサーフ | **散入** Paldean Fates |
| SV4（4K/4M） | 古代の咆哮／未来の一閃 | **⅔** of Paradox Rift |
| SV4a | シャイニートレジャーex | **部分** Paldean Fates |
| SV6 | 変幻の仮面 | **⅔** of Twilight Masquerade |
| SV8a | テラスタルフェスex | **部分** Prismatic Evolutions |

英版 *Paldean Fates* 是把 SV4a **加上** SV3a／SV4K／SV4M 的剩料混編而成；日版 SV2／SV4／SV6 各是兩個半套，英版才合併成一套。

**所以「日版 setCode → 英版 setCode」這個對應根本不存在，只有卡級（card-level）對應才有意義。**

我實測驗證了這個陷阱：日版 `SV3-125`（リザードンex SAR）vs 英版 `sv03-125`（Charizard ex, Double Rare, Cardmarket €3–4）—— **同一個數字，完全不同的卡，價差兩個數量級**。

> **推論**：不要在系統裡建「日英套牌對照表」。要用英文來源就直接用它的日版目錄（TCGplayer categoryId 85 / PriceCharting 的 `pokemon-japanese-*` / Scrydex 的 `/ja/`），**不要繞道英版**。

### 2.4 🚨 真正的難題：variant（版本）

這是我認為**比接任何 API 都優先**的問題。

```
GET https://api.tcgdex.net/v2/ja/cards/SV2a-025   # ピカチュウ（ポケモンカード151）
  type=normal                 idProduct=719467  trend=  0.02 EUR  ≈ NT$   0.7
  type=reverse foil=pokeball  idProduct=837271  trend=  0.28 EUR  ≈ NT$  10
  type=reverse foil=masterball idProduct=837272  trend=369.10 EUR ≈ NT$13,730
```

**同一組 `(sv2a, 025/165)`，價差 18,000 倍。你的 schema 現在分不出來。**

- **TCGdex 處理得最好**：`variants_detailed[]` 每個 variant 有獨立 `variantId` 與獨立 `cardmarket.idProduct`
- **TCGplayer 側**：把 variant 拆成不同 `productId`（不同 name 字串），以及 prices 的 `subTypeName`
- **⚠️ TCGCSV 拿不到 SKU 層級**（首頁自己說的），所以**拿不到分 condition 的價**

〔推論〕沒有 `variant` 欄位，錨點在 151／SV8a 這類含特殊 mirror 的套牌上會系統性錯到離譜。而且會比現在**更糟** —— 因為錯的數字會掛上「外部來源」的權威。

### 2.5 rarity 不能當 join key

- TCGdex 日版 SV4a 抽樣 16 張，`rarity` **全部是 null**；SV8a、SV2a 的卡則有值。**逐 set 不一致。**
- 各家英譯不同：TCGplayer 用 `"Special Art Rare"`、TCGdex 英版用 `"Illustration rare"` / `"Shiny rare"`
- → **rarity 只能當顯示欄位，不能當比對依據。**

### 2.6 鑑定卡的識別

| 項目 | 狀況 |
|---|---|
| **PSA cert number** | ✅ 有官方 API 可驗，回傳含 `spec_id`、`grade`、`population` |
| **PSA SpecID** | 🚨 **只能從 cert 反查，無法從 setCode/cardNo 正查**。PSA 沒有公開的 SpecID 目錄 |
| **PSA APR URL** | 🚨 末端是不透明數字 ID，**無法從 setCode 推出**，必須先爬一份 slug 對照表 —— 而 PSA 擋爬蟲 |
| **BGS / Beckett** | 🚨 有[公開查詢頁](https://www.beckett.com/grading/card-lookup)（可查總分與 subgrades），但**查不到任何官方 API**。**BGS 目前只能人工** |

### 2.7 查不到的卡（冷門、促販、特典）

| 類型 | 狀況 |
|---|---|
| **プロモ（SV-P）** | ✅ 三邊都有：TCGdex `ja/sets/SV-P`（288 張）、TCGCSV `groupId 23779`、PSA APR 有 `pokemon-japanese-sv-p-promo`。**促販卡不是問題** |
| **特典 / 大會賞品** | ❌ **查不到系統性的目錄來源**。TCGCSV 日版有 `M-P Promotional Cards`、`Japanese CD Promo` 等零星分類，但沒有完整目錄 |
| **極冷門單卡** | ⚠️ 目錄裡有，但**沒有成交紀錄** → 價格欄位為 null。TCGdex 明說：*"If the card is not listed on a marketplace, the provider will be omitted."* |

**這是 §3.3 要處理的核心情境。**

### 2.8 跨來源統一識別碼：不存在

MTG 有 [Scryfall](https://scryfall.com/docs/api/cards/id)（穩定 UUID）＋ [MTGJSON identifiers](https://mtgjson.com/data-models/identifiers/)（一個物件同時給 scryfallId / tcgplayerProductId / cardmarketId）。

**寶可夢沒有等價物。** 現況是各家自有 ID。目前查到**唯二可用的公開對照鉤子**是：

1. TCGdex 回應內含 **`cardmarket.idProduct`**
2. PriceCharting API 回傳 **`epid`（eBay Product ID）**

〔推論〕**你自己的 `CardItem.id` 就得扮演 Scryfall 的角色** —— 建一張本地的 `card_external_ids` 對照表，把各來源的 ID 掛上去，只做一次，之後都用它。

---

## 三、實務建議

### 3.1 更新頻率該多久一次

**先看卡價實際的波動節奏。** [スニダン 2024/10–2025/10 交易數據分析](https://snkrdunk.com/articles/30531/)（二手可信，平台自有交易資料）歸納出四個模式：

| 模式 | 實例 | 幅度 |
|---|---|---|
| 發售初期過熱後回跌 | 南條子 マリィ UR：15,232 → 2,750 円 | **−82%** |
| 新卡帶動舊卡 | ポポッコ CHR：6,400 → 10,000 円 | +56% |
| 聯名／限定藝術長期升值 | ゴッホ ピカチュウ：18,027 → 111,369 円 | **+518%** |
| 再販／賽制變更 | 「再販発表直後市場擔憂供應增加，賣家搶先拋售」 | 急跌 |

節奏：**發售當日～1 個月是最高價位期，1～2 個月後才穩定。**

**再看資料源本身的更新節奏（一手實測）：**

| 來源 | 更新頻率 |
|---|---|
| Cardmarket（經 TCGdex） | 每日一次（我抓到的 timestamp 是 `2026-08-24T15:18:56Z`，全部卡片同一秒 → 批次作業） |
| TCGCSV | 每日 20:00 UTC |
| TCGplayer（經 TCGdex） | 每小時（但日版全 null） |
| PokemonPriceTracker / tcgfast / PriceCharting | 每日 |
| eBay API 條款 | listing **上限 6 小時**、其他 24 小時 |

**建議：每日一次，凌晨批次跑。理由有三：**

1. **上游本來就只有每日**。跑得比上游快，只是浪費 credits 拿到同一份資料。
2. **經濟護欄不需要即時性**。`redeemAllowed` 擋的是「參考價總值超過票收」這種量級錯誤，不是 5% 的日內波動。
3. **開池當下鎖定價格更重要**（見 §3.5）。

**兩個例外，要加開一次：**
- **新套牌發售後 30 天內**：那段是 −82% 的區間，可以改成一日兩次
- **開池前的即時校驗**：賣家送出開池請求時，對這一池的卡**同步打一次即時查詢**，避免用到 20 小時前的快取

### 3.2 用哪個統計量

**建議：以「七日成交均價」為主，同時保存區間，並且永遠記錄 `sampleSize`。**

| 統計量 | 評價 |
|---|---|
| **單日均價 / 最近一筆** | ❌ **絕對不要**。我實測 SV8a-217：`avg1=660` vs `avg7=391` —— **一天內 69% 的擺盪**。用它當回收價的基礎，等於送給賣家一個時間套利的窗口 |
| **最低價（`low`）** | ❌ 不要。Cardmarket 的 `low` 含毀損品，實測常只有 `trend` 的 30–50%（SV4a-347：`low=300` vs `trend=646`） |
| **`trend`（Cardmarket 自有演算法）** | ⚠️ 不透明。你無法向玩家解釋這個數字怎麼來的 |
| **七日均價（`avg7`）** | ✅ **推薦**。壓掉單日雜訊，又不會像 30 日那樣在暴跌期嚴重滯後 |
| **三十日均價（`avg30`）** | ⚠️ 當**上限**用。SV3-125 實測：`avg30=32.49` → `avg7=21.33` → `trend=16.16`，30 日均在下跌趨勢中會高估 |
| **中位數** | ✅ 理論上更抗離群值，但**多數 API 不提供**，只能自己從逐筆成交算 |

**為什麼是均價不是中位數**：〔推論〕不是因為均價比較好，是因為**能拿到的就是均價**。如果你買的方案有逐筆成交（PokemonPriceTracker 的 `ebay.priceHistory`、JustTCG 的 historical price points），**改用中位數更好**，因為卡片市場的離群值（誤標、含簽名、錯版）比一般商品多。

**「區間」要保留而不是丟掉**：`low` / `avg7` / `avg30` 三個數字一起存。介面上顯示 `avg7`，但當 `avg30 / avg7 > 1.5` 或 `< 0.67`（也就是月內振幅超過 50%）時，**要在介面上標「劇烈波動中」**，並且護欄計算改用較保守的那一端。

### 3.3 🚨 抓不到價格的卡怎麼辦

**這是整份研究裡最重要的一節。** 「抓不到就退回賣家自填」等於洞還在。

**核心原則：抓不到價格 ≠ 允許賣家自由填。抓不到價格 = 這張卡不能作為高價獎品進池。**

#### 分四級處理

| 級別 | 條件 | 處置 |
|---|---|---|
| **A. 已錨定** | 外部來源有價，且 `sampleSize` 足夠 | `refPrice` = 外部值。賣家**不能改**，只能看 |
| **B. 弱錨定** | 外部有價但樣本少（成交筆數 < N），或月內振幅 > 50% | 外部值為準，但**加上不確定性標記**。護欄計算取區間的**保守端**（回收率算低值、還元率算高值） |
| **C. 有可比卡** | 這張卡抓不到，但**同套牌同稀有度**的其他卡抓得到 | 用同組的中位數當**上限**。賣家可以填低於上限的數字，**不能填高於上限** |
| **D. 完全無資料** | 特典、大會賞品、極冷門 | **上限鎖死**（見下） |

#### D 級的具體做法（三選一，我建議第三種）

1. **不准進池** —— 最乾淨，但會擋掉真正稀有的好卡，對賣家不公平
2. **限額進池** —— 允許，但 `refPrice` 硬性上限設為一個小數字（例如 NT$500），賣家想標高就是不行
3. **★ 進池但不計價值，且需人工核定才能解鎖** —— 這張卡可以放進池子當獎品，但：
   - `refPrice = 0`，**不計入還元率的分子**（跟現在 BUST 的處理一樣）
   - **不能回收**（`recyclePoints` 回傳 0）—— 這一條堵死印點數的路
   - 介面上明說「這張卡沒有市場參考價，只能出貨不能回收」
   - 賣家可以申請人工核價，附上成交截圖／PSA APR 連結，平台審核後解鎖

〔推論〕第三種最好，因為它**把舉證責任放回賣家身上，而且不獎勵謊報**。填高沒好處（不計入還元率），要拿到價值只能出貨給玩家。

#### 還有一個必須堵的洞：**賣家會挑抓不到的卡**

如果 D 級處理太寬鬆，賣家會系統性地選用查不到價的卡。**建議加一條池層級的護欄**：一池裡 C+D 級卡的數量佔比若超過某個門檻（例如 30%），整池不准開。這條跟 `redeemAllowed` 是同一種東西 —— 堵的是「把價值藏在系統看不見的地方」。

### 3.4 鑑定等級的倍數問題

**如果你只接得到 RAW 價（第 1、2 層），PSA 10 的價格從哪來？**

三個選項：

1. **固定倍數表** —— 最簡單，最不準。PSA 10 的溢價倍數在不同卡之間差異巨大（我實測 mock 資料裡合理的倍數從 1.4× 到 4.3×，而真實市場上熱門卡的 PSA 10 溢價可以到 10× 以上）。〔推論〕**不建議當成唯一依據**，但可以當「上限檢查」：如果賣家填的 PSA 10 價格超過 RAW 錨點的 N 倍，就要人工審核
2. **買分級資料**（第 3 層）—— 正解，但要花錢
3. **RAW 錨點 + population** —— PSA Public API 有 population。〔推論〕pop 低的卡溢價高，可以建模型，但**這是研究題不是工程題**，不要在第一版做

**我的建議：第一版用「RAW 錨點 × 可設定倍數上限」當護欄（不當報價），同時把第 3 層的採購排進計畫。** 也就是說：

- 賣家填的 PSA 10 價格 ≤ RAW 錨點 × 上限倍數 → 放行
- 超過 → 擋下來，要求人工核價

這比現況嚴格得多（現況是完全沒有上限），但不需要買分級資料就能做。

### 3.5 開池當下要鎖定價格

〔推論〕這一點跟資料來源無關，但同樣重要：

**`refPrice` 一旦用來計算還元率並公開展示，就必須凍結在開池那一刻。** 否則會出現：開池時還元率 75%（合法），三天後卡價暴跌，實際還元率變成 40%（掠奪級），而玩家看到的是三天前的數字。

**建議**：`PoolPrize` 存一份 `refPriceSnapshot` + `snapshotAt` + `snapshotSource`。回收（`recyclePoints`）用哪一個要明確決定：
- 用 snapshot → 對玩家公平（他買票時看到的就是這個），但卡價暴跌時平台要吃虧損
- 用即時價 → 平台不吃虧，但玩家會覺得被騙

〔推論〕**建議用 snapshot，但加一條「回收價不高於當前市價」的上限。** 這樣暴跌時平台不會被套利，暴漲時玩家享受到的是他原本就看到的價值。**這是一個必須由你決定的商業取捨，不是技術問題。**

### 3.6 介面上怎麼誠實呈現

**必須顯示的四件事：**

1. **數字本身** —— 例：`參考市值 NT$9,740`
2. **來源** —— 例：`來源：Cardmarket（歐洲）`。有超連結最好（PriceCharting 的條款甚至**要求**這樣做，TCGplayer 條款也強制要求附連結與免責聲明）
3. **時間** —— 例：`更新於 8 小時前`。不要寫「即時」，那是謊話
4. **不確定性** —— 例：`近 30 日區間 NT$6,200–14,800`

**還要說清楚的三件事（這幾點最容易被忽略）：**

- **匯率**：如果錨點是歐元或美元，要標示換算匯率與時間。〔推論〕不標的話，對台灣買家反而是誤導 —— 因為他無法判斷這個數字是不是台灣行情
- **市場**：Cardmarket 是**歐洲**市場的日版卡價，eBay 是**全球**，遊々亭是**日本國內**。這三個對同一張卡可以差很多。**要標明是哪一個市場**
- **鑑定等級**：如果錨點是 RAW 價而卡是 PSA 10，**絕對不能直接顯示 RAW 價當成這張卡的價值**。要嘛顯示 `RAW 參考價 NT$9,740（本卡為 PSA 10，實際價值更高）`，要嘛不顯示

**建議的文案骨架：**

```
市場參考價  NT$9,740
└ 來源：Cardmarket 七日成交均價（歐洲市場，未鑑定）
└ 更新：2026-08-25 03:00（8 小時前）
└ 近 30 日區間：NT$6,200 – NT$14,800
└ ⚠️ 本卡為 PSA 10，鑑定後價值通常高於此數字
```

### 3.7 有沒有平台把「外部價」與「賣家自填」並列？

**有，而且有前車之鑑值得抄，也有教訓值得避開。**

**eBay 做過，而且被賣家罵爆：**

eBay 在交易卡 listing 上測試顯示 **median sold price**，[Value Added Resource 的報導](https://www.valueaddedresource.net/ebay-tests-median-sold-price-trading-cards/)（二手可信）指出：賣家強烈反彈，因為它壓低了要價、鼓勵了低球出價；2023 年那次測試也「almost universally panned」。

**但最關鍵的批評是這一句**：交易卡的價格指南**無法按 grade 篩選**，導致比較根本不準確 —— 而 grading 對卡片價格影響巨大。

> **對你的教訓（〔推論〕）**：
> 1. **不分鑑定等級的外部錨點，會讓誠實的賣家看起來像在騙人。** 一張 PSA 10 標 NT$42,000，旁邊放一個 RAW 的 NT$9,740，看起來像溢價 4 倍 —— 但那是**對的**。這會摧毀賣家對平台的信任。
> 2. **所以「分得出鑑定等級」不是加分項，是必要條件。** 這也是為什麼第 3 層（付費分級 API）遲早要買。

**做得比較好的：**
- [Graded Market](https://www.gradedmarket.eu/)：listing 上顯示一個由實際成交建構的 market price reference，**可以直接跟要價比較**（二手可信）
- [eBay Price Guide](https://pages.ebay.com/price-guide/)：兩年的第一方成交資料、含 Best Offer 成交價、可切換 sold / active、可看 PSA pop report
- **TCGplayer 的做法值得抄**：成交筆數不足時**不顯示** Market Price，而不是顯示一個不可靠的數字

**日本 オリパ 業界的現況：沒有人這樣做，而這正是問題所在。**

日本業界對「還元率」的普遍批評是：**販売店用自家價格而不是市場價格算還元率**。有分析直接點名這個手法（二手可信，[オリパのミカタ](https://oripa.growdeco.co.jp/rr/)）：某卡市場買取價 7,000 円，店家用「當店販売価格 10,000 円」算還元率，數字就好看了。另有分析指出，**販売価格通常是買取価格的 1.3–2 倍**（二手可信，[攻略大百科](https://premium.gamepedia.jp/toreca/archives/11291)）。

而且日本的執法已經動了：2024 年有オリパ業者因**當選機率虛偽表示**被處**課徵金 780 萬円、營業停止 6 個月**（二手可信，[トレカ商事 note](https://note.com/toreca_corp/n/n9c068db5e67a)）。

> **這對 VaultDraw 的意義（〔推論〕）**：
> 1. **賣家自填 `refPrice` 不是你的獨創缺陷，是整個業界的通病。** 但這代表你**沒有現成答案可抄**，也代表**先做出來的人有真實的差異化**。
> 2. **「70% 回收率」這個設計本身，暗示 `refPrice` 應該是「販売価格」等級的數字** —— 因為 70% 大致就是日本市場買取／販売的比例。〔推論〕如果你改用「買取価格」等級的錨點（例如遊々亭買取價），**回收率 70% 就會變成過於慷慨**，經濟模型要一起重算。**這是接錨點時最容易踩的坑。**

---

## 四、法遵

> **再說一次：這不是法律意見。** 以下是查到的條文、判決與條款，附連結讓你自己去看。適用要看具體事實，動手前請諮詢台灣執業律師。

### 4.1 一句話總結

**每一個因為抓取資料而輸掉的案子，都不是輸在著作權，而是輸在「違約」「侵害動產」或「電腦犯罪」。** 「這是公開資料」「事實不受著作權保護」這兩句話，在實務上救不了人。

### 4.2 台灣：Lawsnote 案讓「先爬再說」變成刑事風險

見[發現六](#六台灣有一個案子讓先爬再說這條路的風險比你想的高一個數量級)。重點重述：

- 一審：創辦人 **4 年徒刑**、民事賠償 **1 億 545 萬元**（[益思分析](https://www.is-law.com/lawsnote-fined-is-web-crawling-or-scraping-legal/)、[聯合新聞網](https://udn.com/news/story/7321/8832333)、[法律百科](https://www.legis-pedia.com/topic/podcast/195)）
- **「違反網站使用規範」＝ 刑法 359 條的「無故」**
- **編排格式可構成編輯著作**，即使底層是公開事實
- **仍在上訴中，尚未定讞**

**相關條文（一手）：**

- [著作權法第 7 條](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=J0070017&flno=7)：「就資料之選擇及編排具有創作性者為編輯著作，以獨立之著作保護之。」
  → 〔推論〕**單筆價格數字大概率不受保護，但「一整張整理好的價目表」很可能受保護。**
- [著作權法第 9 條](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=J0070017&flno=9)：「單純為傳達事實之新聞報導所作成之語文著作」不得為著作權標的
  → ⚠️ **注意這條講的是「新聞報導」，不是通則性的「事實不受保護」條款。台灣沒有美國 Feist 那樣的明文事實排除。**
- 台灣**沒有**歐盟式的 sui generis 資料庫權（查不到任何相反規定）

**還有一條容易被忽略的：公平交易法第 25 條**

> 「除本法另有規定者外，事業亦不得為其他足以影響交易秩序之欺罔或顯失公平之行為。」

公平會的[處理原則](https://www.ftc.gov.tw/internet/main/doc/docDetail.aspx?uid=167&docid=266)明列「榨取他人努力成果」為顯失公平態樣，具體行為包括**「抄襲他人投入相當努力建置之網站資料，混充為自身網站或資料庫之內容，藉以增加自身交易機會」**（[公平會說明](https://www.ftc.gov.tw/internet/main/doc/docDetail.aspx?uid=1214&docid=13264)）。

〔推論〕**這條幾乎是為「抓別人的價格庫來做自己的行情頁」量身寫的。即使著作權過關，公平會這關也未必過。**

### 4.3 美國：CFAA 風險降了，但那從來不是主要風險

- **[Feist v. Rural Telephone, 499 U.S. 340 (1991)](https://supreme.justia.com/cases/federal/us/499/340/)**：最高法院**否定「勤勞蒐集」理論**。純事實不受著作權保護；資料彙編只有在**選擇、協調、編排**具原創性時才受保護，且保護不及於事實本身。
  → **「PSA 10 皮卡丘 = ¥180,000」這個數字，在美國法下是不受保護的事實。**
- **[Van Buren v. United States, 594 U.S. 1 (2021)](https://www.supremecourt.gov/opinions/20pdf/19-783_k53l.pdf)**：CFAA 的 "exceeds authorized access" 採**窄解**（gates-up-or-down），**單純違反使用政策不構成 CFAA**。
- **hiQ v. LinkedIn —— ★ 最重要的一課，而且大多數人只記得前半**：
  - 第九巡迴 2019、Van Buren 發回後 [2022/4/18 再次確認](https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf)：抓取**公開可得**資料**不構成 CFAA 的 "without authorization"**
  - **但 hiQ 最後輸了。** 地院就 LinkedIn 的**違約**請求作出對 LinkedIn 有利的簡易判決
  - 2022/12 和解，法院核准 Consent Judgment 與永久禁制令：**50 萬美元判決**、認定 hiQ 就 **trespass to chattels 與 misappropriation** 負責、永久禁止抓取、**須銷毀所有原始碼、資料與衍生演算法**。hiQ 實質停業
  - （[Proskauer](https://www.proskauer.com/blog/hiq-and-linkedin-reach-proposed-settlement-in-landmark-scraping-case)、[Morgan Lewis](https://www.morganlewis.com/blogs/sourcingatmorganlewis/2022/12/linkedin-v-hiq-landmark-data-scraping-suit-provides-guidance-to-data-scrapers-and-web-operators)）

> **「CFAA 不成立」不等於「可以抓」。違約與 trespass to chattels 才是真正殺死 hiQ 的東西。**

- **[eBay v. Bidder's Edge (N.D. Cal. 2000)](https://en.wikipedia.org/wiki/EBay_v._Bidder%27s_Edge)**：拍賣聚合站每天約 10 萬次請求，eBay 以 trespass to chattels 取得初步禁制令。⚠️ 後續 Intel v. Hamidi (2003) 否定了該案的部分推論，該理論一度衰退 —— 但 hiQ 和解時仍被認定成立
- **[Craigslist v. 3Taps (N.D. Cal. 2013)](https://en.wikipedia.org/wiki/Craigslist_Inc._v._3Taps_Inc.)**：**寄發 cease-and-desist 信 ＋ 封鎖 IP 即構成充分的「線上禁止進入」通知**，之後繼續存取即違反 CFAA
  → 〔推論〕**收到 C&D 或被封 IP 後還繼續抓，法律地位會急劇惡化。**

### 4.4 歐盟：資料庫不受保護，反而讓網站更能用契約禁止你

- **Database Directive 96/9/EC 第 7(1) 條**：對內容之**取得、驗證或呈現**有實質投資的資料庫，受 sui generis 權保護
- **[BHB v. William Hill (C-203/02, 2004)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A62002CJ0203)**：CJEU 區分**「取得既有資料」才算數，「創造新資料」不算**
  - 〔推論，非直接判例〕：平台**自己標的售價**較像「創造」→ 保護較弱；平台**蒐集的成交紀錄／彙整的行情**較像「取得＋驗證」→ **保護較強**。**查不到**直接針對價格資料庫的 CJEU 判決
- **[Ryanair v PR Aviation (C-30/14, 2015)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A62014CJ0030)** —— **比價網站抓航班價格的案子，跟你的情境最像**：
  - CJEU 裁定：Database Directive **不適用於**既不受著作權也不受 sui generis 權保護的資料庫，因此指令保障的「合法使用者最低權利」**不阻止**資料庫所有人**以契約限制第三方使用**
  - → **這是對 scraper 最壞的結果：資料庫「不受保護」反而讓網站可以用 ToS 全面禁止，且沒有法定例外可以主張。**

### 4.5 日本：條文寬鬆，但刑事門檻低得嚇人

- **[著作権法第 30 条の 4](https://www.bunka.go.jp/seisaku/bunkashingikai/chosakuken/hoseido/r05_07/pdf/94011401_07.pdf)**（2019/1/1 施行）：**非享受目的**利用（含「情報解析」）原則上不需權利人同意，**且不限商業用途**。但但書：**「著作権者の利益を不当に害することとなる場合」不適用**
- **第 47 条の 5**：所在檢索服務與情報解析服務，**在結果提供時附隨的「軽微利用」**受權利限制
- **關鍵區別**：30 条の 4 適用於**純解析、不呈現原著作**；47 条の 5 適用於**要呈現片段給使用者看**，**後者要件嚴格得多**
  → 〔推論〕**抓價格做內部統計模型** → 較可能落入 30 条の 4；**抓價格直接顯示給使用者當「參考市值」** → 是享受目的，要看 47 条の 5 的「軽微」門檻，而且很難主張自己是「所在檢索服務」。但書「不當害及著作權人利益」對「取代原資料庫」的行為特別致命
  （參考：[文化審議会「AIと著作権に関する考え方」](https://www.bunka.go.jp/seisaku/bunkashingikai/chosakuken/bunkakai/69/pdf/94022801_01.pdf)、[STORIA法律事務所解說](https://storialaw.jp/blog/10806)）
- **[岡崎市立中央図書館事件（Librahack, 2010）](https://ja.wikipedia.org/wiki/%E5%B2%A1%E5%B4%8E%E5%B8%82%E7%AB%8B%E4%B8%AD%E5%A4%AE%E5%9B%B3%E6%9B%B8%E9%A4%A8%E4%BA%8B%E4%BB%B6)** —— 這不是著作權案，是**刑事業務妨害**案：
  - 開發者以**每秒約 1 次、每天 1 小時**抓圖書館新書頁面
  - 2010/5/25 以偽計業務妨害嫌疑**逮捕、羈押 21 天**，6/14 以**起訴猶予**釋放
  - 爭議點：使用者無攻擊意圖，且**根本原因是圖書館系統本身的瑕疵**
  - → **「不起訴」不等於「沒事」—— 他被關了 21 天。日本對 scraping 的刑事門檻很低，而且跟你的技術正當性關係不大。**

### 4.6 「只顯示來源與連結、不轉存」風險確實不同

- **[CJEU Svensson (C-466/12, 2014)](https://ipkitten.blogspot.com/2014/02/breaking-news-cjeu-in-svensson-says.html)**：對**已在網路上自由可得**的著作設超連結，**不構成向公眾傳播**（沒有觸及「新公眾」），**不需授權**

**風險梯度（〔推論〕，非直接判例）：**

| 做法 | 風險 |
|---|---|
| 純連結 + 來源名稱，不顯示數字 | **最低**（Svensson） |
| 顯示單一數字 + 「資料來源：X（連結）」，**不入庫** | 中等 |
| 系統性轉存成自己的 DB，離線提供 | **最高** —— Lawsnote / hiQ / Ryanair 全部踩在這裡 |

⚠️ **但注意 Ryanair 的教訓**：即使資料本身不受著作權保護，網站仍可用 ToS 契約禁止你抓。**連結本身通常沒問題，但「先抓後顯示連結」的抓取步驟仍是違約。**

### 4.7 有沒有人因為抓卡價被告？

**查不到。** 我搜了 TCGplayer / PriceCharting 的 scraping 訴訟，**沒有找到任何確認的案例**。查到的只有 TCGplayer 對 Card Trader 就其 multi-homing 工具發 C&D（不同性質）。

⚠️ [Cardmarket 2024/5 對 Pokemon TCG 市場操縱者採取法律行動](https://www.pokebeach.com/2024/05/cardmarket-takes-legal-action-against-pokemon-tcg-market-manipulators-seeks-damages)（二手可信）—— **那是告操縱價格，不是告抓取，跟你的情境不同。**

〔推論〕**「沒人被告」不是安全的理由，只是「還沒有人做到夠大讓人想告」。** VaultDraw 如果做起來，就會是那個「夠大」的。

### 4.8 風險排序（我的判斷，非法律意見）

| 做法 | 風險 | 備註 |
|---|---|---|
| **JustTCG / PokemonPriceTracker 付費 API** | **最低** | 條款白紙黑字寫著你可以做你要做的事 |
| 只顯示「賣家自填 + 外部來源連結」不入庫 | 低 | Svensson。但**解決不了 refPrice 的洞** |
| TCGdex（Cardmarket 轉手） | 中低 | 資料庫 MIT，但價格轉手的授權是空白的 |
| PriceCharting / Scrydex（先取得書面同意） | 中低 | 拿到信之前不要寫程式 |
| TCGCSV | 中 | 免費好用，但**無條款 + 上游 TCGplayer 明文禁止** |
| 跟 **呼卡 Huca / カードラッシュ / オークファン** 談授權 | 中 | 資料最對味，但要談，且呼卡自己的上游合法性存疑 |
| 自建爬蟲抓任何日本／台灣卡店 | **高** | Lawsnote + hiQ + Ryanair + Librahack 四個方向同時中槍 |

---

## 五、查不到的部分

**這一節是刻意列的。使用者明確要求過寧可說查不到，不要推測填補。**

### 條款與授權（最要命的一類）

1. **TCGdex 價格資料的授權**。它的 `cards-database` repo 是 MIT，但價格來自 Cardmarket / TCGplayer；`tcgdex.dev` 沒有 `/terms` 或 `/legal`（實測 404），[markets-prices](https://tcgdex.dev/markets-prices) 與 [FAQ](https://tcgdex.dev/faq) 都沒有說明價格的再散布權利。**這是第 1 層建議的法務缺口，接之前建議去它的 Discord 或 GitHub 直接問。**
2. **TCGCSV 的任何條款**，以及它與 TCGplayer 的授權關係
3. **Cardmarket 的 Terms of Service 原文**（Cloudflare 擋，回 CAPTCHA）
4. **TCGplayer API 條款的一手原文**（該頁對我回 403，本文引用由子代理取得，**請自己覆核**）
5. **PriceCharting Terms 的一手原文**（同上，403）
6. **psacard.com 專屬的網站使用條款**（`/termsandconditions` 是評級服務合約）。PSA Public API 對「儲存與展示 cert 資料」的規範也查不到
7. **tcgfast 的條款**（`/terms` 回 404）
8. **Scrydex 對「快取後在商用網站顯示」的明文立場**（條款沉默）
9. **pokemontcg.io 的資料授權**（repo 無 LICENSE 檔；`dev.pokemontcg.io/terms` 只寫 *"Price data is for informational purposes only."*）
10. **蝦皮台灣繁中版 ToS 的禁爬條文原文**（help.shopee.tw 回空殼頁）
11. **駿河屋 / トレコロ / メルカリ 的利用規約全文**
12. **カードラッシュ通販站本體**的規約（本文引用的是集團媒體站 cardrush.media，**不等同通販站**）
13. **呼卡 Huca 的利用規約**（`/terms` 404）與它是否握有 Snkrdunk 的授權

### 費用與門檻

14. **PSA Public API 的 rate limit 與費用**（官方文件未載明）
15. **オークファン法人 API 的定價**（需洽談）
16. **Collectr API 的費用**（申請頁 404）
17. **TCGplayer API 的費用**與「是否仍受理新申請」的**官方**公告（只有競品部落格的說法，不採信）
18. **Shopee Affiliate API 是否回傳成交價**、台灣站實際審核門檻
19. **露天是否有全站商品／成交查詢 API**
20. **eBay 那句 "restricted and not open to new users at this time" 的官方原文頁面**（developer.ebay.com 全站 403）

### 資料涵蓋率（採用前必須自己實測的）

21. **JustTCG 的日版卡數與 PSA 覆蓋率**（v2 beta，未公布數字）
22. **PokemonPriceTracker / tcgfast / Scrydex 對「你自己那些卡」的實際命中率** —— 尤其冷門日版、促販、特典
23. **PSA APR 對日版 sv4a 這類套牌的資料密度**
24. **Cardmarket 對日版卡的覆蓋完整度**（我只能透過 TCGdex 間接驗證 31/31，無法直接列舉）
25. **TCGplayer API catalog 是否含 Pokemon Japan 分類**（我只驗證了 TCGCSV 鏡像有）

### 識別與對應

26. **The Pokémon Company 官方發布的機器可讀日版套牌代號總表**（確認：不存在公開版本）
27. **PSA SpecID 的公開目錄或反向查詢介面**（確認：只能從 cert 反查）
28. **Beckett / BGS 的任何官方 API**（確認：查不到）
29. **日版特典／大會賞品卡的系統性目錄來源**
30. **寶可夢版的跨來源統一識別碼標準**（確認：**不存在**，Scryfall 沒有等價物）

### 法律

31. **Lawsnote 案二審結果**（仍在智慧財產及商業法院審理中，**一審不是定讞**）
32. **日本針對「商品價格」scraping 的民事判例**
33. **直接針對「價格資料庫」的 CJEU sui generis 判決**
34. **任何因為抓取卡價被告的確認案例**

### 我沒做也不該做的

35. **PSA Public API 的實測** —— 需要註冊 PSA 帳號並輸入憑證，我不會代你註冊
36. **各付費 API 的實測** —— 需要信用卡與帳號

---

## 六、具體實作建議

### 第 0 步：先做兩件不用接任何 API 的事

**0-a. 加 `variant` 欄位到 `CardItem`。**
理由見 §2.4（同一組 `(setCode, cardNo)` 可以差 18,000 倍）。值域對齊 TCGdex 的 `variants_detailed[].type` + `.foil`。**這件事比接錨點更優先** —— 沒有它，錨點會系統性錯，而且錯得比現在更有說服力。

**0-b. 建 `card_external_ids` 對照表。**
寶可夢沒有跨來源統一 ID（§2.8），所以你自己的 `CardItem.id` 得扮演那個角色。一張表掛上各來源的鍵：

```
card_external_ids
  card_id            → 你的主鍵
  tcgplayer_product  → 從 TCGCSV 的 (abbreviation, extendedData.Number) 取得
  cardmarket_product → 從 TCGdex 的 pricing.cardmarket.idProduct 取得
  tcgdex_variant     → variants_detailed[].variantId
  ebay_epid          → 若買 PriceCharting 則有
  psa_spec_id        → 只能從已知 cert 反查
```

一次建好，之後所有來源都掛在上面。**這是把「換資料源」從重寫變成換一欄的關鍵。**

### 第 1 步：先接 TCGdex 的 Cardmarket 價（一到兩天的工）

- 你已經在用 TCGdex、`artId` 已經在資料庫裡、31/31 命中、免費免 key
- 用 `avg7`，同時存 `low` / `avg30` / `updated`
- **⚠️ 先去問清楚價格資料的授權**（§5 第 1 項）—— 這是唯一的未知數

**這一步不是為了顯示價格，是為了得到一張「賣家填的 vs 外部」的對照表。** 先跑起來、先看數字、先在後台看一週，**不要一上來就給玩家看**。

〔推論〕光是把[發現五](#五把外部價貼上去會立刻暴露現有-refprice-的量級錯誤--而且兩個方向都錯)那張表跑在真實資料上，你就會知道問題有多大、以及第 3 層值不值得花錢。

### 第 2 步：把錨點接進護欄，但先只當「上限」不當「報價」

**不要一次改成「外部價取代賣家自填」。** 分兩階段：

**階段 A（保守，建議先做）** —— 賣家還是填，但加上限：
- `refPrice` > 外部錨點 × N 倍 → **擋下開池**，要求人工核價
- N 的取值：RAW 卡建議 1.5，PSA 卡建議 8（因為 PSA 溢價本來就高，見 §3.4）
- **這一步就足以堵掉「印點數」那條路**（安全稽核 C-2）—— 賣家把爆賞的 `refPrice` 填成天文數字這件事，會在開池時就被擋下

**階段 B** —— 外部錨點成為 `refPrice` 本身，賣家只能看不能改。等第 3 步的分級資料到位再做。

### 第 3 步：買一份分級資料

- **先用 [JustTCG](https://justtcg.com/) 的免費層實測你自己的 PSA 卡**（1,000 req/月，夠測）
- 覆蓋夠 → 用 JustTCG Starter $19/月（條款最寬，**唯一明文允許與其他來源合併**）
- 覆蓋不夠 → PokemonPriceTracker Business $99/月（鑑定價是生產級的，條款也明文允許）
- **不要用 PriceCharting / Scrydex，除非先拿到書面同意**

### 第 4 步：接 PSA Public API 驗 cert

跟價格是兩回事，但同樣是地基。賣家填假 `certNo` 配 `grade: 10` 這條路現在是通的。

### 第 5 步：處理抓不到的卡

實作 §3.3 的四級制，重點是 D 級的處理：**`refPrice = 0`、不計入還元率、不能回收、可申請人工核價。** 再加一條池層級護欄：C+D 級卡佔比超過門檻就不准開池。

### 第 6 步：介面

照 §3.6 的骨架。四件事一件都不能少：數字、來源（含連結）、時間、不確定性。**外加匯率、市場、鑑定等級的標示。**

### 排序理由

| 步驟 | 為什麼是這個順序 |
|---|---|
| 0. variant + ID 表 | 沒有它，後面全部會系統性錯 |
| 1. TCGdex 免費錨點 | 成本接近零，且能立刻量化問題有多大 |
| 2. 上限護欄 | **這一步就堵掉了印點數**，而且不需要花錢 |
| 3. 買分級資料 | 只有到這一步才能真正取代賣家自填 |
| 4. PSA cert 驗證 | 跟 3 平行，但獨立 |
| 5. 抓不到的處理 | 必須跟 2 或 3 同時上線，否則賣家會系統性選查不到的卡 |
| 6. 介面 | 最後做，因為前面沒穩定之前不該給玩家看 |

### 最後：你最該先決定的一件事

**不是「接哪個 API」，是「`refPrice` 到底代表什麼」。**

現在它同時扮演三個角色，而這三個角色需要的是**不同的數字**：

| 角色 | 需要的數字 |
|---|---|
| 還元率的分子（公開展示） | 玩家心中「這張卡值多少」→ **零售價** |
| 回收價的基礎（付 70%） | 平台實際能變現多少 → **買取價** |
| 市場折扣的參考 | 玩家在別處買要花多少 → **零售價** |

日本市場的**販売価格通常是買取価格的 1.3–2 倍**（§3.7）。也就是說：

- 如果錨點接的是**零售價**（Cardmarket、TCGplayer 都是），**70% 回收率大致對得上買取價，現有經濟模型可以維持**
- 如果錨點接的是**買取價**（遊々亭買取價那種），**70% 回收率就太慷慨了，整套護欄的門檻要重算**

〔推論〕**這是一個商業決策，不是技術決策，而且它會決定你接哪個來源。** 在寫任何程式之前先想清楚。

---

## 附錄：本文所有一手實測的重現方式

```bash
# 1. TCGdex 日版卡（含 Cardmarket 價）— 免 key
curl -s https://api.tcgdex.net/v2/ja/cards/SV4a-349 | jq '.variants_detailed[].pricing'

# 2. variant 陷阱（同一張卡差 18,000 倍）
curl -s https://api.tcgdex.net/v2/ja/cards/SV2a-025 | jq '.variants_detailed[] | {type,foil,cm:.pricing.cardmarket.trend}'

# 3. TCGCSV 日版目錄（注意：一定要帶 User-Agent，否則 401）
curl -s -A "Mozilla/5.0" https://tcgcsv.com/tcgplayer/categories | jq '.results[] | select(.name|test("Pok"))'
curl -s -A "Mozilla/5.0" https://tcgcsv.com/tcgplayer/85/groups   | jq '.results[] | select(.abbreviation=="SV4a")'
curl -s -A "Mozilla/5.0" https://tcgcsv.com/tcgplayer/85/23601/products | jq '.results[] | select(.extendedData[]?.value=="349/190")'
curl -s -A "Mozilla/5.0" https://tcgcsv.com/tcgplayer/85/23601/prices   | jq '.results[] | select(.productId==567748)'

# 4. 日英卡號不對應（同數字不同卡）
curl -s https://api.tcgdex.net/v2/ja/cards/SV3-125  | jq '{name,set:.set.name}'   # リザードンex SAR
curl -s https://api.tcgdex.net/v2/en/cards/sv03-125 | jq '{name,rarity}'          # Charizard ex Double rare

# 5. 各站可及性（2026-08-25 實測）
curl -s -o /dev/null -w "%{http_code}\n" https://api.pokemontcg.io/v2/sets     # 500
curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0" https://www.psacard.com/robots.txt  # 403
curl -s -o /dev/null -w "%{http_code}\n" https://www.cardmarket.com/           # 403

# 6. 日本各站 robots.txt
curl -s https://yuyu-tei.jp/robots.txt      # 無任何 Disallow，僅 Crawl-delay
curl -s https://snkrdunk.com/robots.txt     # 僅 Disallow /en/v1/*（但規約禁爬）
curl -s https://www.suruga-ya.jp/robots.txt # Allow: /，Content-Signal ai-train=no
```
