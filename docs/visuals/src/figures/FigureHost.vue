<script setup lang="ts">
import { Icon } from '@iconify/vue'
import icons from 'virtual:stack-icons'

import { FIGURE_ICONS } from '../stack/stack'

/** Where the bucket can live. Any service with the S3 API works through ERGOSPHERE_IT_S3_ENDPOINT. */
const providers = [
  { icon: 'selfhst:amazon-s3', name: 'Amazon S3' },
  { icon: 'selfhst:cloudflare', name: 'Cloudflare R2' },
  { icon: 'selfhst:garage', name: 'Garage' },
  { icon: FIGURE_ICONS.storage, name: 'Any S3 API, or a directory', plain: true },
]

const drawers = [
  { name: 'objects/', tag: 'immutable · cached forever' },
  { name: 'bundles/', tag: 'immutable · cached forever' },
  { name: 'installers/', tag: 'immutable · cached forever' },
  { live: true, name: 'channels/', tag: 'no-store · always fresh' },
]
</script>

<!-- Host the updates: the bucket can live on any of these, a CDN serves it, and apps only read. -->
<template>
  <div class="f-figure" role="img" aria-label="The bucket can live on Amazon S3, Cloudflare R2, Garage, any service with the S3 API, or a directory. It holds objects, bundles, and installers that never change, and channel files that are never cached. A CDN serves it, and apps read it over HTTPS.">
    <svg class="f-wires" width="1440" height="480" aria-hidden="true">
      <path v-for="(p, i) in providers" :key="p.name" :d="`M340 ${92 + i * 98} C380 ${92 + i * 98} 380 240 420 240`" />
      <path d="M920 240 H1000" />
      <path d="M1100 240 C1140 240 1140 130 1180 130" />
      <path d="M1100 240 H1180" />
      <path d="M1100 240 C1140 240 1140 350 1180 350" />
    </svg>

    <div
      v-for="(p, i) in providers"
      :key="p.name"
      class="provider"
      :style="{ left: '100px', top: `${60 + i * 98}px` }"
    >
      <span class="f-tile tile" :class="{ plain: p.plain }">
        <Icon :icon="icons[p.icon]!" />
      </span>
      <span class="f-note name-of">{{ p.name }}</span>
    </div>

    <div class="f-device bucket" style="left: 420px; top: 40px">
      <span class="f-label" style="position: absolute; top: 18px; left: 26px">bucket · feedUrl</span>
      <div v-for="d in drawers" :key="d.name" class="drawer">
        <span class="name">{{ d.name }}</span>
        <span class="tag" :class="{ live: d.live }">
          <i v-if="d.live" class="lamp" />{{ d.tag }}
        </span>
      </div>
    </div>

    <div class="f-device cdn" style="left: 1000px; top: 190px">
      <Icon :icon="icons[FIGURE_ICONS.cloud]!" />
    </div>
    <p class="f-note" style="left: 1032px; top: 300px">
      CDN
    </p>

    <div
      v-for="y in [90, 200, 310]"
      :key="y"
      class="f-device app"
      :style="{ left: '1180px', top: `${y}px` }"
    >
      <div class="f-disc run" style="width: 36px; height: 36px" />
    </div>
    <p class="f-note" style="left: 1280px; top: 218px; width: 140px">
      Apps read over HTTPS.
    </p>
  </div>
</template>

<style scoped>
.provider {
  display: flex;
  align-items: center;
  gap: 14px;
}

.tile {
  width: 64px;
  height: 64px;
  border-radius: 20px;
  font-size: 32px;
}

.tile.plain {
  color: var(--muted);
}

.name-of {
  width: 160px;
}

.bucket {
  display: grid;
  width: 500px;
  height: 400px;
  padding: 52px 24px 24px;
  border-radius: 36px;
  gap: 12px;
}

.drawer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-radius: 18px;
  background: var(--surface);
}

.name {
  font-family: var(--font-mono);
  font-size: 16px;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 13px;
}

.tag.live {
  color: var(--cyan-ink);
}

.lamp {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--cyan);
}

.cdn {
  display: grid;
  width: 100px;
  height: 100px;
  color: var(--muted);
  font-size: 40px;
  place-items: center;
}

.app {
  display: grid;
  width: 80px;
  height: 80px;
  border-radius: 22px;
  place-items: center;
}
</style>
