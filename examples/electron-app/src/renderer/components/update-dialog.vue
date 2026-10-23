<script setup lang="ts">
import type { Activation } from '@ergosphere-it/driver-electron/core'

const props = defineProps<{ activation: Activation, version: string }>()
const emit = defineEmits<{ apply: [], later: [] }>()
</script>

<template>
  <div class="backdrop">
    <div class="dialog">
      <h2>{{ props.version }} is ready</h2>
      <p v-if="props.activation === 'reload'">
        Only the page changed. The page reloads, and the app keeps running.
      </p>
      <p v-else-if="props.activation === 'restart'">
        The app code changed. The app restarts to finish the update.
      </p>
      <p v-else>
        This is a full update. The app quits, installs it, and opens again.
      </p>
      <div class="row">
        <button @click="emit('later')">
          Later
        </button>
        <button class="primary" @click="emit('apply')">
          {{ { install: 'Install now', reload: 'Reload now', restart: 'Restart now' }[props.activation] }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); display: grid; place-items: center; }
.dialog { width: 340px; background: #fff; color: #111; border-radius: 14px; padding: 20px; box-shadow: 0 20px 60px rgba(0, 0, 0, .35); }
h2 { margin: 0 0 6px; font-size: 18px; }
p { margin: 0 0 16px; color: #555; font-size: 14px; }
.row { display: flex; justify-content: flex-end; gap: 8px; }
button { font: inherit; border: 0; border-radius: 7px; padding: 6px 12px; cursor: pointer; background: #eee; color: #111; }
button.primary { background: #4b45c2; color: #fff; }
</style>
