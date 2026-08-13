<script setup lang="ts">
/**
 * 立體開卡演出。
 *
 * 重點：整組結果共用「一個」WebGLRenderer。若每張卡各開一個 canvas，
 * 10 連抽就會逼近瀏覽器的 WebGL context 上限（約 8–16 個）並開始強制回收。
 *
 * 卡面優先用真實卡圖（賣家實拍 / PSA / TCGdex），載不到才退回程序生成的
 * 漸層卡面。兩者都會在上面疊賞別膠囊與籤號，維持一致的識別資訊。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { DrawResultItem, Tier } from '@/types/models'
import { canonicalArt } from '@/lib/tcgdex'

const props = defineProps<{ items: DrawResultItem[] }>()
const emit = defineEmits<{ (e: 'revealed'): void }>()

const host = ref<HTMLDivElement | null>(null)
const fallback = ref(false)
const ctx = shallowRef<{ dispose: () => void } | null>(null)

/**
 * canvas 沒辦法直接用 CSS 變數，但把顏色寫死就會在切換主題時整組失效
 * （淺色卡面出現在深色介面上）。改成繪製當下即時讀取權杖值，
 * 卡面就自動跟著主題走，也不必再維護第二組顏色常數。
 */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

const TIER_VAR: Record<Tier, [string, string]> = {
  A: ['--tier-a', '#e0961b'],
  B: ['--tier-b', '#8b6ff0'],
  C: ['--tier-c', '#3aa5c9'],
  D: ['--tier-d', '#a49a92'],
  LAST: ['--tier-last', '#f73b20'],
  BUST: ['--faint', '#8c94a1']
}
const tierColor = (t: Tier) => token(...TIER_VAR[t])

/**
 * 卡面底色要跟著主題明暗翻轉，否則深色介面上會出現一片刺眼白卡。
 *
 * 不去判斷 data-theme 或 prefers-color-scheme —— 那等於把主題規則抄第二份，
 * 之後改 tokens.css 這裡就會不同步。直接量測 --surface 的亮度，
 * 不論主題怎麼定義，結果永遠一致。
 */
function surfaceIsDark(): boolean {
  const c = token('--surface', '#ffffff')
  const m = c.match(/^#?([0-9a-f]{6})$/i)
  if (!m) return false
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  // 相對亮度（Rec. 709），0.5 以下視為深色
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
}

const TIER_LABEL: Record<Tier, string> = {
  A: 'A 賞', B: 'B 賞', C: 'C 賞', D: 'D 賞', LAST: '最後賞', BUST: '爆賞'
}

function hueOf(image: string) {
  const m = image.match(/^placeholder:(\d+)/)
  return m ? Number(m[1]) : 220
}

/**
 * 把卡面畫到 canvas 當貼圖。
 * art 有值時鋪成底圖（cover 裁切保持比例），否則用原本的漸層底。
 * 兩種情況都會疊上賞別與籤號，讓識別資訊一致。
 */
function faceCanvas(item: DrawResultItem, art?: HTMLImageElement) {
  const W = 512, H = 716
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')!

  if (art) {
    /* 卡圖本身已經有豐富的文字與圖案，直接把資訊疊上去會互相打架。
       改成：卡圖等比縮小置中，下方留一條純色資訊帶放賞別與籤號。 */
    const BAND = 132                      // 底部資訊帶高度
    const areaH = H - BAND
    /* 襯底刻意固定深色、不跟隨主題：寶可夢卡圖本身多半是深色邊框，
       淺色襯底會在卡緣切出一圈突兀的白邊。這是設計選擇不是漏掉的權杖。 */
    const mat = '#141210'
    g.fillStyle = mat
    g.fillRect(0, 0, W, H)
    const scale = Math.min(W / art.width, areaH / art.height)
    const dw = art.width * scale, dh = art.height * scale
    g.drawImage(art, (W - dw) / 2, (areaH - dh) / 2, dw, dh)

    // 資訊帶
    g.fillStyle = mat
    g.fillRect(0, areaH, W, BAND)

    const label = TIER_LABEL[item.tier]
    g.font = '600 32px "Noto Sans TC", sans-serif'
    const tw = g.measureText(label).width
    g.fillStyle = tierColor(item.tier)
    const bw = tw + 40, bh = 52
    g.beginPath(); g.roundRect(40, areaH + 24, bw, bh, 26); g.fill()
    g.fillStyle = item.tier === 'D' ? mat : '#fff'
    g.textBaseline = 'middle'
    g.fillText(label, 40 + 20, areaH + 24 + bh / 2 + 1)

    // 籤號靠右，跟膠囊同一條基線
    g.fillStyle = 'rgba(255,255,255,.62)'
    g.font = '400 26px "IBM Plex Mono", monospace'
    const seq = item.bonus ? '加贈' : `籤 #${item.ticketSeq}`
    g.textAlign = 'right'
    g.fillText(seq, W - 40, areaH + 24 + bh / 2 + 1)
    g.textAlign = 'left'

    // 卡名放資訊帶下半，過長截斷
    g.fillStyle = '#fff'
    g.font = '500 34px "Noto Sans TC", sans-serif'
    let nm = item.card.name
    while (g.measureText(nm).width > W - 80 && nm.length > 2) nm = nm.slice(0, -1)
    if (nm !== item.card.name) nm += '…'
    g.fillText(nm, 40, areaH + 100)

    return c
  } else {
    const h = hueOf(item.card.image)
    const dark = surfaceIsDark()
    // 同一組色相，深色主題下把明度整組壓低、彩度略提，才不會變成灰霧
    const base = dark ? `hsl(${h} 26% 13%)` : `hsl(${h} 40% 93%)`
    const spot1 = dark ? `hsl(${h} 58% 26%)` : `hsl(${h} 82% 86%)`
    const spot2 = dark ? `hsl(${(h + 55) % 360} 52% 24%)` : `hsl(${(h + 55) % 360} 72% 82%)`
    const fade = dark ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)'

    g.fillStyle = base
    g.fillRect(0, 0, W, H)
    const g1 = g.createRadialGradient(W * 0.25, H * 0.1, 0, W * 0.25, H * 0.1, W * 1.05)
    g1.addColorStop(0, spot1)
    g1.addColorStop(1, fade)
    g.fillStyle = g1; g.fillRect(0, 0, W, H)
    const g2 = g.createRadialGradient(W * 0.85, H * 0.95, 0, W * 0.85, H * 0.95, W * 1.05)
    g2.addColorStop(0, spot2)
    g2.addColorStop(1, fade)
    g.fillStyle = g2; g.fillRect(0, 0, W, H)

    // 內框
    g.strokeStyle = dark ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.8)'
    g.lineWidth = 6
    g.strokeRect(26, 26, W - 52, H - 52)
  }

  // 賞別膠囊
  const label = TIER_LABEL[item.tier]
  g.font = '600 34px "Noto Sans TC", sans-serif'
  const tw = g.measureText(label).width
  g.fillStyle = tierColor(item.tier)
  const bx = 54, by = 56, bw = tw + 44, bh = 58
  g.beginPath(); g.roundRect(bx, by, bw, bh, 29); g.fill()
  const darkFace = surfaceIsDark()
  const ink = darkFace ? '255,255,255' : '26,22,20'
  g.fillStyle = item.tier === 'D' && !darkFace ? '#1a1614' : '#fff'
  g.textBaseline = 'middle'
  g.fillText(label, bx + 22, by + bh / 2 + 1)

  // 以下只走「無卡圖」的程序卡面（有圖的路徑已在上方 return）
  // 卡名（過長截斷）
  g.fillStyle = `rgba(${ink},.9)`
  g.font = '500 40px "Noto Sans TC", sans-serif'
  let name = item.card.name
  while (g.measureText(name).width > W - 108 && name.length > 2) name = name.slice(0, -1)
  if (name !== item.card.name) name += '…'
  g.fillText(name, 54, H - 116)

  // 籤號
  g.fillStyle = `rgba(${ink},.5)`
  g.font = '400 26px "IBM Plex Mono", monospace'
  g.fillText(item.bonus ? '加贈' : `籤 #${item.ticketSeq}`, 54, H - 66)

  // 浮水印
  g.fillStyle = `rgba(${ink},.24)`
  g.font = '600 24px sans-serif'
  g.fillText('VD', W - 84, H - 66)

  return c
}

function backCanvas() {
  const W = 512, H = 716
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = token('--surface-2', '#f6f2f0'); g.fillRect(0, 0, W, H)
  g.strokeStyle = surfaceIsDark() ? 'rgba(255,255,255,.07)' : 'rgba(26,22,20,.10)'
  g.lineWidth = 3
  for (let i = -H; i < W; i += 26) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + H, H); g.stroke()
  }
  g.fillStyle = token('--accent', '#f73b20')
  g.font = '600 64px sans-serif'
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText('VD', W / 2, H / 2)
  return c
}

onMounted(async () => {
  const el = host.value
  if (!el || !props.items.length) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { fallback.value = true; return }

  let THREE: typeof import('three')
  try { THREE = await import('three') } catch { fallback.value = true; return }

  let renderer: import('three').WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
  } catch { fallback.value = true; return }

  const root = el
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'
  root.appendChild(renderer.domElement)

  // ---- 幾何：圓角卡板 ----
  const W = 1.28, H = 1.79, R = 0.1, D = 0.035
  const shape = new THREE.Shape()
  shape.moveTo(-W / 2 + R, -H / 2)
  shape.lineTo(W / 2 - R, -H / 2)
  shape.quadraticCurveTo(W / 2, -H / 2, W / 2, -H / 2 + R)
  shape.lineTo(W / 2, H / 2 - R)
  shape.quadraticCurveTo(W / 2, H / 2, W / 2 - R, H / 2)
  shape.lineTo(-W / 2 + R, H / 2)
  shape.quadraticCurveTo(-W / 2, H / 2, -W / 2, H / 2 - R)
  shape.lineTo(-W / 2, -H / 2 + R)
  shape.quadraticCurveTo(-W / 2, -H / 2, -W / 2 + R, -H / 2)
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: D, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2, curveSegments: 10
  })
  geo.center()
  // ExtrudeGeometry 的 UV 不適合貼圖，用平面投影重算
  const pos = geo.attributes.position
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + W / 2) / W
    uv[i * 2 + 1] = (pos.getY(i) + H / 2) / H
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))

  const backTex = new THREE.CanvasTexture(backCanvas())
  backTex.colorSpace = THREE.SRGBColorSpace
  const disposables: { dispose(): void }[] = [geo, backTex]
  // 擋掉還在飛的卡圖請求，避免載入後寫進已銷毀的 texture
  let disposed = false

  const cards: import('three').Group[] = []
  const n = props.items.length
  // 固定兩張並排，往下一列一列排 —— 卡片才不會因為連抽數多而縮到看不清
  const cols = Math.min(n, 2)
  const gapX = 1.62, gapY = 2.25

  props.items.forEach((item, i) => {
    // 先用程序卡面立刻上場（不擋動畫），真實卡圖載到後再重繪貼圖換上
    const tex = new THREE.CanvasTexture(faceCanvas(item))
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
    disposables.push(tex)

    canonicalArt(item.card.name).then(url => {
      if (disposed || !url) return
      const img = new Image()
      img.crossOrigin = 'anonymous'   // 沒設會污染 canvas，texture 讀不出來
      img.onload = () => {
        if (disposed) return
        // 直接替換同一張 texture 的來源，材質不用重建
        tex.image = faceCanvas(item, img)
        tex.needsUpdate = true
      }
      img.onerror = () => { /* 載不到就保留程序卡面 */ }
      img.src = url
    })

    const rare = item.tier === 'A' || item.tier === 'LAST'
    const faceMat = new THREE.MeshPhysicalMaterial({
      map: tex,
      roughness: rare ? 0.16 : 0.42,
      metalness: rare ? 0.42 : 0.1,
      clearcoat: 1,
      clearcoatRoughness: rare ? 0.06 : 0.28,
      iridescence: rare ? 1 : 0.35,
      iridescenceIOR: rare ? 1.8 : 1.4,
      iridescenceThicknessRange: [140, 700],
      // 稀有卡整面微微自發光，比打一顆聚光燈自然
      emissive: new THREE.Color(rare ? (item.tier === 'LAST' ? 0xf73b20 : 0xe0961b) : 0x000000),
      emissiveIntensity: 0
    })
    const backMat = new THREE.MeshPhysicalMaterial({
      map: backTex, roughness: 0.5, metalness: 0.05, clearcoat: 0.6
    })
    disposables.push(faceMat, backMat)

    // ExtrudeGeometry 的 group 0 = 正反面, group 1 = 側邊
    const mesh = new THREE.Mesh(geo, [faceMat, backMat])
    const g = new THREE.Group()
    g.add(mesh)

    const col = i % cols
    const row = Math.floor(i / cols)
    const rows = Math.ceil(n / cols)
    const inRow = Math.min(cols, n - row * cols)
    g.userData = {
      homeX: (col - (inRow - 1) / 2) * gapX,
      homeY: -(row - (rows - 1) / 2) * gapY,
      delay: 0.18 + i * 0.16,
      rare,
      faceMat
    }
    g.position.set(g.userData.homeX, g.userData.homeY, 0)
    g.rotation.y = Math.PI     // 先背面朝前
    scene.add(g)
    cards.push(g)

    if (rare) {
      // 光源擺在卡片「後方」當背光暈 —— 放在正前方近距離會在卡面燒出光斑
      const glow = new THREE.PointLight(item.tier === 'LAST' ? 0xf73b20 : 0xe0961b, 0, 6, 1.6)
      glow.position.set(g.userData.homeX, g.userData.homeY, -1.4)
      scene.add(glow)
      g.userData.glow = glow
    }
  })

  // Object3D.position 是唯讀屬性，只能用 .set() —— Object.assign 會拋錯
  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(3, 5, 7)
  const fillL = new THREE.DirectionalLight(0x9b7ef5, 1.3)
  fillL.position.set(-5, 2, 4)
  const warm = new THREE.DirectionalLight(0xf73b20, 0.9)
  warm.position.set(4, -3, 3)
  scene.add(new THREE.AmbientLight(0xffffff, 1.35), key, fillL, warm)

  // 依卡片數量把相機拉到剛好框住
  const rows = Math.ceil(n / cols)
  const spanX = cols * gapX
  const spanY = rows * gapY
  function fit() {
    const w = root.clientWidth, h = root.clientHeight
    if (!w || !h) return
    camera.aspect = w / h
    const fovR = (camera.fov * Math.PI) / 180
    const distY = (spanY / 2) / Math.tan(fovR / 2)
    const distX = (spanX / 2) / Math.tan(fovR / 2) / camera.aspect
    camera.position.z = Math.max(distX, distY) * 1.06
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }
  const ro = new ResizeObserver(fit)
  ro.observe(root)
  fit()

  // 游標視差
  const ptr = { x: 0, y: 0 }, tgt = { x: 0, y: 0 }
  const onMove = (e: PointerEvent) => {
    const r = root.getBoundingClientRect()
    tgt.x = ((e.clientX - r.left) / r.width - 0.5) * 2
    tgt.y = ((e.clientY - r.top) / r.height - 0.5) * 2
  }
  root.addEventListener('pointermove', onMove, { passive: true })
  const onLeave = () => { tgt.x = 0; tgt.y = 0 }
  root.addEventListener('pointerleave', onLeave)

  let visible = true
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting }, { threshold: 0.01 })
  io.observe(root)

  const t0 = performance.now()
  let raf = 0
  let done = false
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

  function tick() {
    raf = requestAnimationFrame(tick)
    if (!visible) return
    const t = (performance.now() - t0) / 1000
    ptr.x += (tgt.x - ptr.x) * 0.06
    ptr.y += (tgt.y - ptr.y) * 0.06

    let allDone = true
    for (const g of cards) {
      const { delay, homeX, homeY, rare, glow, faceMat } = g.userData as any
      const p = Math.min(1, Math.max(0, (t - delay) / 0.9))
      if (p < 1) allDone = false
      const e = easeOut(p)

      // 翻面 + 朝鏡頭拱起再落位
      g.rotation.y = Math.PI * (1 - e) + ptr.x * 0.26 * e
      g.rotation.x = -ptr.y * 0.2 * e + (1 - e) * 0.3
      g.position.z = Math.sin(Math.PI * p) * 1.5
      g.position.x = homeX
      g.position.y = homeY + Math.sin(Math.PI * p) * 0.18
      // 落位後緩慢呼吸浮動
      if (p >= 1) g.position.y = homeY + Math.sin(t * 0.9 + homeX) * 0.045
      if (glow) glow.intensity = e * (3.2 + Math.sin(t * 2.2) * 1.1)
      if (rare && faceMat) faceMat.emissiveIntensity = e * (0.13 + Math.sin(t * 2.2) * 0.06)
    }
    if (allDone && !done) { done = true; emit('revealed') }

    camera.position.x = ptr.x * 0.5
    camera.position.y = -ptr.y * 0.35
    camera.lookAt(0, 0, 0)
    renderer.render(scene, camera)
  }
  tick()

  ctx.value = {
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerleave', onLeave)
      ro.disconnect(); io.disconnect()
      for (const d of disposables) d.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }
})

onBeforeUnmount(() => { ctx.value?.dispose(); ctx.value = null })
</script>

<template>
  <div class="reveal3d" :class="{ fallback }">
    <div ref="host" class="host" aria-hidden="true"></div>
    <slot v-if="fallback" name="fallback" />
  </div>
</template>

<style scoped>
.reveal3d { position: relative; width: 100%; height: 100%; }
.host { position: absolute; inset: 0; }
.fallback .host { display: none; }
</style>
