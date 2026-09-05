# 競品對照：VinciWorld（vinciworld.xyz）／Renaiss vs VaultDraw

> 調查日期：**2026-09-06**。方法：對方側為**唯讀瀏覽**（WebFetch／WebSearch＋抓公開 JS bundle 讀字串），
> 未註冊、未連錢包、未入金、未提交任何表單、未執行任何鏈上交易。
> VaultDraw 側為**逐檔讀碼**，行號是 2026-09-06 當下工作樹（`main`，commit `59cb838`）。
>
> 這一輪**沒有動任何程式碼**，只有這份文件。
>
> 體例沿用 [cardbase-comparison.md](cardbase-comparison.md)。**那一份不重複，這一份也不重做它。**

---

## 怎麼讀這份文件

**每一條都標了它的證據等級**：

| 記號 | 意思 |
|---|---|
| **讀碼** | 直接讀 VaultDraw 的程式碼確認的（附絕對路徑與行號） |
| **一手** | 我自己打開對方的頁面／文件／JS bundle 看到的，附網址與日期 |
| **業者宣稱** | Renaiss／VinciWorld 自己說的（官網、docs、新聞稿）。**沒有第三方查證** |
| **二手可信** | 第三方報導，來源具名 |
| **推論** | 只做了推理，沒有實跑。**看到這個記號就代表我可能錯** |
| **查不到** | 找過，沒有。單獨列在第六節 |

**一個先講清楚的界線**：這一輪我**沒有**入金、沒有抽任何一包、沒有連錢包。
所以凡是「實際抽起來如何」「錢真的收得到嗎」這類問題，這份文件一律沒有答案，
不要把它讀成實測報告。

---

## 零、先講六句結論

### 一、`vinciworld.xyz` 現在還沒開。它是一個候補名單頁。

抓下來的首頁 HTML 只有一句 `Loading...`，全部內容在 JS 裡。
把 39 支 chunk 抓下來讀字串，整個站目前只有這些對外文案（一手，2026-09-06）：

> `"Enter your email or X handle and we'll let you know when Vinci World is ready."`
> `"Join the waitlist"`　`"You're on the list!"`
> `"Thanks for joining the Vinci World waitlist. We'll reach out when it's your turn to play."`
> `"Meanwhile, explore what we're building at Renaiss."`

**「像素世界、蓋房子、獵鑑定卡、展示收藏」那句話只存在於 `<meta name="description">`**
（一手，`vinci_index.html` 的 meta 標籤），**不是一個我看得到在跑的產品**。
JS 裡搜 `gacha` / `buyback` / `marketplace` / `redeem` / `leaderboard` / `furniture`
**全部零命中** —— 目前打包進去的只有登入（SIWE 錢包簽名 ＋ Privy ＋ Reown/WalletConnect）
與候補表單。

**所以：不要照著它的功能清單做任何決策。那份清單是行銷文案，不是產品。**

### 二、它不是獨立的一家，是 Renaiss 的門面。真正要研究的對象是 Renaiss。

JS bundle 裡的 AppKit metadata 原字（一手）：

```
metadata:{name:"Vinci World", description:"Incubated by Renaiss", ...}
```

同一支 chunk 裡還有 `IRenaissSBT` 合約 ABI、一個標題叫 `"Renaiss Verse"` 的 iframe、
以及登入流程的兩句提示：`"Finish your wallet upgrade on Renaiss first."`、
`"Upgrade your Renaiss wallet"`；服務條款連的是 `https://renaiss.xyz/terms`。
環境變數名甚至有 `NEXT_PUBLIC_VINCI_WORLD_BASE_URL`、`NEXT_PUBLIC_BNB_RPC_URL`。

**VinciWorld 是 Renaiss 的遊戲化前端，帳號、錢包、條款、資產全部在 Renaiss 那一邊。**
下面第一節講的都是 Renaiss。

### 三、Renaiss 的核心經濟設計，**兩條紅線各踩一條，而且是正面踩**。

| 紅線 | Renaiss 做了什麼 | 證據 |
|---|---|---|
| **1. 點數不可換回現金**（刑法 266 對價關係） | 全站以 **BNB 鏈上的 USDT** 計價與結算，入金是把 USDT 轉進站內地址，抽到的卡是 ERC-721，可在二級市場賣掉換回 USDT，USDT 出金到交易所就是新台幣 | docs：`"The system uses USDT"`（一手，[docs.renaiss.xyz](https://docs.renaiss.xyz/index.md)）；中文教學：「支持幣種：BNB 鏈版本的 USDT…點選 Top Up 獲取地址」（二手可信，[grenade.tw](https://grenade.tw/blog/renaiss-tcg-rwa-tutorial/)） |
| **2. 平台不可買回自己送出的獎品**（電子遊戲場業管理條例 §14-II-2） | 每一台 gacha 機的商品頁上都印著 **`Instant buyback 85%`**，SDK 有 `listGachaBuybackOffers()` / `buybackGacha()`，**結算幣別是 USDT** | 一手，[/gacha/pandora-28](https://www.renaiss.xyz/gacha/pandora-28)、[/gacha/pandora-48](https://www.renaiss.xyz/gacha/pandora-48)、[docs typescript-sdk](https://docs.renaiss.xyz/typescript-sdk.md) |

**第二條特別要看。** `docs/HANDOFF.md:25` 記著一件事：

> 「我曾經建議過 70% 回購當行銷賣點，查證後發現違法並收回」

**Renaiss 做的正是那件被收回的事，只是數字是 85%。**
它做得到，是因為它的法律主體是 **Renaiss Network Limited，英屬維京群島**
（一手，[/privacy](https://www.renaiss.xyz/privacy)：`Craigmuir Chambers, Road Town, Tortola`），
條款準據法是 BVI 法。**VaultDraw 的主體在台灣。這不是「他們比較敢」，是不同法域。**

### 四、它的「EV 高於售價」是毛的，扣掉自己的買回率之後是 92%。

四台機器的標示（一手，[/gacha](https://www.renaiss.xyz/gacha)，2026-09-06）：

| 機台 | 售價 | 標示 EV | 毛 EV／售價 | **× 85% 買回後** |
|---|---|---|---|---|
| PANDORA 28 | $28 | $30.59 | 109.3% | **92.9%** |
| PANDORA 48 | $48 | $51.82 | 108.0% | **91.8%** |
| PANDORA 88 | $88 | $96.28 | 109.4% | **93.0%** |
| PANDORA 248 | $248 | ~$271 | ~109% | **~92.9%** |

〔推論，算術我自己做的〕**玩家如果抽完就立刻變現，四台機器一致落在 92–93%。**
還沒扣二級市場 2% 手續費（一手，[/terms](https://www.renaiss.xyz/terms)：
`"2% of the Platform Valuation or sale amount"`）與 gas。
第三方也有同樣觀察：「大多數平台宣傳期望值高於包價，但扣掉 85–90% 的買回折扣與市場手續費之後，平均是虧的」
（二手可信，Zeneca / RipIndex 一系）。

**對照 VaultDraw**（讀碼）：`src/shared/economics.ts:63` 算的**保底回饋率**
＝ `Σ(賣家宣告買回價 × 數量) ÷ 票收`。分子是**賣家有義務付出去的錢**，
上界 100% 直接擋（印鈔）、下界 25% 也擋（`:48-50` `FLOOR_MINT=100 / FLOOR_THIN=90 / FLOOR_PREDATORY=25`、
`:129-132` `floorAllowed()`）。**VaultDraw 對外揭露的那個數字，本身就是淨的、是承諾、而且被護欄夾住。**
這一項 VaultDraw 現在就做得比 Renaiss 好，**不要往 EV 那個方向退**。

### 五、它的 "Provably Fair" 只證明了一半，而那一半正好是 VaultDraw 也有的那一半。

Renaiss 商品頁原字（一手）：

> `"Provably fair odds, verified by Renaiss Fair"`
> Merkle root ＝ `"A fingerprint of this pack's card pool, published on-chain before the drop."`
> 首頁：`"Merkle proofs and zero-knowledge validation anchor card provenance, while every result is provably random and verifiable on-chain."`

**Merkle root 證明的是「池裡有哪些卡、開賣前就鎖死」—— 那是獎品清單的承諾，不是抽選的承諾。**
它跟 VaultDraw 的 `manifest_hash` 是同一件事
（讀碼：`src/shared/fairness.ts:129-148` `manifestString`，v4 含 `grader/grade/certNo/refPrice/buyback/variantId`）。

**另一半 —— 「provably random」的隨機數從哪來 —— 我查不到任何機制描述。**

- `docs.renaiss.xyz/contracts.md` 列出五組合約（一手）：`TokenVendingMachineV3`、
  `CollectibleInventory`、`RenaissRegistry`、`OrderBook`、`TimelockController`。
  **沒有任何一個跟 VRF、randomness、fairness、merkle 有關的合約。**
- 沒有 seed、沒有 commit、沒有 reveal、沒有 VRF 供應商具名、**找不到給玩家自己重算的驗算頁**。

**對照 VaultDraw**（讀碼，這一段是它真正的護城河）：

| 環節 | 位置 | 做了什麼 |
|---|---|---|
| server seed | `server/src/pools-service.ts:159` | `randomBytes(32)`，`:162` `assertSeedEntropy()` 擋低熵種子 |
| commit | `src/shared/fairness.ts:163-170` | `SHA256(server_seed ‖ manifest_hash)`，**開賣前公開** |
| client seed | `server/src/pools-service.ts:79,93` | **drand 的未來輪次**（`FUTURE_ROUNDS = 4`，約兩分鐘後），開池當下那個數字還不存在 |
| 籤序 | `src/shared/fairness.ts:223-239` | `HMAC-SHA256` 亂數流跑 Fisher-Yates，`:207-214` 拒絕取樣避免取餘偏差 |
| reveal | `server/src/pools-service.ts:833-838` | 售罄後 `server_seed` **才**公開；`server/src/routes/pools.ts:79` 之前一律回 `null` |
| 自己驗 | `src/shared/fairness.ts:284-320` `verifyReveal()` ＋ `src/pages/FairnessPoolPage.vue` | 在瀏覽器重算整條籤序逐位比對 |

**Renaiss 有 500 萬美元級的交易量與一句 "provably random"；VaultDraw 有零個真實賣家與一整套可重算的證明。**
這是這份文件最重要的一句話，第四節 A-1 就是從這裡長出來的。

### 六、它已經站在台灣了 —— 而且就在昨天，就在三創。

- **2026-09-05，FLAGSHIP Card Show Taiwan，台北三創 CLAPPER STUDIO。
  主辦是 Renaiss Protocol，OKX Wallet 協辦，30+ TCG 攤位。**
  （一手，[luma.com/b7qjo1ko](https://luma.com/b7qjo1ko?locale=zh-TW)：
  `"Renaiss Protocol"` 主辦、`"OKX Wallet"` 聯合主辦、`5 September 2026`、`CLAPPER STUDIO, SYNTREND`）
- **VinciWorld 是那場的冠名贊助**，跟 Renaiss 一起做「遊戲化收藏體驗」（二手可信，搜尋結果轉述的 gnn.gamer.com.tw 報導；**原文 403 抓不到，這一條沒有一手**）。
- 更早：**2026-02-28 台北社群交流會，含 Alpha 實體卡兌換**（二手可信，[luma.com/k7pbzrm6](https://luma.com/k7pbzrm6?locale=zh-TW)）。
  BETA 2.0 的兌換路線圖點名了「香港、台灣、馬來西亞」的線下聚會（業者宣稱）。

**⚠️ 這跟 CardBase 那份的結論六是同一場展。**
[cardbase-comparison.md](cardbase-comparison.md) 記著 CardBase 去了「台北三創 Flagship Card Show T02 攤位」——
**那場展的主辦方就是 Renaiss。** 兩個競品在同一場活動裡，一個是攤位、一個是主辦。

〔推論〕**台灣的鑑定卡社群現在是 Web3 資金正在買的通路。**
這件事對 VaultDraw 的意義**不是**「該不該上鏈」（不該，見第四節 D），
而是**它會怎麼改變使用者對「線上抽卡」的預設印象** —— 玩家可能開始預期
「抽到不喜歡的可以馬上按一顆鈕換回錢」。VaultDraw 給不了那顆鈕，**而且不該給**。
所以要準備的是**說法**，不是功能。

---

## 一、VinciWorld／Renaiss 是什麼（查證）

### 1.1 一段話講完

> **Renaiss 是一家英屬維京群島註冊的公司，在 BNB 鏈上把 PSA 鑑定過的實體寶可夢卡
> 代幣化成 ERC-721，用 USDT 賣「gacha 抽包」，抽到的卡可以立刻按 85% 賣回給平台、
> 可以在站內二級市場掛賣（平台抽 2%）、也可以申請贖回實體卡；
> VinciWorld 是它孵化的像素風遊戲化前端，目前還在候補名單階段。**

### 1.2 它到底賣什麼、收入怎麼來

| 收入來源 | 證據 | 等級 |
|---|---|---|
| **抽包本身的差額** | 標示 EV 約售價的 108–109%，但只提供 85% 即時買回 → 立刻變現的淨值 ~92%（見結論四） | 一手＋我自己算的〔推論〕 |
| **二級市場手續費 2%** | `"2% of the Platform Valuation or sale amount"` | 一手，[/terms](https://www.renaiss.xyz/terms) |
| 未來：借貸 / 抵押 | 官網側欄 `Lending`／`Borrowing` 標 `coming soon` | 一手 |
| 未來：保管費 | 條款：目前無經常性保管費，`"may be introduced in the future"` | 一手 |
| **不是**代幣發行 | `"截至目前 Renaiss 沒有發行原生代幣"` | 二手可信，[grenade.tw](https://grenade.tw/blog/renaiss-tcg-rwa-tutorial/)；創投報導亦稱無代幣 |

### 1.3 抽選機制

- **形狀**：`Infinite Gacha`（無限池）四台常駐 —— PANDORA 28 / 48 / 88 / 248；
  另有 `Limited Gacha`（限量檔期），2026-09-06 當下 `"No limited drop is running right now."`（一手）
- **每包一張卡**（`"1 Card"`）
- **機率公開**，四層 Tier ＋ 價值區間 ＋ 百分比。PANDORA 48 為例（一手）：
  `Tier S $250–$1,500+ <1%`／`Tier A $100–$250 2%`／`Tier B $60–$100 13%`／`Tier C $25–$60 85%`
- **沒有保底／天井**（一手，`/gacha` 與商品頁都查不到任何 pity 描述）
- **籤位不是玩家自選** —— 無限池沒有籤位這個概念

**「無限池」跟 commit-reveal 在數學上是不相容的**〔推論，但我對這一條有信心〕：
VaultDraw 的可驗算性建立在「**固定總籤數的一個排列**」上
（讀碼：`src/shared/fairness.ts:223-239` `seatSequence()` 把獎品按數量展開成陣列再洗牌，
`server/src/pools-service.ts:194` 開池時一次算完整條籤序寫進 `pool_seats`）。
**沒有「全部」，就沒有「排列」，也就沒有「事後公開種子重算整條序列」這件事可做。**
Renaiss 換成無限池（Gacha V2，二手可信，[GlobeNewswire 2026-02-11](https://www.globenewswire.com/news-release/2026/02/11/3236786/0/en/renaiss-completes-gacha-v2-beta-records-over-700-000-in-single-day-trading-volume.html)：
`"infinite pool"`）之後，它能證明的就只剩 Merkle root 那一半了。**這是設計取捨，不是它偷懶。**

### 1.4 錢怎麼進、怎麼出

```
交易所買 USDT(BSC)  →  Top Up 轉進站內地址  →  抽包 / 買卡
                                                    ↓
                            ┌───────────────────────┼──────────────────┐
                            ↓                       ↓                  ↓
                     85% 即時買回              二級市場掛賣        贖回實體卡
                     （USDT，平台出）        （USDT，平台抽 2%）    （自付運費）
                            └───────────┬───────────┘
                                        ↓
                              USDT 提回自己的錢包 → 交易所 → 法幣
```

（一手：docs 的 `USDT`／`buybackGacha()`／`Permit2 USDT approvals`；
二手可信：grenade.tw 的 Top Up 流程說明。**「提回自己錢包」那一步我沒有實測**，
但 ERC-721／USDT 在自託管錢包裡本來就可轉出，這是鏈的性質不是平台的功能。）

**這條線的每一段對 VaultDraw 都是禁區。** 見第四節 D。

### 1.5 規模（查得到的都寫，而且它們對不上）

| 時點 | 數字 | 來源 | 等級 |
|---|---|---|---|
| 2025-11 | 測試網上線 | 創投新聞稿 | 業者宣稱 |
| 2025-12-19 | Open Beta 上線 | 同上 | 業者宣稱 |
| 2026-02-11 | 單日交易量 **$700,000**；累計 **$3M**；註冊用戶 **160,000+**；beta 期間抽出 **7,117 張** PSA 卡 | [GlobeNewswire](https://www.globenewswire.com/news-release/2026/02/11/3236786/0/en/renaiss-completes-gacha-v2-beta-records-over-700-000-in-single-day-trading-volume.html) | 業者新聞稿 |
| BETA 2.0 前後 | 用戶 **220,000+**；交易量 **$4M** | Phemex 轉載 | 業者宣稱 |
| 募資公告 | **$1.5M** 種子輪，YZi Labs 領投，Gate Ventures／Hash Global／Redline Labs 跟投；自稱**「營收約 $20M」、用戶 260,000+** | [The Block 新聞稿](https://www.theblock.co/press-releases/405252/)／[CryptoBriefing](https://cryptobriefing.com/renaiss-funding-round-yzi-labs/) | 業者宣稱 |

**⚠️ 這幾組數字彼此對不上。** 「累計交易量 $3–4M」跟「營收 $20M」不可能同時為真
（營收不會是交易量的五倍）。〔推論〕比較可能的解釋是各篇在講不同的量
（GMV vs 抽包銷售額 vs 累計流水），但**沒有一篇定義過口徑**。
**引用這些數字時要連同這句一起引，不要單挑一個數字當事實。**

### 1.6 它的信任機制不是身分驗證

- **主體**：Renaiss Network Limited（BVI），準據法 BVI（一手，/terms、/privacy）
- **實體卡不由它保管**：條款原字 `"Assets are stored by third-party Vault providers"`、
  `"We do not provide custody or security services for Assets"`（一手，/terms）
- **KYC**：只寫「依適用法律所需範圍收集 verification information」，**沒有具體流程**（一手，/privacy）
- **年齡**：只寫「非針對兒童」，**沒有任何年齡驗證機制**（一手，/privacy）
- **免責**：`"You agree you will not use the Platform for investment purposes."`、
  `"We make no promises regarding value, liquidity, or future functionality"`（一手，/terms）

**⚠️ 一處自相矛盾（一手）**：/terms 裡讀不到任何買回方案，
而商品頁與 SDK 都有 `Instant buyback 85%` 並以 USDT 結算。
**產品在做的事沒有寫進條款。** 這對使用者是風險，對我們是提醒：
**買回這種承諾必須寫進具約束力的地方。**（VaultDraw 是寫進 commit 雜湊裡，見第二節。）

---

## 二、VaultDraw 現況（讀碼）

只寫這一輪對照真的用到的部分。全景在 [HANDOFF.md](HANDOFF.md)。

### 2.1 點數是封閉的，而且是結構性封閉

- `points_ledger` 定義在 `server/migrations/001_init.sql:16-30`（`002_core.sql:20-23` 把 `order_id` 改名 `ref_id`）。
- 錢包**沒有 balance 欄位**，餘額是 `SUM(points_ledger.delta)` 推導出來的
  （`server/src/money.ts:33-69` `walletOf()`）；寫帳唯一入口 `credit()`（`:101-109`），
  靠唯一索引 `on conflict do nothing` 擋重複。
- **錢包 API 只有 GET，沒有任何寫入端點**（`server/src/routes/wallet.ts:10-17`）。
- **全 repo 搜 `withdraw` / `payout` / `cashout` / `提領` / `stripe`，`server/src` 零命中。**
  命中的只有兩處前端文案 —— `src/pages/LandingPage.vue:539`、`src/pages/MarketPage.vue:801`，
  兩句都是「不可提領現金或轉讓」。
- 點數發行來源只有四種 reason（`server/src/monitor.ts:80`）：
  `topup` / `seed` / `admin-grant` / `line-signup-bonus`，**其中真的有程式在寫的只有 `admin-grant`**
  （`server/src/routes/admin.ts:61-70`）與 seed。

**這是紅線一在程式碼裡的樣子：不是一句免責聲明，是「那條路不存在」。**

### 2.2 買回：錢從賣家出，平台不在這條路上

- `server/src/pool-settlement.ts:411` `credit(tx, s.sellerId, -points, 'pool-recycle-out', s.id)`
- `server/src/pool-settlement.ts:415` `credit(tx, s.ownerId, points, 'pool-recycle-in', s.id)`

**只有賣家與卡主兩個帳戶，平台帳戶不參與。** 錢從該池的保留額出，
賣家付不出來就整筆 rollback（`:396-405` `SELLER_UNFUNDED`，刻意 throw）。
規則演進三版寫在 `server/src/shared/recycle.ts:5-24`（**第一版就是「平台付」，已被推翻**）。

平台帳戶（`server/src/orders-service.ts:14` `PLATFORM_ID = 'u-platform'`）
唯一會進錢的路徑是市場保證金沒收（`:89-90`），**與買回無關**。

**這是紅線二在程式碼裡的樣子。**

### 2.3 買回價是綁進承諾的債，不是平台的估價

- 買回價進 manifest v3（`src/shared/fairness.ts:69-76`），開賣後改了雜湊就對不上。
- 建池時缺買回價**不給 commit**（`server/src/pools-service.ts:140`）。
- UI 也守住了：`src/components/PrizeTable.vue:6` 註解「抽完才知道能買回多少就是釣魚」；
  `src/pages/MyCardsPage.vue:1275` 註解「文案刻意不寫『回收 +N 點』：那句話讀起來像平台保證收購」；
  `:1504` 對使用者的字是「**賣家**在開賣前宣告、之後改不了的買回價」。

### 2.4 機率揭露已經做了，而且比 Renaiss 細

- `src/lib/pool-odds.ts:10` 註解直接點名「公平會處理原則裡『機會中獎商品的機率』那條」。
- `:70-72` 同時給 `1 / N` 與百分比 —— `"1 / 40　(2.5%)"`。
- `src/pages/pool/PoolPrizes.vue:59` 標題是「**現在**抽中的機率」，`:71` 明說
  「機率會隨著銷售改變 —— 不是一個固定的中獎率」；`:46` 註解：開賣前與開獎後都不顯示。

**定量池的即時機率是衍生量，比 Renaiss 無限池的固定 Tier% 資訊量更大。**

### 2.5 沒有的東西（讀碼確認，不要在這份文件裡發明）

| 項目 | 狀態 |
|---|---|
| **任何 web3 痕跡** | `web3`／`ethers`／`solana`／`nft`／`metamask`／`onchain` 在 `src/` 與 `server/src/` **零命中**。「wallet」一律指站內點數錢包 |
| **儲值** | `src/pages/TopupPage.vue:18` 直接 `return`，註解「金流還沒接，點數由平台發放」；後端**沒有任何 topup/payment/callback 端點** |
| **gamification** | 排行榜／徽章／成就／等級／任務**全部沒有實作**。`streak` 只是 `RevealBuildup.vue` 的視覺特效；「排行榜」只出現在 `src/shared/pool-settlement.ts:74` 一句註解裡 |
| **保底／天井** | 沒有 |
| **送鑑定（submit for grading）** | 沒有。`grader`/`grade`/`certNo` 只是資料欄位（`server/src/shared/domain.ts:21-23`），PSA 查證整組移除（`server/migrations/029_remove_psa_cache.sql:1-3`） |
| **平台代管實體卡** | 沒有，且是明文決定（`server/migrations/039_stash_expiry_semantics.sql:14-16`、`021_inventory_first.sql:57,132-138`） |
| **平台抽成** | `src/shared/pool-settlement.ts:30` `PLATFORM_FEE_RATE = 0`，`splitTicket()` 的 `if (fee > 0)` 永不成立 |
| **市場手續費** | 成交只有兩筆對沖分錄（`server/src/orders-service.ts:82-84`），**沒有抽成這條分錄** |

### 2.6 有的東西裡，這一輪要用到的兩個

- **公開卡冊**：`src/pages/MyCardsPage.vue:810-850`（分享開關＋slug）、
  `src/pages/PublicCardbookPage.vue`（`/u/:slug`，`src/router/index.ts:223`，刻意不掛 `requiresAuth`）、
  收藏總值由後端算（`server/src/routes/prizes.ts:347-387`）。
- **驗算頁**：`src/pages/FairnessPoolPage.vue`、`FairnessPage.vue`、`src/pages/pool/PoolProof.vue`，
  路由 `src/router/index.ts:89,156-165`。
  **⚠️ 但 `src/lib/config.ts:30` `export const FAIRNESS_UI = false` —— 站內入口全關。**

---

## 三、功能對照表

「部分有」一律寫清楚差在哪，不寫「類似」。**🚩 標記踩到 VaultDraw 紅線的項目。**

| 項目 | Renaiss／VinciWorld | VaultDraw | 差在哪 |
|---|---|---|---|
| **核心賣點** | 把實體鑑定卡代幣化，做成有流動性的鏈上資產 | **抽選**（可重算的 commit-reveal） | **不是同一門生意，而且法域不同** |
| 法律主體 | Renaiss Network Limited（**BVI**），準據法 BVI | 台灣 | **這一行決定了下面每一行怎麼讀** |
| 產品狀態 | Renaiss open beta；**VinciWorld 還在候補名單** | 開發中，尚無金流 | 兩邊都還沒真正開張 |
| **計價單位** | 🚩 **USDT（BNB 鏈）** | 點數，1 元＝1 點，站內用 | — |
| **能不能換回現金** | 🚩 **能。** 賣卡得 USDT → 自託管錢包 → 交易所 | **不能，而且沒有那條程式路徑**（`server/src/routes/wallet.ts` 只有 GET） | **紅線一** |
| **平台買回自己的獎品** | 🚩 **會。`Instant buyback 85%`，USDT 結算，平台出錢** | **不會。**`pool-settlement.ts:411,415` 只有賣家↔卡主兩個帳戶 | **紅線二** |
| 買回價誰定 | 平台，按它自己的估值 × 85% | **賣家開賣前宣告的絕對金額**，寫進 commit 改不了 | 一個是平台的政策，一個是賣家的債 |
| 印鈔護欄 | 85% < 100% 就是全部的護欄，但分子是平台自己估的 | `economics.ts:48-50,129-132` 上界 100% 擋、下界 25% 擋 | VaultDraw 的護欄夾住的是**別人的**承諾 |
| 對外揭露的比率 | `Expected value EV`（**毛的**，~109%） | **保底回饋率**（**淨的**，`economics.ts:63`） | 見結論四。**VaultDraw 這一項比較誠實** |
| **池的形狀** | 無限池（Gacha V2）＋限量檔期 | 固定籤數，玩家**自選籤位**（`pools-service.ts:221-227`） | 無限池換掉了「可重算整條籤序」的可能 |
| 隨機性來源 | **查不到。** 合約清單無 VRF/randomness 合約 | **drand 未來輪次**（`pools-service.ts:79,93`，`FUTURE_ROUNDS = 4`） | **這是最大的差距，方向對 VaultDraw 有利** |
| 獎品清單承諾 | ✅ Merkle root，開賣前上鏈 | ✅ `manifest_hash`，v4 含 variantId／buyback（`fairness.ts:129-148`） | **這一半兩邊等價** |
| 事後自己重算 | ❌ 找不到驗算頁 | ✅ `verifyReveal()`＋`FairnessPoolPage.vue`……**但 `config.ts:30` 把入口關了** | 見第四節 A-1 |
| 機率揭露 | ✅ 四層 Tier ＋ % ＋ 價值區間 | ✅ **即時機率**，同時給 `1/N` 與 %（`pool-odds.ts:70-72`） | VaultDraw 資訊量較大 |
| 保底／天井 | ❌ | ❌ | 兩邊都沒有 |
| 二級市場 | ✅ USDT 撮合，**平台抽 2%** | ✅ **點數託管**：貨款凍結、保證金、72h 出貨、7 天驗收（`src/shared/escrow.ts:20-38`），**0%** | 一個抽成、一個不抽 |
| 借貸／抵押 | `coming soon` | ❌ | 🚩 見第四節 D-5 |
| 代幣／積分／空投 | 無原生代幣；有**點數＋SBT**與空投預期 | 只有點數 | 🚩 見第四節 D-6 |
| 實體卡保管 | 第三方 Vault，**平台明文免責** | **平台不代管**，卡在賣家手上（`migrations/021:57,132-138`） | 兩邊都不自己保管，但責任歸屬寫法不同 |
| 出貨／贖回 | 有 `Redemption`，**費用與流程查不到** | 72h 出貨、7 天鑑賞、逾期退點＋記違約（`escrow.ts:20-26`） | — |
| 鑑定 | PSA 已鑑定卡入庫 | 只有欄位，**PSA 查證已移除**（`migrations/029`） | 這一項 Renaiss 較強（跟 CardBase 的結論一致） |
| **gamification** | VinciWorld＝像素房子／展示收藏（**文案，未上線**）；Renaiss 有 SBT 徽章、Leaderboard `coming soon` | ❌ 完全沒有。只有公開卡冊與訓練家卡片 | 見第四節 C-1 |
| 登入 | SIWE 錢包簽名／Privy／Reown | Google OAuth ＋ LINE Login | — |
| 儲值 | 鏈上轉 USDT | **還沒接金流**（`TopupPage.vue:18`） | — |
| KYC／年齡驗證 | **都沒有具體機制** | 這一輪沒查 | 見第六節 |
| 規模 | 用戶 16–26 萬、交易量 $3–4M、募資 $1.5M（**數字彼此對不上**） | 零真實賣家（`open-issues.md` P-5） | 量級差距是真的，**但它的數字沒有一個經過第三方查核** |
| 台灣落地 | ✅ **主辦 2026-09-05 台北三創 Flagship Card Show**；2/28 台北社群會 | 目標市場就是台灣 | **同一場展，CardBase 是攤位、Renaiss 是主辦** |

---

## 四、逐項必要性判定

### 判準（不是感覺）

沿用 [cardbase-comparison.md](cardbase-comparison.md) 第四節同一套：

| 級別 | 判準 —— 一句話就能驗證的那種 |
|---|---|
| **現在就該做** | 「**程式碼裡已經存在一個功能，它的正確性依賴這件事，而這件事沒做**」。也就是：不做的話，現在對外寫出去的字是假的 |
| **上線後會需要** | 「現在不做不擋事，但**寫得出一個具體的量的門檻**，過了就會痛」。寫不出門檻的，不算這一級 |
| **可以考慮** | 「有價值，但**做完之後抽選不會變好**」。它在別條線上 |
| **不該做** | 「做了會**讓 VaultDraw 變成一個比較差的 Renaiss**」，或跟已寫下的紅線／已定案的決定衝突 |

**這一輪 A 只有兩項，D 有九項。這個比例本身就是結論** ——
Renaiss 幾乎沒有可抄的東西，因為它整套經濟設計都在紅線外面。

---

### A. 現在就該做

#### A-1　把驗算頁的入口打開（`FAIRNESS_UI = false`）

**判定依據**（讀碼）：`src/lib/config.ts:30` `export const FAIRNESS_UI = false`
——驗算頁與後端 `/reveal` 都在跑、都可用，**但站內所有入口都關著**，
只有已經知道網址的人進得去（`src/router/index.ts:89,156-165`）。

而 `docs/rules.md` 第八節對使用者是這樣寫的：

> 「每個池都有驗算頁，把種子和獎品清單餵進去重算，看籤序對不對得上。**不需要相信我們，你自己算。**」

**這句話目前在畫面上找不到入口去兌現。**

**為什麼是 VinciWorld 這一輪逼出來的：**
Renaiss 把 `Provably Fair` 放在每一台機器的商品頁上當賣點，
背後只有 Merkle root（獎品清單），**隨機性那一半查不到任何機制**（結論五）。
**VaultDraw 手上有它們沒有的那一半 —— drand 未來輪次 ＋ 公開 server seed ＋ 可重算的 `verifyReveal()` ——
然後把它藏起來。** 這不是產品排序問題，是把唯一的結構性優勢主動放棄。

**要動什麼**：`src/lib/config.ts:30` 一個布林值，加上池頁面與 `PoolProof.vue` 的入口露出。
**⚠️ 但先讀 `config.ts:14-29` 那段說明** —— 當初關掉是有理由的，
這一輪我**沒有**查證那個理由是否已經消失。**不要看到這一條就直接翻布林值。**

#### A-2　`rules.md` 第六節的釋放條件跟程式碼不一致（14 天）

**⚠️ 誠實標註：這一條不是 VinciWorld 提示的，是這一輪讀碼順手發現的。**
但它完全符合 A 級判準（對外寫出去的字是假的），漏掉更糟，所以列在這裡。

`docs/rules.md` 第六節寫賣家的錢什麼時候變可動用：

> 「賣家寄出 + 玩家確認收貨（或 7 天鑑賞期滿）」

**程式碼還有第三條路**（讀碼）：`src/shared/pool-settlement.ts:51`
`POOL_VAULT_ACCEPT_MS = 14 * 86_400_000` —— **買家一直不申請出貨的話，池的保留額 14 天自動釋放**
（`server/src/routes/prizes.ts:480-484` 對使用者的字是「寄存確認期 14 天」）。
**`rules.md` 沒有這一條上界。**

**為什麼要現在補**：Renaiss 那邊的教訓就在眼前 ——
**它的買回方案寫在商品頁上，但條款裡讀不到**（第 1.6 節）。
「產品在做的事沒有寫進具約束力的文件」是同一類問題，
而 VaultDraw 的 `rules.md` 是自己對外的規則文件。**改一份 md，不用改程式碼。**

其餘 `rules.md` 落差整理在附錄。

---

### B. 上線後會需要

#### B-1　接金流那天，「點數不可提領」要從「沒寫」升級成「寫了而且擋得住」

**門檻：第一筆真實儲值進帳的那一天。**

現在點數不能提領是因為**那條路不存在**（第 2.1 節），這比任何免責聲明都強。
但一接上金流，就會出現三件現在不存在的東西：**退款、重複扣款的補償、爭議退回**。
每一種都是「錢往回走」的路徑，也就是每一種都會被拿來當提領用。

**具體要做的**（〔推論〕，這一輪沒有設計，只標問題）：
`points_ledger` 的 reason 是唯一的閘門（`server/src/monitor.ts:80` 那份 `ISSUE` 清單）。
退款要不要開新 reason、退到點數還是退到原支付工具，
**是紅線一在工程上唯一會真正被考驗的地方**。

**已經有一半答案在 `docs/research-oripa-business-model.md` 第三節**（日本 7 家平台規約全部一致：
1 點＝1 円、預付、不可退款、不可換現金、不可轉讓、效期 ≤6 個月），
以及那一節記下的「回收所得點數**繼承原始儲值點數的到期日**」——
**這條堵的是無限展延效期，接金流時要一起做。**

#### B-2　準備好回答「為什麼你們沒有『一鍵換回錢』」

**門檻：真實使用者 > 0，或第一場實體活動。**

Renaiss 主辦的展已經在三創辦過（結論六），OKX Wallet 協辦。
〔推論〕**台灣的鑑定卡玩家很快就會把「抽到不想要的可以按一顆鈕換回 USDT」當成基準線。**

VaultDraw 給不了那顆鈕，也**不該**給。但目前對外的說法散在三個地方：
`rules.md` 第四節、`src/pages/LandingPage.vue:539`、`src/pages/MarketPage.vue:801`。

**要做的是一段話，不是一個功能**：
「你的卡可以用**賣家開賣前就承諾好的價格**賣回給他 —— 那個價格寫在雜湊裡，他改不了。
平台不買回自己送出的獎品，因為台灣明文禁止（電子遊戲場業管理條例 §14-II-2）。」
**這段話比 85% 更好賣，前提是使用者看得懂它在保護誰。**

#### B-3　年齡與未成年

**門檻：接金流的同一天。**

Renaiss 的做法（一手，/privacy）是「非針對兒童」一句話帶過，**沒有任何驗證機制**。
它在 BVI，VaultDraw 在台灣。**這一項不要參考它。**
（VaultDraw 現況這一輪沒查，列在第六節。）

---

### C. 可以考慮

#### C-1　收藏展示的遊戲化（VinciWorld 的「房子」）

**判定理由：做完之後抽選不會變好。它在別條線上。**

VinciWorld 的整個概念就是這個 —— 像素世界、蓋房子、展示收藏。
**但它還沒上線**（結論一），所以「這招有沒有用」**完全沒有證據**。

VaultDraw 已經有這條線的兩個東西（讀碼）：
公開卡冊（`src/pages/PublicCardbookPage.vue`，`/u/:slug`）與
訓練家卡片產生器（`src/pages/TrainerCardPage.vue`、`src/features/trainer-card/`）。
**先看那兩個有沒有人用**，再談要不要加房間。

⚠️ **如果真的做，有一條不能碰**：不要做「排行榜」。
Renaiss 的 Leaderboard 標 `coming soon`，而排行榜在抽卡場景裡就是
**把消費金額做成公開競賽**。這一條會直接把 §266 的「射倖」論述變難打。
〔推論，我沒有法律意見書〕**但方向上不值得冒。**

#### C-2　Builder Program／SSO／SDK

Renaiss 做了整套（`docs.renaiss.xyz` 有 TypeScript SDK、OIDC SSO、Builder Tiers），
**而 VinciWorld 就是這套的第一個用戶**。這是一個聰明的分發策略：
**自己做基礎設施，讓別人做前端**。

**但 VaultDraw 現在沒有對外 API，也沒有第二個前端要接。**
記在這裡是因為它解釋了 Renaiss 為什麼要孵化 VinciWorld，**不是因為現在該做。**

---

### D. 不該做（這一節請認真讀）

> **先確認兩條紅線我沒有轉述錯**（已核對 `docs/rules.md` 與 `docs/HANDOFF.md:24-25`）：
>
> 1. **點數絕對不能提領為現金** —— `rules.md` 第一節：「點數不能換回現金。這不是產品選擇，是法律紅線（刑法 266 條的對價關係）。」
> 2. **平台不能買回自己的獎品** —— `rules.md` 第四節：「平台買回自己送出的獎品在台灣是明文禁止的（電子遊戲場業管理條例第 14 條）」；`HANDOFF.md:25` 補上條號：**第 14 條第 2 項第 2 款**，明文禁止「買回提供給客人之獎品」。
>
> **✅ 使用者的轉述完全正確，兩條都對得上。**
>
> 下面每一項單獨看都很合理 —— 它們在 Renaiss 那邊都在跑、都有錢在流。
> **合起來就是把 VaultDraw 搬到一個它的法律主體不在的法域去營運。**

#### D-1　🚩 **踩紅線一** ❌ 代幣化（把卡做成 NFT／鏈上資產）

**這是 Renaiss 的地基，也是 VaultDraw 最不能碰的一件事。**

卡一旦是 ERC-721，它就**可轉讓、可在任何 DEX 定價、可換回穩定幣**。
「點數不能換回現金」這條防線的整個意義是**切斷站內價值與現金的對價關係**；
把獎品做成鏈上資產，等於在點數之外開了第二條、而且是**平台完全管不住**的變現通道。

**VaultDraw 現在乾淨到什麼程度**（讀碼）：`web3`／`ethers`／`solana`／`nft`／`onchain`
在 `src/` 與 `server/src/` **零命中**。**這個零不是巧合，要守住。**

#### D-2　🚩 **踩紅線二** ❌ 平台即時買回（`Instant buyback 85%`）

**這一項要看最久，因為它是 Renaiss 最有效的功能，也是我們已經拒絕過一次的那件事。**

`docs/HANDOFF.md:25` 逐字記著：

> 「我曾經建議過 70% 回購當行銷賣點，**查證後發現違法並收回**」

**Renaiss 做的就是那件事，數字是 85%。** 它做得到是因為主體在 BVI。

**除了違法之外，還有兩個結構性理由**：

1. **印鈔。** 平台掏錢買回自己送出的獎品，等於平台對「獎品值多少」有定價權
   ＋對「要付多少」有義務。這兩個湊在一起就是可以自己喊高再自己回收。
   `rules.md` 第四節已經寫過這個推理。
2. **它會蓋掉一個比較好的機制。** VaultDraw 的買回價是**賣家開賣前宣告、寫進 commit 雜湊、
   之後改不了的債**（`src/shared/fairness.ts:69-76`、`server/src/pools-service.ts:140`）。
   Renaiss 的 85% 是**平台按自己估的價、隨時可調的政策**（而且**條款裡根本沒寫**，見 1.6）。
   **VaultDraw 的版本在可驗證性上完全勝出。加一個平台買回會把它稀釋掉。**

#### D-3　🚩 **踩紅線一** ❌ 穩定幣／外幣計價與入金

跟 [cardbase-comparison.md](cardbase-comparison.md) 的 D-1（多幣別）是同一條理由，**但更嚴重**：
多幣別只是把點數重新錨定到現金的**聯想**，穩定幣是直接**打通**。

#### D-4　🚩 **踩紅線一** ❌ 二級市場以可提出的資產結算

VaultDraw 的市場已經是託管制、以點數結算、成交只有兩筆對沖分錄
（`server/src/orders-service.ts:82-84`）。**把結算幣別換成任何可以離開站內的東西，紅線一就破了。**
`MarketPage.vue:801` 那句「賣出所得為點數，不可提領現金或轉讓」是這條線的宣告，**它現在是真的**。

#### D-5　🚩 **可能踩紅線一** ❌ 借貸／抵押卡片（Renaiss 的 `Lending` / `Borrowing`）

**抵押品換現金就是變現。** 玩家把抽到的卡抵押出去拿到 USDT，
跟賣掉換 USDT 在資金流上沒有差別，只是多一層。

〔推論，**我沒有查證台灣的具體條文**〕另外還會碰到當舖業／融資性租賃／重利那一圈的管制，
**這超出我這一輪的能力範圍**。**但方向已經足夠清楚：不做。**

#### D-6　❌ 積分／SBT／空投預期（**這一項不是紅線，是產品理由**）

Renaiss 有一整套：連結 X／Discord 得徽章、入金滿 $60 解鎖 SBT 階級、
推薦人抽 1% 佣金、發過 $5,000–$15,000 的實體卡空投
（二手可信，[airdrops.io](https://airdrops.io/renaiss-protocol/)）。
中文教學的提醒很誠實：「目前沒有原生代幣，**點數與 SBT 價值未獲保證**」。

**SBT 不可轉讓，所以它本身不直接踩紅線一。** 不該做的理由是別的：

1. **它把使用者的動機從「我想要這張卡」換成「我在賺未來的空投」。**
   一個賣鑑定卡的平台，最不該做的就是讓人為了投機而抽卡 ——
   **那正好是 §266「射倖」論述最怕看到的畫面。**
2. **它需要一個「未來的錢」來兌現，而 VaultDraw 沒有代幣也不該有。**
   沒有那個未來，積分就只是一個要維護的假承諾。
3. **VaultDraw 已經有一個更好的忠誠度資產：卡冊。** 卡是真的、是自己的、可以公開分享
   （`src/pages/PublicCardbookPage.vue`）。**不要在真資產旁邊擺一個假資產。**

#### D-7　❌ 把「期望值（EV）」當賣點

Renaiss 每台機器都印 `Expected value EV $51.82`，**而那是毛的**（結論四）。

**三個不做的理由**：

1. **它會誤導。** 玩家看到 108% 會讀成「平均賺 8%」，實際立刻變現是 92%。
2. **VaultDraw 已經有更誠實的數字。** 保底回饋率（`src/shared/economics.ts:63,139`）
   的分子是**賣家有義務付的錢**，是淨的，而且被上下界夾住。
3. **講 EV 等於把抽卡框成投資。** Renaiss 自己的條款要使用者同意
   `"You will not use the Platform for investment purposes."` ——
   **它一邊印 EV 一邊要你簽這句。不要學這個。**

#### D-8　❌ 無限池（Infinite Gacha）

**這不是法律問題，是機制問題，而且是這份文件裡技術上最硬的一條。**

VaultDraw 的可驗算性建立在「固定總籤數的一個排列」上
（`src/shared/fairness.ts:223-239`、`server/src/pools-service.ts:194` 開池時一次寫完整條籤序）。
**沒有「全部」就沒有「排列」，也就沒有事後公開種子重算整條序列這回事。**

Renaiss 從 V1 的限量包改成 V2 無限池之後，它剩下能證明的就只有 Merkle root
（池的組成），**抽選那一半只剩一句宣稱**。

**做無限池 = 主動放棄 VaultDraw 唯一沒有競品的東西。**

#### D-9　❌ 照抄它的合規姿態（BVI 主體、無 KYC、無年齡驗證、條款與產品不一致）

- 主體在 BVI、準據法 BVI（一手，/terms）
- 條款裡**讀不到買回方案**，商品頁上卻印著 85%（一手，第 1.6 節）
- 年齡只有一句「非針對兒童」，**沒有機制**（一手，/privacy）
- 免責寫到 `"We make no promises regarding value, liquidity, or future functionality"`

**它同時在台北辦實體展、做實體卡兌換。**〔推論〕這套組合對台灣使用者的保護是薄的。
**VaultDraw 已經選了另一條路 —— 平台自己扛（託管、保證金、爭議裁決、違約累積）。**
[cardbase-comparison.md](cardbase-comparison.md) D-3 講過同一件事：混兩套會讓「出事了誰負責」變模糊。

---

## 五、如果要做，由淺到深的順序

1. **A-2**：改 `docs/rules.md` 第六節，補上 14 天上界。**一份 md，不動程式碼。**
2. **B-2**：把「為什麼沒有一鍵換回錢」寫成一段對外的話。**也是文字，不是功能。**
3. **A-1**：**先讀 `src/lib/config.ts:14-29` 當初關掉的理由**，確認它是否已消失；
   確認後才翻 `:30` 的布林值並補入口。
4. **B-1**：接金流之前，把退款／補償的 ledger reason 設計定案（含日本那條「回收點數繼承原到期日」）。
5. **B-3**：年齡與未成年（跟 B-1 同一天）。
6. C-1 / C-2：**先看公開卡冊與訓練家卡有沒有人用**，再談。

---

## 六、我查不到的東西

**照實列，不推測成事實。**

| # | 查不到什麼 | 找過哪裡 | 為什麼重要 |
|---|---|---|---|
| 1 | 🚨 **Renaiss 的隨機數到底怎麼產生** | 首頁、四台機器商品頁、docs 全部 7 頁、`contracts.md` 五組合約、一般搜尋 | **這是「provably random」的全部內容。** 合約清單裡沒有 VRF／randomness／fairness 合約，也找不到給玩家重算的驗算頁。在拿到機制之前，那句話只是行銷詞 —— **也正因如此，A-1 的價值才成立** |
| 2 | **VinciWorld 實際長什麼樣、什麼時候開** | vinciworld.xyz 首頁＋39 支 JS chunk 全抓下來讀字串、搜尋、Renaiss 官方管道 | 目前只有候補表單。**「像素世界蓋房子」只存在於 meta description。** 這一輪關於 VinciWorld 的一切都只能是「它宣稱要做什麼」 |
| 3 | **買回的時間窗、是否有次數上限、85% 的分母（"insured value"）誰定** | 商品頁只有 `Instant buyback 85%` 六個字；/terms **完全沒寫買回**；docs SDK 只寫 API 形狀 | 搜尋時會撈到「3 天內、85%→93% 分級、USDC」——**那是 Jupiter Gacha 的文件，不是 Renaiss 的**，不要套上去 |
| 4 | **實體卡贖回的費用與流程** | /gacha、/terms、docs、中文教學、一般搜尋 | 側欄有 `Redemption`，但費用、運費、時限、失敗怎麼辦全部沒有。這是它與 VaultDraw 出貨制度最該比的一項，**比不了** |
| 5 | **它的真實規模** | 5 篇新聞稿 / 轉載 | 用戶 16 萬 / 22 萬 / 26 萬、交易量 $3M / $4M、「營收 $20M」—— **彼此對不上，且全部是業者自述**，沒有一篇定義口徑，沒有第三方查核 |
| 6 | **VinciWorld 是不是同一家公司** | JS bundle（`"Incubated by Renaiss"`）、條款連到 renaiss.xyz、Twitter `@vinciwld` / creator `@renaissxyz` | 「孵化」不等於同一法人。**這會影響「誰對玩家負責」的判斷** |
| 7 | **9/5 那場展 VinciWorld 實際做了什麼** | luma 活動頁（**沒提 VinciWorld**）、gnn.gamer.com.tw（**403 抓不到原文**） | 「冠名贊助 ＋ 遊戲化收藏體驗」這句只有搜尋摘要，**沒有一手**。而這是「它離台灣玩家多近」最直接的證據 |
| 8 | **`@vinciwld` 的追蹤數與貼文** | X 搜尋、直接抓 x.com（**402 Payment Required**） | 沒有任何社群規模的數字 |
| 9 | **VaultDraw 自己的年齡／未成年處理現況** | 這一輪沒查 | B-3 的前置。**在查證之前不要假設有或沒有** |
| 10 | **`FAIRNESS_UI = false` 當初為什麼關** | 只確認了 `src/lib/config.ts:30` 這個值與 `:14-29` 有一段說明，**沒有讀那段說明的內容** | **A-1 的前置。這一項沒查清楚之前，A-1 不能直接動手** |
| 11 | **借貸／抵押在台灣的具體法規障礙** | 沒查 | D-5 的理由目前只到「變現路徑」這一層。**方向夠清楚，但條文層級的論述我沒有** |

---

## 附錄：`docs/rules.md` 與程式碼的其餘落差

這一輪讀碼順手比對出來的，**跟 VinciWorld 無關**，但既然查到就記下來，
免得下一輪再查一次。A-2 是其中唯一升級成「現在就該做」的一條。

| `rules.md` | 程式碼 | 落差 |
|---|---|---|
| 第一節「儲值換點數」 | `src/pages/TopupPage.vue:18`；後端無端點 | **目前完全不能自行儲值**，只有 `POST /admin/grant`（`server/src/routes/admin.ts:61-70`）手動發放 |
| 第二節「買回總額不能超過票收」 | `src/shared/economics.ts:89-92,129-132` | **漏寫下界**：保底回饋率 < 25%（predatory）也會被擋開池 |
| 第六節 賣家何時拿到錢 | `src/shared/pool-settlement.ts:51` `POOL_VAULT_ACCEPT_MS = 14d` | **→ 已升級為 A-2** |
| 第三節「留著（有寄存期限）」 | `server/migrations/039_stash_expiry_semantics.sql:29-31` | 未說明到期後果 —— 實際上**只通知**，不扣卡、不強制出貨 |
| 第二節 賞別只有 A/B/C/D | `src/types/models.ts:21` `'A'\|'B'\|'C'\|'D'\|'LAST'\|'BUST'` | 型別與後端仍有 `LAST`／`BUST`（`:15-20` 說明保留理由是 `redeemAllowed` 的安全閘）。`PrizeTable.vue:26-31` 對 `BUST` 有專門的顯示分支，**但 `rules.md` 完全沒提爆賞** |
| 第八節「每個池都有驗算頁」 | `src/lib/config.ts:30` | **→ 已升級為 A-1** |
| 第十節 平台抽成 0% | `src/shared/pool-settlement.ts:30` `PLATFORM_FEE_RATE = 0` ✓ | 一致，但未提**沒收的保證金進平台帳戶**（`server/src/orders-service.ts:89-90`）—— 那是目前唯一的平台收入分錄 |
| 第八節 drand 未來輪次 | `server/src/pools-service.ts:79` `FUTURE_ROUNDS = 4` ✓ | 一致 |
| 「還沒定案：平台不代管實體卡」 | `migrations/021:57,132-138`、`039:14-16` ✓ | 一致 |
| 「還沒定案：沒有保底／天井」 | 全 repo 無實作 ✓ | 一致 |
