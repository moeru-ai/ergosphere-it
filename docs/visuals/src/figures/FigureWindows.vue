<script setup lang="ts">
import { Icon } from '@iconify/vue'
import icons from 'virtual:stack-icons'

import { FIGURE_ICONS } from '../stack/stack'
</script>

<!-- Open windows from the active bundle: the call in the middle is the point. -->
<template>
  <div class="f-figure" role="img" aria-label="A window loads its page with window.loadURL(activeBundle.pageUrl()). The page comes from the bundle that runs now, so after a page-only update the window reloads on the same route.">
    <svg class="f-wires" width="1440" height="480" aria-hidden="true">
      <path d="M300 240 H1000" />
    </svg>

    <div class="f-device app" style="left: 120px; top: 150px">
      <div class="f-well" style="width: 112px; height: 112px">
        <div class="f-disc run" style="width: 84px; height: 84px">
          1.0.4
        </div>
      </div>
    </div>
    <p class="f-note" style="left: 120px; top: 344px; width: 220px">
      The bundle that runs now.
    </p>

    <p class="f-note" style="left: 380px; top: 166px">
      Every window loads its page from the active bundle.
    </p>
    <span class="call" style="left: 380px; top: 210px">window.loadURL(<b>activeBundle.pageUrl()</b>)</span>

    <div class="f-device window" style="left: 1000px; top: 110px">
      <span class="dots"><i /><i /><i /></span>
      <span class="route">/settings</span>
      <span class="bar" style="width: 70%" />
      <span class="bar" style="width: 55%" />
      <span class="bar" style="width: 62%" />
      <span class="reloaded">
        <Icon :icon="icons[FIGURE_ICONS.refresh]!" />
      </span>
    </div>
    <p class="f-note" style="left: 1000px; top: 392px; width: 330px">
      After a page-only update, the window reloads on the same route.
    </p>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  width: 180px;
  height: 180px;
  border-radius: 40px;
  place-items: center;
}

/* The call is the subject of the figure, so it is the largest text. */
.call {
  padding: 16px 22px;
  border-radius: 16px;
  background: var(--surface-2);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 22px;
  white-space: nowrap;
}

.call b {
  color: var(--cyan-ink);
  font-weight: 400;
}

.window {
  display: grid;
  width: 330px;
  height: 260px;
  padding: 18px 22px;
  border-radius: 22px;
  align-content: start;
  gap: 14px;
}

.dots {
  display: flex;
  gap: 6px;
}

.dots i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--surface-3);
}

.route {
  justify-self: start;
  padding: 6px 12px;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--soft);
  font-family: var(--font-mono);
  font-size: 14px;
}

.bar {
  height: 12px;
  border-radius: 6px;
  background: var(--surface-2);
}

.reloaded {
  position: absolute;
  top: 14px;
  right: 16px;
  display: grid;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--orange);
  color: var(--bg);
  font-size: 18px;
  place-items: center;
}
</style>
