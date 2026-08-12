<script setup lang="ts">
// 把任何內容包成會隨游標傾斜的 3D 卡面（含全息反光與邊緣光）
import { useTilt } from '@/composables/useTilt'

const props = withDefaults(defineProps<{ max?: number; glare?: boolean; radius?: string }>(), {
  max: 16,
  glare: true,
  radius: '14px'
})

const { el, rx, ry, gx, gy, active, onMove, reset } = useTilt(props.max)
</script>

<template>
  <div class="scene" @pointermove="onMove" @pointerleave="reset">
    <div
      ref="el"
      class="plane"
      :class="{ active }"
      :style="{
        transform: `rotateX(${rx}deg) rotateY(${ry}deg)`,
        borderRadius: radius
      }"
    >
      <slot />
      <span
        v-if="glare"
        class="glare"
        :style="{ background: `radial-gradient(58% 58% at ${gx}% ${gy}%, rgba(255,255,255,.55), transparent 70%)` }"
        aria-hidden="true"
      ></span>
      <span
        v-if="glare"
        class="holo"
        :style="{ backgroundPosition: `${gx}% ${gy}%` }"
        aria-hidden="true"
      ></span>
    </div>
  </div>
</template>

<style scoped>
.scene { perspective: 900px; }
.plane {
  position: relative;
  transform-style: preserve-3d;
  transition: transform .4s cubic-bezier(.2,.7,.3,1);
  overflow: hidden;
}
.plane.active { transition: transform .08s linear; }
.glare, .holo {
  position: absolute; inset: 0;
  pointer-events: none;
  opacity: 0; transition: opacity .3s;
}
.glare { mix-blend-mode: soft-light; }
.holo {
  mix-blend-mode: color-dodge;
  background-image: linear-gradient(115deg,
    transparent 20%,
    rgba(90, 214, 232, .35) 36%,
    rgba(155, 126, 245, .35) 50%,
    rgba(245, 143, 208, .35) 64%,
    transparent 80%);
  background-size: 260% 260%;
}
.plane.active .glare { opacity: 1; }
.plane.active .holo { opacity: .55; }
@media (prefers-reduced-motion: reduce) {
  .plane { transition: none; transform: none !important; }
  .glare, .holo { display: none; }
}
</style>
