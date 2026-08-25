<script setup lang="ts">
/**
 * 煙霧 —— 從畫面四個邊慢慢往內聚攏圍成一片，然後收攏成一張卡。
 *
 * 給了 image 的話，卡片是這支 shader「用煙聚出來」的，不是煙散開露出底下的卡：
 * 卡面的顏色先被攤在一大片區域上、被噪聲攪亂、彩度抽掉，再往內收回卡框。
 *
 * 跟 ShaderSky 的差別在「它站在哪一層」。星雲是背景，畫在最底下；
 * 這團煙畫在卡片「前面」，靠自己的 alpha 讓卡片露出來。
 * 揭曉靠的是煙散掉，不是卡片變亮 —— 這是煙霧揭曉跟淡入的根本差別。
 *
 * 所以這支 shader 輸出的是 vec4(色, alpha)，不是不透明畫面，
 * context 要開 premultipliedAlpha: false，否則半透明處會被當成預乘值而發黑。
 *
 * 時間軸自己跑（uProg 0→1），不從外面餵每幀的值：
 * 外層的相位是 setTimeout 推的，用 prop 傳進來每一幀都要過一次 Vue 的更新，
 * 而這裡只要一個從 performance.now() 算出來的數字。
 *
 * 效能沿用 ShaderSky 那三件事：降解析度算、分頁看不見就停、
 * 開頭量一次幀率太慢就降 octave。煙是低頻訊號，降解析度幾乎看不出來。
 *
 * ---- uProg 與外層相位的對照表 ----
 * duration 收到的是「到 form 結束為止」的長度（CardEmerge 的 SMOKE_MS），
 * 不是整段演出 —— settle 是 DOM 那張卡接手之後的餘韻，煙那時已經沒事做。
 * 下面每一個 smoothstep 的常數都是對著這張表算的：
 *
 *   uProg   相位            這裡在做什麼
 *   .000    still 起
 *   .083    gather 起       煙從四邊往內長
 *   .274    swell 起        合攏、懸置（卡片輪廓閃一次預告）
 *   .405    charge 起       煙被吸向核心、壓實、變厚
 *   .583    burst 起        炸開：往外掀 + 開始消散
 *   .690    form 起         殘料在卡框堆積 → 圖案顯影
 *  1.000    form 結束       圖案完成，等 DOM 接手
 *
 * 這張表是**正規時間軸**，跟外層每一拍實際幾毫秒解耦。
 * 外層的節奏會依賞別變（高賞別在 charge 與 burst 之間多插了兩拍），
 * 如果讓 uProg 直接等於「經過時間 ÷ 總長」，上面所有常數就會跟著位移，
 * 每加一拍都得回來重算一次 —— 那是一定會忘記做的事。
 * 所以改成外層傳 segments（每一組實際毫秒數對應到正規軸上哪一段），
 * 這裡做分段線性重映射。**這張表因此永遠不用改**，
 * 高賞別多出來的兩拍只是把 .405 → .583 那一段拉長，煙自然就吸得更久。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** 整段演出長度（毫秒）。煙的湧入與消散都攤在這段時間上 */
  duration?: number
  /** 煙的色調 [r,g,b]（0..1） */
  tint?: [number, number, number]
  /** 濃度倍率。1 = 完全遮住後面，調低可以讓卡片一直隱約看得到 */
  density?: number
  /** 要被煙「聚出來」的卡圖網址。給了才會做凝聚，沒給就只是一團煙 */
  image?: string | null
  /** 卡片在畫面上的半寬半高（shader 座標，以畫布高為 1）。
      凝聚完成時卡片就落在這個矩形上，DOM 那張卡要能無縫接上去 */
  cardHalf?: [number, number]
  /**
   * 分段線性時間重映射：[實際毫秒, 正規軸起點, 正規軸終點][]。
   * 見檔頭的對照表 —— 有了它，外層增刪拍子都不會動到 shader 裡的常數。
   * 不給就退回「經過時間 ÷ duration」的線性版本。
   */
  segments?: [number, number, number][] | null
  /**
   * 第一次爆的時刻（毫秒）。0 = 沒有第一次爆（低賞別）。
   * 煙在那一下要被掀一把、邊緣被照亮一次，否則第一次爆只發生在衝擊層上，
   * 煙原封不動 —— 看起來會像那一聲是疊上去的貼圖，不是這團煙裡炸出來的。
   */
  crackAt?: number
  /**
   * 第二次爆的時刻（毫秒）。0 = 沒有（低賞別）。
   * 跟 crackAt 走同一條包絡、同一個 uniform，差別只在振幅（1.65 倍）——
   * 同一個語彙、更大的規模，這是「一次比一次大」在煙這一層的說法。
   */
  surgeAt?: number
}>(), {
  duration: 4600, tint: undefined, density: 1, image: null,
  cardHalf: () => [0.232, 0.325], segments: null, crackAt: 0, surgeAt: 0
})

const emit = defineEmits<{ (e: 'fail'): void; (e: 'fps', v: number): void; (e: 'cardready'): void }>()

const canvas = ref<HTMLCanvasElement | null>(null)
let gl: WebGL2RenderingContext | null = null
let raf = 0
let program: WebGLProgram | null = null
let startTime = 0
let quality = 1
let dpr = 1

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uProg;      // 0..1 正規時間軸上的進度（見檔頭對照表）
uniform float uCrack;     // 前兩次爆的包絡 0..1.65（低賞別恆為 0）
uniform float uQuality;
uniform vec3  uTint;
uniform float uDensity;
uniform sampler2D uCard;
uniform float uHasCard;   // 卡圖貼圖就緒才是 1
uniform vec2  uCardHalf;  // 卡片最終矩形的半寬半高

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p, int oct) {
  float v = 0.0, amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    v += amp * noise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return v;
}

/* 煙的密度場。
   跟星雲用的是同一套 fbm，差別在三個地方 ——
   這三個差別就是「煙」跟「雲氣」的分野：
     1 整團有方向（flow 上升、conv 向心）：雲氣沒有方向
     2 繞中心捲，內圈角速度比外圈快：這是 curl noise 的窮人版，煙才會「翻」
     3 域扭曲的強度大很多（2.6 vs 星雲的 3.2 但取樣頻率更高）：煙的邊緣要撕裂
*/
float smokeField(vec2 p, float t, float flow, float conv, int oct) {
  /* 取樣座標往外撐，畫面上的煙就持續往中心收。
     光靠遮罩往內推的話，煙的紋理是站著不動的，只有邊界在移動 ——
     看起來像一塊布被拉開，不像煙在流動。 */
  p *= 1.0 + conv;
  p.y -= t * 0.13 * flow;                           // flow > 0 上升、< 0 下墜
  float r = length(p);
  float a = (0.62 / (r + 0.30)) * t * 0.30;         // 內圈轉得快 = 翻捲
  float cs = cos(a), sn = sin(a);
  p = mat2(cs, -sn, sn, cs) * p;

  vec2 q = vec2(fbm(p * 2.0 + vec2(0.0, t * 0.22), oct),
                fbm(p * 2.0 + vec2(3.7, -t * 0.18), oct));
  return fbm(p * 2.7 + 2.6 * q + vec2(1.3, 4.1), oct);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  /* 四層就夠。細絲交給下面獨立的高頻層去做，比在每一次 fbm 都多疊一層便宜得多 ——
     這支 shader 一個畫素要算十次 fbm，octave 加一層等於多四十次噪聲取樣。 */
  int oct = uQuality > 0.5 ? 4 : 2;

  /* 四條互相獨立的時間曲線。
     gather  聚集：煙從四個邊往內長，慢慢圍成一片
     squeeze 壓實：蓄力段被核心吸過去，體積變小密度變高
     blast   掀開：爆發那一瞬間往外推的一下（短命）
     clear   消散：整體變薄

     分開才控制得住 —— 用同一條曲線的話，煙會沿原路退回四個邊，
     看起來像倒放。煙聚攏之後是在原地散掉的，不是縮回去。 */
  float gather  = smoothstep(0.06, 0.27, uProg);  // gather 這一拍結束時煙剛好合攏
  float squeeze = smoothstep(0.41, 0.58, uProg);  // charge 這一拍：往核心收
  /* 掀開只活 0.10 個 uProg（滿速下約 0.9 秒）。
     它必須短 —— 爆震是一下，拖長就變成「煙在放大」。 */
  float blast   = smoothstep(0.583, 0.615, uProg) * (1.0 - smoothstep(0.615, 0.72, uProg));
  float clear   = smoothstep(0.585, 0.96, uProg); // 炸完就開始薄下去

  /* 很慢的鏡頭漂移。只作用在煙的取樣座標，不能動到 p ——
     p 還要拿來定位卡片，一起轉的話卡片會跟著歪。
     沒有這一層，整片煙只是在原地翻；有了之後畫面有輕微視差。 */
  float cam = uTime * 0.016;
  vec2 sp = mat2(cos(cam), -sin(cam), sin(cam), cos(cam)) * p
          * (1.0 - 0.045 * sin(uTime * 0.10));

  float zoom = mix(2.60, 1.30, smoothstep(0.0, 0.80, uProg));
  /* 取樣座標放大 = 畫面上的煙變小 = 整團往中心縮；縮小則相反。
     蓄力時往內收、爆發那一下往外掀。
     這比改遮罩自然得多：紋理本身跟著一起被壓縮／撐開，
     只動遮罩的話煙的細節站在原地不動，讀起來像一塊布被拉。 */
  /* 前兩次爆只把煙掀開一部分：uCrack 的振幅本身就是分級的
     （第一次 1.0 → 0.16，第二次 1.65 → 0.26），主爆才是 0.42。
     掀得一樣多的話三次爆看起來一樣大，後面兩次就沒有更大一級可言了。 */
  zoom *= 1.0 + squeeze * 0.55 - blast * 0.42 - uCrack * 0.16;
  float d = smokeField(sp * zoom, uTime, 0.45, gather * 0.5 + squeeze * 0.45, oct);

  /* 細絲層：更高頻、跑更快的一層疊上去。
     主場的 fbm 給的是大團的形狀，煙真正「活」的感覺來自邊緣那些細絲 ——
     只有一層的話所有結構都是同一個尺度，看久了會發現它在重複。 */
  // 這一層本來就是高頻，再往下疊的 octave 已經細過一個畫素，算了也看不到
  float fine = fbm(sp * zoom * 3.4 + vec2(uTime * 0.26, -uTime * 0.33), 2);
  d += (fine - 0.5) * 0.13;

  /* 從四個邊聚集。
     推進量用「到最近的那條邊的距離」—— 這是矩形的距離場，
     所以煙是沿著四邊同時往內長，四個角會先接起來，最後在中心闔上。
     用半徑當距離場的話就變成一個圓往內縮，那是收口不是聚集。

     邊界必須用噪聲咬出鋸齒，而且鋸齒要會動：
     不然畫面上會出現一個很明顯的圓角矩形框慢慢往內縮。 */
  vec2 ed = min(uv, 1.0 - uv);
  float edgeDist = min(ed.x, ed.y);
  /* 鋸齒要兩個尺度疊起來，而且低頻那個要夠強。
     只用單一高頻噪聲的話，前緣會是一條「有毛邊的直線」——
     畫面上讀到的仍然是一個等寬的圓角矩形框在往內縮。
     真正破掉框感的是低頻：某幾處的煙會先伸出長舌頭進來，其它地方還落在後面。 */
  float tongue = (fbm(sp * 1.5 + vec2(uTime * 0.13, uTime * -0.09), oct) - 0.5) * 0.42;
  float fray = (fbm(sp * 5.5 - vec2(uTime * 0.21, 0.0), oct) - 0.5) * 0.13;
  // 舌頭一開始就要在，只用 gather 當係數的話前 1/4 段仍然是規矩的方框
  float ragged = (tongue + fray) * smoothstep(0.0, 0.16, gather);
  float reach = mix(0.04, 0.80, gather) + ragged;
  // 推進到 reach 以內的都是煙，最外側那 0.22 是柔邊
  float band = 1.0 - smoothstep(reach - 0.22, reach, edgeDist);
  d *= clamp(band, 0.0, 1.0);

  /* 消散的方向。
     之前是「中心先破洞」—— 那是為了露出底下的卡。現在卡是煙聚出來的，
     中心正是煙要堆起來的地方，在那裡挖洞等於把要用的料挖掉。
     改成外圍先空、煙往中間收。 */
  float rc = length(p * vec2(1.0, 0.78));
  d -= clear * smoothstep(0.16, 0.78, rc) * 1.6;

  /* ---- 第一段：煙往卡的位置堆積 ----
     這一段做的是「形」，不是「圖」：煙在卡框的位置越堆越厚，
     先堆出一張煙做的卡 —— 這時候還完全沒有圖案。

     它加在門檻之前，所以這塊煙跟畫面上其它煙走同一套門檻、打光、自我陰影。
     這是它讀起來是煙而不是一個貼上去的矩形的原因。 */
  float acc = uHasCard > 0.5 ? smoothstep(0.62, 0.84, uProg) : 0.0;
  vec2 relA = p / (uCardHalf * mix(0.74, 1.0, acc));
  float sdA = max(abs(relA.x), abs(relA.y));
  // 邊界一開始很糊很不規則，隨堆積收緊成卡框。用已經算過的細絲層當亂數，不多花成本
  float ragA = (fine - 0.5) * (1.0 - acc) * 1.5;
  float softA = mix(0.95, 0.05, acc * acc);
  float slab = 1.0 - smoothstep(1.0 - softA, 1.0 + softA * 0.45, sdA + ragA);
  /* 堆上去的密度要帶著煙自己的紋理，不能是一塊均勻的高原。
     加常數的話這塊區域每個畫素一樣厚 —— 自陰影把它整片壓黑、
     邊緣光又完全不觸發，結果是一個黑色矩形，讀起來像破洞不像一團煙。 */
  d += slab * acc * 0.70 * (0.35 + 0.90 * fine);

  /* 門檻決定「多少比例的畫面算是煙」。
     fbm 的值集中在 0.5 附近，門檻設 0.4 的話有一半以上的畫素直接變全透明 ——
     煙就只剩幾縷，遮不住後面的卡。起手要遮得住，門檻必須壓在分布下緣。

     消散的門檻走平方曲線。線性的話門檻一開始就抬得很快，
     周圍的煙在還沒堆到卡上之前就掉光了。 */
  /* 蓄力時門檻壓低一點 = 同一片噪聲有更多畫素算得上是煙 = 煙看起來更濃。
     配合上面的向心收縮，讀起來就是「同樣多的煙被塞進更小的地方」。 */
  float thr = mix(0.12, 0.82, clear * clear) - squeeze * 0.045;
  float alpha = smoothstep(thr, thr + 0.30, d);
  alpha *= (1.0 - clear * clear * 0.55) * uDensity;

  /* 打光。
     光源在中心（卡片的位置），所以是背光：煙越靠近中心越亮，
     而且密度的「邊緣」最亮 —— 薄的地方光透得過去，厚的地方透不過。
     正統做法是朝光源再取樣一次密度算梯度，但那要多跑三次 fbm；
     用 alpha 的邊帶當梯度的近似，視覺幾乎一樣，成本是零。 */
  float glow = exp(-rc * 1.75);
  float rim = smoothstep(thr, thr + 0.09, d) - smoothstep(thr + 0.09, thr + 0.34, d);

  vec3 dark = vec3(0.035, 0.026, 0.062);
  vec3 col = mix(dark, uTint * 0.55, glow * 0.42);
  /* 自陰影：厚的地方擋住背後的光，所以越厚越暗。
     少了這一項，整片煙會是同一個中間調的紫 —— 看起來像紫色顏料不像煙。
     煙之所以讀得出體積，靠的就是「暗的body + 亮的邊」這個對比。 */
  col *= mix(1.0, 0.38, smoothstep(thr + 0.03, thr + 0.44, d));
  col += uTint * rim * (0.45 + 1.05 * glow);
  col += vec3(1.0, 0.93, 0.86) * rim * glow * glow * 0.8;   // 最靠近光源的邊緣接近白
  /* 第一次／第二次爆：整團煙的邊緣被照亮一下。
     打在 rim（密度的邊帶）上而不是整片加亮 —— 一團煙被閃光燈打到時，
     亮起來的是它的輪廓與薄的地方，厚的地方仍然是暗的。
     整片加亮的話它會變成一片發光的霧，體積感就沒了。 */
  /* 振幅在這裡要夾住。uCrack 到第二次爆是 1.65，直接乘進來的話
     整團煙的邊帶會一起過曝，畫面上只剩一大片白 —— 煙的體積感是靠
     「暗的 body + 亮的邊」，邊亮過頭就沒有 body 可言了。
     掀開的幅度（zoom）不夾，那是物理位移；發光的亮度夾，那是曝光。 */
  col += mix(uTint, vec3(1.0), 0.55) * rim * min(uCrack, 1.15) * 1.0;
  /* 堆在卡片位置上的那團煙被卡背後的光打亮。
     少了這一項，煙堆得越厚反而越黑，看起來像卡片的位置被挖空。 */
  col += mix(uTint, vec3(1.0), 0.30) * slab * acc * (rim * 1.15 + 0.10);

  /* ---- 第二段：圖案在堆好的煙上顯影 ----
     順序不能顛倒。之前把「聚集」跟「顯影」擠在同一段做，材料一出現就是卡的顏色，
     結果看到的是一張大卡在縮小 —— 不是煙聚成卡。
     先有形（上面的 slab），後有圖（這裡）。 */
  if (uHasCard > 0.5) {
    float img = smoothstep(0.79, 0.965, uProg);

    /* 這一段的擾動很小：料已經堆在該在的位置了，這裡只負責讓圖案浮出來。
       之前那個 2.9 倍的攤開量是「聚集」階段的工作，已經移到 slab 去做。 */
    vec2 warp = vec2(fbm(relA * 1.9 + vec2(0.0, uTime * 0.18), 2),
                     fbm(relA * 1.9 + vec2(6.3, -uTime * 0.15), 2)) - 0.5;
    vec2 q = relA + warp * (1.0 - img) * 0.62;

    /* 顯影分兩波，這是「拼湊起來」的本體。
       第一波大塊先以半強度落定，第二波在已落定的塊上補滿剩下一半。
       只有一波的話每個畫素從無到有一次到位，讀起來是「溶解進來」不是「拼起來」。

       兩波都用 q 取樣（跟著料一起走），不是用 p ——
       用 p 的話生成圖樣會釘在螢幕上，煙在動、生成邊界卻不動，馬上穿幫。 */
    float bCoarse = fbm(q * 1.5 + vec2(11.7, 4.3), oct);
    float bFine = fbm(q * 4.8 + vec2(3.1, 19.4), oct);
    /* 顯影順序帶一點方向性：由左下往右上。
       純噪聲的話落定的位置到處亂跳，看起來像雜訊在閃；
       混一點方向進去，才會讀成有人在依序把它拼完。 */
    float sweep = 0.5 + 0.42 * (q.x * 0.55 - q.y * 0.75);
    float bc = mix(bCoarse, sweep, 0.42) * 0.62;
    float bf = mix(bFine, sweep, 0.25) * 0.55 + 0.30;
    float wCoarse = smoothstep(bc, bc + 0.26, img);
    float wFine = smoothstep(bf, bf + 0.20, img);
    float formed = wCoarse * (0.55 + 0.45 * wFine);

    // 卡框：顯影完成時要是乾淨的直邊，才接得上 DOM 那張卡
    float box = 1.0 - smoothstep(0.985, 1.0 + mix(0.26, 0.004, img),
                                 max(abs(q.x), abs(q.y)));

    /* swell 那一拍（煙合攏、還沒開始堆）先閃一次卡片輪廓。
       那一拍本來是刻意的空白，但完全沒東西看會變成單純的等待 ——
       給一個「有東西要來了」的預告，懸置才成立。
       閃完馬上接 charge，預告跟蓄力連在一起才是一句完整的話。 */
    float ghost = smoothstep(0.30, 0.37, uProg) * (1.0 - smoothstep(0.39, 0.47, uProg));
    if (ghost > 0.002) {
      vec2 gq = relA * 1.05 + (vec2(fbm(relA * 2.1 + uTime * 0.30, 2),
                                    fbm(relA * 2.1 + 9.1 - uTime * 0.24, 2)) - 0.5) * 0.55;
      float gbox = 1.0 - smoothstep(0.84, 1.06, max(abs(gq.x), abs(gq.y)));
      float gl2 = dot(texture(uCard, gq * 0.5 + 0.5).rgb, vec3(0.299, 0.587, 0.114));
      col += mix(uTint, vec3(1.0), 0.35) * gl2 * gbox * ghost * 0.6;
      alpha = max(alpha, gbox * ghost * 0.32);
    }

    vec3 tex = texture(uCard, q * 0.5 + 0.5).rgb;
    float ca = clamp(formed * box, 0.0, 1.0);
    col = mix(col, tex, ca);
    alpha = max(alpha, ca);

    /* 每一塊接上去的瞬間亮一下。兩波各閃一次 ——
       第一次是塊落定，第二次是細節補滿，所以同一個位置會亮兩下。 */
    float spark = (wCoarse * (1.0 - wCoarse) + wFine * (1.0 - wFine) * 0.7) * 4.0 * box;
    col += mix(uTint, vec3(1.0), 0.5) * spark * 0.5;
  }

  /* 灰燼：稀疏的亮點在煙裡慢慢往上飄。
     用格子雜湊不用 fbm —— 每格最多一顆，成本幾乎是零。
     半徑要留得夠大（約十個畫素）：低解析度算完再放大，
     太小的亮點會變成一顆顆方塊，就是之前星點踩過的那個坑。 */
  vec2 gp = p * 9.5 + vec2(sin(uTime * 0.19) * 0.35, -uTime * 0.26);
  vec2 gi = floor(gp), gf = fract(gp) - 0.5;
  // 衰減指數決定顆粒大小。太小會變方塊、太大就成了鏡頭光斑，
  // 這個值對應到畫面上大約六到八個畫素
  float mote = step(0.90, hash(gi)) * exp(-dot(gf, gf) * 95.0);
  float emberLife = smoothstep(0.25, 0.42, uProg) * (1.0 - smoothstep(0.86, 1.0, uProg));
  col += mix(uTint, vec3(1.0), 0.55) * mote * emberLife * 0.45;
  alpha = max(alpha, mote * emberLife * 0.5);

  // 顆粒：打散漸層色帶，暗部重亮部細
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  float grain = hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
  col += grain * mix(0.05, 0.012, smoothstep(0.0, 0.5, lum));

  // 四角留厚一點，中間先開 —— 舞台感
  float vig = smoothstep(1.35, 0.35, length((uv - 0.5) * vec2(1.1, 1.0)));
  alpha *= 0.35 + 0.65 * vig + 0.35 * (1.0 - vig);

  outColor = vec4(max(col, 0.0), clamp(alpha, 0.0, 1.0));
}`

function compile(g: WebGL2RenderingContext, type: number, src: string) {
  const sh = g.createShader(type)!
  g.shaderSource(sh, src)
  g.compileShader(sh)
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    console.warn('[SmokePlume]', g.getShaderInfoLog(sh))
    g.deleteShader(sh)
    return null
  }
  return sh
}

function resize() {
  const c = canvas.value
  if (!c || !gl) return
  const scale = (quality ? 0.62 : 0.34) * dpr
  const w = Math.max(1, Math.floor(c.clientWidth * scale))
  const h = Math.max(1, Math.floor(c.clientHeight * scale))
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
    gl.viewport(0, 0, w, h)
  }
}

let uRes: WebGLUniformLocation | null = null
let uTime: WebGLUniformLocation | null = null
let uProg: WebGLUniformLocation | null = null
let uCrack: WebGLUniformLocation | null = null
let uQuality: WebGLUniformLocation | null = null
let uTint: WebGLUniformLocation | null = null
let uDensity: WebGLUniformLocation | null = null
let uCard: WebGLUniformLocation | null = null
let uHasCard: WebGLUniformLocation | null = null
let uCardHalf: WebGLUniformLocation | null = null

let cardTex: WebGLTexture | null = null
let cardImg: HTMLImageElement | null = null

/* 卡圖上貼圖。
   跨網域的圖必須帶 crossOrigin='anonymous'，否則 texImage2D 會讓
   context 被污染而丟 SecurityError（tcgdex 有回 access-control-allow-origin: *）。
   失敗就安靜放棄 —— uHasCard 保持 0，外層自己用 DOM 那張卡。 */
function loadCard(url: string) {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  cardImg = img
  img.onload = () => {
    if (!gl || cardImg !== img) return
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    // 攤開的時候會取樣到框外，夾邊比重複好 —— 重複會看到卡片密鋪
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    /* 一定要有 mipmap。卡圖是 ~730px，畫布只有 ~170px 寬，卡片佔其中一半 ——
       接近 10 倍的縮小。只用 LINEAR 的話每個畫素只取一個 texel，
       卡面會變成一片閃爍的雜訊，看起來像訊號壞掉不像卡片。
       WebGL2 對非二次冪貼圖也支援 mipmap，所以可以直接產。 */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    // WebGL 的 v 軸跟圖片相反，不翻的話卡片會上下顛倒
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    } catch {
      gl.deleteTexture(tex)
      return
    }
    gl.generateMipmap(gl.TEXTURE_2D)
    cardTex = tex
    emit('cardready')
  }
  img.src = url
}

let frames = 0
let measureStart = 0

/** 經過時間 → 正規時間軸的進度。見檔頭對照表。 */
function progAt(el: number) {
  const segs = props.segments
  if (!segs || !segs.length) return Math.min(1, el / props.duration)
  let t = 0
  for (const [ms, a, b] of segs) {
    if (el < t + ms) return a + (b - a) * ((el - t) / ms)
    t += ms
  }
  return 1
}

/** 第一次爆的包絡：一下子亮起來（70ms），然後指數退掉。
    起手不做斜坡的話它會在一幀之內從 0 跳到 1，讀起來像畫面閃了一格壞掉。 */
function crackAt(el: number) {
  const pop = (at: number, amp: number, tau: number) => {
    if (!at) return 0
    const d = el - at
    if (d <= 0) return 0
    return amp * Math.exp(-d / tau) * Math.min(1, d / 70)
  }
  /* 取最大值而不是相加：兩次爆在時間上分得夠開，相加只會在都很小的時候
     憑空多出一點亮度；取最大值則保證「畫面上正在發生的是比較大的那一次」。
     第二次的尾巴也拖得長一點（380 → 520 ms）—— 規模大，餘波就該久。 */
  return Math.max(pop(props.crackAt, 1, 380), pop(props.surgeAt, 1.65, 520))
}

function frame(now: number) {
  raf = requestAnimationFrame(frame)
  if (!gl || !program) return
  resize()

  const el = now - startTime
  const t = el / 1000
  const prog = progAt(el)

  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(program)
  gl.uniform2f(uRes, gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uTime, t)
  gl.uniform1f(uProg, prog)
  gl.uniform1f(uCrack, crackAt(el))
  gl.uniform1f(uQuality, quality)
  const tint = props.tint ?? [0.55, 0.34, 0.92]
  gl.uniform3f(uTint, tint[0], tint[1], tint[2])
  gl.uniform1f(uDensity, props.density)
  if (cardTex) {
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, cardTex)
    gl.uniform1i(uCard, 0)
  }
  gl.uniform1f(uHasCard, cardTex ? 1 : 0)
  gl.uniform2f(uCardHalf, props.cardHalf[0], props.cardHalf[1])
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  if (quality && measureStart) {
    frames++
    const ms = now - measureStart
    if (ms > 1000) {
      const fps = (frames / ms) * 1000
      emit('fps', Math.round(fps))
      if (fps < 40) { quality = 0; resize() }
      measureStart = 0
    }
  }
}

/** 重跑一次（外層重播時呼叫） */
function restart() {
  startTime = performance.now()
}
defineExpose({ restart })

onMounted(() => {
  const c = canvas.value
  if (!c) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)

  const g = c.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    // 這支 shader 輸出的是直通 alpha，不是預乘的
    premultipliedAlpha: false,
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: true
  })
  if (!g) { emit('fail'); return }
  gl = g

  const vs = compile(g, g.VERTEX_SHADER, VERT)
  const fs = compile(g, g.FRAGMENT_SHADER, FRAG)
  if (!vs || !fs) { emit('fail'); return }

  const prog = g.createProgram()!
  g.attachShader(prog, vs)
  g.attachShader(prog, fs)
  g.linkProgram(prog)
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
    console.warn('[SmokePlume] link', g.getProgramInfoLog(prog))
    emit('fail')
    return
  }
  program = prog
  uRes = g.getUniformLocation(prog, 'uRes')
  uTime = g.getUniformLocation(prog, 'uTime')
  uProg = g.getUniformLocation(prog, 'uProg')
  uCrack = g.getUniformLocation(prog, 'uCrack')
  uQuality = g.getUniformLocation(prog, 'uQuality')
  uTint = g.getUniformLocation(prog, 'uTint')
  uDensity = g.getUniformLocation(prog, 'uDensity')
  uCard = g.getUniformLocation(prog, 'uCard')
  uHasCard = g.getUniformLocation(prog, 'uHasCard')
  uCardHalf = g.getUniformLocation(prog, 'uCardHalf')

  // 半透明的煙要正常疊在頁面上
  g.enable(g.BLEND)
  g.blendFuncSeparate(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA, g.ONE, g.ONE_MINUS_SRC_ALPHA)

  if (props.image) loadCard(props.image)

  startTime = performance.now()
  measureStart = startTime
  resize()
  raf = requestAnimationFrame(frame)
  document.addEventListener('visibilitychange', onVis)
})

function onVis() {
  if (document.hidden) {
    cancelAnimationFrame(raf)
    raf = 0
  } else if (!raf) {
    raf = requestAnimationFrame(frame)
  }
}

watch(() => props.image, url => {
  cardTex = null
  cardImg = null
  if (url && gl) loadCard(url)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  document.removeEventListener('visibilitychange', onVis)
  cardImg = null
  if (gl) {
    if (program) gl.deleteProgram(program)
    if (cardTex) gl.deleteTexture(cardTex)
  }
  gl = null
})
</script>

<template>
  <canvas ref="canvas" class="plume" aria-hidden="true"></canvas>
</template>

<style scoped>
.plume {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  display: block;
  pointer-events: none;
}
</style>
