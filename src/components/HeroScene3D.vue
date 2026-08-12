<script setup lang="ts">
/**
 * 首頁 3D banner：雙層環繞的鑑定卡群 + 粒子塵光 + 泛光後製。
 *
 * 幾個讓畫面「有質感」的關鍵：
 *  1. 環境貼圖（RoomEnvironment）—— 沒有它，iridescence 沒東西可反射，會顯得平。
 *  2. ACESFilmic 色調映射 —— 讓高光滾出漸層而不是死白。
 *  3. UnrealBloom —— 只在效能足夠的裝置開，手機吃不消。
 *
 * three 動態載入不進首屏；prefers-reduced-motion 或無 WebGL 時退回靜態漸層。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

/**
 * 經典角色卡面（象徵性展示，非特定實體卡）。
 *
 * 這裡刻意寫死網址而不走 canonicalArt() 搜尋：
 *  1. 搜尋要先打一次 API 再載圖，12 張就是 12 次額外往返 —— 卡片會慢半拍才出現
 *  2. 部分角色（快龍、耿鬼、迷唇姐…）在 TCGdex 繁中庫查得到卡但沒有圖，
 *     搜尋會回 null，那幾張就永遠停在空白色塊
 * 以下 12 組皆已實測回 200 且確實有圖。
 */
const CLASSIC_ART = [
  'https://assets.tcgdex.net/zh-tw/SV/SVF/001/low.webp',  // 光輝噴火龍
  'https://assets.tcgdex.net/zh-tw/SV/SVC/001/low.webp',  // 皮卡丘
  'https://assets.tcgdex.net/zh-tw/S/S8a/002/low.webp',   // 夢幻
  'https://assets.tcgdex.net/zh-tw/SV/SVEM/001/low.webp', // 超夢
  'https://assets.tcgdex.net/zh-tw/S/SCB/001/low.webp',   // 妙蛙花
  'https://assets.tcgdex.net/zh-tw/SV/SV2a/009/low.webp', // 水箭龜
  'https://assets.tcgdex.net/zh-tw/S/SDL/005/low.webp',   // 風速狗
  'https://assets.tcgdex.net/zh-tw/S/S8a/004/low.webp',   // 鳳王
  'https://assets.tcgdex.net/zh-tw/S/S8a/005/low.webp',   // 洛奇亞
  'https://assets.tcgdex.net/zh-tw/S/SLL/004/low.webp',   // 路卡利歐
  'https://assets.tcgdex.net/zh-tw/S/S6a/002/low.webp',   // 伊布
  'https://assets.tcgdex.net/zh-tw/SV/SV3a/002/low.webp'  // 拉普拉斯
]

const host = ref<HTMLDivElement | null>(null)
const ready = ref(false)
const failed = ref(false)

// three 物件放 shallowRef —— 讓 Vue 不要遞迴代理整個場景圖（會嚴重拖慢）
const ctx = shallowRef<{ dispose: () => void } | null>(null)

onMounted(async () => {
  const el = host.value
  if (!el) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { failed.value = true; return }

  let THREE: typeof import('three')
  try { THREE = await import('three') } catch { failed.value = true; return }

  let renderer: import('three').WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
  } catch { failed.value = true; return }

  const root: HTMLDivElement = el
  const dpr = Math.min(window.devicePixelRatio, 2)
  // 泛光很吃 fill rate，窄螢幕與低核心數裝置直接關掉
  const rich = window.innerWidth >= 900 && (navigator.hardwareConcurrency ?? 4) >= 6

  renderer.setPixelRatio(dpr)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.92
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'
  root.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  camera.position.set(0, 0, 13)

  // ---- 環境貼圖：讓金屬與虹彩有東西可反射 ----
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js')
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = envRT.texture

  // ---- 卡片幾何 ----
  function slab(w: number, h: number, r: number, depth: number) {
    const s = new THREE.Shape()
    s.moveTo(-w / 2 + r, -h / 2)
    s.lineTo(w / 2 - r, -h / 2)
    s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r)
    s.lineTo(w / 2, h / 2 - r)
    s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2)
    s.lineTo(-w / 2 + r, h / 2)
    s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r)
    s.lineTo(-w / 2, -h / 2 + r)
    s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2)
    return new THREE.ExtrudeGeometry(s, {
      depth, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 3, curveSegments: 10
    })
  }
  const SLAB_W = 1.75, SLAB_H = 2.45
  const geo = slab(SLAB_W, SLAB_H, 0.15, 0.07)
  geo.center()
  // ExtrudeGeometry 預設 UV 不適合直接貼卡圖（會拉伸/重複），跟 CardReveal3D
  // 一樣手動依頂點座標投影重算，圖案才會乾淨貼滿正反面。
  {
    const pos = geo.attributes.position
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) + SLAB_W / 2) / SLAB_W
      uv[i * 2 + 1] = (pos.getY(i) + SLAB_H / 2) / SLAB_H
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  }

  // 比頁面 wash 色更飽和 —— 在環境反射與泛光之下，太淡的顏色會被洗成白色
  // 貼圖抓不到時（離線 / API 掛掉）就停在這個顏色，畫面仍然完整
  const palette = [0xff9d84, 0xa78bfa, 0x5fd8c4, 0xf58fd0, 0xffc76b, 0x7fb2f5]
  const disposables: { dispose(): void }[] = [geo]
  const cards: import('three').Mesh[] = []
  let disposed = false
  const loader = new THREE.TextureLoader()
  loader.setCrossOrigin('anonymous')

  // 兩層環繞：內圈大而近、外圈小而遠，製造縱深
  const rings = [
    { count: 5, radius: 3.1, z: 0.4, scale: 1.0, speed: 0.16 },
    { count: 7, radius: 5.3, z: -3.2, scale: 0.72, speed: -0.1 }
  ]
  let globalIdx = 0
  rings.forEach((ring, ri) => {
    for (let i = 0; i < ring.count; i++) {
      const mat = new THREE.MeshPhysicalMaterial({
        color: palette[(i + ri * 3) % palette.length],
        // 金屬度過高 + 明亮環境 = 白色鏡子，底色與虹彩會被反射蓋掉
        metalness: 0.2,
        roughness: 0.22,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        iridescence: 1,
        iridescenceIOR: 2.0,
        iridescenceThicknessRange: [220, 1000],
        envMapIntensity: 0.75,
        sheen: 0.9,
        sheenColor: new THREE.Color(0xffffff)
      })
      disposables.push(mat)
      const m = new THREE.Mesh(geo, mat)
      const a = (i / ring.count) * Math.PI * 2
      m.scale.setScalar(ring.scale)
      m.userData = { a, ring: ri, radius: ring.radius, baseZ: ring.z, speed: ring.speed }
      scene.add(m)
      cards.push(m)

      // 卡面貼圖非同步進場：先用色塊墊著，圖載到就換上，不擋動畫啟動
      const url = CLASSIC_ART[globalIdx % CLASSIC_ART.length]
      globalIdx++
      loader.load(
          url,
          tex => {
            if (disposed) { tex.dispose(); return }
            tex.colorSpace = THREE.SRGBColorSpace
            mat.map = tex
            mat.color.set(0xffffff)
            // 原本為了「空白色塊」調校的高虹彩/高光澤/高反射，疊在真圖上會
            // 把圖案整片洗成死白（清漆反射亮光 + 環境反射 + 虹彩色移三層疊加）。
            // 貼圖後全部收斂，讓角色圖案讀得清楚，只留一點卡片該有的光澤。
            mat.iridescence = 0.12
            mat.sheen = 0.15
            mat.clearcoat = 0.45
            mat.clearcoatRoughness = 0.3
            mat.envMapIntensity = 0.3
            mat.roughness = 0.4
            mat.needsUpdate = true
            disposables.push(tex)
          },
          undefined,
          () => { /* 載圖失敗，保留原本的粉彩色塊 */ }
      )
    }
  })

  // ---- 粒子塵光 ----
  const P = 240
  const pPos = new Float32Array(P * 3)
  for (let i = 0; i < P; i++) {
    pPos[i * 3] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 18 - 9
    pPos[i * 3 + 1] = (Math.sin(i * 78.233) * 43758.5453 % 1) * 11 - 5.5
    pPos[i * 3 + 2] = (Math.sin(i * 39.425) * 43758.5453 % 1) * 10 - 7
  }
  const pGeo = new THREE.BufferGeometry()
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
  const pMat = new THREE.PointsMaterial({
    size: 0.055, color: 0xffffff, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false
  })
  const dust = new THREE.Points(pGeo, pMat)
  scene.add(dust)
  disposables.push(pGeo, pMat)

  // ---- 燈光：白主光 + 三顆環繞彩光 ----
  const key = new THREE.DirectionalLight(0xffffff, 2.0)
  key.position.set(4, 6, 8)
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.5))

  // 強度求「染色」不求「照亮」—— 太亮會在卡面爆出白斑並被泛光放大
  const orbs = [
    new THREE.PointLight(0xf73b20, 9, 14, 2),
    new THREE.PointLight(0x9b7ef5, 8, 14, 2),
    new THREE.PointLight(0x5ad6e8, 7, 14, 2)
  ]
  orbs.forEach(o => scene.add(o))

  /* ---- 光暈：用場景內的加法混合面片，不用後製泛光 ----
     UnrealBloomPass 會把背景合成成不透明，在透明 canvas 上會露出一塊
     矩形底色；而且淺色主題下粉彩很容易整片超過門檻糊成白霧。
     改成在卡片後方放幾片放射漸層，光暈感一樣但能正確疊在頁面漸層上。 */
  function glowTexture(hex: string) {
    const s = 256
    const c = document.createElement('canvas')
    c.width = s; c.height = s
    const g = c.getContext('2d')!
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    grd.addColorStop(0, hex)
    grd.addColorStop(0.45, hex.replace('rgb', 'rgba').replace(')', ', .35)'))
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, s, s)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const glowSpecs = [
    { color: 'rgb(255,150,120)', size: 9, pos: [-3.4, 1.2, -5] },
    { color: 'rgb(150,120,245)', size: 8, pos: [3.6, -1.4, -5.5] },
    { color: 'rgb(110,215,225)', size: 7, pos: [0.4, 2.2, -6] }
  ]
  const glows: import('three').Mesh[] = []
  for (const spec of glowSpecs) {
    const tex = glowTexture(spec.color)
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    })
    const pg = new THREE.PlaneGeometry(spec.size, spec.size)
    const mesh = new THREE.Mesh(pg, mat)
    mesh.position.set(spec.pos[0], spec.pos[1], spec.pos[2])
    mesh.renderOrder = -1
    scene.add(mesh)
    glows.push(mesh)
    disposables.push(tex, mat, pg)
  }
  void rich

  // ---- 互動 ----
  const ptr = { x: 0, y: 0 }, tgt = { x: 0, y: 0 }
  const onMove = (e: PointerEvent) => {
    const r = root.getBoundingClientRect()
    tgt.x = ((e.clientX - r.left) / r.width - 0.5) * 2
    tgt.y = ((e.clientY - r.top) / r.height - 0.5) * 2
  }
  window.addEventListener('pointermove', onMove, { passive: true })

  const resize = () => {
    const w = root.clientWidth, h = root.clientHeight
    if (!w || !h) return
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }
  const ro = new ResizeObserver(resize)
  ro.observe(root)
  resize()

  let visible = true
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting }, { threshold: 0.01 })
  io.observe(root)

  let raf = 0
  const t0 = performance.now()
  function tick() {
    raf = requestAnimationFrame(tick)
    if (!visible) return
    const t = (performance.now() - t0) / 1000
    ptr.x += (tgt.x - ptr.x) * 0.05
    ptr.y += (tgt.y - ptr.y) * 0.05

    for (const m of cards) {
      const { a, radius, baseZ, speed } = m.userData as any
      const ang = a + t * speed
      m.position.set(
        Math.cos(ang) * radius,
        Math.sin(ang * 1.3 + a) * 1.35 + Math.sin(t * 0.7 + a * 2) * 0.3,
        baseZ + Math.sin(ang) * 1.7
      )
      m.rotation.y = ang * 0.85 + ptr.x * 0.4
      m.rotation.x = Math.sin(t * 0.45 + a) * 0.22 - ptr.y * 0.28
      m.rotation.z = Math.cos(t * 0.3 + a) * 0.1
    }

    dust.rotation.y = t * 0.02
    dust.rotation.x = ptr.y * 0.05

    orbs.forEach((o, i) => {
      const a = t * (0.45 + i * 0.18) + (i / orbs.length) * Math.PI * 2
      o.position.set(Math.cos(a) * 5.2, Math.sin(a * 1.4) * 3.2, Math.sin(a) * 3.4 + 1.5)
    })

    // 光暈緩慢呼吸並輕微漂移
    glows.forEach((g, i) => {
      const m = g.material as import('three').MeshBasicMaterial
      m.opacity = 0.4 + Math.sin(t * 0.6 + i * 2.1) * 0.14
      g.position.x += Math.sin(t * 0.25 + i) * 0.004
      g.lookAt(camera.position)
    })

    camera.position.x = ptr.x * 1.1
    camera.position.y = -ptr.y * 0.7
    camera.lookAt(0, 0, 0)

    renderer.render(scene, camera)
  }
  tick()
  ready.value = true

  ctx.value = {
    dispose() {
      disposed = true // 擋掉還在飛的貼圖請求，避免載入後套到已銷毀的 material
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      ro.disconnect(); io.disconnect()
      envRT.dispose()
      pmrem.dispose()
      for (const d of disposables) d.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }
})

onBeforeUnmount(() => { ctx.value?.dispose(); ctx.value = null })
</script>

<template>
  <div class="hero3d" :class="{ ready, failed }">
    <div ref="host" class="canvas-host" aria-hidden="true"></div>
    <div v-if="failed" class="fallback" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
.hero3d { position: relative; width: 100%; height: 100%; }
.canvas-host { position: absolute; inset: 0; opacity: 0; transition: opacity 1.1s ease; }
.ready .canvas-host { opacity: 1; }
.fallback {
  position: absolute; inset: 0;
  background:
    radial-gradient(60% 55% at 30% 30%, var(--wash-peach), transparent 65%),
    radial-gradient(55% 55% at 72% 40%, var(--wash-lilac), transparent 65%),
    radial-gradient(60% 50% at 50% 85%, var(--wash-rose), transparent 65%);
  filter: blur(6px);
}
</style>
