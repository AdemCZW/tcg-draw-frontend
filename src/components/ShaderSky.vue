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
  /** 光源（球）在畫面上的垂直位置，0 = 上緣、1 = 下緣。
      鏡頭光斑必須從真正的亮源長出來，對不上就只是一條莫名其妙的橫帶 */
  coreY?: number
}>(), { energy: 0.2, burst: false, coreY: 0.3 })

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
uniform float uCoreY;    // 亮源的垂直位置（shader 座標）

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
  /* 取樣座標先繞中心旋轉一點點，角速度隨半徑衰減 —— 這是 curl noise 的窮人版：
     不算向量場，直接讓內圈轉得比外圈快，雲氣就會「捲」而不只是平移。 */
  // 以光源（球）為中心的座標 —— 光暈與鏡頭光斑都要從這裡長出來
  vec2 pc = p - vec2(0.0, uCoreY);
  float rad = length(p);
  float rc = length(pc);
  float swirl = (0.55 / (rad + 0.35)) * (0.25 + 0.75 * uEnergy) * uTime * 0.045;
  float cs = cos(swirl), sn = sin(swirl);
  vec2 pw = mat2(cs, -sn, sn, cs) * p;

  vec2 q = vec2(fbm(pw * 1.7 + vec2(0.0, t), oct),
                fbm(pw * 1.7 + vec2(5.2, 1.3 - t), oct));
  float f = fbm(pw * 2.3 + 3.2 * q + vec2(1.7, 9.2) + t * 0.6, oct);

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

  /* 色差（chromatic aberration）。
     正統做法是把畫面在 R/G/B 三個位移各取樣一次 —— 但那代表噪聲要算三遍，
     這裡最貴的就是噪聲。改成「每個通道走稍微不同的色階門檻」：
     視覺結果同樣是邊緣出現紅／藍分離，成本是零。
     偏移量隨半徑增加，因為真實鏡頭的色散就是越靠邊越明顯。 */
  float ca = rad * 0.055 * (0.6 + 0.4 * uEnergy);

  vec3 col = deep;
  col = mix(col, cool, smoothstep(0.30, 0.86, f));
  col = mix(col, mid,  smoothstep(0.46, 0.96, f) * (0.30 + 0.45 * uEnergy));
  col = mix(col, hot,  smoothstep(0.62, 1.02, f) * (0.18 + 0.62 * uEnergy));
  col.r = mix(col.r, smoothstep(0.30 - ca, 0.86 - ca, f), 0.22);
  col.b = mix(col.b, smoothstep(0.30 + ca, 0.86 + ca, f), 0.22);

  /* 亮部溢出（就是 bloom 的本質）：只有最亮的一小撮才往外抹光。
     真的做 bloom 要離屏 blur 好幾趟，這裡讓亮處自己溢出。 */
  float core = smoothstep(0.70, 1.02, f);
  col += flare * pow(core, 2.0) * (0.20 + 0.72 * uEnergy);

  // ---- 中央的能量核 ----
  float d = rc;
  float halo = exp(-d * 3.2) * (0.06 + 0.38 * uEnergy);
  col += vec3(0.45, 0.28, 0.85) * halo;

  /* 變形鏡頭光斑（anamorphic flare）。
     就是電影裡那道水平藍色長條 —— 變形鏡頭把光斑在水平方向拉長的結果。
     做法很單純：把座標的 x 壓扁再取指數衰減，就得到一條又長又細的光。
     這是整組效果裡「電影感」訊號最強、成本最低的一個。 */
  float streak = exp(-abs(pc.x) * 2.6) * exp(-abs(pc.y) * 52.0);
  col += vec3(0.35, 0.62, 1.0) * streak * (0.10 + 0.75 * uEnergy);
  // 垂直方向給一道很淡的，避免看起來只有一根棒子
  float streakV = exp(-abs(pc.y) * 6.0) * exp(-abs(pc.x) * 96.0);
  col += vec3(0.5, 0.7, 1.0) * streakV * (0.05 + 0.3 * uEnergy);

  /* 暈光（halation）：亮部往周圍滲出的暖色。
     底片上強光會穿透乳劑再從背面反射回來，形成偏紅的暈 ——
     數位相機沒有，所以它是很強的「這是底片」訊號。 */
  float glowMask = smoothstep(0.55, 1.0, f) + streak * 0.8 + halo;
  col += vec3(1.0, 0.42, 0.26) * glowMask * glowMask * 0.06 * (0.4 + 0.6 * uEnergy);

  // ---- 爆發衝擊：一圈往外擴散的亮環 ----
  if (uBurst >= 0.0) {
    float bt = uBurst;
    float ring = exp(-pow((rc - bt * 1.5) * 7.0, 2.0));   // 高斯環，從光源擴散
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
  /* 底片顆粒。關鍵是「暗部顆粒重、亮部細」—— 整片同量的雜訊看起來像壞掉的螢幕，
     隨亮度衰減才像底片。順便打散漸層的色帶。 */
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  float grain = hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
  col += grain * mix(0.055, 0.012, smoothstep(0.0, 0.5, lum));

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
let uCoreY: WebGLUniformLocation | null = null

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
  // coreY 從「畫面比例」換算成 shader 座標（y 向上、以中心為 0）
  gl.uniform1f(uCoreY, 0.5 - props.coreY)
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
  uCoreY = g.getUniformLocation(prog, 'uCoreY')

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
