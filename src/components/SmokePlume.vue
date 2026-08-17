<script setup lang="ts">
/**
 * 煙霧羽流 —— 一團煙衝進畫面、翻捲、然後散開露出後面的東西。
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
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{
  /** 整段演出長度（毫秒）。煙的湧入與消散都攤在這段時間上 */
  duration?: number
  /** 煙的色調 [r,g,b]（0..1） */
  tint?: [number, number, number]
  /** 濃度倍率。1 = 完全遮住後面，調低可以讓卡片一直隱約看得到 */
  density?: number
}>(), { duration: 4600, tint: undefined, density: 1 })

const emit = defineEmits<{ (e: 'fail'): void; (e: 'fps', v: number): void }>()

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
uniform float uProg;      // 0..1 整段演出的進度
uniform float uQuality;
uniform vec3  uTint;
uniform float uDensity;

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
     1 整團往上飄（減 t）：煙有方向，雲氣沒有
     2 繞中心捲，內圈角速度比外圈快：這是 curl noise 的窮人版，煙才會「翻」
     3 域扭曲的強度大很多（2.6 vs 星雲的 3.2 但取樣頻率更高）：煙的邊緣要撕裂
*/
float smokeField(vec2 p, float t, int oct) {
  p.y -= t * 0.13;                                  // 上升流
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
  int oct = uQuality > 0.5 ? 4 : 2;

  /* 兩條互相獨立的時間曲線。
     burst  湧入：一團煙從畫面下方衝上來填滿畫面
     clear  消散：從中心先破開，再整體變薄

     兩條分開才控制得住 —— 用同一條曲線的話，煙會「進來又原路退回去」，
     看起來像倒放。真實的煙是進來之後在原地散掉的。 */
  float burst = smoothstep(0.0, 0.20, uProg);
  float clear = smoothstep(0.40, 1.0, uProg);

  /* 特徵尺寸隨進度變大 = 整團煙往鏡頭方向逼近。
     只有平移的話煙是「飄過去」，會放大才是「衝過來」。
     整組數值都往上抬過一次：尺寸太大的話一個畫面裡只剩三四團，
     細節不夠就不像煙像水彩暈開。 */
  float zoom = mix(3.10, 1.45, smoothstep(0.0, 0.75, uProg));

  float d = smokeField(p * zoom, uTime, oct);

  /* 湧入的前緣。從畫面下緣外面往上掃，掃過的地方才有煙。
     前緣本身用 smoothstep 給 0.4 的寬度，邊界才是一團煙而不是一條直線。 */
  float front = mix(-0.72, 1.10, burst);
  float wipe = 1.0 - smoothstep(front, front + 0.42, p.y);
  // 前緣附近多一點亂流，看起來才像在翻滾而不是一片布往上拉
  wipe *= 0.75 + 0.5 * fbm(p * 4.0 + vec2(0.0, uTime * 0.3), oct);
  d *= clamp(wipe, 0.0, 1.0);

  /* 消散：中心先破開一個洞（要露出來的東西在中心），再整體變薄。
     只做「整體變薄」的話煙會像一起淡出，讀不出「散開」。 */
  float rc = length(p * vec2(1.0, 0.78));
  float hole = clear * (1.0 - smoothstep(0.0, 0.62, rc)) * 1.35;
  d -= hole;

  /* 門檻決定「多少比例的畫面算是煙」。
     fbm 的值集中在 0.5 附近，門檻設 0.4 的話有一半以上的畫素直接變全透明 ——
     煙就只剩幾縷，遮不住後面的卡。起手要遮得住，門檻必須壓在分布下緣。 */
  float thr = mix(0.12, 0.80, clear);
  float alpha = smoothstep(thr, thr + 0.30, d);
  alpha *= (1.0 - clear * 0.45) * uDensity;

  /* 打光。
     光源在中心（卡片的位置），所以是背光：煙越靠近中心越亮，
     而且密度的「邊緣」最亮 —— 薄的地方光透得過去，厚的地方透不過。
     正統做法是朝光源再取樣一次密度算梯度，但那要多跑三次 fbm；
     用 alpha 的邊帶當梯度的近似，視覺幾乎一樣，成本是零。 */
  float glow = exp(-rc * 1.75);
  float rim = smoothstep(thr, thr + 0.09, d) - smoothstep(thr + 0.09, thr + 0.34, d);

  vec3 dark = vec3(0.035, 0.026, 0.062);
  vec3 col = mix(dark, uTint * 0.55, glow * 0.55);
  /* 自陰影：厚的地方擋住背後的光，所以越厚越暗。
     少了這一項，整片煙會是同一個中間調的紫 —— 看起來像紫色顏料不像煙。
     煙之所以讀得出體積，靠的就是「暗的body + 亮的邊」這個對比。 */
  col *= mix(1.0, 0.40, smoothstep(thr + 0.05, thr + 0.44, d));
  col += uTint * rim * (0.45 + 1.05 * glow);
  col += vec3(1.0, 0.93, 0.86) * rim * glow * glow * 0.8;   // 最靠近光源的邊緣接近白

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
  const scale = (quality ? 0.5 : 0.34) * dpr
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
let uQuality: WebGLUniformLocation | null = null
let uTint: WebGLUniformLocation | null = null
let uDensity: WebGLUniformLocation | null = null

let frames = 0
let measureStart = 0

function frame(now: number) {
  raf = requestAnimationFrame(frame)
  if (!gl || !program) return
  resize()

  const el = now - startTime
  const t = el / 1000
  const prog = Math.min(1, el / props.duration)

  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(program)
  gl.uniform2f(uRes, gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uTime, t)
  gl.uniform1f(uProg, prog)
  gl.uniform1f(uQuality, quality)
  const tint = props.tint ?? [0.55, 0.34, 0.92]
  gl.uniform3f(uTint, tint[0], tint[1], tint[2])
  gl.uniform1f(uDensity, props.density)
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
  uQuality = g.getUniformLocation(prog, 'uQuality')
  uTint = g.getUniformLocation(prog, 'uTint')
  uDensity = g.getUniformLocation(prog, 'uDensity')

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
  if (gl && program) gl.deleteProgram(program)
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
