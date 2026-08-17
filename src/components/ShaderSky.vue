<script setup lang="ts">
/**
 * 著色器星空 —— 形象頁的背景由 GPU 每一幀即時算出來，不是預先做好的漸層。
 *
 * 為什麼不用 three.js：全螢幕背景只需要一個覆蓋畫面的三角形 + 一支 fragment
 * shader。原生 WebGL2 約一百行、0 KB 相依；為了畫背景在「使用者看到的第一頁」
 * 載入 717 KB 的 three.js 不划算。輝光也不用 UnrealBloomPass（要多個 render
 * target，手機上很貴）—— 亮部溢出直接寫在 shader 的數學裡。
 *
 * 效能三件事（這條路真正的成本都在這）：
 *  1. 降解析度算。星雲全是低頻訊號，用 0.55 倍算完再讓 CSS 放大，看不出來，
 *     但 fragment 數量少一半以上 —— 這是最有效的一刀
 *  2. 分頁看不見就停。背景動畫在背景分頁燒 GPU 是純粹浪費電
 *  3. 前 30 幀量一次實際幀率，太慢就自己降級（減少 octave 並再降解析度）
 *
 * 拿不到 WebGL2 就發 fail，讓外層退回純 CSS 那版。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** 這一幕的能量 0..1，由外層的分幕機餵進來 */
  energy?: number
  /** 爆發那一拍設 true，shader 會給一記衝擊 */
  burst?: boolean
}>(), { energy: 0.2, burst: false })

const emit = defineEmits<{ (e: 'fail'): void; (e: 'fps', v: number): void }>()

const canvas = ref<HTMLCanvasElement | null>(null)
let gl: WebGL2RenderingContext | null = null
let raf = 0
let program: WebGLProgram | null = null
let startTime = 0
let burstAt = -999

/* 目標能量與實際能量分開：幕次是瞬間切換的，但畫面要滑過去 */
let energyNow = 0
let quality = 1        // 1 = 全效，0 = 降級
let dpr = 1

const VERT = `#version 300 es
void main() {
  // 用一個覆蓋畫面的大三角形，不用兩個三角形的 quad ——
  // 少一條對角線接縫，GPU 也少跑一次頂點
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uEnergy;   // 0..1 這一幕的能量
uniform float uBurst;    // 爆發後經過的秒數，負值代表沒發生
uniform float uQuality;  // 1 全效 / 0 降級

// ---- 噪聲：value noise + fbm ----
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);          // smoothstep 插值
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p, int oct) {
  float v = 0.0, amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    v += amp * noise(p);
    p *= 2.02;                           // 非整數倍避免格狀圖樣
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;  // 置中且不隨長寬比變形

  float t = uTime * 0.035;
  int oct = uQuality > 0.5 ? 4 : 2;

  /* 域扭曲（domain warping）：用一層 fbm 擾動下一層的取樣座標，
     噪聲才會像「流動的雲」而不是「靜態的斑點」。

     教科書寫法是兩層扭曲（q → r → f），一個像素要算五次 fbm，
     每次最多五個 octave = 25 次噪聲取樣。實測在這台上會掉到自動降級的門檻。
     砍成一層扭曲（q → f）只要三次 fbm，少四成成本，
     而雲氣的有機感幾乎看不出差別 —— 第二層扭曲的貢獻主要在極近距離的細節，
     全螢幕背景根本看不到。 */
  vec2 q = vec2(fbm(p * 1.7 + vec2(0.0, t), oct),
                fbm(p * 1.7 + vec2(5.2, 1.3 - t), oct));
  float f = fbm(p * 2.3 + 3.2 * q + vec2(1.7, 9.2) + t * 0.6, oct);

  /* 配色。
     這裡的關鍵不是「亮」而是「對比」：星雲要大片暗、少數地方很亮。
     第一版把門檻設得太低（0.15 起就開始上色），fbm 的值大多落在 0.3~0.6，
     結果整個畫面被中等亮度的紫填滿，前景的字和卡全被洗掉。
     把門檻往上推、把底色壓更暗，亮的地方才會「亮起來」。 */
  vec3 deep  = vec3(0.022, 0.014, 0.052);
  vec3 cool  = vec3(0.23, 0.13, 0.56);
  vec3 mid   = vec3(0.12, 0.36, 0.82);
  vec3 hot   = vec3(0.90, 0.38, 0.70);
  vec3 flare = vec3(1.00, 0.82, 0.55);

  vec3 col = deep;
  col = mix(col, cool, smoothstep(0.30, 0.86, f));
  col = mix(col, mid,  smoothstep(0.46, 0.96, f) * (0.30 + 0.45 * uEnergy));
  col = mix(col, hot,  smoothstep(0.62, 1.02, f) * (0.18 + 0.62 * uEnergy));

  /* 亮部溢出（就是 bloom 的本質）：只有最亮的一小撮才往外抹光。
     真的做 bloom 要離屏 blur 好幾趟，這裡讓亮處自己溢出。 */
  float core = smoothstep(0.70, 1.02, f);
  col += flare * pow(core, 2.0) * (0.20 + 0.72 * uEnergy);

  // ---- 中央的能量核 ----
  float d = length(p);
  float halo = exp(-d * 3.2) * (0.06 + 0.38 * uEnergy);
  col += vec3(0.45, 0.28, 0.85) * halo;

  // ---- 爆發衝擊：一圈往外擴散的亮環 ----
  if (uBurst >= 0.0) {
    float bt = uBurst;
    float ring = exp(-pow((d - bt * 1.5) * 7.0, 2.0));    // 高斯環
    float decay = exp(-bt * 1.6);
    col += flare * ring * decay * 1.6;
    col += flare * exp(-bt * 6.0) * 0.30;                  // 起手的白閃
  }

  /* 這裡刻意不畫星點。
     降解析度渲染只對「低頻」內容成立 —— 星雲是大片柔和的漸變，放大回去看不出來；
     星點是單像素的高頻訊號，用 0.38 倍算完再放大，每顆會變成一塊糊掉的方格。
     星星交給全解析度的 CSS 圖層畫，各自做各自擅長的事。 */

  // ---- 收尾：四角壓暗 + 輕微顆粒 ----
  float vig = smoothstep(1.20, 0.26, length((uv - 0.5) * vec2(1.15, 1.0)));
  col *= 0.24 + 0.76 * vig;
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.016;   // 打散色帶

  outColor = vec4(max(col, 0.0), 1.0);
}`

function compile(g: WebGL2RenderingContext, type: number, src: string) {
  const sh = g.createShader(type)!
  g.shaderSource(sh, src)
  g.compileShader(sh)
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    console.warn('[ShaderSky]', g.getShaderInfoLog(sh))
    g.deleteShader(sh)
    return null
  }
  return sh
}

function resize() {
  const c = canvas.value
  if (!c || !gl) return
  // 降解析度算：星雲全是低頻訊號，放大回去看不出差別
  const scale = (quality ? 0.55 : 0.38) * dpr
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
let uEnergy: WebGLUniformLocation | null = null
let uBurst: WebGLUniformLocation | null = null
let uQuality: WebGLUniformLocation | null = null

let frames = 0
let measureStart = 0

function frame(now: number) {
  raf = requestAnimationFrame(frame)
  if (!gl || !program) return
  resize()

  const t = (now - startTime) / 1000
  // 能量滑向目標，幕次切換才不會是硬跳
  energyNow += (props.energy - energyNow) * 0.02

  gl.useProgram(program)
  gl.uniform2f(uRes, gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uTime, t)
  gl.uniform1f(uEnergy, energyNow)
  gl.uniform1f(uBurst, burstAt < 0 ? -1 : t - burstAt)
  gl.uniform1f(uQuality, quality)
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  /* 開頭量一次真實幀率。低於 40fps 就降級 —— 與其讓整頁卡，
     不如少兩層 octave、再降解析度，視覺差別遠小於掉幀的痛。 */
  if (quality && measureStart) {
    frames++
    const el = now - measureStart
    if (el > 1200) {
      const fps = (frames / el) * 1000
      emit('fps', Math.round(fps))
      if (fps < 40) { quality = 0; resize() }
      measureStart = 0
    }
  }
}

onMounted(() => {
  const c = canvas.value
  if (!c) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)

  const g = c.getContext('webgl2', {
    antialias: false,          // 全螢幕漸層不需要 MSAA，省頻寬
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: true   // 軟體渲染就別跑，直接退回 CSS
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
    console.warn('[ShaderSky] link', g.getProgramInfoLog(prog))
    emit('fail')
    return
  }
  program = prog
  uRes = g.getUniformLocation(prog, 'uRes')
  uTime = g.getUniformLocation(prog, 'uTime')
  uEnergy = g.getUniformLocation(prog, 'uEnergy')
  uBurst = g.getUniformLocation(prog, 'uBurst')
  uQuality = g.getUniformLocation(prog, 'uQuality')

  energyNow = props.energy
  startTime = performance.now()
  measureStart = startTime
  resize()
  raf = requestAnimationFrame(frame)

  document.addEventListener('visibilitychange', onVis)
})

/* 分頁看不見就停。rAF 本來就會被節流，但明確停掉才是真的不耗電；
   這裡停掉沒有副作用 —— 背景視覺不需要在使用者看不到時繼續推進。 */
function onVis() {
  if (document.hidden) {
    cancelAnimationFrame(raf)
    raf = 0
  } else if (!raf) {
    raf = requestAnimationFrame(frame)
  }
}

watch(() => props.burst, on => {
  if (on && gl) burstAt = (performance.now() - startTime) / 1000
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  document.removeEventListener('visibilitychange', onVis)
  if (gl && program) gl.deleteProgram(program)
  gl = null
})
</script>

<template>
  <canvas ref="canvas" class="sky3d" aria-hidden="true"></canvas>
</template>

<style scoped>
.sky3d {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  display: block;
  /* 低解析度的畫面放大回來，讓瀏覽器平滑內插 */
  image-rendering: auto;
}
</style>
