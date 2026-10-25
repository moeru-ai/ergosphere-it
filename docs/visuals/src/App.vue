<script setup lang="ts">
import type { CaptureScene } from './capture'

import { CAPTURE_SIZES } from './capture'
import CaptureFrame from './components/CaptureFrame.vue'
import CodeTour from './components/CodeTour.vue'
import FeatureCards from './components/FeatureCards.vue'
import HeroFigure from './components/HeroFigure.vue'
import HowItWorks from './components/HowItWorks.vue'

/**
 * `?capture=<scene>` renders one still frame for the README banners: hero, setup, how, or features, at the sizes in capture.ts.
 * `&at=<seconds>` picks the moment, `&round=1` the round of the machine that goes back, and `&theme=light` the theme.
 * A bare `?capture` is the hero.
 */
const params = new URLSearchParams(location.search)
const capture = params.has('capture')
const scene = (Object.keys(CAPTURE_SIZES) as CaptureScene[]).find(s => s === params.get('capture')) ?? 'hero'
const at = params.has('at') ? Number(params.get('at')) : undefined
const round = params.has('round') ? Number(params.get('round')) : undefined

// A banner has rounded corners on a transparent page, so it sits well on any README background.
if (capture)
  document.documentElement.classList.add('capture')

const repo = 'https://github.com/moeru-ai/ergosphere-it'
</script>

<template>
  <CaptureFrame v-if="capture" :scene="scene" :at="at" :round="round" />
  <template v-else>
    <HeroFigure />
    <main>
      <CodeTour />
      <HowItWorks />
      <FeatureCards />
    </main>
    <footer class="footer">
      <a :href="`${repo}#installation-and-usage`">Get started</a>
      <a :href="`${repo}/blob/main/docs/spec.md`">Specification</a>
      <a :href="`${repo}/blob/main/docs/api.md`">API</a>
      <a :href="repo">GitHub</a>
      <p class="credit">
        Service icons by <a href="https://github.com/selfhst/icons">selfh.st</a>, under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
      </p>
    </footer>
  </template>
</template>

<style scoped>
.footer {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  max-width: 1160px;
  margin: 0 auto;
  padding: 120px 36px 96px;
  font-size: 15px;
}

.footer a {
  color: var(--muted);
  text-decoration: none;
}

.credit {
  flex-basis: 100%;
  margin: 8px 0 0;
  color: var(--faint);
  font-size: 13px;
}

.credit a {
  color: var(--faint);
  text-decoration: underline;
}

.footer a:hover {
  color: var(--text);
}
</style>
