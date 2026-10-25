<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { APP, BUCKET, captionAt, CELL, CI, frameAt, LAMP, LOCAL, MANIFESTS, OBJECTS, ROUND, ROUNDS, SOCKET, SPARE, STAGE, STAGED, STEPS } from '../how/timeline'

const props = defineProps<{
  /** The round for a still frame: 0 keeps the new bundle, 1 sends it back. */
  stillRound?: number
  /** Freezes the machine at this time of the round, for a screenshot. */
  stillAt?: number
}>()

const wrap = ref<HTMLElement>()
const scale = ref(1)
const time = ref(props.stillAt ?? 0)
const roundIndex = ref(props.stillRound ?? 0)
const held = ref(false)
const lean = ref({ x: 0, y: 0 })

const round = computed(() => ROUNDS[roundIndex.value % ROUNDS.length]!)
const frame = computed(() => frameAt(time.value, round.value))
const caption = computed(() => captionAt(time.value, round.value))

const HEALTH_R = 52
const HEALTH_C = 2 * Math.PI * HEALTH_R

function ringDash(r: number, progress: number): string {
  const c = 2 * Math.PI * r
  return `${c * progress} ${c}`
}

/** Jumps to a step and holds it while the pointer stays on the lights. */
function hold(index: number): void {
  held.value = true
  time.value = STEPS[index]!.at + (index === STEPS.length - 1 ? 1.4 : 0.9)
}

function release(): void {
  held.value = false
}

function onPointer(event: PointerEvent): void {
  const box = wrap.value?.getBoundingClientRect()
  if (!box)
    return
  lean.value = { x: (event.clientX - box.left) / box.width - 0.5, y: (event.clientY - box.top) / box.height - 0.5 }
}

let frameId = 0
let last = 0
let onScreen = false
let observer: ResizeObserver | undefined
let visibility: IntersectionObserver | undefined

function tick(now: number): void {
  frameId = requestAnimationFrame(tick)
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  if (held.value)
    return
  time.value += dt
  if (time.value >= ROUND) {
    time.value -= ROUND
    roundIndex.value++
  }
}

function run(): void {
  cancelAnimationFrame(frameId)
  if (!onScreen || document.hidden)
    return
  last = performance.now()
  frameId = requestAnimationFrame(tick)
}

onMounted(() => {
  observer = new ResizeObserver(() => {
    if (wrap.value)
      scale.value = wrap.value.clientWidth / STAGE.width
  })
  if (wrap.value)
    observer.observe(wrap.value)
  if (props.stillAt !== undefined)
    return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    time.value = 10.4
    return
  }
  visibility = new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? false
    run()
  })
  if (wrap.value)
    visibility.observe(wrap.value)
  document.addEventListener('visibilitychange', run)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frameId)
  observer?.disconnect()
  visibility?.disconnect()
  document.removeEventListener('visibilitychange', run)
})

const toneOf = (stored: boolean, i: number): string => (i >= 6 ? (stored ? 'new' : 'empty') : 'old')
</script>

<template>
  <section class="section" aria-labelledby="machine">
    <h2 id="machine">
      How it works
    </h2>

    <div
      ref="wrap"
      class="wrap"
      :style="{ height: `${STAGE.height * scale}px` }"
      aria-hidden="true"
      @pointermove="onPointer"
      @pointerleave="lean = { x: 0, y: 0 }"
    >
      <div class="stage" :style="{ transform: `translate(${lean.x * 10}px, ${lean.y * 8}px) scale(${scale})` }">
        <div class="wire" :style="{ left: `${CI.x + CI.w}px`, top: `${SOCKET.y}px`, width: `${BUCKET.x - CI.x - CI.w}px` }" />
        <div class="wire" :style="{ left: `${BUCKET.x + BUCKET.w}px`, top: `${SOCKET.y}px`, width: `${APP.x - BUCKET.x - BUCKET.w}px` }" />

        <!-- ci -->
        <div class="box ci" :style="{ left: `${CI.x}px`, top: `${CI.y}px`, width: `${CI.w}px`, height: `${CI.h}px`, boxShadow: `0 0 ${28 * frame.ciGlow}px rgb(var(--cyan-rgb) / ${0.1 * frame.ciGlow})` }">
          <span class="led" :class="{ lit: frame.ciGlow > 0.2 }" />
        </div>
        <p class="tag" :style="{ left: `${CI.x}px`, top: `${CI.y + CI.h + 12}px` }">
          ci
        </p>

        <!-- bucket: objects, manifests, channel -->
        <div class="box bucket" :style="{ left: `${BUCKET.x}px`, top: `${BUCKET.y}px`, width: `${BUCKET.w}px`, height: `${BUCKET.h}px` }">
          <div class="tray" style="top: 14px; height: 96px" />
          <div class="tray" style="top: 122px; height: 50px" />
          <div class="tray" style="top: 184px; height: 62px" />
        </div>
        <p class="tag" :style="{ left: `${BUCKET.x}px`, top: `${BUCKET.y + BUCKET.h + 12}px` }">
          bucket
        </p>
        <p class="tag small" :style="{ left: `${BUCKET.x + 25}px`, top: `${BUCKET.y + 16}px` }">
          objects
        </p>
        <p class="tag small" :style="{ left: `${BUCKET.x + 25}px`, top: `${BUCKET.y + 124}px` }">
          manifests
        </p>
        <p class="tag small" :style="{ left: `${LAMP.x + 22}px`, top: `${LAMP.y - 8}px` }">
          channel
        </p>
        <div
          v-for="(o, i) in OBJECTS"
          :key="`o${i}`"
          class="square"
          :data-tone="toneOf(frame.stored[i]!, i)"
          :style="{ left: `${o.x}px`, top: `${o.y}px`, width: `${CELL}px`, height: `${CELL}px` }"
        />
        <div
          v-for="(m, i) in MANIFESTS"
          :key="`m${i}`"
          class="bar"
          :data-tone="i < 2 ? 'old' : frame.manifest ? 'new' : 'empty'"
          :style="{ left: `${m.x}px`, top: `${m.y}px` }"
        />
        <div class="lamp" :class="{ lit: frame.lamp }" :style="{ left: `${LAMP.x - 10}px`, top: `${LAMP.y - 10}px` }" />

        <!-- app -->
        <div class="box app" :style="{ left: `${APP.x}px`, top: `${APP.y}px`, width: `${APP.size}px`, height: `${APP.size}px` }">
          <div class="socket" :style="{ left: `${SOCKET.x - APP.x - 46}px`, top: `${SOCKET.y - APP.y - 46}px`, width: '92px', height: '92px' }" />
          <div class="socket" :style="{ left: `${SPARE.x - APP.x - 18}px`, top: `${SPARE.y - APP.y - 18}px`, width: '36px', height: '36px' }" />
          <div class="socket" :style="{ left: `${STAGED.x - APP.x - 20}px`, top: `${STAGED.y - APP.y - 20}px`, width: '40px', height: '40px' }" />
        </div>
        <div
          v-for="(l, i) in LOCAL"
          :key="`l${i}`"
          class="square local"
          :style="{ left: `${l.x}px`, top: `${l.y}px`, background: `color-mix(in srgb, var(--cyan) ${frame.localFlash * 100}%, var(--surface-3))` }"
        />
        <p class="tag" :style="{ left: `${APP.x}px`, top: `${APP.y + APP.size + 12}px` }">
          your app
        </p>

        <svg class="rings" :width="STAGE.width" :height="STAGE.height" :viewBox="`0 0 ${STAGE.width} ${STAGE.height}`">
          <circle
            v-if="frame.health.progress > 0.002"
            :cx="SOCKET.x"
            :cy="SOCKET.y"
            :r="HEALTH_R"
            class="health"
            :class="{ failing: frame.health.failing }"
            :stroke-dasharray="`${HEALTH_C * frame.health.progress} ${HEALTH_C}`"
            :transform="`rotate(-90 ${SOCKET.x} ${SOCKET.y})`"
          />
          <template v-for="(r, i) in frame.rings" :key="`r${i}`">
            <circle
              v-if="r.progress > 0.002"
              :cx="r.x"
              :cy="r.y"
              :r="r.r"
              class="ring"
              :stroke-dasharray="ringDash(r.r, r.progress)"
              :transform="`rotate(-90 ${r.x} ${r.y})`"
            />
          </template>
        </svg>

        <div
          v-for="(m, i) in frame.movers"
          :key="`v${i}`"
          class="square mover"
          :style="{ left: `${m.x - CELL / 2}px`, top: `${m.y - CELL / 2}px`, width: `${CELL}px`, height: `${CELL}px` }"
        />
        <div class="ping" :style="{ left: `${frame.ping.x - 5}px`, top: `${frame.ping.y - 5}px`, opacity: frame.ping.opacity }" />

        <div
          v-for="(d, i) in frame.discs"
          :key="`d${i}`"
          class="disc mono"
          :data-tone="d.tone"
          :style="{ left: `${d.x - d.r}px`, top: `${d.y - d.r}px`, width: `${d.r * 2}px`, height: `${d.r * 2}px`, opacity: d.opacity, fontSize: `${Math.max(9, d.r * 0.32)}px` }"
        >
          <span v-if="d.r >= 26">{{ d.label }}</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <ol class="leds" @mouseleave="release">
        <li v-for="(s, i) in STEPS" :key="s.name">
          <button
            type="button"
            class="step"
            :class="{ on: frame.step === i, bad: frame.step === i && frame.health.failing }"
            @mouseenter="hold(i)"
            @focus="hold(i)"
            @blur="release"
          >
            <span class="dot" />
            <span class="mono num">{{ i + 1 }}</span>
            <span class="mono name">{{ s.name }}</span>
          </button>
        </li>
      </ol>
      <p class="caption" aria-live="polite">
        {{ caption }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.section {
  max-width: 1160px;
  margin: 0 auto;
  padding: 120px 24px 0;
}

h2 {
  margin: 0 0 24px;
  font-size: clamp(30px, 4vw, 40px);
  font-weight: 600;
  letter-spacing: -0.02em;
}

.wrap {
  position: relative;
  overflow: hidden;
  border-radius: 28px;
  background: radial-gradient(90% 120% at 50% 0%, var(--figure-hi), var(--figure-lo));
}

.stage {
  position: absolute;
  top: 0;
  left: 0;
  width: 1000px;
  height: 440px;
  transform-origin: 0 0;
  transition: transform 0.4s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.stage > * {
  position: absolute;
  margin: 0;
}

.wire {
  height: 1px;
  background: var(--wire);
}

.box {
  border-radius: 32px;
  background: linear-gradient(160deg, var(--device-hi), var(--device-lo));
  box-shadow: 0 24px 48px var(--shadow);
  transition: box-shadow 0.3s;
}

.box.app {
  border-radius: 40px;
}

.ci .led {
  position: absolute;
  top: 18px;
  right: 18px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--surface-3);
  transition: background 0.3s, box-shadow 0.3s;
}

.ci .led.lit {
  background: var(--orange);
  box-shadow: 0 0 7px rgb(var(--orange-rgb) / 28%);
}

.tray {
  position: absolute;
  right: 12px;
  left: 12px;
  border-radius: 18px;
  background: var(--tray);
}

.tag {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: 13px;
}

.tag.small {
  font-size: 11px;
}

.square {
  border-radius: 6px;
  transition: background 0.3s, box-shadow 0.3s;
}

.square[data-tone='old'] {
  background: var(--surface-3);
}

.square[data-tone='empty'] {
  background: var(--empty);
}

.square[data-tone='new'],
.square.mover {
  background: var(--cyan);
  box-shadow: 0 0 8px rgb(var(--cyan-rgb) / 16%);
}

.square.local {
  width: 12px;
  height: 12px;
  border-radius: 4px;
}

.bar {
  width: 36px;
  height: 10px;
  border-radius: 5px;
  transition: background 0.3s, box-shadow 0.3s;
}

.bar[data-tone='old'] {
  background: var(--surface-3);
}

.bar[data-tone='empty'] {
  background: var(--empty);
}

.bar[data-tone='new'] {
  background: var(--cyan);
  box-shadow: 0 0 8px rgb(var(--cyan-rgb) / 16%);
}

.lamp {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--surface-3);
  transition: background 0.4s, box-shadow 0.4s;
}

.lamp.lit {
  background: var(--cyan);
  box-shadow: 0 0 13px rgb(var(--cyan-rgb) / 24%);
}

.socket {
  position: absolute;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 40%, var(--well-hi), var(--well-lo));
  box-shadow: inset 0 2px 8px var(--well-shadow);
}

.rings {
  overflow: visible;
  pointer-events: none;
}

.rings circle {
  fill: none;
  stroke-linecap: round;
}

.ring {
  stroke: var(--cyan);
  stroke-width: 2;
}

.health {
  stroke: var(--text);
  stroke-width: 3;
  transition: stroke 0.3s;
}

.health.failing {
  stroke: var(--red);
}

.ping {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--orange);
  box-shadow: 0 0 8px rgb(var(--orange-rgb) / 28%);
}

.disc {
  display: grid;
  border-radius: 50%;
  place-items: center;
  transition: background 0.4s, color 0.4s, box-shadow 0.4s;
}

.disc[data-tone='run'] {
  background: var(--text);
  box-shadow: 0 0 22px rgb(var(--text-rgb) / 6%);
  color: var(--bg);
}

.disc[data-tone='new'] {
  background: var(--cyan);
  box-shadow: 0 0 22px rgb(var(--cyan-rgb) / 14%);
  color: var(--on-cyan);
}

.disc[data-tone='old'] {
  background: var(--surface-3);
  color: var(--muted);
}

.disc[data-tone='bad'] {
  background: var(--red);
  box-shadow: 0 0 28px rgb(var(--red-rgb) / 18%);
  color: var(--on-red);
}

/* Numbered lights, like the step keys of a sequencer. Pointing at one holds that step. */
.panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px 32px;
  margin-top: 16px;
  padding: 18px 20px;
  border-radius: 24px;
  background: var(--surface);
}

.leds {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: grid;
  min-width: 76px;
  padding: 10px 12px;
  border: 0;
  border-radius: 14px;
  background: var(--surface-2);
  color: var(--muted);
  cursor: default;
  font: inherit;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 4px 8px;
  text-align: left;
  transition: background 0.3s;
}

.step .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--surface-3);
  transition: background 0.3s, box-shadow 0.3s;
}

.step .num {
  color: var(--faint);
  font-size: 11px;
}

.step .name {
  grid-column: 1 / -1;
  font-size: 13px;
}

.step.on {
  background: var(--surface-3);
  color: var(--text);
}

.step.on .dot {
  background: var(--orange);
  box-shadow: 0 0 7px rgb(var(--orange-rgb) / 28%);
}

.step.on.bad .dot {
  background: var(--red);
  box-shadow: 0 0 7px rgb(var(--red-rgb) / 28%);
}

.caption {
  flex: 1 1 280px;
  min-height: 2.8em;
  margin: 0;
  color: var(--muted);
  font-size: 17px;
  line-height: 1.4;
  text-wrap: pretty;
}
</style>
