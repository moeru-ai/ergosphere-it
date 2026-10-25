<script setup lang="ts">
import type { CaptureScene } from '../capture'

import { CAPTURE_SIZES } from '../capture'
import FigureBuild from '../figures/FigureBuild.vue'
import FigureHost from '../figures/FigureHost.vue'
import FigureKeys from '../figures/FigureKeys.vue'
import FigurePrompt from '../figures/FigurePrompt.vue'
import FigurePublish from '../figures/FigurePublish.vue'
import FigureWindows from '../figures/FigureWindows.vue'
import CodeTour from './CodeTour.vue'
import FeatureCards from './FeatureCards.vue'
import HeroFigure from './HeroFigure.vue'
import HowItWorks from './HowItWorks.vue'

/**
 * A fixed frame for the README banners: one scene of the page at one size, without section titles, frozen in time.
 * scripts/banners.ts screenshots each scene in both themes.
 */
const props = defineProps<{
  /** The moment, in seconds, for scenes that move. */
  at?: number
  /** The round of the machine: 0 keeps the new bundle, 1 sends it back. */
  round?: number
  scene: CaptureScene
}>()

const size = CAPTURE_SIZES[props.scene]

const FIGURES = {
  'figure-build': FigureBuild,
  'figure-host': FigureHost,
  'figure-keys': FigureKeys,
  'figure-prompt': FigurePrompt,
  'figure-publish': FigurePublish,
  'figure-windows': FigureWindows,
} as const
const figure = props.scene in FIGURES ? FIGURES[props.scene as keyof typeof FIGURES] : undefined
</script>

<template>
  <div class="frame" :class="scene" :style="{ width: `${size.width}px`, height: `${size.height}px` }">
    <component :is="figure" v-if="figure" />
    <HeroFigure v-else-if="scene === 'hero'" capture :capture-at="at" />
    <CodeTour v-else-if="scene === 'setup'" />
    <HowItWorks v-else-if="scene === 'how'" :still-at="at ?? 6.6" :still-round="round ?? 0" />
    <FeatureCards v-else />
  </div>
</template>

<style scoped>
.frame {
  display: flex;
  overflow: hidden;
  border-radius: 28px;
  flex-direction: column;
  justify-content: center;
  padding: 0 60px;
  background: var(--bg);
}

.frame.hero,
.frame[class*='figure-'] {
  padding: 0;
}

/* A capture draws exact frames: nothing eases on its own between them. */
.frame.how :deep(*) {
  transition: none !important;
}

/* At 3:1 the file keys do not fit. The banner shows one file, and its name says which. */
.frame.setup :deep(.keys) {
  display: none;
}

/* The README has its own headings, so the frame drops the section titles and their space. */
.frame :deep(section) {
  max-width: none;
  margin: 0;
  padding: 0;
}

.frame :deep(h2) {
  display: none;
}
</style>
