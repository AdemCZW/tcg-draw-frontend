# 開卡揭曉演出：衝擊感改版的研究筆記

寫這份文件的原因：使用者的回饋是「不夠細緻、太柔和、沒有熱血感」，
並且點名了「粒子」與「Clove 的抽卡特效」。這兩個都是可以查證的東西，
所以先查再改，不憑印象寫。

---

## 一、參考對象：Clove（クローブ）オリパ

**查得到，而且確認是線上オリパ平台。** 由 Clove Base 營運，
價位帶從 500 円到三萬円以上。以下是幾份日文攻略／整理站對它「ガチャ演出」的描述。

來源：

- <https://onlineoripa.jp/clove-animation> — 〈cloveオリパのガチャ演出を集めてみた！当たり確定演出はどんな感じ？〉
- <https://toreka-cycler.com/pokeca/pcg-oripa-cl-4> — 〈【映像付き】Cloveオリパのガチャ演出まとめ！〉
- <https://oripaku.jp/clove-direction/> — 〈cloveオリパの爆アド当たり確定演出はコレ！〉
- <https://pokeca-oripa.com/cloveguide/> — 〈【最新版】cloveオンラインオリパ完全攻略ガイド〉

**注意事項（誠實揭露）：** 上面幾份都是**第三方攻略站的文字描述**，
不是 Clove 官方的技術說明，我也沒有實際跑過它的 app。
其中〈映像付き〉那篇宣稱附有影片，但抓下來的是文字轉譯，我沒有看到影像本身。
所以下面整理的是「這些站怎麼描述它」，不是「我看過它長這樣」。
使用者說的「Clove 的抽卡特效」**極可能**就是這個平台，但無法百分之百確認。

### 這些描述裡反覆出現的幾件事

1. **主演出是「光球破裂」（球体が割れる演出）。**
   破得越碎＝越接近大獎。這是整個平台的骨幹演出。
2. **稀有度用顏色階梯表示**：青 → 青＋虹框 → 金 → 虹。
   顏色本身就是資訊，玩家看到色階就知道有沒有中。
3. **確定演出（爆熱 / 激アツ）**：火球出現、烈焰翻捲、粗體字疊在上面。
   多份來源都用「パチスロを彷彿とさせる」（像柏青哥電子老虎機）形容它的強度。
4. **PSA10 專用演出**：兩顆光球**對撞**，撞出銀／金／虹三階。
5. **被淘汰掉的演出**：早期的「光線集中」演出（落選一條、中獎五條匯聚）
   已經停用，理由是**看不懂、而且結束得太快**。
6. 演出**不定期改版、追加**，且**一定帶聲音**。

### 對我們的啟示（哪些能抄、哪些不能）

| Clove 的做法 | 我們怎麼處理 |
| --- | --- |
| 光球蓄力 → 破裂 | **採用。** 這正是我們現在缺的「爆點」。我們的版本是煙先被吸進核心壓實，再炸開。 |
| 破得越碎 = 越大獎 | **採用其精神**，但綁在既有的賞別分級上（`pace` / 新增的 `intensity`），不新增資訊層。 |
| 顏色階梯 | **已經有了**（`TIER_HUE`）。維持，不改配色語彙。 |
| 爆熱＝火球＋粗體字 | **粗體字不採用。** 硬性限制是手機 UI 不放 emoji，而「爆アド」這種字卡也不是這個網站的調性（我們走的是煙霧／儀式感，不是柏青哥）。**火焰的「熱」改用色溫與爆光量表達。** |
| 兩球對撞 | **不採用。** 我們的舞台上只有一張卡，硬塞第二顆球會多出一個沒有意義的角色。 |
| 「光線集中」因為太快、看不懂而被淘汰 | **這是最有價值的一條負面教材。** 我們的向心速度線因此只在**蓄力**階段出現、而且要慢，讓人看得出它在「吸」；爆發時才反轉成放射。 |
| 一定帶聲音 | **不做。** 本專案目前整條演出無音訊，臨時加音效會在靜音手機上什麼也沒有、在沒靜音的手機上嚇到人，而且沒有音量控制的位置。列為後續。 |

---

## 二、網頁上可行的粒子與衝擊感技法

### 2-1 粒子：怎麼在手機瀏覽器上跑得動

來源：

- <https://gpfault.net/posts/webgl2-particles.txt.html> — GPU-Accelerated Particles with WebGL 2（transform feedback）
- <https://webgl2fundamentals.org/webgl/lessons/webgl-instanced-drawing.html> — WebGL2 Instanced Drawing
- <https://webglfundamentals.org/webgl/lessons/webgl-qna-efficient-particle-system-in-javascript---webgl-.html> — Efficient particle system in WebGL
- <http://www.opengl-tutorial.org/intermediate-tutorials/billboards-particles/particles-instancing/> — Billboards & Particles / Instancing
- <https://velasquezdaniel.com/blog/rendering-100k-spheres-instantianing-and-draw-calls/> — 十萬顆的 instancing 實測

三條路，成本由高到低：

1. **Transform feedback（WebGL2）** — 粒子狀態存在 GPU buffer 裡逐幀迭代。
   能做碰撞、流場、生命週期回收。代價是兩組 buffer 來回 ping-pong、
   要管 VAO 與 varyings，程式碼量最大。
2. **Instanced billboard quads** — `drawArraysInstanced`，一次 draw call 畫 N 個面片。
   每顆粒子可以有任意貼圖與旋轉。
3. **Point sprites（`gl.POINTS`）** — 一次 `drawArrays`，一個頂點一顆粒子，
   `gl_PointSize` 決定大小，`gl_PointCoord` 在 fragment shader 裡當作 UV。
   最省，但點的大小有上限、也不能旋轉。

**我們選 3，而且再省一層：粒子狀態完全不存。**
每顆粒子的方向、速度、大小、壽命全部由 `gl_VertexID` 雜湊出來，
位置在 vertex shader 裡用一條解析式（`p = dir * speed * f(t)`）直接算。
結果是：**零 buffer、零 CPU 每幀工作、一次 draw call**，
`drawArrays(POINTS, 0, N)` 而且連頂點屬性都不用綁。

為什麼夠用：這支演出的粒子是**一次性爆發**，沒有回收、沒有互動、沒有碰撞。
Transform feedback 解的是「狀態要延續」的問題，我們沒有這個問題，
付它的複雜度是白付。實測上限反而卡在 fill rate（重疊的半透明點），
不是頂點數——所以省的應該是「畫多大」而不是「算多少顆」。

拖尾（trail）的做法：不另外做線段，而是讓連續的 k 個索引屬於同一顆粒子、
只差一點點時間偏移。同一顆的 k 個影像沿軌跡排成一串，越後面越小越暗，
讀起來就是拖尾。成本是粒子數乘 k，但每一顆都還在同一次 draw call 裡。

### 2-2 衝擊感：不是把東西做亮，是把節奏做出來

來源：

- <https://arxiv.org/pdf/2208.06155> — What Features Influence Impact Feel? A Study of Impact Feedback in Action Games
- <https://arxiv.org/pdf/2011.09201> — Designing Game Feel: A Survey
- <https://salivity.github.io/game-development/article/maximizing-game-feel-in-action-game-development>
- <https://tigerabrodi.blog/juice-is-the-difference-between-a-game-that-feels-alive-and-one-that-doesn-t>
- <https://halisavakis.com/my-take-on-shaders-shockwave-effect/> — Shockwave 效果的 shader 寫法
- <https://gamedevbill.com/shockwave-shader-graph/> — Shockwave shader graph

整理出來實際採用的幾項：

| 技法 | 內容 | 我們的參數 |
| --- | --- | --- |
| **蓄力→爆發→餘韻** | 衝擊感來自對比。爆發前必須先有一段**收**（安靜、變暗、向內），否則爆發沒有基準線可比。 | 新增 `charge` 一拍 1.5 秒，煙被吸進核心、畫面壓暗、微震累積 |
| **Hit-stop（命中停頓）** | 命中瞬間凍結 40–80 ms（重擊可到 1/4 秒）。這一格不動比任何動畫都更能表達重量。 | 爆發後 55 ms 起凍 110 ms（滿強度）。衝擊層是把餵給 shader 的秒數重映射；DOM 這邊插一格 `transition: none` 的定格姿勢（放大 3.5 %、亮度 +35 %）。CSS transition 沒辦法真的暫停，所以停頓是「插進一格不動的畫」而不是「凍住動畫」 |
| **方向性螢幕震動 + 指數衰減** | 震動要沿受力方向、而且要快速收斂，不能一直抖。 | 首擺 9 px（滿強度，乘 `--int`），八個關鍵影格衰減到 0，全長 700 ms，加在 `.stage` 的 `translate` 上 |
| **衝擊波環（shockwave ring）** | 一圈能量從中心擴散。單環太乾淨，兩三環錯開才有厚度。 | 三環錯開 0 / 90 / 180 ms，半徑走 `1-e^-4.2t`（出手最快），擴張的同時變薄變糊，接近畫面外緣時淡出（不淡出會在四邊留一圈框） |
| **放射狀速度線** | 蓄力時向內（吸），爆發時向外（噴）。 | 角度切扇區（蓄力 110 格、爆發 150 格）+ 只取扇區正中一絲的高斯遮罩。**沒有那道細化，每條線就是一整片實心扇形，畫面變成風車** —— 這是實作時踩到並修掉的坑 |
| **色差（chromatic aberration）** | 重擊瞬間畫面邊緣紅／青分離。 | **近似做法**，見下方「放棄的東西」 |
| **爆光（bloom / white-out）** | 爆發那一格整個核心過曝到接近純白，其它細節全部消失。這是「看不見」在替「太亮了」說話。 | `e^-11t` 衰減，且亮度集中在核心（`0.20 + 3.4·e^-4r`）。第一版常數項給到 1.6，整片畫面連四角一起純白，那不是爆光是換頁，而且手機貼臉看會刺眼 |
| **暈影收縮（vignette punch）** | 爆發瞬間四角壓暗、視野變窄，讀起來像瞳孔縮一下。 | 與 hit-stop 同步 |

### 2-3 放棄的東西，以及理由

- **真正的全畫面色差 / bloom（post-process）。**
  正統做法是把煙層與卡片先渲染進 FBO，再拿 FBO 當貼圖做第二 pass 取樣三次（RGB 各偏移一點）。
  問題是我們的卡片是 **DOM 元素**（`<img>`，為了色彩管理、可選取、無障礙），
  不在 WebGL 裡；要做就得整段改成純 canvas 渲染，等於把 CardEmerge 重寫、
  而且會失去 DOM 那張卡的全部好處。
  **改為近似**：在衝擊波環的兩側各加一道加法式的紅／青（紅偏外、青偏內），
  再讓整個舞台在命中停頓那一格吃一次 CSS `brightness/contrast/saturate` 的推高。
  這不是真的把畫面分離，但視覺線索一樣是「高速邊緣的紅青鑲邊」，成本是零。

- **Transform feedback 粒子。** 理由見 2-1，我們沒有需要延續的狀態。

- **第二個 WebGL context 專門做後製。** 手機上兩個 context 會互相搶資源，
  而且 iOS Safari 有 context 數量上限（超過會把舊的丟掉）。
  衝擊波環、速度線、色差環全部塞進**同一個 canvas 的第一個 pass**（全螢幕三角形），
  粒子是同一個 canvas 的第二個 pass。**一個 context、兩次 draw call。**

- **重新啟用 `RevealBuildup.vue`（1228 行的光球蓄勢）。**
  使用者說時間可以拉長，所以這件事有重新考慮的價值，但結論仍然是不啟用：
  它是**另一個獨立的全螢幕演出**，播完才輪到煙霧，兩段之間沒有任何交接——
  光球消失、畫面重來一次。這正是當初把它拿掉的理由，時間變長並沒有解決它。
  **真正需要的「蓄力」是煙霧演出自己內部的一拍**，共用同一個核心光、同一團煙、
  同一個舞台，爆發之後煙直接變成卡的材料。所以蓄力做成 `charge` 這一拍，
  而不是把舊元件接回來。舊元件維持未使用。

- **音效。** 見上表。

- **改用 rAF 推進相位。** `CardEmerge` 刻意用 `setTimeout` 是因為分頁被節流時
  rAF 不推進、整段演出會凍在某一格。這個理由沒有變，維持 `setTimeout`。
  新增的粒子層有自己的 rAF 時鐘（跟 `SmokePlume` 一樣），
  分頁看不見就停、切回來從當下的進度接上——它是「畫面」不是「流程」，
  凍住不影響使用者最後看到結果。

---

## 三、節奏設計（滿強度，`pace = 1`）

| 拍 | 長度 | 在做什麼 |
| --- | --- | --- |
| `still` | 0.7 s | 黑場，只有一點微光。不要一進來就有東西。 |
| `gather` | 1.6 s | 煙從四個邊往內長，四角先接起來。 |
| `swell` | 1.1 s | 煙合攏、懸置。刻意什麼都不發生；卡片輪廓閃一次當預告。 |
| `charge` | 1.5 s | **新。** 核心把煙吸進去壓實、畫面壓暗、向心速度線、粒子被吸入、低頻震動漸強。這是爆發的基準線。 |
| `burst` | 0.9 s | **新。** hit-stop 110 ms → 白場過曝 → 三道衝擊波環 → 粒子爆散＋拖尾 → 螢幕震動指數衰減 → 紅青分離環。 |
| `form` | 2.6 s | 爆光退下，煙的殘料在卡框位置堆積、圖案分兩波顯影。 |
| `settle` | 1.6 s | 餘韻。DOM 那張卡接手、掃光掃過、殘餘粒子飄落。 |

合計 **10.0 秒**。低賞別由 `pace` 壓縮（B 賞 ×1.4、C／D ×1.9 → 約 5.3 秒），
並且新增的 `intensity` 會同步壓低粒子數、震幅、爆光量——
低賞別不只是播得快，是**真的比較小聲**。這維持了原本「演出對應真的開出來的東西」的原則。

---

## 四、實作落點

| 檔案 | 改了什麼 |
| --- | --- |
| `src/components/ImpactBurst.vue` | **新增。** 衝擊層：一個 WebGL2 context、兩個 program、兩次 draw call。pass 1 是全螢幕三角形（爆光、三道衝擊波環、紅／青分離、向心／放射速度線、暈影），pass 2 是 `gl.POINTS` 的程序式粒子（4020 個點 = 670 顆 × 6 段拖尾，零 buffer、零頂點屬性）。畫布是不透明黑底 + 純加法混色，靠 CSS `mix-blend-mode: screen` 疊回頁面。 |
| `src/components/CardEmerge.vue` | 五拍 → 七拍（插入 `charge` / `burst`）；新增 `.stage` 內層承載螢幕震動與命中停頓（**不能加在 `.emerge` 上，那裡的 transform 是結果頁的置中**）；新增 `intensity` prop；核心光在蓄力時反向收縮。 |
| `src/components/SmokePlume.vue` | 時間軸從「整段」改成「到 form 結束為止」，所有 `smoothstep` 常數對著新的七拍重算（檔頭有對照表）；新增 `squeeze`（蓄力向心壓實）與 `blast`（爆發那一下往外掀）兩條曲線。 |
| `src/pages/DrawResultPage.vue` | 新增 `emergeIntensity`（跟 `pace` 分開）；保險絲 12 s → 15 s；順手修掉跳過提示被殘留的 `translateX(-50%)` 推到畫面外的問題（實測 `left = -196.5px`）。 |
| `src/components/RevealBuildup.vue` | **沒有動，維持未使用。** 理由見上面「放棄的東西」。 |

## 五、實測（393 × 852）

在 Playwright 驅動的真實 Chrome（Apple M4，ANGLE Metal，非 SwiftShader）上跑完整段最高賞演出：

| 量測 | 數字 |
| --- | --- |
| 整段平均幀率 | **60.0 fps**（3015 幀取樣） |
| 最重的一段（charge + burst + form，3.3 s→6.9 s） | **60.0 fps**，p95 幀時間 17.2 ms，最差 17.6 ms |
| 掉到 30 fps 以下的幀數 | **0** |
| 四倍畫素的壓力測試（786 × 1704，等同 dpr = 2 手機的填色率） | 仍然 **60.0 fps**，最差幀 17.7 ms，超過 33 ms 的幀數 0 |
| 畫布實際解析度（393 × 852 舞台，dpr = 1） | 煙 422 × 528、衝擊 545 × 682 |

降級策略（兩層都有，沿用既有做法）：
- 開頭量一次幀率，低於 40 fps 就把畫布解析度砍到 0.50 倍（衝擊層）／0.34 倍（煙），
  粒子數同時砍到 45 %，煙的 fbm octave 從 4 降到 2。
- 分頁看不見就停 rAF；衝擊層演出結束後直接不再排下一幀，不留常駐的 rAF。
- 拿不到 WebGL2（或帶 `?nogl=1`）時兩層各自 emit `fail`，退回純 CSS 的煙，演出照樣走完。

跑版量測（逐元素 `getBoundingClientRect()`）：
- 結果頁：超出視窗的元素 **0 個**，`documentElement.scrollWidth === innerWidth === 393`，`body.scrollWidth === 393`。
- 演出層：舞台本來就比視窗寬（681.6 px），**左右各溢出 144.3 px，完全對稱**，由 `.emergeWrap` 的 `overflow: hidden` 對稱裁掉 —— 這正是當初那個「畫面偏右」的 bug 要確認的事。
- 跳過提示：修正後 `left = 0, right = 393`，置中。

行為驗證：
- `prefers-reduced-motion: reduce`（`emulateMedia`）：`.emergeWrap` 不存在，明細直接可見。
- 整層點擊跳過：`.emergeWrap` 立刻消失、明細顯示。
- 不跳過讓它播完（約 10 s）：同樣落到結果頁，無殘留。
- D 賞：整段約 5.3 s 播完，爆發明顯小一號（無色差環、粒子噴幅收窄）。
