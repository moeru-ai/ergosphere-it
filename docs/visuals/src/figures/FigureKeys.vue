<script setup lang="ts">
import { Icon } from '@iconify/vue'
import icons from 'virtual:stack-icons'

import { FIGURE_ICONS } from '../stack/stack'
</script>

<!-- Create a signing key: keygen makes a pair. The public key goes into the app, the private key into CI. -->
<template>
  <div class="f-figure" role="img" aria-label="ergosphere-it keygen makes two keys. The public key goes into ergo.config.ts, and the app checks every bundle with it. The private key goes into a CI secret, and CI signs every release with it.">
    <svg class="f-wires" width="1440" height="480" aria-hidden="true">
      <path d="M430 240 H500 C540 240 540 140 580 140 H620" />
      <path d="M500 240 C540 240 540 340 580 340 H620" />
      <path d="M1070 140 H1140" />
      <path d="M1070 340 H1140" />
    </svg>

    <div class="f-device cmd" style="left: 100px; top: 190px; width: 330px; height: 100px">
      <Icon :icon="icons[FIGURE_ICONS.terminal]!" class="cmd-icon" />
      <span>ergosphere-it keygen</span>
    </div>

    <div class="f-tile" style="left: 620px; top: 100px; color: var(--cyan-ink)">
      <Icon :icon="icons[FIGURE_ICONS.key]!" />
    </div>
    <div style="left: 726px; top: 104px; width: 330px">
      <p class="f-title">
        Public key
      </p>
      <p class="f-note">
        Goes into ergo.config.ts. Safe to commit.
      </p>
    </div>

    <div class="f-tile" style="left: 620px; top: 300px; color: var(--orange)">
      <Icon :icon="icons[FIGURE_ICONS.key]!" />
    </div>
    <div style="left: 726px; top: 304px; width: 330px">
      <p class="f-title">
        Private key
      </p>
      <p class="f-note">
        Goes into the CI secret UPDATES_SIGNING_KEY. Never commit it.
      </p>
    </div>

    <div class="f-device holder" style="left: 1140px; top: 80px">
      <div class="f-well" style="width: 72px; height: 72px; color: var(--cyan-ink)">
        <Icon :icon="icons[FIGURE_ICONS.key]!" />
      </div>
    </div>
    <p class="f-note" style="left: 1140px; top: 214px; width: 230px">
      Your app checks every bundle with it.
    </p>

    <div class="f-device holder" style="left: 1140px; top: 280px">
      <div class="f-well" style="width: 72px; height: 72px; color: var(--muted)">
        <Icon :icon="icons[FIGURE_ICONS.lock]!" />
      </div>
    </div>
    <p class="f-note" style="left: 1140px; top: 414px; width: 230px">
      CI signs every release with it.
    </p>
  </div>
</template>

<style scoped>
.cmd {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-family: var(--font-mono);
  font-size: 17px;
}

.cmd-icon {
  color: var(--muted);
  font-size: 24px;
}

.holder {
  display: grid;
  width: 200px;
  height: 120px;
  font-size: 30px;
  place-items: center;
}
</style>
