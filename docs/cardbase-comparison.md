# 競品對照：CardBase（cardbase.io）vs VaultDraw

> 調查日期：**2026-09-06**。方法：CardBase 側為**唯讀瀏覽**（WebFetch／WebSearch），
> 未註冊、未下載 App、未付款、未提交任何表單。VaultDraw 側為**逐檔讀碼**，
> 行號是 2026-09-06 當下工作樹（`main`，commit `59cb838`）。
>
> 這一輪**沒有動任何程式碼**，只有這份文件。

---

## 怎麼讀這份文件

沿用 [open-issues.md](open-issues.md) 與 [trainer-card-plan.md](trainer-card-plan.md) 的記號。
**每一條都標了它的證據等級**：

| 記號 | 意思 |
|---|---|
| **讀碼** | 直接讀 VaultDraw 的程式碼確認的（附檔案行號） |
| **一手** | 我自己打開 CardBase 的頁面看到的，附網址與日期 |
| **業者宣稱** | CardBase 自己說的（官網／App Store 描述）。**沒有第三方查證** |
| **二手可信** | 第三方報導／商店頁，來源具名 |
| **推論** | 只做了推理，沒有實跑。**看到這個記號就代表我可能錯** |
| **查不到** | 找過，沒有。單獨列在第六節 |

**這份文件不重做兩件已經做過的研究。** 外部價格資料的來源、條款與法遵，
整份在 [research-card-pricing.md](research-card-pricing.md)（1,068 行，含實測）；
拍照辨識的成本、失敗樣態與工期，整份在 [ai-opportunities.md](ai-opportunities.md) 第一節。
下面只寫「CardBase 讓那兩份研究的哪一段變得更急或更不急」。

---

## 零、先講七句結論

**一、簡報給我的三條前提裡，有一條已經過時了，而它是最重要的那條。**

> 「VaultDraw 的 `refPrice` 是賣家自己宣告的，而**它被用在經濟護欄與還元率上**。」

**護欄與還元率那一半，2026-08 就已經拆掉了。**（讀碼）
`src/shared/economics.ts:11-27` 明寫換過分子：現在算的是**保底回饋率**
＝ `Σ(宣告買回價 × 數量) ÷ 票收`，分子是**賣家有義務付出去的錢**，
不是他嘴上喊的市值。`src/shared/recycle.ts:19` 一行：
「refPrice 從此**不參與任何金額計算**」。舊制的還元率只留在舊池
（`src/types/models.ts:148` `returnRatio`，註解寫「**只有舊池有**」）。
`docs/HANDOFF.md` 4.1 標題就是「refPrice 沒有外部錨點 —— **已解**（2026-08-25）」。

**但這不代表問題消失了，只是搬了家。** 見結論二。

**二、refPrice 現在只剩三個出口，而那三個出口正好就是 CardBase 的整個產品。**（讀碼）

| 出口 | 位置 | 它在對使用者宣稱什麼 |
|---|---|---|
| **市場的預設排序，名字叫「低於市值」** | `src/pages/MarketPage.vue:104-110`（`sort = ref('deal')`、label 就是這四個字）、`server/src/routes/public.ts:375` `default('deal')` | 「這張比市值便宜」 |
| **卡冊的「收藏總值」＋成長曲線，而且可以公開分享** | `src/lib/api.ts:493`、`src/pages/MyCardsPage.vue:925,974`、`src/pages/PublicCardbookPage.vue:238-240` | 「你的收藏值這麼多」 |
| **獎項表裡爆賞保底卡那一行** | `src/components/PrizeTable.vue:30` | 「這張保底卡值多少」 |

CardBase 的首頁標語是 **"What Is Your Collection Worth?"**，
市集主打 **"Real sold prices"**（一手，[cardbase.io/en](https://cardbase.io/en)，2026-09-06）。
**VaultDraw 已經在做同樣的兩件事了 —— 用一個賣家自己打進去的數字。**

**三、`DEAL_RATIO` 的分母是賣家自填的欄位，而它決定市場的預設順序與精選區。**（讀碼）

```sql
-- server/src/routes/public.ts:266-267
const DEAL_RATIO = sql`coalesce(
  (price - nullif((card->>'refPrice')::numeric, 0)) / nullif((card->>'refPrice')::numeric, 0), 0)`
```

`refPrice` 由賣家在登記卡片時自己填（`src/pages/CardUploadPage.vue:276` 是一個
`type="number"` 的輸入框），後端只檢查上限 **10,000,000**
（`server/src/card-cert.ts:85` `REF_PRICE_MAX`）。
把 refPrice 填成掛價的十倍，`deal_ratio` 就是 `-0.9`，
既排在預設排序第一位，也穩穩落進精選區的門檻（`public.ts:608` `<= -0.08`）。
**沒有任何交叉檢查。** 這不是理論上的洞，是「照著現在的表單填就會發生」。

**四、CardBase 的「零手續費」不是一個可以搬過來的商業模式，因為那兩個字的前提是「不碰錢」。**

CardBase 條款原文（一手，[cardbase.io/en/terms](https://cardbase.io/en/terms)，2026-09-06）：

> "CARDBASE acts solely as an information exchange platform, providing space for users to post buy/sell information"

**它是佈告欄，不是託管。** 買賣雙方自己用 FPS／銀行轉帳結清，平台不經手，
所以「零手續費」是**成本結構的結果**，不是讓利。
它靠訂閱賺錢：Pro **HK$88／月**（或 HK$888／年）、Ultra **HK$218／月**（HK$2,188／年）
（一手，[cardbase.io/en/pricing](https://cardbase.io/en/pricing)；
App Store 內購頁的 HK 區數字一致，US 區為 $9.99／$29.99 月）。

VaultDraw 的市場**是託管**：貨款 100% 凍結、賣家押保證金、72 小時出貨期限、
7 天驗收期、逾期沒收（`src/shared/escrow.ts:20-38`、`server/src/orders-service.ts:86-90`）。
**這套東西有成本，而 CardBase 沒有付這個成本。**
拿它的 0% 當「別人做得到我也做得到」的證據是錯的比較。

**五、CardBase 自己非常小 —— 不要被功能清單嚇到。**

| 訊號 | 數字 | 來源 |
|---|---|---|
| Google Play **安裝數** | **50+**，1 則評論 | 鏡像站 apkcombo／apkpure（Play 本站抓取受阻），2026-09-06 |
| Android **上架日** | **2026-08-20**（不到一個月） | 同上 |
| App Store 香港區 | **4.4 星／只有 7 則評分** | apps.apple.com/hk，2026-09-06 |
| App Store 美國區 | "insufficient ratings" | 同上 |
| 詐騙回報資料庫 | **"34 community reports"** | 一手，[cardbase.io/en](https://cardbase.io/en) |
| Threads @cardbasehk | 989 追蹤者 | 一手，2026-09-06 |
| 募資／媒體報導 | **查不到任何一筆** | Crunchbase／LinkedIn／一般搜尋 |

**它是一個功能鋪得很開、但使用者基數是三位數以下的產品。**
〔推論〕它的功能清單是**產品願景**，不是「已經被驗證有人在用」的清單。照抄清單會抄到別人的假設。

⚠️ **這裡有一個很容易踩的坑**：搜尋 "Cardbase" 會撈到「聚合 30+ 市場」「採用 eBay solds ＋ TCGplayer market price」
「2020 年募資 $5M」這些說法 —— **那些全部屬於別家公司**（getcardbase.com 是美國運動卡掃描；
Crunchbase 上那家 Mountain View 的 Cardbase 已更名 Collectibles.com）。
**cardbase.io 從來沒有具名過任何價格資料來源。** 不要把別家的資訊套到它身上。

**六、它正在往台灣走，而且它的 App 更新紀錄裡出現了「抽獎」。**

- Threads @cardbasehk 貼文：赴台參加**台北三創「Flagship Card Show」T02 攤位**（一手，2026-09-06）。
  網站語言有 en／zh-HK／ja／ko／th 五種（**沒有 zh-TW**），但市集頁**已經在用 NT$ 標價**。
- iOS 版本 1.7.0 的更新紀錄裡列了「**抽獎**」；Help 頁的 Using Features 分類裡有一項叫 **"Pool Calculator"**
  （一手，[/en/help](https://cardbase.io/en/help)，內容需展開，**未取得**）。

〔推論，而且我可能錯〕**這兩條合起來，看起來像是往オリパ／抽選靠。**
如果屬實，CardBase 就不只是「一個做收藏管理的鄰居」，而是**會走進 VaultDraw 主線的對手**。
**這是這份文件裡最值得優先追問的一件事**（第六節第 4 項），
但在拿到 Pool Calculator 的實際內容之前，它只是一個推論 —— 不要拿它當行動依據。

**七、如果只能從這份對照裡拿走一件事：**

**CardBase 值得抄的不是「接一個價格 API」，是「不夠準的時候就不講」這條紀律。**
它的掃卡頁原文（一手，[/en/scan-your-card](https://cardbase.io/en/scan-your-card)）：

> "Grades with thin data are flagged 'not enough data' rather than guessed"

VaultDraw 現在做的是相反的事：`refPrice` 沒填時，**顯示層**已經很守規矩
（`src/lib/refprice.ts:19-23` 一律顯示「未標示」、`refDiscount()` 碰到 null 回 null），
**但排序層直接 `coalesce(..., 0)`**（`public.ts:267`）——
沒有標示的卡被當成折價 0%，跟「剛好標在市價」混在一起排。
同一份資料，同一個 repo，兩層守的紀律不一樣。

---

## 一、CardBase 是什麼（查證）

### 1.1 先排除同名混淆

查 "Cardbase" 會撞到至少三家不同的公司。本文件講的**只有 cardbase.io**：

| 名字 | 是誰 | 是不是本文對象 |
|---|---|---|
| **cardbase.io** | 香港，TCG 收藏管理＋估值＋市集。開發商 "cardbase limited"，頁尾 "© CardBase Limited 2026"，Android 套件名 **`io.cardbase.app`** | ✅ **是** |
| getcardbase.com / getcardbase.app | 美國，運動卡掃描。**宣稱聚合 30+ 市場、採用 eBay solds ＋ TCGplayer market price** | ❌ 不是 |
| Crunchbase 上的 "Cardbase"（Mountain View, 2020, 募資 $5M） | **已更名 Collectibles.com** | ❌ 不是 |
| `com.cardbase.app`（Google Play，開發商 TRADEWAVE） | "CardBase - Sell Gift Cards" 禮品卡 App | ❌ 不是 |
| CardBASE Technologies Ltd | 愛爾蘭，智慧卡 | ❌ 不是 |
| Hong Kong CardApp Limited（2011） | 訂餐 | ❌ 不是 |

🚨 **第二列與第三列特別容易誤導。**
網路上「Cardbase 用 eBay 已售出 ＋ TCGplayer 市價」「Cardbase 募了 500 萬美元」
這兩句話**都是別家的**。cardbase.io **從來沒有具名過任何價格來源，也查不到任何募資**。

### 1.2 功能（業者自述，一手）

來源：[cardbase.io/en](https://cardbase.io/en)、[/en/scan-your-card](https://cardbase.io/en/scan-your-card)、
[/en/pricing](https://cardbase.io/en/pricing)、[/en/about](https://cardbase.io/en/about)、
[/en/use-the-app](https://cardbase.io/en/use-the-app)、[/en/shop](https://cardbase.io/en/shop)，皆 2026-09-06。

| 功能 | 他們自己的說法 |
|---|---|
| 拍照掃卡 | "Photograph a card and CardBase works out the set, number and variant"；"AI reads the card name and number, **measures the borders, and computes a centering score**" |
| 價格查詢 | "Real sold prices converted to HKD, **free and without an account**"；"We pull recent market **SOLD** records — **raw and each grade separately** — updated daily" |
| 資料不足 | "Grades with thin data are flagged **'not enough data' rather than guessed**" |
| 市集 | "List straight from your collection. **No platform cut on person-to-person sales**" |
| 賣家驗證 | "Enter a **phone number, FPS ID, bank account or link** to check"（⚠️ 實際上是社群回報的識別碼查詢，**不是身分驗證** —— 見 §1.5） |
| 詐騙回報 | "**34 community reports** · Free · **No record does not mean safe**" |
| 鑑定證書查詢 | 支援 **PSA / CGC / BGS / TAG / ARS / ACE** 六家，輸入 8–10 位證書編號（[/zh-HK/grading](https://cardbase.io/zh-HK/grading)） |
| 收藏管理 | "Collection records · Grade tracking · **ROI analysis**" |
| 幣別 | 以 **HKD** 為樞紐的多幣別換算（市集頁上同時看得到 **NT$** 與 HK$） |
| 卡種 | Pokémon、One Piece、Disney Lorcana、Magic: The Gathering |
| 資料庫規模 | "685,800+" 張卡（業者宣稱，未查證） |
| 周邊 | /en/shop 賣卡套與展示用品，HK$500 免運；導覽另有 "Proxy shop"（代購，細節未載） |
| 送評 | Ultra 方案含「每月 150 次送評」；推薦計畫可賺 "grading credits" |

**免責聲明他們自己寫得很清楚**（一手）：AI 辨識 "may contain errors, should be confirmed manually, and are **not 100% accurate**"。

### 1.3 定價與商業模式（一手，這一節是重點）

| 方案 | 價格 | 內容（官網原文摘要） |
|---|---|---|
| Free | HK$0 | 掃描辨識＋即時估值、無限收藏追蹤、**30 天**價格歷史、基礎 AI 助手 |
| **Pro**（Recommended） | **HK$88／月**、HK$888／年 | 無限 OCR 掃描、無限價格查詢、價格提醒、**投資組合損益**、AI 卡片研究與市場洞察 |
| **Ultra** | **HK$218／月**、HK$2,188／年 | 更高 AI 呼叫上限、無限收藏、**每月 150 次送評**、優先客服 |

⚠️ **官網跟商店描述互相矛盾，而且矛盾點正好在免費層的核心限制上。**
官網定價頁寫免費層是 "unlimited collection tracking"；
Google Play 的商店描述（兩個獨立鏡像站的抄本一致）寫的是
**"free tier supports up to 30 items with OCR scanning"，Pro 才解鎖無限收藏**。
〔推論〕兩者其中一份是舊的，而**「免費層到底能存幾張卡」是這種產品最關鍵的一個數字** ——
在確認之前，不要拿他們的免費層當任何設計的參照。

官網原句：

> "Free scanning quality and speed are never throttled — Pro only adds advanced features, **it never takes away the basics**."

〔推論〕**免費／付費的分界不是「能不能查」，是「查多深、查多久」** ——
免費也能掃卡、也能看價，付費買的是**歷史長度（30 天 → 無限）、提醒、與損益分析**。
這跟皮卡屋用「延遲 24 小時」當分界（見 [competitor-pikawu.md](competitor-pikawu.md)）是同一種思路的兩個變體：
**把「現在這一次查詢」免費送掉，把「持續追蹤」收費。**

**營收來源盤點：**

1. **訂閱**（Pro／Ultra，走 Apple／Google 內購，隱私頁列了 RevenueCat 做訂閱管理）
2. **周邊電商**（/en/shop 卡套、展示用品）
3. **送評代辦**（grading credits、Ultra 每月 150 次）
4. **代購**（"Proxy shop"，細節查不到）
5. **市集抽成：0%**，而且條款講明理由 —— 它不是交易平台，是資訊佈告欄

**條款關鍵句**（一手，[/en/terms](https://cardbase.io/en/terms)）：

> "CARDBASE acts solely as an **information exchange platform**, providing space for users to post buy/sell information"
> "Payment is charged to your Apple Account or Google Play account when you confirm the purchase"
> "all subscription fees paid are **non-refundable**, except as expressly required by Hong Kong law"
> 準據法：香港特別行政區法律

**這一句是整份對照最重要的一句。** 它把「零手續費」解釋成「我不經手交易」，
而不是「我有辦法免費撮合」。VaultDraw 的市場是託管、有保證金、有出貨時限、有爭議裁決
（`src/shared/escrow.ts`、`server/src/orders-service.ts`），
**兩邊做的根本不是同一種生意。**

### 1.4 價格資料從哪來

**沒有具名。**（一手，逐頁看過 /en、/en/scan-your-card、/en/pricing、/en/terms、/en/privacy、/en/market）

他們只說 "recent market SOLD records"、"updated daily"、"raw and each grade separately"，
並且在市集頁「標示價格來自哪個市場」（App Store 描述宣稱）。
**唯一具名的資料來源在隱私權政策裡：Scryfall（MTG 的卡片資料與圖片）。**
Pokémon／One Piece／Lorcana 的成交價來源一個字都沒提。

> 〔推論〕這正是 [research-card-pricing.md](research-card-pricing.md) 第四節整章在講的風險：
> **不具名，通常不是因為它是商業機密，是因為授權關係經不起寫出來。**
> 皮卡屋至少還寫了「均來自 SNKRDUNK、eBay 等第三方公開資訊平台」（見 [competitor-pikawu.md](competitor-pikawu.md) 結論 4），
> CardBase 連這句都沒有。**這不是可以抄的做法，這是要避開的做法。**

### 1.5 信任機制 —— 它**不是**身分驗證，這一點很重要

首頁把它寫成 "Seller Verification"，但點進 [/en/market/safety](https://cardbase.io/en/market/safety)
與 [/en/market/safety/check](https://cardbase.io/en/market/safety/check) 之後（一手，2026-09-06），
它自己講得很清楚 —— **平台不驗證任何人的身分，它只是一個識別碼查詢框**：

> "aggregates data by identifier — **not an accusation against any individual**"
> "**A name is not an identity key.** It is only matched as a keyword in reviewed text."
> "Reporter identities and private evidence photos are never published"
> "**No record ≠ safe**" · "check the HK Police **Scameter** before paying"
> "is **not legal advice and not an official police service**"

- 可查的識別碼：**phone / FPS / account / link**。
- **FPS（轉數快）在這裡不是付款整合**，是詐騙警示的一個欄位。原文：
  "**Fake FPS / transfer screenshots are common** — they show a 'paid' screenshot while your account hasn't actually received anything"。
- 資料庫筆數與資料來源**未公開**（首頁那個 "34 community reports" 是唯一露出的數字）。
- **鑑定證書查詢**（[/zh-HK/grading](https://cardbase.io/zh-HK/grading)）另外有一支，支援
  **PSA、CGC、BGS、TAG、ARS、ACE 六家**，輸入 8–10 位證書編號查。
  **這一支跟賣家驗證是兩件事**，但它是 CardBase 唯一真的在做「對外部權威查證」的地方。
- **沒有**：保證金、託管、出貨時限、逾期罰則、買家保障 —— 它不經手交易，這些它做不了也不需要做。
  買賣雙方**自行面交、自行轉帳**。

> 〔推論〕**「賣家驗證」這四個字被用得比它實際做的事大很多。**
> 它真正提供的是「這個門號／帳號有沒有被人回報過」，
> 而它自己已經在頁面上把這個功能的極限講出來了（"No record ≠ safe"）。
> **這是誠實的做法，但那不代表這個機制強。**

---

## 二、VaultDraw 現況（讀碼）

只列跟這次對照有關的，全部附行號。

### 2.1 卡片登記

| 事實 | 出處 |
|---|---|
| 登記一張卡有兩種模式：**從目錄挑**（TCGdex）或**手填卡名／系列／卡號** | `src/pages/CardUploadPage.vue:38-45`（`entryMode: 'catalog' \| 'manual'`） |
| **一次只能登記一張**，註解明寫「要登記三張就走三次」 | `CardUploadPage.vue:33-36` |
| 目錄搜尋**最準的寫法是日文卡名** | `src/lib/tcgdex-catalog.ts:14-24`（逐項實測記錄） |
| 目錄外的卡（手填）**一定要上傳正面照** | `server/src/routes/cardbook.ts:113-130` |
| 有速率限制：40 張／15 分鐘，兩個桶（帳號、IP） | `cardbook.ts:66-96` |
| 帶鑑定編號的登記是**所有權宣告**，唯一索引 `unique(grader, cert_no)`；撞到別人的只能走人工接管工單 | `cardbook.ts:14-17`、`server/src/routes/tickets.ts:80-120` |
| **沒有拍照辨識** | 全 repo 無此路徑；規劃在 [ai-opportunities.md](ai-opportunities.md) 第一節，狀態是提案 |
| **PSA 查證沒有上線** —— 曾經有快取表，因為 API 帳號待核准全 403 而整張刪掉 | `server/migrations/029_remove_psa_cache.sql`（檔頭原文：「該來源已經不可用（帳號待核准全 403）」） |

### 2.2 refPrice 的每一個出口

| # | 位置 | 用途 | 有沒有外部依據 |
|---|---|---|---|
| 1 | `server/src/routes/public.ts:266-267` `DEAL_RATIO` | 市場**預設排序**（`:375` `default('deal')`）＋精選「今日最殺」（`:608` `<= -0.08`） | ❌ 賣家自填 |
| 2 | `src/lib/api.ts:493` `totalValue` | 卡冊「**收藏總值**」大數字（`MyCardsPage.vue:974`，單位寫「**點**」） | ❌ |
| 3 | `src/lib/api.ts:496` `curve` | 收藏成長曲線（`src/components/ValueCurve.vue`） | ❌ |
| 4 | `src/lib/api.ts:494` `best` | 「最高價」那一張（`MyCardsPage.vue:1008`） | ❌ |
| 5 | `src/pages/PublicCardbookPage.vue:238-240` | **公開分享的卡冊**上的總值 | ❌ |
| 6 | `server/src/card-public.ts:52-55` | `refPrice` **在公開白名單裡**，會送到未登入的訪客手上 | ❌ |
| 7 | `src/components/PrizeTable.vue:30` | 爆賞保底卡那一行的「賣家標示參考價」 | ❌ |
| 8 | `src/shared/fairness.ts:100,136` | 進 manifest 被雜湊（**這一項是對的** —— 綁進 commit 讓它開賣後改不了，是揭露不是計算） | 不適用 |

**refPrice 已經不碰的地方**（這是好消息，不要退回去）：

- 經濟護欄：`src/shared/economics.ts:11-27`，分子換成宣告買回價
- 回收金額：`src/shared/recycle.ts:19`，「不參與任何金額計算」
- 池的獎項表主數字：`src/components/PrizeTable.vue:23`，欄位是**買回價**不是參考價

### 2.3 賣家信任

| 機制 | 有沒有 | 出處 |
|---|---|---|
| **市場託管訂單的保證金** | ✅ **有**。價格的 10%／5%／2%（依完成單數），上限 5,000 點 | `src/shared/escrow.ts:33-38` `depositFor()` |
| 保證金沒收 | ✅ 逾期未出貨或爭議判買家勝 | `server/src/orders-service.ts:86-90` |
| **開池保證金** | ❌ **沒有**，用「新賣家額度上限＋違約累積」替代 | `docs/open-issues.md` D-3、`docs/rules.md` 第二節 |
| 違約累積 → 不能再開池 | ✅ | `server/src/routes/sellers.ts:132-134` |
| 賣家頁統計 | ✅ 開池數、出貨數、爭議率、**宣告大獎率 vs 實際大獎率** | `server/src/routes/public.ts:145-160` `compose()` |
| 身分驗證（電話／銀行／實名） | ❌ **沒有** | — |
| 詐騙回報資料庫 | ❌ 沒有結構化的。只有客服工單一個 `report`（檢舉或申訴）分類 | `server/src/routes/contact.ts:45` |
| 一卡多賣防線 | ✅ 資料庫層唯一索引，不是應用層檢查 | `server/migrations/001_init.sql:44-47`、`prizes_cert_alive` |
| `certNo` **不對外公開** | ✅ 白名單刻意排除，理由是「拿著它可以去別處搶註」 | `server/src/card-public.ts:19-25` |

### 2.4 成本基礎：資料已經在了，只是沒有人去查

**這是這一輪讀碼最意外的發現。**（讀碼）

```sql
-- server/migrations/002_core.sql:129-138
create table if not exists draws (
  id text primary key, pool_id text, user_id text,
  seats int[] not null,
  cost  bigint not null,        -- ← 這一次抽卡總共花了多少點
  source text not null default 'draw', created_at bigint not null
);
-- :179-192
create table if not exists prizes (
  ..., draw_id text references draws(id), ...   -- ← 每張卡指得回那次抽卡
);
```

**每一張抽到的卡，都查得出它花了多少點**（`cost ÷ array_length(seats,1)`）。
市場買來的卡也一樣：`points_ledger` 有 `reason='vault-buy'` ＋ `ref_id=listingId` ＋ `created_at`
（`server/src/routes/orders.ts:255-256`、`server/migrations/001_init.sql:16-23`）。

**也就是說：**
- **成本基礎（我當初花多少）不缺資料，缺的是一支查詢與一個決定。**
- **VaultDraw 自己的「實際成交價」也不缺資料** —— `vault-buy` / `order-receive` / `trade-buy`
  三種 reason 都帶著 `ref_id` 與 `created_at`，join 回 `listings.card` 就是
  「哪一張卡、什麼版本、什麼鑑定等級、賣了多少點、什麼時候」。
  **CardBase 花錢去買的那種資料，VaultDraw 每一筆成交都在自己產生。**

⚠️ 但要誠實講兩件事：

1. `listings` 表本身**沒有 `sold_at`**（`001_init.sql:32-42`，狀態只有 live/sold/delisted）。
   時間要從 `points_ledger.created_at` 回推。這條路走得通，但不是一個現成的欄位。
2. **現在的成交量是零。** `docs/open-issues.md` P-5 實測結論：
   正式站陳列的 **32 個池 100% 是假池**，一個真實賣家開的都沒有（實測 2026-08-27）。
   ⚠️ P-1 在 2026-09-04 已修（`railway.json` 不再跑 seed），而 P-1 自己註明
   「既有正式資料是否仍包含 fixture，應另以 production API／資料庫盤點」——
   **所以下面每一個拿「零個真實賣家」當門檻的判斷，都應該先重新盤點一次再套用。**
   自家成交價這條路要有量才有意義 —— 這決定了它的必要性等級（見第四節）。

### 2.5 已經決定不做的事（不要在這份文件裡復活它們）

來自 `docs/open-issues.md` 第七節與 `docs/rules.md`：

| # | 事情 | 狀態 |
|---|---|---|
| D-1 | 寄存到期怎麼處理 | 待使用者拍板 |
| D-2 | 過戶時不重設寄存期限 | **已定案：不重設是對的**，已改成揭露（36 項迴歸實測） |
| D-3 | 開池保證金 | 不做，用額度上限＋違約累積替代 |
| D-4 | 保底／天井 | 不做（建議不做，待確認） |
| D-5 | 市場交易手續費 | **0%，機制根本不存在** |
| D-6 | 平台抽成 | **0%，但管線整套蓋好了**，改一個常數就生效（`src/shared/pool-settlement.ts:30`） |
| D-7 | 裸卡上架 | 使用者說緩 |

紅線（`docs/HANDOFF.md` 第 1 節，使用者反覆強調）：
**點數永遠不可以換回現金**（刑法 266）、**平台不可以買回自己送出的獎品**（電子遊戲場業管理條例 §14-II-2）、
**手機 UI 不可以有 emoji**。

---

## 三、功能對照表

「部分有」一律寫清楚差在哪，不寫「類似」。

| 功能 | CardBase | VaultDraw | 差在哪 |
|---|---|---|---|
| **核心賣點** | 你的收藏值多少 | **抽選**（commit-reveal ＋ drand 可驗證） | **不是同一門生意。**這一行決定了下面每一行怎麼讀 |
| 拍照掃卡辨識 | ✅ set／number／variant，含**置中評分**與 AI 分級預估；Pokémon 與 One Piece 可**裝置端**離線掃 | ❌ 手填或從 TCGdex 目錄挑 | 差一整個登記門檻。詳見第四節 A-1 |
| 卡片目錄 | 業者宣稱 685,800+ 張，四種 TCG | TCGdex `/v2/ja/`，**只有寶可夢日版** | VaultDraw 的目錄是**故意窄的** —— 它賣的是日版鑑定卡 |
| 變體（variant）辨識 | ✅ 掃描直接判 variant | ✅ 有 `variantId`，**但要人挑** | `tcgdex-catalog.ts:41-48` 實測：同卡號普卡 €0.02 vs 大師球鏡面 €369 |
| **參考價來源** | "Real **sold** prices"，raw 與各鑑定等級分開，每日更新，**來源不具名** | **賣家自己填**（`CardUploadPage.vue:276`，上限 1,000 萬） | **這是最大的差距**，詳見第四節 A-2／A-3 |
| 資料不足時 | ✅ 標 "not enough data"，**不猜** | ⚠️ **兩層紀律不一致**：顯示層守（`refprice.ts:19`「未標示」），排序層 `coalesce(...,0)` 當成 0% 折價（`public.ts:267`） | 見第四節 A-1 |
| 價格歷史 | Free 30 天／Pro 無限；7／30／90 天走勢 | ❌ 沒有卡片層級的價格歷史 | VaultDraw 有的是**收藏總值曲線**，那是另一回事 |
| 收藏總值 | ✅ 產品的主標語 | ✅ 有，**而且可公開分享** | 分母不同：一邊是成交價，一邊是自填值 |
| **成本基礎／損益** | ✅ Pro 功能（投資組合損益、ROI 分析；更新紀錄提到「圖表加成本線」） | ⚠️ **資料有、介面沒有**（`draws.cost` ＋ `prizes.draw_id`） | 見第四節 C-1，這一項兩面都要講 |
| 多幣別 | ✅ HKD 樞紐，市集看得到 NT$ | ❌ 只有點數，1 元＝1 點（`src/pages/TopupPage.vue:44`） | VaultDraw **不該**有多幣別：點數不能換現金是紅線 |
| 市集 | P2P 佈告欄，**平台不經手款項**，0% | **託管**：貨款凍結、保證金、72h 出貨、7 天驗收、爭議裁決，0%（D-5） | 同樣是 0%，一個是不做所以沒成本，一個是做了但選擇不收 |
| 賣家信任 | **社群回報的識別碼查詢**（電話／FPS／帳號／連結）。**不驗證身分**，自己註明 "No record ≠ safe" | 保證金＋違約累積＋賣家統計＋cert 唯一索引 | **兩種思路**，詳見第四節 B-2。VaultDraw 這邊在結構上比較強 |
| 買家保障 | ❌ **沒有**。平台不經手款項，自行面交轉帳 | ✅ 託管、貨款凍結、爭議裁決 | 這是 0% 手續費的代價 |
| 鑑定編號驗證 | ✅ 有查詢頁，PSA/CGC/BGS/TAG/ARS/ACE 六家 | ❌ **PSA 查證沒上線**（029 已刪快取表，帳號待核准 403） | **這是 CardBase 唯一明確做得比較好的一項** |
| 送評代辦 | ✅ Ultra 每月 150 次，推薦計畫給 grading credits | ❌ 沒有 | — |
| 周邊電商／代購 | ✅ /en/shop、Proxy shop | ❌ 沒有 | — |
| **抽選** | ❌ 完全沒有 | ✅ commit-reveal ＋ drand 未來輪次 ＋ 公開驗算頁 | **這是 VaultDraw 唯一沒有競品的東西** |
| 公平性驗算 | 不適用 | ✅ `src/shared/fairness.ts`，manifest 綁 commit，含 variantId | — |
| 收費模式 | **訂閱** HK$88／HK$218 月 | ❌ 尚無金流（`TopupPage.vue:17` 註解：「金流還沒接」） | — |
| 平台 | App 為主（iOS 200.7 MB，iPhone only，iOS 16.4+），網站是落地頁 | Web（GitHub Pages ＋ Railway） | — |
| API | ❌ 查不到 | ❌ 沒有對外 API | — |

---

## 四、逐項必要性判定

### 判準（不是感覺）

| 級別 | 判準 —— 一句話就能驗證的那種 |
|---|---|
| **現在就該做** | 「**程式碼裡已經存在一個功能，它的正確性依賴這件事，而這件事沒做**」。也就是：不做的話，現在畫面上已經寫出去的字是假的 |
| **上線後會需要** | 「現在不做不擋事，但**寫得出一個具體的量的門檻**，過了就會痛」。寫不出門檻的，不算這一級 |
| **可以考慮** | 「有價值，但**做完之後抽選不會變好**」。它在別條線上 |
| **不該做** | 「做了會**讓 VaultDraw 變成一個比較差的 CardBase**」，或跟已寫下的紅線／已定案的決定衝突 |

---

### A. 現在就該做

#### A-1　「低於市值」這四個字，平台答不出來

**判定依據**：`src/pages/MarketPage.vue:106` 的排序標籤原字是「**低於市值**」，
它是**預設排序**（`:104` `sort = ref('deal')`、`server/src/routes/public.ts:375` `default('deal')`），
分母是賣家自填的 `refPrice`（`public.ts:266-267`），
而 refPrice 由賣家在 `CardUploadPage.vue:276` 一個輸入框填進去，上限一千萬。
**照著現在的表單填，就能把自己的掛單排到市場第一位。**

還有第二個獨立的問題：`coalesce(..., 0)`。
沒有標示 refPrice 的卡在排序裡被當成「折價 0%」，
跟「剛好標在市價」混在一起 —— 而顯示層（`src/lib/refprice.ts:11-13`）
特地寫過註解說**不能用 0 頂替**。同一份資料，兩層紀律不一致。

**CardBase 借鏡什麼**：不是「去買成交價 API」（那是 A-3），是那條紀律 ——
**"flagged 'not enough data' rather than guessed"**。

**最小可行的修法（不需要任何外部資料、不需要任何錢）**：

1. 排序標籤從「低於市值」改成講得出口的字（例如「低於賣家標示」）—— 一行文案。
2. `DEAL_RATIO` 拿掉 `coalesce(..., 0)`，沒有 refPrice 的掛單**不進**這個排序，
   也不進精選區 —— 讓「沒有基準」跟「零折價」分開，跟顯示層對齊。
3. 預設排序從 `deal` 換成 `new`，直到有錨點為止。

**為什麼是「現在就該做」**：畫面上已經寫著「市值」兩個字，
而 `docs/rules.md`「還沒定案的事」第一條自己承認
「賣家標示的參考市值目前**沒有外部依據**」。**兩句話直接矛盾。**

**代價**：1 個檔案改文案 ＋ 1 個 SQL 片段 ＋ 1 個預設值。半天。
要動的是 `public.ts:266-267,375,608` 與 `MarketPage.vue:104-110`；
`refprice.ts` 不用動（它已經是對的）。

---

#### A-2　卡冊「收藏總值」的單位是「點」，而且可以公開轉貼

**判定依據**：`MyCardsPage.vue:974` 把 `totalValue` 印出來，
緊接著 `<span class="ovUnit">點</span>`。
而 `totalValue` 是 `Σ refPrice`（`src/lib/api.ts:493`），
`refPrice` 是賣家自填、**選填**、沒填算 0（`refPrice Num()` 回 0，`api.ts:493` 註解自己承認
「沒有標示參考價的卡在總值裡算 0」）。
這個數字同時出現在**公開分享的卡冊**上（`PublicCardbookPage.vue:238-240`），
而 `refPrice` 在公開白名單裡（`server/src/card-public.ts:52-55`）。

**問題有兩層，第二層比較嚴重：**

1. **單位是「點」** —— 點數在 VaultDraw 有明確定義：1 元＝1 點、可以拿去抽卡與買卡
   （`docs/rules.md` 第一節）。把一個賣家自填的估值印成「N 點」，
   讀起來像「這本卡冊可以換 N 點」，**而那是紅線的反面**（點數不能換現金，
   卡冊也不能換點數 —— 能換點數的只有那個池宣告過買回價的卡）。
2. **可公開分享** —— 一個沒有外部依據的數字，被做成可以貼進群組的連結。
   `MyCardsPage.vue:955-966` 已經很小心地處理了「換新連結讓舊連結失效」，
   **可見這條分享路是認真在做的**，那更該確定它送出去的數字站得住。

**CardBase 借鏡什麼**：他們的同一個數字叫 "what your collection is **really** worth"，
底下是成交價。**要嘛把數字換成站得住的，要嘛把「值多少」這個宣稱收回來。**

**最小可行的修法**：把標籤從「收藏總值」改成「**已標示總值**」，
單位不要寫「點」（或寫「賣家標示，僅供參考」），
並在有 refPrice 為 null 的卡時把「N 張未標示」講出來 —— 現在它們靜靜地被當成 0。

**為什麼是「現在就該做」**：這一項跟 A-1 一樣，是**現在畫面上已經在講的話**。
改文案不需要任何外部依賴。

**代價**：文案與一個小計數。1 天以內。
`MyCardsPage.vue:925,974,1008`、`PublicCardbookPage.vue:238-240`、`src/lib/api.ts:493`。

---

#### A-3　把 refPrice 的量級檢查接起來（TCGdex 內建的 Cardmarket 價）

**判定依據**：這一項**不是新研究**，[research-card-pricing.md](research-card-pricing.md)
第 195-200 行已經定案過了：TCGdex 的 `/v2/ja/cards/{id}` **回應裡本來就帶 Cardmarket 價**，
專案 mock 的 31 張卡 **31/31 全部有價**（一手實測，2026-08-25），
免 key、免費、零新依賴 —— 而 VaultDraw 已經在用 TCGdex 取卡圖（`src/lib/tcgdex.ts`）。

那份研究同時算過一張表（第 127-158 行）：拿現有的 31 張示範卡對照 Cardmarket 趨勢價，
**refPrice 兩個方向都錯得離譜** —— 最高 96.3 倍、最低 0.10 倍。

**CardBase 讓這一項從「該做」變成「現在就該做」的理由**：
它證明了**這件事在同一個市場（亞洲、含台幣）已經有人做出來並且拿它收費**。
換句話說，「沒有錨點」不再是一個技術限制，是一個選擇 —— 而選擇要說得出口。

⚠️ **三個不能忽略的限制**（全部出自那份研究，這裡只是不讓它們被忘記）：

- Cardmarket 是**歐洲的歐元價**，不是日本行情也不是台灣行情。
- **它只有 RAW**。一張 PSA 10 旁邊放 RAW 價，會讓**誠實的賣家看起來像在騙人** ——
  eBay 做過同一件事被賣家罵爆（那份研究 §3.7）。
- 用 `avg7`，不要用 `trend`／`low`／`avg1`（`avg1` 實測一天內擺盪 69%）。

**所以這一項的正確範圍是「量級檢查器」，不是「報價」**：
建池／登記時，refPrice 與錨點差超過一個級距就**提醒賣家**（不硬擋），
畫面上不對玩家顯示外部價。這樣就繞開了「RAW vs PSA10 誤會」與「歐洲價不是台灣價」兩個坑。

**為什麼是「現在就該做」**：A-1 與 A-2 只是把話講小；這一項才是把話講對的起點，
而它的成本是全表最低的一項（現有依賴、現有 `artId` 欄位、免費、免 key）。

**代價**：後端一支批次抓取＋一個 `anchor_price` / `anchor_at` / `anchor_source` 欄位＋建池表單的提醒。
**約 3–5 天**，前提是先照那份研究第 179-193 行補 `variant` 欄位 ——
`prizes` 已經有 `variantId`（`server/migrations/019_prize_variant.sql`），**這一步可能已經做完了，要先確認**。

---

### B. 上線後會需要

#### B-1　拍照掃卡辨識（門檻寫得出來）

**它值不值得做，[ai-opportunities.md](ai-opportunities.md) 已經整章分析過了**，
結論是「**排第一，但第一步不是 AI**」：certNo 要走**條碼**（有校驗、確定性、零邊際成本），
AI 只負責「這串字是哪個欄位」與跨模態比對。成本算到小數點：
Opus 5 掃一張 NT$1.23，60 張卡的池 NT$74，是那個池票收的 **0.12%**。工期 3–4 週。

**CardBase 加了什麼新資訊：**

1. **它把辨識做到裝置端**（App Store 更新紀錄提到 Pokémon 與 One Piece 的 on-device 掃描）。
   〔推論〕這是為了讓免費層「掃描品質與速度永不限流」在成本上活得下去 ——
   **免費送掉的功能不能是按次計費的功能。** 這對定價設計是一課，對 VaultDraw 暫時不適用（沒有 App）。
2. **它多掃了一樣東西：置中評分（centering score）**。這是我在 ai-opportunities 裡沒看到的角度 ——
   同一張照片，除了「這是哪張卡」，還能回答「這張卡品相如何」。〔推論〕對 VaultDraw 的
   **裸卡上架**（D-7，使用者說緩）會很有用，但那條線本來就緩著。
3. **它自己寫了免責**："not 100% accurate"、"should be confirmed manually"。
   跟 ai-opportunities「輸出只能是建議或風險分數，不能是決定」同一條線。**這是共識，不是巧合。**

**為什麼是「上線後會需要」而不是「現在就該做」**：
`docs/open-issues.md` P-5 實測（2026-08-27）—— 正式站 **32/32 是假池，零個真實賣家**。
（P-1 已於 2026-09-04 修掉「每次部署重塞假資料」，但既有資料**尚未重新盤點** —— 見第六節第 13 項。）
**現在的瓶頸不是「賣家嫌登記麻煩」，是「一個賣家都還沒有」。**
掃卡是在解一個還沒發生的問題。

**具體門檻（過了就該做）**：
- 有 **3 個以上真實賣家**，且其中任何一人抱怨過登記流程；或
- 單一賣家一次要登記 **20 張以上**（現在的表單一次一張，20 張＝20 趟完整流程）；或
- 開池表單的放棄率量得出來且高於一半。

**代價**：3–4 週，其中約一半跟 AI 無關（條碼 3–5 天含 iOS Safari 要帶 zxing-wasm 約 250KB、
上傳管線 1 天、後端端點 3–5 天、前端 3–5 天、標註集與調校 5–8 天）。
**第 0 步只要 1 小時**：拿三張真實的日版 PSA 卡拍照，看標籤到底印什麼 ——
那一小時決定整個提案成不成立（ai-opportunities 第 30-35 行的警告）。

---

#### B-2　賣家身分驗證：CardBase 那一套**不要照抄**，但它暴露了一個真的缺口

**兩邊的思路差在哪：**

| | CardBase | VaultDraw |
|---|---|---|
| 誰承擔違約成本 | **買家**（平台不經手錢，出事只能靠回報與報警） | **賣家**（保證金被沒收、違約累積、不能再開池） |
| 「驗證」的實質 | **查一個識別碼有沒有被回報過**。頁面自己寫 "A name is not an identity key"、"not an accusation against any individual" —— **它不驗證身分** | **卡的身分**（cert 唯一索引、目錄挑卡、manifest 綁 commit） |
| 資訊怎麼累積 | 社群回報（34 筆），自己註明 "No record ≠ safe"，並叫使用者去查香港警方 Scameter | 平台自己的紀錄（出貨數、爭議率、宣告 vs 實際大獎率），**自動產生、無法灌** |

**VaultDraw 的那一套在結構上比較強**，理由是它不依賴使用者的善意：
保證金是資料庫裡凍住的點數（`src/shared/escrow.ts:33-38`），
違約是自動記的（`server/src/orders-service.ts:186-199`），
一卡多賣是資料庫唯一索引擋的（`001_init.sql:44-47`，註解原文：
「這是資料庫層的約束，不是應用層的檢查 —— 應用層的檢查擋不住併發」）。
**CardBase 的 34 筆社群回報做不到這三件事的任何一件。**

**而且要講清楚：CardBase 那一套比我原本以為的更弱。**
它不驗證身分（§1.5），它只是查一個識別碼有沒有被回報過，
自己在頁面上寫 "No record ≠ safe" 並叫使用者去查香港警方的 Scameter。
**「賣家驗證」這四個字在他們那裡是行銷用語，不是機制。**

**但有一個真的缺口，而 CardBase 剛好照到它**：
**VaultDraw 完全不驗證「這個人是誰」。**
保證金上限 5,000 點（`escrow.ts:33` `DEPOSIT_CAP`），
開池則根本沒有保證金（D-3）。**一個違約到不能開池的賣家，換一個帳號就回來了。**
現在沒事，是因為賣家數是零。

**為什麼是「上線後會需要」**：門檻是「**第一次有人因為違約被停權**」——
那一刻才知道他會不會換帳號回來。在那之前做，是在防一個沒發生的攻擊。

**該做什麼、不該做什麼（這一段很重要）**：
- ✅ 做**單一、最低成本、最不侵入**的一項：手機號碼綁定（一個帳號一個門號）。
  它擋的是「批量換帳號」，不是「壞人」。
- ❌ **不要做**社群詐騙回報資料庫。理由在第五節 D-3。
- ❌ **不要收**銀行帳號。VaultDraw 的錢在站內帳本裡走，不需要知道任何人的銀行帳號；
  收了就多一整類個資風險，換不到任何東西。

**代價**：簡訊驗證要接一個供應商並付費。1–2 週＋每則簡訊成本。

---

#### B-3　把 VaultDraw 自己的成交價變成 refPrice 的錨點

**這是我認為最被低估的一條，而且它比接外部 API 更適合 VaultDraw。**

**資料已經在累積了**（讀碼，見第 2.4 節）：
`points_ledger` 的 `vault-buy` / `order-receive` / `trade-buy` 三種 reason，
每一筆都有 `ref_id`（掛單／訂單／邀約 id）與 `created_at`，
join 回 `listings.card` 就是「哪一張卡（含 `setCode`／`cardNo`／`grader`／`grade`／`variantId`）、
賣了多少點、什麼時候」。**這正是 CardBase 拿去當產品核心的那種資料，
而 VaultDraw 每一筆成交都在自己產生 —— 不用談授權、不踩 Lawsnote 案的線
（[research-card-pricing.md](research-card-pricing.md) §4.2）、不用付月費。**

**這條路獨有的三個好處：**
1. **是台幣、是點數、是同一群人的行情** —— 外部錨點全部有「歐洲價／北美價不是台灣行情」的問題（那份研究 §3.6）。自家成交價沒有這個問題。
2. **分得出鑑定等級** —— 因為 `listings.card` 就帶著 `grader` 與 `grade`。
   而那份研究 §3.7 的結論是「**分得出鑑定等級不是加分項，是必要條件**」。
3. **法遵是零** —— 自己的資料。

**為什麼不是「現在就該做」**：
`docs/open-issues.md` P-5 實測（2026-08-27）—— **32/32 是假池，成交量實質為零**。
（同上，這個數字該重新盤點過再拿來做決定。）
沒有量的統計比沒有統計更糟（那正是 CardBase 用 "not enough data" 在防的事）。

**具體門檻**：某一張卡（同 `setCode`＋`cardNo`＋`variantId`＋`grader`＋`grade`）
累積 **5 筆以上**成交，才對那張卡顯示自家成交價；不足就顯示「成交筆數不足」——
**這一條直接抄 TCGplayer 的做法**（那份研究 §3.7 已經點名它值得抄）。

**代價**：
- 一支 SQL view／物化視圖 ＋ 一個顯示元件：**3–5 天**。
- ⚠️ 順手該補的：`listings` 沒有 `sold_at`（`001_init.sql:32-42`），
  時間現在只能從 `points_ledger` 回推。加一個欄位是一支 migration。
  **這件事早做比晚做便宜，但不是急件** —— 時間資訊沒有遺失，只是要繞路查。

---

#### B-4　鑑定編號查證：這是 CardBase 唯一明確做得比較好的一項

**現況（讀碼）**：VaultDraw 曾經有 PSA 查證與快取表，
**整張表在 `server/migrations/029_remove_psa_cache.sql` 被 drop 掉了**，
檔頭原文：「該來源已經不可用（**帳號待核准全 403**），也就是說**重建不出來**」，
並且明講「平台**不再宣稱或顯示** PSA 已查證」。
今天 `certNo` 只做兩件事：格式正規化，以及 `unique(grader, cert_no)` 的唯一索引
（`server/src/card-cert.ts`、`server/migrations/001_init.sql:44-47`）。
**沒有任何一步確認「這個編號真的存在、真的是這個分數」。**

**CardBase 有一支查詢頁**（[/zh-HK/grading](https://cardbase.io/zh-HK/grading)，一手），
支援 PSA／CGC／BGS／TAG／ARS／ACE 六家，輸入 8–10 位證書編號。
**它怎麼做到的，查不到**（第六節第 11 項）—— 但它證明了這件事在 2026 年做得出來，
而 VaultDraw 卡在「PSA 帳號待核准」這一個窗口上。

**該做什麼**：[cert-verification-alternatives.md](cert-verification-alternatives.md)
已經整份研究過六條路。它的「第 0 層：今天就能做，不用等任何人，零成本零風險」
（E-1 格式與上限檢查、E-3 平台內交叉比對、E-5 把 PSA 官方頁當**給買家看的連結**）
**現在應該重讀一次** —— 因為 029 把上面那層拆掉之後，
今天連「格式對不對」這種零成本的檢查有沒有補回來，我這一輪沒有確認（第六節第 12 項）。

**為什麼是「上線後會需要」**：門檻是 **第一筆真實的鑑定卡交易**。
在那之前，一個沒有人用的驗證機制不會保護到任何人。
但那一天到了，「買家付了幾萬點買一張 PSA 10，而平台從來沒查過它存不存在」
就會是一句寫不出去的話。

**代價**：第 0 層（本地檢查＋對外連結）**1–2 天**，不用等任何人。
接外部 API 是另一件事，成本與條款見那份研究。

---

### C. 可以考慮

#### C-1　成本基礎與損益（使用者特別問的一項，兩面都要講）

**資料已經有了**（讀碼，第 2.4 節）：`draws.cost` ＋ `prizes.draw_id`
＋ `points_ledger` 的 `draw` reason。**做這件事不需要任何新資料，只需要一個決定。**

**好的一面：**
- 它是**誠實**。使用者花了多少點，帳本裡本來就記著（`WalletPage` 已經逐筆列出來了，
  `src/lib/api.ts:180-186` 的 `REASON_NOTE` 有「抽選」這一項）。
  **拒絕加總一組使用者自己看得到的數字，是一種假裝。**
- 它是**負責任的抽選平台會做的事**。日本オリパ業界 2024 年有業者因當選機率虛偽表示
  被課徵金 780 萬円＋停業 6 個月（`research-card-pricing.md` §3.7 引述）。
  一個敢讓使用者看見自己花了多少的平台，跟一個不敢的，監理眼中不是同一件事。
- 它跟 VaultDraw 已經做的每一件事**同一個方向**：commit-reveal、公開驗算頁、
  「不需要相信我們，你自己算」（`docs/rules.md` 第八節）。

**壞的一面（要講得比好的一面更清楚）：**
- **它會讓使用者算得出自己抽輸多少，而且算式的分子是一個假數字。**
  「我花了 12,000 點，收藏總值 8,400 點」—— 那個 8,400 是 `Σ refPrice`，
  是**賣家自己填的**。使用者會拿一個真實的支出，去減一個沒有依據的估值，
  然後對那個差額產生真實的情緒。**這比不顯示更糟。**
- **所以 C-1 有一個硬前提：A-2 與 A-3 要先做完。**
  在收藏總值站得住之前做損益，等於把 A-2 的問題放大。
- **抽選平台的損益數字跟收藏 App 的損益數字，讀起來不一樣。**
  CardBase 的使用者是在二級市場買賣，損益是投資結果；
  VaultDraw 的使用者是在抽，損益讀起來是**賭輸多少**。同一個數字，兩種語意。

**判定「可以考慮」而不是更高的理由**：做完之後**抽選本身不會變好**。
它改善的是使用者對自己行為的認識，那是好事，但不在主線上。

**代價**：查詢與介面 2–3 天。**但前置的 A-2＋A-3 是 5–7 天，那才是真正的成本。**

**如果要做，我建議的形狀**：只顯示**支出**（「你在這個平台花了 N 點」），
**不要**自動算差額。讓使用者自己把它跟收藏總值放在一起 ——
平台不該替一個不可靠的減法背書。

---

#### C-2　卡片層級的價格歷史（7／30／90 天走勢）

CardBase 拿它當付費分界（Free 30 天、Pro 無限）。
**對 VaultDraw 沒有主線價值**：VaultDraw 的使用者不是來看走勢決定買賣時機的，
是來抽卡的。做了它，是往「收藏 App」走了一步。

真正有用的變體是 B-3 的副產品：**同一張卡在本站的歷史成交價**。
那個對「這個池值不值」有直接幫助，而走勢圖沒有。

**代價**：B-3 做完之後幾乎免費（同一份資料換一個畫法）。

---

#### C-3　置中評分 / AI 分級預估

CardBase 有（"measures the borders, and computes a centering score"）。
對 VaultDraw 只在 **D-7 裸卡上架**那條線上有意義，而那條線使用者說緩。
**等 D-7 解凍再說。**

---

#### C-4　訂閱制

CardBase 的 HK$88／HK$218 證明「收藏工具的訂閱」在亞洲收得到錢
（皮卡屋的 NT$199–1,249 是同一個證據，見 [competitor-pikawu.md](competitor-pikawu.md)）。

**但對 VaultDraw 這不是下一步**：
- D-6 的平台抽成**管線已經整套蓋好**（`src/shared/pool-settlement.ts:30` `PLATFORM_FEE_RATE = 0`，
  註解明講 0 是商業決定不是 TODO），**改一個常數就生效**。
  在一條蓋好的路旁邊再蓋一條新的，不是好的順序。
- VaultDraw **金流還沒接**（`src/pages/TopupPage.vue:17,33`：「金流還沒接（需要跟供應商談合作）」）。
  訂閱要另一套金流。
- 訂閱要有「持續回來看的理由」，而 VaultDraw 的使用者是**事件驅動**的（有池才來）。

**判定**：可以考慮，但排在 D-6 之後。

---

### D. 不該做（這一節請認真讀）

> **這兩個產品的核心不一樣。**
> CardBase 賣的是「你的收藏值多少」，VaultDraw 賣的是**抽選**。
> 下面每一項單獨看都很合理，合起來就是把 VaultDraw 變成一個功能比較少、
> 使用者比較少、資料比較差的 CardBase。

#### D-1　❌ 多幣別

**理由是紅線，不是取捨。** 點數不能換回現金（刑法 266 條的對價關係，
`docs/HANDOFF.md` 第 1 節、`docs/rules.md` 第一節）。
VaultDraw 的內部單位是「點」，1 元＝1 點（`TopupPage.vue:44`）。
**加上「這張卡值 HK$300 / US$40」會做兩件壞事**：
把點數重新錨定到現金（正是紅線要切斷的聯想），
以及讓平台對一個它答不出來的匯率＋行情負責。

CardBase 做得了，是因為它不經手錢。**VaultDraw 經手。**

#### D-2　❌ 支援 One Piece／Lorcana／MTG

**目錄窄是故意的。** `src/lib/tcgdex-catalog.ts:8-10` 註解原文：
「語系一律用 `/v2/ja/`。實測 `/v2/en/` 查不到日版卡……**而這個平台賣的是日版鑑定卡**」。
多開一種卡種要多一份目錄、多一份變體規則、多一份價格來源、多一份卡圖授權，
**而抽選一次只會抽同一種卡。**

CardBase 要鋪四種，是因為它的產品是「收藏管理」——卡種越多，可管理的收藏越多。
**VaultDraw 的產品是「這個池」，池是單一的。** 這是完全不同的擴張邏輯。

現在的真問題是**零個真實賣家**（P-5 實測），不是卡種太少。

#### D-3　❌ 社群詐騙回報資料庫

**這一項我想特別講，因為它表面上最像「VaultDraw 缺的東西」。**

CardBase 自己在首頁標註 **"No record does not mean safe"** ——
**它自己知道這個功能的召回率很低。** 34 筆回報，是一個誠實的數字，
也是一個說明問題的數字。

**對 VaultDraw 不該做的三個理由：**

1. **它會取代掉比較強的東西。** VaultDraw 的違約紀錄是**自動、客觀、無法被灌**的
   （逾期未出貨 → 系統自動記，`orders-service.ts:186-199`）。
   社群回報是**手動、主觀、可以被灌**的。兩個並列在同一個賣家頁上，
   使用者會看比較聳動的那一個。**加一個弱訊號，會稀釋一個強訊號。**
2. **它會製造一個新的攻擊面。** 賣家之間互相檢舉的成本是零。
   VaultDraw 的紀錄裡每一項都要付出真實代價才能改變
   （要記一次違約，賣家得真的沒出貨、真的被沒收保證金）。
3. **它把責任搬到使用者身上。** VaultDraw 已經選了另一條路：
   平台自己扛（託管、保證金、爭議裁決）。混兩套會讓「出事了誰負責」變模糊 ——
   而那正是託管制度存在的全部意義。

**已經有的正確做法**：客服工單的 `report`（檢舉或申訴）分類
（`server/src/routes/contact.ts:45`）—— 有人審，不是公開計數器。

#### D-4　❌ 「這張卡值多少」的即時估值當成主功能

CardBase 首頁大字是 "What Is Your Collection Worth?"。
VaultDraw 首頁大字如果變成同一句，**它就不是抽選平台了**。

更實際的理由：`docs/rules.md` 第四節寫得很清楚 ——
「平台**買回**自己送出的獎品在台灣是明文禁止的（電子遊戲場業管理條例第 14 條）」，
所以 VaultDraw 唯一有約束力的數字是**賣家宣告的買回價**，
它是一筆債不是一個估價。**把估值抬成主功能，會讓使用者以為那個估值是可以兌現的。**
那不只是誤解，那是把整套法律論述的地基往回挖。

**A-3 的量級檢查**跟這一項的差別在哪：量級檢查是**給賣家看的內部護欄**（填離譜了提醒他），
不是給玩家看的估價。這條線不能越。

#### D-5　❌ 「零手續費」當行銷賣點

VaultDraw 的市場手續費與平台抽成**現在確實都是 0%**（D-5／D-6，讀碼確認仍成立）。
**但不要拿它當賣點**，兩個理由：

1. **CardBase 的 0% 有結構性理由（不經手錢），VaultDraw 的 0% 沒有。**
   VaultDraw 蓋了託管、保證金、爭議裁決 —— 這些有真實成本。
   把 0% 講成承諾，等於承諾一件遲早要收回的事。
   而 `pool-settlement.ts:24-30` 的註解已經寫明：0 是**商業決定**，不是 TODO。
2. **一旦講成賣點，之後調整費率就變成「背叛」而不是「調整」。**
   D-6 的管線是刻意蓋好的 —— 蓋好一條路然後對外承諾永遠不走，是最糟的組合。

#### D-6　❌ 具名不清的外部成交價

CardBase 對 Pokémon／One Piece／Lorcana 的成交價來源**一個字都沒說**（一手，逐頁確認）。
只有 MTG 的 Scryfall 具名（在隱私權政策裡）。

**這不是可以抄的做法。** [research-card-pricing.md](research-card-pricing.md) §4.2 記著
Lawsnote 案一審：創辦人 4 年徒刑、民事賠償約 1 億 545 萬元，
且法院認為「**違反網站使用規範即構成刑法 359 條的『無故』**」。
**公司在台灣，適用台灣法。**

那份研究的結論值得原樣重複一次：
**不要用「資料誰最好」來選，用「誰的條款白紙黑字允許你做你要做的事」來選。**

#### D-7　❌ 把抽選功能加到收藏管理裡（反過來也一樣）

CardBase 的 Help 頁有一個叫 **"Pool Calculator"** 的條目
（一手，[/en/help](https://cardbase.io/en/help)，內容需展開，未取得 —— 見第六節），
而 iOS 1.7.0 的更新紀錄裡列了「**抽獎**」。
〔推論〕它可能正在往オリパ／抽選靠。

**即使它真的是抽選功能，也不改變判斷**：
VaultDraw 的抽選有 commit-reveal ＋ drand 未來輪次 ＋ 公開驗算頁 ＋ manifest 綁 variantId
（`src/shared/fairness.ts`、`docs/rules.md` 第八節）。
**這一套是 VaultDraw 唯一沒有競品的東西**，而它之所以站得住，
是因為整個系統都繞著它設計（獎品清單封存、買回價鎖死、種子熵閘、自抽不計入公開籤數）。
一個收藏 App 加一個計算機，跟這個不是同一件事。

**反過來的版本更危險**：不要為了「像 CardBase 一樣完整」，
把收藏管理的功能一項一項加進來 —— 每加一項，
上面那套公平性機制要照顧的表面積就大一分。

---

## 五、如果要做，由淺到深的順序

每一項都寫了**代價**與**前置**。前置沒完成就往下做，會做出比不做更糟的東西。

| 順序 | 項目 | 代價 | 前置 | 為什麼排在這 |
|---|---|---|---|---|
| **1** | **A-1** 市場排序：改文案、拿掉 `coalesce(...,0)`、預設排序換 `new` | **半天**，2 個檔案 | 無 | 唯一一項「現在畫面上的字是假的」。零依賴 |
| **2** | **A-2** 卡冊總值：改文案、把「N 張未標示」講出來 | **1 天以內** | 無 | 同上，而且它會被公開轉貼 |
| **3** | 確認 `variantId` 是否已經貫穿（`019_prize_variant.sql` 已存在，要確認建池／登記／市場三條路都帶著它） | **半天讀碼** | 無 | 沒有它，任何錨點在含大師球鏡面的套牌上會系統性錯 18,000 倍 |
| **4** | **A-3** 接 TCGdex 內建的 Cardmarket 價當**量級檢查器**（`avg7`，只給賣家看，不硬擋） | **3–5 天** | 第 3 項 | 成本最低的錨點：現有依賴、現有欄位、免費、免 key |
| **5** | 補 `listings.sold_at`（一支 migration） | **半天** | 無 | 不急，但早做便宜。時間資訊沒遺失，只是要繞 `points_ledger` |
| **6** | **B-3** 自家成交價：物化視圖 ＋「成交筆數不足」門檻（≥5 筆才顯示） | **3–5 天** | 第 3、5 項；**且要有真實成交量** | 唯一一條沒有法遵風險、分得出鑑定等級、是台幣行情的錨點 |
| **7** | **B-4** 證書編號的**本地**檢查（格式／上限／平台內交叉比對）＋把 PSA 官方頁當**給買家看的連結** | **1–2 天**，不用等任何人 | 先確認 029 之後有沒有補回來（第六節第 12 項） | [cert-verification-alternatives.md](cert-verification-alternatives.md) 的「第 0 層」。零成本零風險，而 029 把上面那層拆掉了 |
| **8** | **B-2** 手機號碼綁定（**只做這一項**，不做銀行帳號、不做社群回報） | **1–2 週**＋簡訊成本 | 第一次有人因違約被停權 | 擋批量換帳號，不擋壞人 |
| **9** | **B-1** 拍照掃卡：**先花 1 小時**拍三張真實 PSA 卡看標籤印什麼 | **1 小時**（決定後續成不成立） | 有 ≥3 個真實賣家 | 那一小時決定 3–4 週要不要花 |
| **10** | B-1 本體：條碼優先 → AI 只做欄位歸屬與跨模態比對 | **3–4 週** | 第 9 項的答案是「對得回 setCode」 | 見 [ai-opportunities.md](ai-opportunities.md) 第一節 |
| **11** | **C-1** 成本基礎：**只顯示支出，不自動算差額** | **2–3 天** | **A-2 ＋ A-3 必須先完成** | 在總值站得住之前做，等於放大 A-2 的問題 |

**第 1、2 項今天就做得完，而且不需要任何外部依賴、不需要任何錢。**
如果這一輪只做一件事，做第 1 項。

---

## 六、我查不到的東西

**照實列，不推測成事實。**

| # | 查不到什麼 | 找過哪裡 | 為什麼重要 |
|---|---|---|---|
| 1 | **CardBase 的成交價資料來源** | /en、/en/scan-your-card、/en/pricing、/en/terms、/en/privacy、/en/market、/en/news 全部逐頁看過 | 這是他們整個產品的地基。不具名讓人沒辦法判斷「Real sold prices」有多真、授權有沒有問題 |
| 2 | **市集除了 0% 抽成之外有沒有其他收費** | /en/pricing 完全沒提市集；/en/terms 只講訂閱 | 決定「零手續費」是不是真的完全零 |
| 3 | **他們的營收規模、募資、成立時間、團隊人數** | /en/about、/en/news 12 篇、一般搜尋 | /en/about 只說「為亞洲收藏家設計」，提到香港賣家與卡店。**沒有任何財務或里程碑資訊** |
| 4 | 🚨 **"Pool Calculator" 是什麼，以及 1.7.0 更新紀錄裡的「抽獎」是什麼** | /en/help 只取得分類標題，答案需展開；App Store 更新紀錄只有兩個字 | **這一項最該先追。** 如果 CardBase 真的在做抽選，它就從「隔壁賽道的鄰居」變成「主線上的對手」，而它已經在往台灣走（見結論六）。判斷要整個重來 |
| 5 | **詐騙回報的審核流程與資料庫規模** | /en/market/safety、/en/market/safety/check | 34 筆是怎麼進來的、有沒有人審、能不能申訴、資料來源是哪些。**頁面明說「未公開」** |
| 6 | **鑑定證書查詢是怎麼做到的** | /zh-HK/grading（有查詢框，未實際送出查詢） | 六家鑑定公司的 API 都不好拿（PSA 的帳號 VaultDraw 就卡在待核准）。他們是接官方、接第三方、還是爬？**這決定 B-4 能不能參考** |
| 7 | **免費層到底能存幾張卡** | 官網 pricing 寫 "unlimited"，Google Play 描述寫 "up to 30 items" | 兩份官方說法直接矛盾。**在確認之前不要拿他們的免費層當參照** |
| 8 | **註冊實體名稱、地址、負責人、成立時間、團隊人數、募資** | /en/terms、/en/privacy、/en/about、/en/contact、Crunchbase、LinkedIn、一般搜尋 | 只有 "© CardBase Limited 2026"、App Store 開發商 "cardbase limited"、WhatsApp +852 4473 8841。**沒有地址、沒有負責人、沒有任何財務資訊**（比皮卡屋還少 —— 那家至少有統編） |
| 9 | **App Store 上架日期** | apps.apple.com（HK / US） | Android 是 2026-08-20；iOS 推不出來。影響「這家有多新」的判斷 |
| 10 | **使用者對「掃得準不準、價格準不準」的實際回饋** | App Store 評論（7 則）、Google Play（1 則） | **樣本根本不存在。** 這正是我最想知道、卻完全沒有證據的一項 |
| 11 | **VaultDraw 的 `variantId` 有沒有貫穿全部路徑** | 這一輪只確認了 `019_prize_variant.sql` 存在、`fairness.ts` v4 有帶 | 這是 A-3 的前置（第五節第 3 項）。**要讀碼確認，不要假設** |
| 12 | **029 刪掉 PSA 快取之後，本地的編號格式檢查有沒有補回來** | 這一輪只讀了 `card-cert.ts`（它做的是**卡號**比對，不是**證書編號**的格式與上限檢查） | 決定 B-4 的「第 0 層」是待辦還是已完成 |
| 13 | 🚨 **VaultDraw 現在到底有幾個真實賣家、幾筆真實成交** | `open-issues.md` P-5 是 2026-08-27 的實測（32/32 假池），而 P-1 已於 2026-09-04 修掉部署重塞 seed 那條，並自己註明既有資料**要另外盤點**。而且 P-5 數的是**池**，不是市場掛單 | **B-1、B-2、B-3 三項的門檻全部建立在這個數字上。** 這一輪連不到資料庫，所以那三項的「還不急」是**待查**不是實測 |

---

## 附錄：對這次任務簡報的三處更正

任務簡報裡有三條前提，讀碼之後有兩條要修、一條要補充。**記在這裡避免下次再傳一次。**

| # | 簡報說的 | 讀碼結果 |
|---|---|---|
| 1 | 「`refPrice` 被用在**經濟護欄與還元率**上」 | ❌ **已經不是了。** `src/shared/economics.ts:11-27` 換過分子（保底回饋率＝Σ宣告買回價÷票收）、`src/shared/recycle.ts:19`「不參與任何金額計算」、`HANDOFF.md` 4.1 標題是「**已解**（2026-08-25）」。<br>✅ **但它還在三個地方**：市場預設排序、卡冊收藏總值（含公開分享）、爆賞保底卡那一行。問題搬家了，沒消失 |
| 2 | 「VaultDraw 有**保證金**」 | ⚠️ **一半對。** 市場託管訂單**有**（`escrow.ts:33-38`，10%／5%／2%，上限 5,000 點）；**開池沒有**（D-3，用新賣家額度上限＋違約累積替代） |
| 3 | 「差在有沒有『我當初花多少』」 | ⚠️ **不是缺資料，是缺介面。** `draws.cost` ＋ `prizes.draw_id` ＋ `points_ledger`（`reason='draw'`）已經足以算出每張卡的成本。做不做是產品決定，不是工程問題 —— 這反而讓 C-1 更需要謹慎，因為「做不到」不再是不做的理由 |
