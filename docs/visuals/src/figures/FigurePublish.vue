<script setup lang="ts">
import { Icon } from '@iconify/vue'
import icons from 'virtual:stack-icons'

import { FIGURE_ICONS } from '../stack/stack'
import DownArrow from './DownArrow.vue'

const installs = Array.from({ length: 10 }, (_, i) => i)
</script>

<!-- Publish from CI: two flows, each read from top to bottom. -->
<template>
  <div class="f-figure" role="img" aria-label="Two flows in CI. An OTA update: pnpm build, then ergosphere-it publish bundle to 20% of the beta channel. A full release: electron-builder publishes installers, then ergosphere-it register installer records them, and every channel offers them.">
    <div class="lane" style="left: 100px">
      <p class="f-note lane-title">
        An OTA update
      </p>
      <span class="f-chip">pnpm build</span>
      <DownArrow />
      <span class="f-chip">ergosphere-it publish bundle --channel beta --rollout 20</span>
      <DownArrow />
      <div class="result">
        <span class="installs">
          <i v-for="i in installs" :key="i" :class="{ on: i < 2 }" />
        </span>
        <span class="f-note">20% of beta gets it first. Raise it later.</span>
      </div>
    </div>

    <div class="lane" style="left: 780px">
      <p class="f-note lane-title">
        A full release
      </p>
      <span class="f-chip">electron-builder --publish always</span>
      <DownArrow />
      <span class="f-chip">ergosphere-it register installer</span>
      <DownArrow />
      <div class="result">
        <span class="f-tile installer">
          <Icon :icon="icons[FIGURE_ICONS.installer]!" />
        </span>
        <span class="f-note">Every channel offers the new installer.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lane {
  top: 50%;
  display: flex;
  width: 560px;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transform: translateY(-50%);
}

.lane-title {
  margin: 0 0 6px;
  font-weight: 500;
}

.result {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 4px;
}

.result .f-note {
  max-width: 220px;
}

.installs {
  display: grid;
  grid-template-columns: repeat(5, 20px);
  gap: 7px;
}

.installs i {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--surface-3);
}

.installs i.on {
  background: var(--cyan);
}

.installer {
  width: 64px;
  height: 64px;
  border-radius: 20px;
  color: var(--muted);
  font-size: 30px;
}
</style>
