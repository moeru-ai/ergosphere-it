<script setup lang="ts">
import type { UpdateStatus } from '@ergosphere-it/driver-electron/core'

import { computed } from 'vue'

const props = defineProps<{ status: UpdateStatus }>()
const emit = defineEmits<{ apply: [], close: [] }>()

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`

/** What the toast shows for a status. */
const notice = computed(() => {
  const status = props.status
  switch (status.state) {
    case 'applying':
      return { body: status.version, title: { install: 'Installing…', reload: 'Reloading…', restart: 'Restarting…' }[status.activation] }
    case 'downloading':
      return {
        body: status.version,
        detail: `${mb(status.downloadedBytes)} / ${mb(status.totalBytes)}`,
        progress: status.totalBytes ? status.downloadedBytes / status.totalBytes : 1,
        title: 'Downloading update',
      }
    case 'error':
      return { bad: true, body: status.message, title: 'Update error' }
    case 'ready':
      return { apply: true, body: `${status.version} is downloaded.`, detail: { install: 'Install to update', reload: 'Reload to update', restart: 'Restart to update' }[status.activation], title: 'Update ready' }
    case 'rolled-back':
      return { bad: true, body: `Core ${status.from} did not work, so the app went back to core ${status.to}.`, detail: status.reason, title: 'Update failed' }
    default:
      return { title: '' }
  }
})
</script>

<template>
  <div class="toast" :class="{ bad: notice.bad }">
    <div class="row">
      <span class="title">{{ notice.title }}</span>
      <button title="Dismiss" @click="emit('close')">
        ×
      </button>
    </div>
    <div>{{ notice.body }}</div>
    <div v-if="notice.progress !== undefined" class="bar">
      <div :style="{ width: `${Math.round(notice.progress * 100)}%` }" />
    </div>
    <div class="row">
      <span class="detail">{{ notice.detail }}</span>
      <button v-if="notice.apply" class="primary" @click="emit('apply')">
        Apply
      </button>
    </div>
  </div>
</template>

<style scoped>
.toast { position: fixed; left: 16px; bottom: 16px; width: 300px; background: rgba(20, 20, 24, .92); color: #fff; border-radius: 12px; padding: 12px 14px; box-shadow: 0 8px 30px rgba(0, 0, 0, .3); font-size: 13px; }
.toast.bad { background: rgba(150, 30, 30, .95); }
.title { font-weight: 600; margin-bottom: 6px; }
.detail { opacity: .7; }
.bar { height: 6px; border-radius: 3px; background: rgba(255, 255, 255, .2); overflow: hidden; margin: 8px 0 4px; }
.bar > div { height: 100%; background: #7cf; transition: width .15s; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
button { font: inherit; border: 0; border-radius: 7px; padding: 6px 12px; cursor: pointer; background: rgba(255, 255, 255, .15); color: #fff; }
button.primary { background: #fff; color: #111; }
</style>
