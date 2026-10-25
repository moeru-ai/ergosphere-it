<script setup lang="ts">
import { Icon } from '@iconify/vue'
import icons from 'virtual:stack-icons'

import { CHECK_ICON, STACK } from '../stack/stack'
import { theme } from '../theme'
</script>

<template>
  <div class="works">
    <p class="label">
      Works with
    </p>
    <ul class="logos">
      <li v-for="s in STACK" :key="s.name" class="item" :title="s.name" :aria-label="s.name">
        <span class="mark">
          <Icon :icon="icons[theme === 'light' ? s.iconLight ?? s.icon : s.icon]!" class="logo" aria-hidden="true" />
          <span class="badge" aria-hidden="true">
            <Icon :icon="icons[CHECK_ICON]!" />
          </span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* A compact row in the hero: each brand as it draws itself, with a small check on its corner. */
.works {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 20px;
  margin-top: 24px;
}

.label {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
}

.logos {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  display: flex;
  align-items: center;
}

.mark {
  position: relative;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  transition: transform 0.35s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.logo {
  width: 22px;
  height: 22px;
}

.badge {
  position: absolute;
  right: -5px;
  bottom: -5px;
  display: grid;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 2px var(--bg);
  color: var(--on-green);
  font-size: 9px;
  place-items: center;
  transition: transform 0.35s cubic-bezier(0.3, 1.6, 0.5, 1);
}

.item:hover .mark {
  transform: translateY(-2px);
}

.item:hover .badge {
  transform: scale(1.2);
}
</style>
