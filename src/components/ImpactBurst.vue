<script setup lang="ts">
/**
 * 衝擊層 —— 蓄力吸入、爆發、餘韻。畫在煙霧「之上」。
 *
 * 這一層存在的理由：原本的揭曉整段都是柔和的漸變，沒有一個「爆點」。
 * 衝擊感不是把東西做亮做多，是**對比**：先收（charge：畫面壓暗、東西被吸進核心），
 * 才炸得開（burst：白場、衝擊波、粒子爆散）。少了前面那一收，
 * 後面再亮也只是「變亮了」，不是「炸了」。
 * 這條在 docs/reveal-fx-research.md 有出處。
 *
 * ---- 二次改版：多段爆發 ----
 * 單一爆點的問題是它只能被聽到一次。改成「蓄力 → 第一次爆（crack）→
 * 更深的吸入（inhale）→ 主爆（burst）」之後，主爆有了兩個基準線：
 * 一個是前面的安靜，一個是**剛剛才聽過的那一聲**。第二次要壓得過第一次，
 * 才會讀成「原來剛剛那個只是前菜」。
 *
 * 這段加碼只給高賞別（uEpic = 1）。低賞別維持單一爆點的舊節奏 ——
 * 每抽一張 D 賞都播一場兩段式爆炸，衝擊就變成常態，常態化的衝擊等於沒有衝擊。
 *
 * 合成方式：canvas 是**不透明黑底、全部加法疊加**，靠 CSS mix-blend-mode: screen
 * 疊回頁面 —— screen 遇到純黑是恆等，所以黑的地方等同透明。
 * 這樣不必處理直通／預乘 alpha 的坑（SmokePlume 那支就是因為輸出帶 alpha
 * 才必須開 premultipliedAlpha: false），而且發光本來就該是加法。
 *
 * 一個 context、兩個 program、兩次 draw call：
 *   pass 1 全螢幕三角形：衝擊波環（含破碎環、十字光芒、放射裂紋）、
 *          內爆環、速度線、爆光、色差環、暈影
 *   pass 2 gl.POINTS：粒子（吸入 / 第一次爆 / 主爆四個速度層）
 * 手機上開第二個 WebGL context 會互相搶資源（iOS Safari 還有數量上限），
 * 所以寧可兩個 pass 擠在同一張畫布。
 *
 * 粒子**不存狀態**：每顆的方向、速度、大小、壽命全由 gl_VertexID 雜湊出來，
 * 位置在 vertex shader 用解析式直接算。零 buffer、零 CPU 每幀工作，
 * 連頂點屬性都不用綁。transform feedback 解的是「狀態要延續」的問題，
 * 而這裡是一次性爆發，沒有回收也沒有碰撞，付它的複雜度是白付。
 *
 * 時間軸自己跑（跟 SmokePlume 同一套）：外層的相位是 setTimeout 推的，
 * 這裡只要一個從 performance.now() 算出來的秒數。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{
  /** 蓄力開始（毫秒，從演出起點算） */
  chargeAt: number
  /** 第一次爆的瞬間（毫秒）。沒有第一次爆時就等於 burstAt */
  crackAt: number
  /** 深吸氣起點（毫秒）。沒有時就等於 burstAt */
  inhaleAt: number
  /** 主爆瞬間（毫秒） */
  burstAt: number
  /** 整段長度（毫秒），到了就自己停 rAF，不再燒電 */
  total: number
  /** 演出強度 0..1。低賞別不只是播得快，是真的比較小聲 */
  intensity?: number
  /** 高賞別才有的加碼段：第一次爆、內爆環、放射裂紋、後燄環 */
  epic?: boolean
  /**
   * 命中停頓表 [[起點毫秒, 長度毫秒], ...]，起點是**真實經過時間**。
   * 由外層 CardEmerge 統一算好再傳進來 —— 兩邊各算一次的話，
   * DOM 的定格跟 shader 的凍結會對不到同一個時刻，那比沒有停頓還糟。
   */
  stops?: [number, number][]
  /** 主色 [r,g,b]（0..1） */
  tint?: [number, number, number]
}>(), { intensity: 1, epic: false, stops: () => [], tint: () => [0.55, 0.34, 0.92] })

const emit = defineEmits<{ (e: 'fail'): void; (e: 'fps', v: number): void }>()

const canvas = ref<HTMLCanvasElement | null>(null)
let gl: WebGL2RenderingContext | null = null
let raf = 0
let startTime = 0
let quality = 1
let dpr = 1

/* 一顆粒子由連續 TRAIL 個索引組成，彼此只差一點時間偏移 ——
   沿軌跡排成一串就是拖尾。不另外畫線段，全部還在同一次 draw call 裡。
   6 → 7 是為了讓最快那一層（碎屑）拉得出一條看得見的線；
   多的那一段對填色率的影響遠小於「把每顆點畫大一點」。 */
const TRAIL = 7
const BURST_HEADS = 520
const BURST_HEADS_EPIC = 900
const INHALE_HEADS = 150
const INHALE_HEADS_EPIC = 250
/* 第一次爆的碎屑要明顯少於主爆。給一樣多的話兩次爆看起來一樣大，
   主爆就沒有「更大一級」可言了。 */
const CRACK_HEADS_EPIC = 230

const VERT_FS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

/* ---- pass 1：全螢幕的衝擊後製 ---- */
const FRAG_FS = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  uRes;
uniform float uT;        // 演出時間（秒，已含命中停頓的重映射）
uniform float uCharge;   // 蓄力起點（秒）
uniform float uCrack;    // 第一次爆（秒）。無第一次爆時 = uBurst
uniform float uInhaleAt; // 深吸氣起點（秒）。無時 = uBurst
uniform float uBurst;    // 主爆瞬間（秒）
uniform float uInt;      // 強度 0..1
uniform float uEpic;     // 1 = 高賞別
uniform vec3  uTint;

const float TAU = 6.28318;

float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

/* 角度方向的低頻擾動 —— 讓環不是完美的圓、讓裂紋不是筆直的線。
   索引一定要對 f 取模：ang 繞回 -PI 的那一格如果接的是另一組雜湊值，
   環上就會出現一道對不起來的縫，而且那道縫每一幀都在同一個角度，特別顯眼。 */
float angWob(float a, float f, float seed) {
  float x = (a + 3.14159) / TAU * f;
  float i = floor(x), fr = fract(x);
  fr = fr * fr * (3.0 - 2.0 * fr);
  float a0 = h11(mod(i, f) * 1.7 + seed);
  float a1 = h11(mod(i + 1.0, f) * 1.7 + seed);
  return mix(a0, a1, fr) - 0.5;
}

/* 速度線。inward 決定它往核心收還是往外噴 —— 兩個方向共用同一套角度雜湊，
   差別只在方向與速度。抽成函式之後才有本錢讓每一段用不同的扇區數：
   收束的線要**少而長**（看得出核心在吸），噴發的線要**多而短**（看不清楚才有速度）。

   thinB / thinR 是「只取扇區正中那一絲」的高斯寬度（thinR 讓線越往外越細）。
   少了這一項，每一條線就是一整片實心扇形，畫面會變成一個風車。 */
float lines(float ang, float r, float sectors, float prog, float gate,
            float sm, float sa, float thinB, float thinR, bool inward) {
  float sec = (ang + 3.14159) / TAU * sectors;
  float k = floor(sec);
  float thin = exp(-pow(fract(sec) - 0.5, 2.0) * (thinB + thinR * r));
  float seed = h11(k * sm + sa);
  // 往外噴的線要長一截：它同時在變短（前緣往外、尾巴留在原地），
  // 起手不夠長的話還沒被看見就消失了
  float len = inward ? (0.10 + 0.22 * seed) : (0.18 + 0.30 * seed);
  float line;
  if (inward) {
    // 線的前緣往內推進：外側先出現，逐漸伸向核心
    float head = mix(0.92, 0.08, prog * prog * (0.55 + 0.45 * seed));
    line = smoothstep(head + len, head, r) * smoothstep(head - 0.02, head + 0.05, r);
  } else {
    float head = prog * (0.9 + 1.9 * seed);
    line = smoothstep(head, head - len, r) * smoothstep(head + 0.03, head - 0.01, r);
  }
  // gate 只留下一部分角度扇區，全部都有的話會變成一圈實心漸層
  return line * step(gate, seed) * thin;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float r = length(p);
  float ang = atan(p.y, p.x);

  float ct = uT - uCrack;    // 負數 = 第一次爆還沒到
  float bt = uT - uBurst;    // 負數 = 主爆還沒到
  vec3 col = vec3(0.0);

  /* ---- 第一段蓄力：向心速度線 ----
     Clove 早期那個「光線集中」演出被他們自己淘汰掉，理由是看不懂、結束太快。
     所以這裡的向心線**只在蓄力段出現而且要慢**，讓人讀得出核心在「吸」；
     爆發時才反轉成放射。快慢本身就是這兩段的區別。

     終點是 uCrack：低賞別 uCrack = uBurst，這一段的行為跟改版前完全一樣。 */
  float chg = clamp((uT - uCharge) / max(0.001, uCrack - uCharge), 0.0, 1.0);
  if (chg > 0.0 && ct < 0.0) {
    col += mix(uTint, vec3(1.0), 0.25)
         * lines(ang, r, 110.0, chg, 0.66, 1.37, 0.0, 150.0, 0.0, true) * chg * 1.5 * uInt;

    /* 核心的脈動。頻率隨蓄力升高 —— 心跳越來越快是「快要壓不住」最省的說法。
       亮度給得夠才讀得出「能量被壓進一個點」；太淡的話這一拍只會被讀成
       「畫面暗下來了」，蓄力就白做。
       （真正的壓暗做不到：加法混色裡沒有減法，那件事交給外層 CSS 的 filter。） */
    float pulse = 0.5 + 0.5 * sin(uT * (14.0 + 26.0 * chg));
    col += mix(uTint, vec3(1.0), 0.35) * exp(-r * 5.0) * chg * chg
         * (0.55 + 0.85 * pulse) * uInt;
  }

  /* ---- 第一次爆（只有高賞別）----
     刻意做成「小一號的主爆」：一樣的語彙（爆光 + 一道環 + 放射線），
     但亮度、半徑、線的壽命全部砍半，而且**沒有**十字光芒與裂紋。
     語彙相同才會被讀成同一件事的第一次；規模不同才留得住第二次的位置。 */
  if (uEpic > 0.5 && ct >= 0.0) {
    float f = exp(-ct * 13.0) * uInt * 0.60;
    col += mix(uTint, vec3(1.0), 0.62) * f * (0.16 + 2.1 * exp(-r * 5.2));

    float rad = 0.62 * (1.0 - exp(-ct * 6.0));
    float thick = 0.010 + 0.05 * ct;
    float e = (r - rad) / thick;
    col += mix(uTint, vec3(1.0), 0.45) * exp(-e * e) * exp(-ct * 3.2)
         * (1.0 - smoothstep(0.48, 0.95, rad)) * 0.95 * uInt;

    col += mix(uTint, vec3(1.0), 0.30)
         * lines(ang, r, 150.0, ct * 1.5, 0.62, 2.11, 7.0, 110.0, 260.0, false)
         * exp(-ct * 5.0) * 1.4 * uInt;
  }

  /* ---- 深吸氣（只有高賞別）----
     第一次爆之後畫面要比爆之前**更安靜、更暗、更空**，否則第二次只是重播。
     這一段做三件事：收束線變少變長變快、核心脈動頻率再翻倍、
     以及一圈往內收的內爆環。 */
  float inh = clamp((uT - uInhaleAt) / max(0.001, uBurst - uInhaleAt), 0.0, 1.0);
  if (uEpic > 0.5 && inh > 0.0 && bt < 0.0) {
    col += mix(uTint, vec3(1.0), 0.40)
         * lines(ang, r, 64.0, inh, 0.42, 3.31, 2.0, 90.0, 0.0, true) * inh * 2.4 * uInt;

    /* 內爆環：一圈能量往核心收，收到最後幾乎變成一個點。
       這是整段演出唯一一個**往內**的環 —— 方向相反本身就是訊號，
       而且它替主爆先寫好了因果：剛剛吞進去的東西等一下要全部吐回來。

       起點只能給到 0.68，不能給 1.15。這支 shader 算的是 4:5 的舞台，
       但結果頁把舞台放大到蓋滿視窗、只留中間那一條 ——
       393×852 的手機上看得到的其實只有 |p.x| < 0.23、角落 r ≈ 0.55。
       往外擴的環從中心出發、遲早會掃過可見範圍，所以起點無所謂；
       **往內收的環起點如果在可見範圍外，前半段就整段看不到**。
       曲線用 pow(inh, 1.4) 而不是 inh²：平方會讓它在畫面外磨蹭掉一半的時間。 */
    float rad = mix(0.68, 0.035, pow(inh, 1.4));
    float thick = 0.048 - 0.036 * inh;   // 越收越細＝越收越急
    float e = (r - rad) / thick;
    col += mix(uTint, vec3(1.0), 0.35) * exp(-e * e) * (0.45 + 1.9 * inh * inh) * uInt;

    float pulse = 0.5 + 0.5 * sin(uT * (30.0 + 52.0 * inh));
    col += mix(uTint, vec3(1.0), 0.50) * exp(-r * (6.0 + 10.0 * inh))
         * inh * inh * (0.6 + 1.5 * pulse) * uInt * 1.35;
  }

  if (bt >= 0.0) {
    /* ---- 爆光 ----
       炸開那一格核心過曝到接近純白，其它細節全部看不見。
       「看不見」在這裡是替「太亮了」說話 —— 這是整段演出資訊量最低、
       但衝擊最強的一格。 */
    float flash = exp(-bt * 11.0) * uInt;
    /* 過曝要**集中在核心**。常數項給太大、或衰減給太慢，整片畫面
       （連四個角）都會一起變純白 —— 那不是爆光而是換頁，
       而且手機貼著臉看會刺眼。中心炸到爆表、邊緣只被照亮，
       才讀得出光是從一個點出來的。

       衰減從 4.0 收到 7.0 是這一版改的：命中停頓從 110 拉到 165 ms 之後，
       那一格會**停在畫面上更久**，原本勉強可以的滿版白就變成「畫面壞了」。
       停得越久，過曝就要收得越緊。 */
    col += mix(uTint, vec3(1.0), 0.75) * flash * (0.12 + 3.6 * exp(-r * 7.0));

    /* ---- 衝擊波環 ----
       三環錯開。單環太乾淨，讀起來像一個圓在放大；
       錯開的三環才有「一股東西推出去」的厚度。
       半徑走 1-exp：一出手最快，之後迅速慢下來，這是爆震該有的速度曲線。 */
    for (int i = 0; i < 3; i++) {
      float rt = bt - float(i) * 0.09;
      if (rt <= 0.0) continue;
      /* 中間那一環是**破碎的環**：半徑被角度雜訊擾動，讀起來像撞碎的邊緣。
         三環都是完美的圓的話，錯開再多也只是同一個形狀播三次；
         其中一環換個形狀，另外兩環才會被讀成「另外兩環」。
         只給高賞別 —— 低賞別的爆發本來就該乾淨、小聲、快結束。 */
      float wob = (i == 1) ? angWob(ang, 9.0, 3.1) * 0.085 * uEpic : 0.0;
      float rad = 1.05 * (1.0 - exp(-rt * 4.2)) + wob * (1.0 - exp(-rt * 6.0));
      float thick = 0.012 + 0.075 * rt;          // 擴張的同時變薄變糊
      // 環擴到畫面外緣就要收乾淨，不然最後停在四邊留下一圈框
      float fade = exp(-rt * 2.3) * (1.0 - smoothstep(0.62, 1.0, rad));
      float e = (r - rad) / thick;
      float ring = exp(-e * e) * fade / (1.0 + float(i) * 0.9);
      col += mix(uTint, vec3(1.0), 0.5) * ring * 1.25 * uInt;

      /* ---- 色差近似 ----
         真正的色差要把底下的畫面渲染進 FBO 再取樣三次，
         但我們的卡片是 DOM 的 <img>，根本不在 WebGL 裡（見研究文件）。
         改成在環的兩側各加一道紅／青：紅偏外、青偏內。
         這不是真的把畫面分離，但視覺線索一樣是「高速邊緣的紅青鑲邊」。 */
      float e2 = (r - rad - thick * 1.2) / thick;
      float e3 = (r - rad + thick * 1.2) / thick;
      float ca = fade * uInt * 0.5;
      col += vec3(1.0, 0.15, 0.10) * exp(-e2 * e2) * ca;
      col += vec3(0.10, 0.75, 1.0) * exp(-e3 * e3) * ca;
    }

    /* ---- 十字光芒 ----
       三道環都是圓的，畫面上就只有「一圈一圈」這一種語彙。
       加一組沿軸向拉長的光芒之後，爆點才有**方向** ——
       而且這是鏡頭前有強光時真的會發生的事（anamorphic streak），
       不是憑空多畫一個裝飾。
       橫的最長、直的次之、四十五度只留一點，不然會變成一顆星星貼紙。 */
    float w = 0.006 + 0.030 * bt;                 // 隨時間變粗變糊
    float dec = 2.6 + 11.0 * bt;                  // 隨時間變短
    vec2 d45 = vec2(p.x + p.y, p.x - p.y) * 0.70711;
    float fl = exp(-abs(p.y) / w) * exp(-r * dec)
             + 0.72 * exp(-abs(p.x) / (w * 0.8)) * exp(-r * dec * 1.4)
             + 0.32 * (exp(-abs(d45.y) / (w * 0.55)) + exp(-abs(d45.x) / (w * 0.55)))
                    * exp(-r * dec * 2.0);
    col += mix(uTint, vec3(1.0), 0.80) * fl * exp(-bt * 5.2) * 1.45 * uInt;

    /* ---- 放射狀裂紋（只有高賞別）----
       跟速度線的差別是**數量少、活得久、而且不直**。
       速度線是一整片在飛，裂紋是十幾道從中心竄出去的線 ——
       讀起來是「畫面被撞裂」而不是「東西在飛」。
       線的尖端最亮：裂縫是從前緣一路裂開的，最新的那一段才是熱的。 */
    if (uEpic > 0.5) {
      float sec = (ang + 3.14159) / TAU * 16.0;
      float k = floor(sec);
      float seed = h11(k * 5.77 + 3.0);
      float jag = angWob(ang, 48.0, 8.4) * 0.30;   // 讓每一道不筆直
      float thin = exp(-pow(fract(sec) - 0.5 + jag, 2.0) * (300.0 + 900.0 * r));
      float grow = 1.28 * (1.0 - exp(-bt * 8.0));
      float body = smoothstep(grow + 0.015, grow - 0.015, r);
      float tip = 0.18 + 0.95 * smoothstep(0.0, grow * 0.96, r);
      col += mix(uTint, vec3(1.0), 0.55) * body * tip * thin
           * step(0.55, seed) * exp(-bt * 3.0) * 2.6 * uInt;

      /* 後燄環：慢得多、厚得多、暗得多的第四環。
         前三環在半秒內就掃出畫面，之後那兩秒半（卡片顯影）畫面上就沒有
         任何「剛剛炸過」的痕跡了。這一環負責把爆炸的尾巴接到顯影上。 */
      float rt = bt - 0.34;
      if (rt > 0.0) {
        float rad = 1.20 * (1.0 - exp(-rt * 1.9));
        float thk = 0.05 + 0.16 * rt;
        float e = (r - rad) / thk;
        col += mix(uTint, vec3(1.0), 0.15) * exp(-e * e) * exp(-rt * 1.5)
             * (1.0 - smoothstep(0.70, 1.15, rad)) * 0.55 * uInt;
      }
    }

    /* ---- 放射狀速度線 ----
       跟蓄力那組共用角度雜湊，但方向相反、速度快得多。 */
    col += mix(uTint, vec3(1.0), 0.35)
         * lines(ang, r, 150.0, bt, 0.52, 2.11, 7.0, 110.0, 260.0, false)
         * exp(-bt * 3.8) * 2.2 * uInt;

    /* ---- 暈影收縮 ----
       炸開瞬間四角壓黑、視野變窄，像瞳孔縮一下。
       加法混色壓不了黑，所以這裡做的是「中心額外亮一圈」，
       相對之下四角就暗。 */
    col += uTint * exp(-r * r * 9.0) * exp(-bt * 1.6) * 0.35 * uInt;
  }

  outColor = vec4(max(col, 0.0), 1.0);
}`

/* ---- pass 2：粒子 ---- */
const VERT_PT = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uT;
uniform float uCharge;
uniform float uCrack;
uniform float uBurst;
uniform float uInt;
uniform float uEpic;
uniform float uPx;        // 一個「舞台單位」等於幾個 framebuffer 畫素
uniform vec3  uTint;
uniform int   uNInhale;   // 吸入粒子的顆數（頭數 × TRAIL）
uniform int   uNCrack;    // 第一次爆的顆數（頭數 × TRAIL）
uniform float uTrail;

out vec4 vCol;

float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

void main() {
  float id = floor(float(gl_VertexID) / uTrail);
  float sub = mod(float(gl_VertexID), uTrail);   // 0 = 頭，越大越後面
  float aspect = uRes.x / uRes.y;

  vec2 pos = vec2(0.0);
  float life = 0.0;
  float size = 0.0;
  vec3 tone = uTint;

  if (gl_VertexID < uNInhale) {
    /* ---- 吸入 ----
       蓄力段被核心吸進去的碎屑。半徑走 f² 的反向 ——
       離核心越近掉得越快，這樣才像被拉進去，不是等速飄進去。
       高賞別的蓄力（charge + crack + inhale）比低賞別長一倍以上，
       循環次數要跟著加，否則中段會出現一段誰都不在的空窗。 */
    float chg = (uT - uCharge) / max(0.001, uBurst - uCharge);
    if (chg > 0.0 && chg < 1.06) {
      float a = h11(id * 1.93) * 6.28318;
      float f = fract(chg * (1.7 + 1.7 * uEpic) + h11(id * 4.7));
      f = clamp(f + sub * 0.004, 0.0, 1.0);
      float rr = mix(0.78, 0.015, f * f);
      pos = vec2(cos(a), sin(a) * 0.85) * rr;
      // 頭一批要淡入，最後要在爆發前收乾淨，不然爆完還有東西在往內飛
      life = smoothstep(0.0, 0.12, chg) * (1.0 - smoothstep(0.92, 1.05, chg))
           * (1.0 - f * 0.35) * (1.0 - sub / uTrail * 0.6);
      // 越接近爆發吸得越急：末段要更亮更密，才讀得出「壓不住了」
      life *= 0.72 + 0.85 * chg * chg;
      size = uPx * (0.010 + 0.010 * h11(id * 8.1)) * (1.0 - sub / uTrail * 0.45);
      tone = mix(uTint, vec3(1.0), 0.25 * (1.0 - f));
    }
  } else if (gl_VertexID < uNInhale + uNCrack) {
    /* ---- 第一次爆的碎屑（只有高賞別）----
       阻力係數比主爆大（4.4 vs 3.1）＝ 噴不遠就停住。
       第一次爆的東西要留在畫面中間，主爆才有「這次真的掀到邊緣了」的落差。 */
    float bid = id + 917.0;
    float t0 = uT - uCrack - sub * 0.006 - h11(bid * 5.31) * 0.04;
    if (t0 > 0.0) {
      float a = h11(bid * 1.71) * 6.28318;
      float sp = mix(0.35, 1.25, pow(h11(bid * 3.07), 1.8));
      vec2 dir = vec2(cos(a), sin(a) * 0.82);
      pos = dir * sp * (1.0 - exp(-t0 * 4.4)) / 4.4;
      pos.y -= 0.10 * t0 * t0;
      life = exp(-t0 * 2.4) * (1.0 - sub / uTrail * 0.55);
      size = uPx * (0.005 + 0.010 * h11(bid * 9.7)) * (1.0 - sub / uTrail * 0.4);
      tone = mix(vec3(1.0), uTint, clamp(t0 * 2.0, 0.0, 1.0));
    }
  } else {
    /* ---- 主爆 ----
       位移用 (1-e^-kt)/k：這是「初速 v、阻力係數 k」的解析解，
       所以粒子是一出手最快、之後被空氣拖住慢下來。
       等速直線會讀成煙火貼圖，沒有重量。

       ---- 四個速度層 ----
       單一速度的爆炸只有一個「深度」，看起來是貼在螢幕上的一片。
       分層之後：碎屑先掠過（快到只剩一條線）、主體填滿畫面、
       餘燼掛在後面慢慢燒、浮塵最後才懸著不走 —— 同一次爆炸就有了前後。
       比例是刻意的：快的少（11%）、餘燼 16%、浮塵 15%，其餘是主體。
       快的多了畫面會變成一團白線，浮塵多了餘韻會髒。 */
    float bid = id;
    float cls = h11(bid * 13.7);
    float shard = step(cls, 0.11);
    float ember = step(0.11, cls) * step(cls, 0.27);
    float dust  = step(0.27, cls) * step(cls, 0.42);

    /* 拖尾各影像之間的時間差要**小**。太大的話同一顆的幾個影像之間拉開距離，
       畫面上看到的是一串虛線而不是一條尾巴 —— 0.024 就已經明顯斷開了。
       碎屑是唯一的例外：它快到影像之間本來就會連成一條，
       間距給大一點反而拉得出長度。 */
    float gap = mix(0.0055, 0.0125, shard);
    float t0 = uT - uBurst - sub * gap - h11(bid * 5.31) * 0.045;
    if (t0 > 0.0) {
      float a = h11(bid * 1.71) * 6.28318;
      float sp = mix(0.5, 2.3, pow(h11(bid * 3.07), 2.2)) * (0.65 + 0.55 * uInt);
      float k = 3.1;
      float decay = 1.35;
      float sz = 0.006 + 0.014 * h11(bid * 9.7);
      float lifeMul = 1.0;
      /* 每一層的速度都**一定要各自不同**。給同一個常數的話它們會在同一個半徑
         同時停下來，畫面上出現一圈整齊的點 —— 那是最刺眼的程序生成破綻。 */
      if (shard > 0.5) {
        sp = 2.6 + 2.4 * h11(bid * 7.73); k = 5.2; decay = 3.2; sz *= 0.55;
      } else if (ember > 0.5) {
        sp = 0.07 + 0.30 * h11(bid * 7.73); decay = 0.30; sz *= 0.72; lifeMul = 0.55;
      } else if (dust > 0.5) {
        sp = 0.05 + 0.16 * h11(bid * 17.3); k = 2.2; decay = 0.14; sz *= 0.50; lifeMul = 0.30;
      }
      vec2 dir = vec2(cos(a), sin(a) * 0.82);
      pos = dir * sp * (1.0 - exp(-t0 * k)) / k;
      // 一點重力，餘韻時碎屑會垂下來。餘燼與浮塵不受它管
      pos.y -= 0.10 * t0 * t0 * (1.0 - ember - dust);
      // 餘燼相反：熱的東西往上飄。飄速也要各自不同，否則整群同步平移
      pos.y += ember * (0.012 + 0.055 * h11(bid * 21.1)) * t0;
      /* 浮塵：極慢、活很久。一條直線飄上去會整群同步，
         加一點各自相位的橫向擺動，才像空氣裡真的有東西懸著。 */
      pos.y += dust * (0.004 + 0.020 * h11(bid * 29.7)) * t0;
      pos.x += dust * 0.035 * sin(t0 * (0.7 + 1.3 * h11(bid * 31.1))
                                  + h11(bid * 37.3) * 6.28318);
      life = exp(-t0 * decay) * (1.0 - sub / uTrail * 0.55) * lifeMul;
      size = uPx * sz * (1.0 - sub / uTrail * 0.4) * (0.35 + 0.65 * exp(-t0 * 0.8));
      // 剛炸出來是白熱的，之後才退回主色。溫度變化比亮度變化更像火。
      // 碎屑退得更慢：飛得最快的那一批要保持白熱，才讀得出它是「最燙的那些」
      tone = mix(vec3(1.0), uTint, clamp(t0 * mix(1.5, 0.7, shard), 0.0, 1.0));
    }
  }

  gl_PointSize = max(size, 0.0);
  vCol = vec4(tone, life * uInt);
  // 沒活著的粒子丟到裁切範圍外，比在 fragment 丟棄便宜
  gl_Position = life > 0.002
    ? vec4(pos.x / (0.5 * aspect), pos.y / 0.5, 0.0, 1.0)
    : vec4(2.0, 2.0, 2.0, 1.0);
}`

const FRAG_PT = `#version 300 es
precision mediump float;
in vec4 vCol;
out vec4 outColor;
void main() {
  /* 高斯落點，不是硬圓 —— 硬邊的點在低解析度畫布上放大後會變成方塊，
     這是星點踩過的同一個坑。 */
  vec2 d = gl_PointCoord - 0.5;
  float a = exp(-dot(d, d) * 15.0);
  outColor = vec4(vCol.rgb * vCol.a * a, 1.0);
}`

function compile(g: WebGL2RenderingContext, type: number, src: string) {
  const sh = g.createShader(type)!
  g.shaderSource(sh, src)
  g.compileShader(sh)
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    console.warn('[ImpactBurst]', g.getShaderInfoLog(sh))
    g.deleteShader(sh)
    return null
  }
  return sh
}
function link(g: WebGL2RenderingContext, vs: string, fs: string) {
  const v = compile(g, g.VERTEX_SHADER, vs)
  const f = compile(g, g.FRAGMENT_SHADER, fs)
  if (!v || !f) return null
  const p = g.createProgram()!
  g.attachShader(p, v)
  g.attachShader(p, f)
  g.linkProgram(p)
  if (!g.getProgramParameter(p, g.LINK_STATUS)) {
    console.warn('[ImpactBurst] link', g.getProgramInfoLog(p))
    return null
  }
  return p
}

let progFs: WebGLProgram | null = null
let progPt: WebGLProgram | null = null
const uFs: Record<string, WebGLUniformLocation | null> = {}
const uPt: Record<string, WebGLUniformLocation | null> = {}
let vao: WebGLVertexArrayObject | null = null

function resize() {
  const c = canvas.value
  if (!c || !gl) return
  /* 比煙霧那支高一點（0.62）：粒子是高頻訊號，煙不是。
     降太多會讓小顆粒消失在取樣之間，反而看不到粒子。 */
  const scale = (quality ? 0.80 : 0.50) * dpr
  const w = Math.max(1, Math.floor(c.clientWidth * scale))
  const h = Math.max(1, Math.floor(c.clientHeight * scale))
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
    gl.viewport(0, 0, w, h)
  }
}

/** 命中停頓：把真實時間重映射成「舞台時間」。
    不是真的暫停 rAF —— 暫停了就沒有東西可以在解凍時接回來，
    而且分頁切換也會被算進去。凍的是餵給 shader 的那個數字。

    停頓可以有好幾段（高賞別是三段：第一次爆一次、主爆兩次），
    所以這裡累加「到目前為止已經凍掉多少」，而不是減一個常數。
    正在停頓中時 el - at < ms，累加值剛好等於「從停頓起點到現在」，
    相減之後就固定在停頓起點 —— 畫面自然停住。 */
function stageMs(el: number) {
  let acc = 0
  for (const [at, ms] of props.stops) {
    if (el <= at) break
    acc += Math.min(ms, el - at)
  }
  return el - acc
}

let frames = 0
let measureStart = 0

function frame(now: number) {
  if (!gl || !progFs || !progPt) return
  const el = now - startTime
  // 演出結束就收工，不留一支永遠在跑的 rAF
  if (el > props.total + 900) { raf = 0; return }
  raf = requestAnimationFrame(frame)
  resize()

  const t = stageMs(el) / 1000
  /* 各個時刻也要換算成舞台時間。用真實毫秒直接除的話，
     第一次爆的停頓會讓後面所有時刻整體晚 70 ms —— shader 以為主爆還沒到，
     DOM 卻已經跳到 burst 那一拍了。 */
  const tCharge = stageMs(props.chargeAt) / 1000
  const tCrack = stageMs(props.crackAt) / 1000
  const tInhale = stageMs(props.inhaleAt) / 1000
  const tBurst = stageMs(props.burstAt) / 1000

  /* 顆數在低強度時也要砍。只縮亮度不縮數量的話，D 賞的畫面上仍然有
     幾千顆很暗的點在飛，成本照付、看起來卻只是髒。 */
  const lo = 0.45 + 0.55 * props.intensity
  const full = quality ? 1 : 0.45
  const nHead = props.epic ? BURST_HEADS_EPIC : BURST_HEADS
  const nInh = props.epic ? INHALE_HEADS_EPIC : INHALE_HEADS
  const heads = Math.max(1, Math.floor(nHead * lo * full))
  const inh = Math.max(1, Math.floor(nInh * lo * full))
  const crk = props.epic ? Math.max(1, Math.floor(CRACK_HEADS_EPIC * lo * full)) : 0
  const tint = props.tint

  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.useProgram(progFs)
  gl.uniform2f(uFs.uRes!, gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uFs.uT!, t)
  gl.uniform1f(uFs.uCharge!, tCharge)
  gl.uniform1f(uFs.uCrack!, tCrack)
  gl.uniform1f(uFs.uInhaleAt!, tInhale)
  gl.uniform1f(uFs.uBurst!, tBurst)
  gl.uniform1f(uFs.uInt!, props.intensity)
  gl.uniform1f(uFs.uEpic!, props.epic ? 1 : 0)
  gl.uniform3f(uFs.uTint!, tint[0], tint[1], tint[2])
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  gl.useProgram(progPt)
  gl.uniform2f(uPt.uRes!, gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uPt.uT!, t)
  gl.uniform1f(uPt.uCharge!, tCharge)
  gl.uniform1f(uPt.uCrack!, tCrack)
  gl.uniform1f(uPt.uBurst!, tBurst)
  gl.uniform1f(uPt.uInt!, props.intensity)
  gl.uniform1f(uPt.uEpic!, props.epic ? 1 : 0)
  gl.uniform1f(uPt.uPx!, gl.drawingBufferHeight)
  gl.uniform3f(uPt.uTint!, tint[0], tint[1], tint[2])
  gl.uniform1i(uPt.uNInhale!, inh * TRAIL)
  gl.uniform1i(uPt.uNCrack!, crk * TRAIL)
  gl.uniform1f(uPt.uTrail!, TRAIL)
  gl.drawArrays(gl.POINTS, 0, (heads + inh + crk) * TRAIL)

  if (quality && measureStart) {
    frames++
    const ms = now - measureStart
    if (ms > 900) {
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
  frames = 0
  measureStart = startTime
  if (!raf && gl) raf = requestAnimationFrame(frame)
}
defineExpose({ restart })

onMounted(() => {
  const c = canvas.value
  if (!c) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  const g = c.getContext('webgl2', {
    antialias: false, depth: false, stencil: false,
    // 全部加法疊在不透明黑底上，靠 CSS 的 screen 疊回頁面，所以不需要 alpha
    alpha: false,
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: true
  })
  if (!g) { emit('fail'); return }
  gl = g

  progFs = link(g, VERT_FS, FRAG_FS)
  progPt = link(g, VERT_PT, FRAG_PT)
  if (!progFs || !progPt) { emit('fail'); return }

  for (const k of ['uRes', 'uT', 'uCharge', 'uCrack', 'uInhaleAt', 'uBurst', 'uInt', 'uEpic', 'uTint']) {
    uFs[k] = g.getUniformLocation(progFs, k)
  }
  for (const k of ['uRes', 'uT', 'uCharge', 'uCrack', 'uBurst', 'uInt', 'uEpic',
                   'uPx', 'uTint', 'uNInhale', 'uNCrack', 'uTrail']) {
    uPt[k] = g.getUniformLocation(progPt, k)
  }
  /* 一個空的 VAO。粒子沒有任何頂點屬性（全部從 gl_VertexID 算），
     但 WebGL2 的預設 VAO 在某些驅動上仍會抱怨，綁一個乾淨的最省事。 */
  vao = g.createVertexArray()
  g.bindVertexArray(vao)

  g.enable(g.BLEND)
  g.blendFunc(g.ONE, g.ONE)     // 純加法：光就是相加的

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

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  document.removeEventListener('visibilitychange', onVis)
  if (gl) {
    if (progFs) gl.deleteProgram(progFs)
    if (progPt) gl.deleteProgram(progPt)
    if (vao) gl.deleteVertexArray(vao)
  }
  gl = null
})
</script>

<template>
  <canvas ref="canvas" class="burst" aria-hidden="true"></canvas>
</template>

<style scoped>
/* screen：黑的地方是恆等，所以不必輸出 alpha 就能只把「光」疊上去 */
.burst {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  display: block;
  pointer-events: none;
  mix-blend-mode: screen;
}
</style>
