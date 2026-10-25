<script setup lang="ts">
import { Icon } from '@iconify/vue'
import icons from 'virtual:stack-icons'

import { THEME_ICONS } from '../stack/stack'
import { theme, toggleTheme } from '../theme'
import FigureBuild from './FigureBuild.vue'
import FigureHost from './FigureHost.vue'
import FigureKeys from './FigureKeys.vue'
import FigurePrompt from './FigurePrompt.vue'
import FigurePublish from './FigurePublish.vue'
import FigureWindows from './FigureWindows.vue'

/** `?figures` shows every README figure under the heading it belongs to, for review. */
const figures = [
  { component: FigureKeys, heading: 'Create a signing key' },
  { component: FigureBuild, heading: 'Add the build plugins' },
  { component: FigureWindows, heading: 'Open windows from the active bundle' },
  { component: FigurePrompt, heading: 'Connect the updater to your pages' },
  { component: FigureHost, heading: 'Host the updates' },
  { component: FigurePublish, heading: 'Publish from CI' },
]
</script>

<template>
  <main class="gallery">
    <header class="top">
      <h1>README figures</h1>
      <button type="button" class="theme" :aria-label="theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'" @click="toggleTheme">
        <Icon :icon="icons[theme === 'dark' ? THEME_ICONS.light : THEME_ICONS.dark]!" aria-hidden="true" />
      </button>
    </header>
    <section v-for="f in figures" :key="f.heading" class="item">
      <h2 class="mono">
        ### {{ f.heading }}
      </h2>
      <component :is="f.component" />
    </section>
  </main>
</template>

<style scoped>
.gallery {
  display: grid;
  justify-content: center;
  gap: 56px;
  padding: 48px 24px 96px;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

h1 {
  margin: 0;
  font-size: 32px;
  font-weight: 600;
}

h2 {
  margin: 0 0 16px;
  color: var(--faint);
  font-size: 14px;
  font-weight: 400;
}

.theme {
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
}
</style>
