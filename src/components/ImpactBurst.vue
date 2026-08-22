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
 * 合成方式：canvas 是**不透明黑底、全部加法疊加**，靠 CSS mix-blend-mode: screen
 * 疊回頁面 —— screen 遇到純黑是恆等，所以黑的地方等同透明。
 * 這樣不必處理直通／預乘 alpha 的坑（SmokePlume 那支就是因為輸出帶 alpha
 * 才必須開 premultipliedAlpha: false），而且發光本來就該是加法。
 *
 * 一個 context、兩個 program、兩次 draw call：
 *   pass 1 全螢幕三角形：衝擊波環、速度線、爆光、色差環、暈影
 *   pass 2 gl.POINTS：粒子
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
  /** 爆發瞬間（毫秒） */
  burstAt: number
  /** 整段長度（毫秒），到了就自己停 rAF，不再燒電 */
  total: number
  /** 演出強度 0..1。低賞別不只是播得快，是真的比較小聲 */
  intensity?: number
  /** 主色 [r,g,b]（0..1） */
  tint?: [number, number, number]
}>(), { intensity: 1, tint: () => [0.55, 0.34, 0.92] })

const emit = defineEmits<{ (e: 'fail'): void; (e: 'fps', v: number): void }>()

const canvas = ref<HTMLCanvasElement | null>(null)
let gl: WebGL2RenderingContext | null = null
let raf = 0
let startTime = 0
let quality = 1
let dpr = 1

/* 命中停頓：爆光出現之後才凍。凍在「還沒亮」那一格是看不出來的，
   要凍在「已經炸開」那一格，畫面才會像被釘住。
   40–80ms 是動作遊戲的常用值，這裡是整段演出唯一的一次重擊，給到 110。 */
const HIT_STOP = 110
const HIT_DELAY = 55

/* 一顆粒子由連續 TRAIL 個索引組成，彼此只差一點時間偏移 ——
   沿軌跡排成一串就是拖尾。不另外畫線段，全部還在同一次 draw call 裡。 */
const TRAIL = 6
const BURST_HEADS = 520
const INHALE_HEADS = 150

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
uniform float uBurst;    // 爆發瞬間（秒）
uniform float uInt;      // 強度 0..1
uniform vec3  uTint;

float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float r = length(p);
  float ang = atan(p.y, p.x);

  float chg = clamp((uT - uCharge) / max(0.001, uBurst - uCharge), 0.0, 1.0);
  float bt = uT - uBurst;                       // 負數 = 還沒炸
  vec3 col = vec3(0.0);

  /* ---- 蓄力：向心速度線 ----
     Clove 早期那個「光線集中」演出被他們自己淘汰掉，理由是看不懂、結束太快。
     所以這裡的向心線**只在蓄力段出現而且要慢**，讓人讀得出核心在「吸」；
     爆發時才反轉成放射。快慢本身就是這兩段的區別。 */
  if (chg > 0.0 && bt < 0.0) {
    /* 角度切成扇區，但**只取扇區的正中央那一絲**（thin）。
       少了 thin 這一項，每一條線就是一整片實心扇形，
       畫面會變成一個風車，不是速度線。 */
    float sec = (ang + 3.14159) / 6.28318 * 110.0;
    float k = floor(sec);
    float thin = exp(-pow(fract(sec) - 0.5, 2.0) * 150.0);
    float seed = h11(k * 1.37);
    // 線的前緣往內推進：外側先出現，逐漸伸向核心
    float head = mix(0.90, 0.10, chg * chg * (0.55 + 0.45 * seed));
    float len = 0.10 + 0.22 * seed;
    float line = smoothstep(head + len, head, r) * smoothstep(head - 0.02, head + 0.05, r);
    // 只留下三分之一的角度扇區，全部都有的話會變成一圈實心漸層
    line *= step(0.66, seed) * thin;
    col += mix(uTint, vec3(1.0), 0.25) * line * chg * 1.5 * uInt;

    /* 蓄力時畫面往中間收暗：這是爆發的基準線。
       減法在加法混色裡做不到，改成把外圈的既有光壓掉 —— 靠 CSS 的
       radial vignette 做不到跟著時間走，所以這裡用「不加」而不是「減」，
       真正的壓暗交給外層 .charge 的背景。 */
    /* 核心的脈動。頻率隨蓄力升高 —— 心跳越來越快是「快要壓不住」最省的說法。
       亮度給得夠才讀得出「能量被壓進一個點」；太淡的話這一拍只會被讀成
       「畫面暗下來了」，蓄力就白做。 */
    float pulse = 0.5 + 0.5 * sin(uT * (14.0 + 26.0 * chg));
    col += mix(uTint, vec3(1.0), 0.35) * exp(-r * 5.0) * chg * chg
         * (0.55 + 0.85 * pulse) * uInt;
  }

  if (bt >= 0.0) {
    /* ---- 爆光 ----
       炸開那一格核心過曝到接近純白，其它細節全部看不見。
       「看不見」在這裡是替「太亮了」說話 —— 這是整段演出資訊量最低、
       但衝擊最強的一格。 */
    float flash = exp(-bt * 11.0) * uInt;
    /* 過曝要**集中在核心**。常數項給太大的話整片畫面（連四個角）一起變純白，
       那不是爆光而是換頁 —— 而且手機貼著臉看會刺眼。
       中心炸到爆表、邊緣只被照亮，才讀得出光是從一個點出來的。 */
    col += mix(uTint, vec3(1.0), 0.75) * flash * (0.20 + 3.4 * exp(-r * 4.0));

    /* ---- 衝擊波環 ----
       三環錯開。單環太乾淨，讀起來像一個圓在放大；
       錯開的三環才有「一股東西推出去」的厚度。
       半徑走 1-exp：一出手最快，之後迅速慢下來，這是爆震該有的速度曲線。 */
    for (int i = 0; i < 3; i++) {
      float rt = bt - float(i) * 0.09;
      if (rt <= 0.0) continue;
      float rad = 1.05 * (1.0 - exp(-rt * 4.2));
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

    /* ---- 放射狀速度線 ----
       跟蓄力那組共用角度雜湊，但方向相反、速度快得多。 */
    float sec = (ang + 3.14159) / 6.28318 * 150.0;
    float k = floor(sec);
    // 同樣只取扇區正中那一絲，而且越往外越細 —— 線要收斂到一個點才有速度感
    float thin = exp(-pow(fract(sec) - 0.5, 2.0) * (110.0 + 260.0 * r));
    float seed = h11(k * 2.11 + 7.0);
    float sp = 0.9 + 1.9 * seed;
    float head = bt * sp;
    float len = 0.18 + 0.30 * seed;
    float streak = smoothstep(head, head - len, r) * smoothstep(head + 0.03, head - 0.01, r);
    streak *= step(0.52, seed) * thin * exp(-bt * 3.8);
    col += mix(uTint, vec3(1.0), 0.35) * streak * 2.2 * uInt;

    /* ---- 暈影收縮 ----
       炸開瞬間四角壓黑、視野變窄，像瞳孔縮一下。
       加法混色壓不了黑，所以這裡做的是「中心額外亮一圈」，
       相對之下四角就暗。 */
    col += uTint * exp(-r * r * 5.0) * exp(-bt * 1.6) * 0.35 * uInt;
  }

  outColor = vec4(max(col, 0.0), 1.0);
}`

/* ---- pass 2：粒子 ---- */
const VERT_PT = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uT;
uniform float uCharge;
uniform float uBurst;
uniform float uInt;
uniform float uPx;        // 一個「舞台單位」等於幾個 framebuffer 畫素
uniform vec3  uTint;
uniform int   uInhale;    // 吸入粒子的顆數（頭數 × TRAIL）
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

  if (gl_VertexID < uInhale) {
    /* ---- 吸入 ----
       蓄力段被核心吸進去的碎屑。半徑走 f² 的反向 ——
       離核心越近掉得越快，這樣才像被拉進去，不是等速飄進去。 */
    float chg = (uT - uCharge) / max(0.001, uBurst - uCharge);
    if (chg > 0.0 && chg < 1.06) {
      float a = h11(id * 1.93) * 6.28318;
      float f = fract(chg * 1.7 + h11(id * 4.7));
      f = clamp(f + sub * 0.004, 0.0, 1.0);
      float rr = mix(0.75, 0.015, f * f);
      pos = vec2(cos(a), sin(a) * 0.85) * rr;
      // 頭一批要淡入，最後要在爆發前收乾淨，不然爆完還有東西在往內飛
      life = smoothstep(0.0, 0.12, chg) * (1.0 - smoothstep(0.92, 1.05, chg))
           * (1.0 - f * 0.35) * (1.0 - sub / uTrail * 0.6);
      size = uPx * (0.010 + 0.010 * h11(id * 8.1)) * (1.0 - sub / uTrail * 0.45);
      tone = mix(uTint, vec3(1.0), 0.25 * (1.0 - f));
    }
  } else {
    /* ---- 爆散 ----
       位移用 (1-e^-kt)/k：這是「初速 v、阻力係數 k」的解析解，
       所以粒子是一出手最快、之後被空氣拖住慢下來。
       等速直線會讀成煙火貼圖，沒有重量。 */
    float bid = id;
    /* 拖尾各影像之間的時間差要**小**。太大的話同一顆的四個影像之間拉開距離，
       畫面上看到的是一串虛線而不是一條尾巴 —— 0.024 就已經明顯斷開了。 */
    float t0 = uT - uBurst - sub * 0.0055 - h11(bid * 5.31) * 0.045;
    if (t0 > 0.0) {
      /* 有一成六的粒子是「餘燼」：飛不遠、活很久、還會慢慢往上飄。
         沒有它們的話爆炸一秒半就乾乾淨淨，卡片顯影那兩秒半畫面上
         除了卡什麼都沒有，餘韻就只是空白。 */
      float emb = step(0.84, h11(bid * 13.7));
      float a = h11(bid * 1.71) * 6.28318;
      /* 餘燼的速度**一定要各自不同**。給同一個常數的話它們會在同一個半徑
         同時停下來，畫面上出現一圈整齊的點 —— 那是最刺眼的程序生成破綻。 */
      float embSp = 0.07 + 0.30 * h11(bid * 7.73);
      float sp = mix(mix(0.5, 2.3, pow(h11(bid * 3.07), 2.2)) * (0.65 + 0.55 * uInt), embSp, emb);
      float k = 3.1;
      vec2 dir = vec2(cos(a), sin(a) * 0.82);
      pos = dir * sp * (1.0 - exp(-t0 * k)) / k;
      pos.y -= 0.10 * t0 * t0 * (1.0 - emb);      // 一點重力，餘韻時碎屑會垂下來
      // 餘燼相反：熱的東西往上飄。飄速也要各自不同，否則整群同步平移
      pos.y += emb * (0.012 + 0.055 * h11(bid * 21.1)) * t0;
      life = exp(-t0 * mix(1.35, 0.30, emb)) * (1.0 - sub / uTrail * 0.55)
           * mix(1.0, 0.55, emb);
      size = uPx * (0.006 + 0.014 * h11(bid * 9.7)) * (1.0 - sub / uTrail * 0.4)
           * (0.35 + 0.65 * exp(-t0 * 0.8)) * mix(1.0, 0.7, emb);
      // 剛炸出來是白熱的，之後才退回主色。溫度變化比亮度變化更像火。
      tone = mix(vec3(1.0), uTint, clamp(t0 * 1.5, 0.0, 1.0));
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
    而且分頁切換也會被算進去。凍的是餵給 shader 的那個數字。 */
function stageMs(el: number) {
  const b = props.burstAt + HIT_DELAY
  const hs = HIT_STOP * props.intensity
  if (el < b) return el
  if (el < b + hs) return b
  return el - hs
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
  const heads = quality ? BURST_HEADS : Math.floor(BURST_HEADS * 0.45)
  const inh = quality ? INHALE_HEADS : Math.floor(INHALE_HEADS * 0.45)
  const tint = props.tint

  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  gl.useProgram(progFs)
  gl.uniform2f(uFs.uRes!, gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uFs.uT!, t)
  gl.uniform1f(uFs.uCharge!, props.chargeAt / 1000)
  gl.uniform1f(uFs.uBurst!, (props.burstAt + HIT_DELAY) / 1000)
  gl.uniform1f(uFs.uInt!, props.intensity)
  gl.uniform3f(uFs.uTint!, tint[0], tint[1], tint[2])
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  gl.useProgram(progPt)
  gl.uniform2f(uPt.uRes!, gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uPt.uT!, t)
  gl.uniform1f(uPt.uCharge!, props.chargeAt / 1000)
  gl.uniform1f(uPt.uBurst!, (props.burstAt + HIT_DELAY) / 1000)
  gl.uniform1f(uPt.uInt!, props.intensity)
  gl.uniform1f(uPt.uPx!, gl.drawingBufferHeight)
  gl.uniform3f(uPt.uTint!, tint[0], tint[1], tint[2])
  gl.uniform1i(uPt.uInhale!, inh * TRAIL)
  gl.uniform1f(uPt.uTrail!, TRAIL)
  gl.drawArrays(gl.POINTS, 0, (heads + inh) * TRAIL)

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

  for (const k of ['uRes', 'uT', 'uCharge', 'uBurst', 'uInt', 'uTint']) {
    uFs[k] = g.getUniformLocation(progFs, k)
  }
  for (const k of ['uRes', 'uT', 'uCharge', 'uBurst', 'uInt', 'uPx', 'uTint', 'uInhale', 'uTrail']) {
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
