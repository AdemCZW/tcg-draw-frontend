<script setup lang="ts">
/**
 * 立體開卡演出。
 *
 * 重點：整組結果共用「一個」WebGLRenderer。若每張卡各開一個 canvas，
 * 10 連抽就會逼近瀏覽器的 WebGL context 上限（約 8–16 個）並開始強制回收。
 *
 * 卡面用 CanvasTexture 程序生成（漸層 + 邊框 + 賞別 + 卡名），
 * 正式版換成 R2 實拍圖時只要改 faceTexture() 的來源即可。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { DrawResultItem, Tier } from '@/types/models'

const props = defineProps<{ items: DrawResultItem[] }>()
const emit = defineEmits<{ (e: 'revealed'): void }>()

const host = ref<HTMLDivElement | null>(null)
const fallback = ref(false)
const ctx = shallowRef<{ dispose: () => void } | null>(null)

const TIER_COLOR: Record<Tier, string> = {
  A: '#e0961b', B: '#8b6ff0', C: '#3aa5c9', D: '#a49a92', LAST: '#f73b20', BUST: '#1a1614'
}
const TIER_LABEL: Record<Tier, string> = {
  A: 'A 賞', B: 'B 賞', C: 'C 賞', D: 'D 賞', LAST: '最後賞', BUST: '爆賞'
}

function hueOf(image: string) {
  const m = image.match(/^placeholder:(\d+)/)
  return m ? Number(m[1]) : 220
}

/** 把卡面畫到 canvas 當貼圖 */
function faceCanvas(item: DrawResultItem) {
  const W = 512, H = 716
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')!
  const h = hueOf(item.card.image)

  g.fillStyle = `hsl(${h} 40% 93%)`
  g.fillRect(0, 0, W, H)
  const g1 = g.createRadialGradient(W * 0.25, H * 0.1, 0, W * 0.25, H * 0.1, W * 1.05)
  g1.addColorStop(0, `hsl(${h} 82% 86%)`)
  g1.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = g1; g.fillRect(0, 0, W, H)
  const g2 = g.createRadialGradient(W * 0.85, H * 0.95, 0, W * 0.85, H * 0.95, W * 1.05)
  g2.addColorStop(0, `hsl(${(h + 55) % 360} 72% 82%)`)
  g2.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = g2; g.fillRect(0, 0, W, H)

  // 內框
  g.strokeStyle = 'rgba(255,255,255,.8)'
  g.lineWidth = 6
  g.strokeRect(26, 26, W - 52, H - 52)

  // 賞別膠囊
  const label = TIER_LABEL[item.tier]
  g.font = '600 34px "Noto Sans TC", sans-serif'
  const tw = g.measureText(label).width
  g.fillStyle = TIER_COLOR[item.tier]
  const bx = 54, by = 56, bw = tw + 44, bh = 58
  g.beginPath(); g.roundRect(bx, by, bw, bh, 29); g.fill()
  g.fillStyle = item.tier === 'D' ? '#1a1614' : '#fff'
  g.textBaseline = 'middle'
  g.fillText(label, bx + 22, by + bh / 2 + 1)

  // 卡名（過長截斷）
  g.fillStyle = 'rgba(26,22,20,.88)'
  g.font = '500 40px "Noto Sans TC", sans-serif'
  let name = item.card.name
  while (g.measureText(name).width > W - 108 && name.length > 2) name = name.slice(0, -1)
  if (name !== item.card.name) name += '…'
  g.fillText(name, 54, H - 116)

  // 籤號
  g.fillStyle = 'rgba(26,22,20,.45)'
  g.font = '400 26px "IBM Plex Mono", monospace'
  g.fillText(item.bonus ? '加贈' : `籤 #${item.ticketSeq}`, 54, H - 66)

  // 浮水印
  g.fillStyle = 'rgba(26,22,20,.22)'
  g.font = '600 24px sans-serif'
  g.fillText('VD', W - 84, H - 66)

  return c
}

function backCanvas() {
  const W = 512, H = 716
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#f6f2f0'; g.fillRect(0, 0, W, H)
  g.strokeStyle = 'rgba(26,22,20,.10)'
  g.lineWidth = 3
  for (let i = -H; i < W; i += 26) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + H, H); g.stroke()
  }
  g.fillStyle = 'rgba(247,59,32,.9)'
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

  const cards: import('three').Group[] = []
  const n = props.items.length
  // 固定兩張並排，往下一列一列排 —— 卡片才不會因為連抽數多而縮到看不清
  const cols = Math.min(n, 2)
  const gapX = 1.62, gapY = 2.25

  props.items.forEach((item, i) => {
    const tex = new THREE.CanvasTexture(faceCanvas(item))
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
    disposables.push(tex)

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
