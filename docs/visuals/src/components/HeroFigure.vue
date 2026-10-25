<script setup lang="ts">
import type { Disc } from '../hero/timeline'

import { Icon } from '@iconify/vue'
import icons from 'virtual:stack-icons'
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { APP, captionOpacity, CAPTIONS, discsAt, LOOP, STAGE } from '../hero/timeline'
import { THEME_ICONS } from '../stack/stack'
import { theme, toggleTheme } from '../theme'
import WorksWith from './WorksWith.vue'

const props = defineProps<{
  /** A still 1280×640 frame without links, for the README banner and the social preview. */
  capture?: boolean
  /** The moment of the loop for the still frame, in seconds. */
  captureAt?: number
}>()

const hero = ref<HTMLElement>()
const stage = ref<HTMLElement>()
const discEls = ref<HTMLElement[]>([])
const caption = ref(0)
/** The time of a still frame. Captions follow it directly, so every frame of a recording is exact. */
const stillTime = ref(props.captureAt ?? 7.0)

/** Blur that grows toward the far end of the channel: releases that have not arrived yet. */
const farBlur = [1, 2, 4, 8, 14]
/** Blur that grows toward the bottom: where a bad bundle drops out. */
const dropBlur = [1, 2, 4, 8, 14]

const SLOT_Y = APP.y + APP.size / 2

let fitScale = 1
let fitX = 0
let fitY = 0
const pointer = { x: 0, y: 0 }

function paintDisc(el: HTMLElement | undefined, d: Disc): void {
  if (!el)
    return
  el.style.transform = `translate3d(${d.x + d.shake - d.r}px, ${d.y - d.r}px, 0)`
  el.style.width = `${d.r * 2}px`
  el.style.height = `${d.r * 2}px`
  el.style.fontSize = `${Math.max(10, d.r * 0.36)}px`
  el.style.opacity = String(d.opacity)
  el.dataset.tone = d.tone
  el.dataset.small = String(d.r < 24)
  if (el.firstElementChild && el.firstElementChild.textContent !== d.label)
    el.firstElementChild.textContent = d.label
}

function paint(t: number): void {
  discsAt(t).forEach((d, i) => paintDisc(discEls.value[i], d))
  const index = CAPTIONS.findLastIndex(c => c.at <= t)
  if (index !== caption.value)
    caption.value = index
}

function place(): void {
  const s = stage.value
  if (!s)
    return
  // A little parallax: the figure leans toward the pointer.
  const dx = pointer.x * 14
  const dy = pointer.y * 10
  s.style.transform = `translate(${fitX + dx}px, ${fitY + dy}px) scale(${fitScale})`
}

function fit(): void {
  const h = hero.value
  if (!h)
    return
  const W = h.clientWidth
  const H = h.clientHeight
  const wide = W >= 900 || props.capture
  const cx = wide ? W * 0.72 : W * 0.5
  const cy = wide ? H * 0.5 : H * 0.7
  fitScale = wide ? Math.min((W * 0.55) / STAGE.width, (H * 0.88) / STAGE.height) : Math.min((W * 0.95) / STAGE.width, (H * 0.42) / STAGE.height)
  fitX = cx - (STAGE.width / 2) * fitScale
  fitY = cy - (STAGE.height / 2) * fitScale
  place()
}

function onPointer(event: PointerEvent): void {
  pointer.x = event.clientX / window.innerWidth - 0.5
  pointer.y = event.clientY / window.innerHeight - 0.5
  place()
}

let frame = 0
let observer: ResizeObserver | undefined
let visibility: IntersectionObserver | undefined
let onScreen = true
let clock = 0
let last = 0

function tick(now: number): void {
  frame = requestAnimationFrame(tick)
  clock = (clock + Math.min(0.05, (now - last) / 1000)) % LOOP
  last = now
  paint(clock)
}

function run(): void {
  cancelAnimationFrame(frame)
  if (!onScreen || document.hidden)
    return
  last = performance.now()
  frame = requestAnimationFrame(tick)
}

onMounted(() => {
  fit()
  observer = new ResizeObserver(fit)
  if (hero.value)
    observer.observe(hero.value)
  if (props.capture) {
    paint(stillTime.value)
    // The banner script draws an animated banner frame by frame through this hook.
    window.__heroAt = (t: number) => {
      stillTime.value = t
      paint(t)
    }
    return
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    paint(stillTime.value)
    return
  }
  window.addEventListener('pointermove', onPointer, { passive: true })
  visibility = new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? true
    run()
  })
  if (hero.value)
    visibility.observe(hero.value)
  document.addEventListener('visibilitychange', run)
  run()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  observer?.disconnect()
  visibility?.disconnect()
  window.removeEventListener('pointermove', onPointer)
  document.removeEventListener('visibilitychange', run)
})

const repo = 'https://github.com/moeru-ai/ergosphere-it'
</script>

<template>
  <header ref="hero" class="hero" :class="{ capture }">
    <div ref="stage" class="stage" aria-hidden="true">
      <div class="channel" :style="{ left: `${APP.x + APP.size}px`, top: `${SLOT_Y}px`, width: `${STAGE.width - APP.x - APP.size + 60}px` }" />
      <p class="label channel-label" :style="{ left: `${APP.x + APP.size + 60}px`, top: `${SLOT_Y - 34}px` }">
        Channel
      </p>

      <div class="app" :style="{ left: `${APP.x}px`, top: `${APP.y}px`, width: `${APP.size}px`, height: `${APP.size}px` }">
        <div class="socket" :style="{ left: `${APP.size / 2 - 64}px`, top: `${APP.size / 2 - 64}px` }" />
        <div class="socket spare" :style="{ left: '12px', top: `${APP.size - 56}px` }" />
      </div>
      <p class="label" :style="{ left: `${APP.x}px`, top: `${APP.y + APP.size + 14}px` }">
        Your app
      </p>

      <div v-for="i in 3" :key="i" ref="discEls" class="disc mono" data-tone="new">
        <span />
      </div>

      <div v-for="(b, i) in farBlur" :key="`far-${b}`" class="blur far" :style="{ '--from': `${i * 18}%`, 'backdropFilter': `blur(${b}px)`, 'WebkitBackdropFilter': `blur(${b}px)` }" />
      <div v-for="(b, i) in dropBlur" :key="`drop-${b}`" class="blur drop" :style="{ '--from': `${i * 18}%`, 'backdropFilter': `blur(${b}px)`, 'WebkitBackdropFilter': `blur(${b}px)` }" />

      <div class="captions" :style="{ left: `${APP.x}px`, top: `${APP.y - 64}px` }">
        <p
          v-for="(c, i) in CAPTIONS"
          :key="c.at"
          class="caption"
          :class="{ on: i === caption }"
          :style="capture ? { opacity: captionOpacity(i, stillTime), transform: 'none' } : undefined"
        >
          {{ c.text }}
        </p>
      </div>
    </div>

    <button
      v-if="!capture"
      type="button"
      class="theme"
      :aria-label="theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'"
      @click="toggleTheme"
    >
      <Icon :icon="icons[theme === 'dark' ? THEME_ICONS.light : THEME_ICONS.dark]!" aria-hidden="true" />
    </button>

    <div class="copy">
      <h1>ergosphere-it</h1>
      <p class="tagline">
        Over-the-air updates for Electron apps that always find their way back.
      </p>
      <ul class="facts">
        <li>Signed releases</li>
        <li>Staged rollouts</li>
        <li>Automatic rollback</li>
      </ul>
      <WorksWith />
      <nav v-if="!capture" class="links" aria-label="Project">
        <a class="btn primary" :href="`${repo}#installation-and-usage`">Get started</a>
        <a class="btn" :href="repo">GitHub</a>
      </nav>
    </div>

    <p class="sr-only">
      An app runs bundle 1.0.3. Bundle 1.0.4 arrives over the air and takes over. Bundle 1.0.5 arrives, crashes, and drops out,
      and the app goes back to 1.0.4 on its own.
    </p>
  </header>
</template>

<style scoped>
.hero {
  position: relative;
  overflow: hidden;
  height: 100vh;
  min-height: 620px;
}

/* A capture draws exact frames: nothing eases on its own between them. */
.hero.capture,
.hero.capture * {
  transition: none !important;
}

.hero.capture {
  width: 100%;
  height: 100%;
  min-height: 0;
}

.stage {
  position: absolute;
  top: 0;
  left: 0;
  width: 640px;
  height: 480px;
  transform-origin: 0 0;
  transition: transform 0.4s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.channel {
  position: absolute;
  height: 2px;
  background: linear-gradient(90deg, rgb(var(--cyan-rgb) / 45%), rgb(var(--cyan-rgb) / 10%));
}

.app {
  position: absolute;
  border-radius: 44px;
  background: var(--device);
  box-shadow: 0 30px 60px var(--shadow);
}

/* Sockets are darker wells: where a bundle sits, and where the previous one waits. */
.socket {
  position: absolute;
  width: 128px;
  height: 128px;
  border-radius: 50%;
  background: var(--well-lo);
  box-shadow: inset 0 2px 8px var(--well-shadow);
}

.socket.spare {
  width: 44px;
  height: 44px;
}

.disc {
  position: absolute;
  top: 0;
  left: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  will-change: transform;
  transition: background 0.45s, color 0.45s, box-shadow 0.45s;
}

.disc[data-small='true'] span {
  display: none;
}

.disc[data-tone='run'] {
  background: var(--text);
  box-shadow: 0 0 28px rgb(var(--text-rgb) / 7%);
  color: var(--bg);
}

.disc[data-tone='new'] {
  background: var(--cyan);
  box-shadow: 0 0 28px rgb(var(--cyan-rgb) / 14%);
  color: var(--on-cyan);
}

.disc[data-tone='old'] {
  background: var(--surface-3);
  color: var(--muted);
}

.disc[data-tone='bad'] {
  background: var(--red);
  box-shadow: 0 0 34px rgb(var(--red-rgb) / 18%);
  color: var(--on-red);
}

.blur {
  position: absolute;
  pointer-events: none;
}

/* Progressive blur: each layer starts further out and blurs more. */
.blur.far {
  top: 0;
  right: -80px;
  bottom: 0;
  left: 430px;
  mask-image: linear-gradient(90deg, transparent var(--from), #000 calc(var(--from) + 18%));
}

.blur.drop {
  right: -80px;
  bottom: -80px;
  left: -80px;
  height: 200px;
  mask-image: linear-gradient(180deg, transparent var(--from), #000 calc(var(--from) + 18%));
}

.label {
  position: absolute;
  margin: 0;
  color: var(--muted);
  font-size: 15px;
}

.channel-label {
  color: var(--cyan-ink);
}

.captions {
  position: absolute;
  width: 480px;
  height: 24px;
}

.caption {
  position: absolute;
  margin: 0;
  color: var(--muted);
  font-size: 17px;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 0.5s, transform 0.5s;
}

.caption.on {
  opacity: 1;
  transform: none;
}

.theme {
  position: absolute;
  z-index: 2;
  top: 20px;
  right: 20px;
  display: grid;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 50%;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  font-size: 20px;
  place-items: center;
  transition: background 0.2s, color 0.2s;
}

.theme:hover {
  background: var(--surface-2);
  color: var(--text);
}

.copy {
  position: absolute;
  top: 50%;
  left: clamp(20px, 7vw, 112px);
  right: 20px;
  max-width: 520px;
  transform: translateY(-50%);
}

.capture .copy {
  left: 88px;
}

h1 {
  margin: 0;
  font-size: clamp(52px, 7vw, 92px);
  font-weight: 600;
  letter-spacing: -0.025em;
  line-height: 1;
}

.capture h1 {
  font-size: 84px;
}

.tagline {
  max-width: 460px;
  margin: 20px 0 0;
  color: var(--soft);
  font-size: clamp(20px, 2vw, 26px);
  line-height: 1.35;
  text-wrap: pretty;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 28px 0 0;
  padding: 0;
  list-style: none;
}

.facts li {
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 15px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 36px;
}

.sr-only {
  position: absolute;
  overflow: hidden;
  width: 1px;
  height: 1px;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 899px) {
  .copy {
    top: clamp(32px, 8vh, 80px);
    transform: none;
  }

  .captions {
    display: none;
  }
}
</style>
