<script setup lang="ts">
import type { UpdaterStatus } from '@ergosphere-it/electron/types'

import { computed, ref } from 'vue'

const props = defineProps<{ status: UpdaterStatus }>()
const emit = defineEmits<{ apply: [], dismissRollback: [] }>()

const labels = { install: 'Install and restart', reload: 'Reload now', restart: 'Restart now' }

/** What the toast shows. Statuses that users cannot act on show nothing. */
const notice = computed(() => {
  const status = props.status
  switch (status.status) {
    case 'applying':
      return { body: status.update.version, title: { install: 'Installing…', reload: 'Reloading…', restart: 'Restarting…' }[status.update.requires] }
    case 'download-failed':
      return { bad: true, body: `The download of ${status.update.version} failed. The app tries again at ${new Date(status.retryAt).toLocaleTimeString()}.`, title: 'Update paused' }
    case 'downloading':
      return { body: status.update.version, percent: status.percent, title: 'Downloading update' }
    case 'ready':
      return { action: labels[status.update.requires], body: `${status.update.version} is downloaded.`, title: 'Update ready' }
    case 'rolled-back':
      return {
        bad: true,
        body: status.reason === 'withdrawn'
          ? `Version ${status.from.version} was withdrawn. The app went back to ${status.to.version}.`
          : `Version ${status.from.version} did not start correctly. The app went back to ${status.to.version}.`,
        title: 'Update undone',
      }
    default:
      return undefined
  }
})

// A closed notice stays closed until the status means something new. Download progress of one update keeps its key.
const key = computed(() => {
  const status = props.status
  if (status.status === 'rolled-back')
    return `rolled-back-${status.from.releaseId}`

  return 'update' in status && status.update ? `${status.status}-${status.update.releaseId}` : status.status
})
const closedKey = ref<string>()

function close(): void {
  closedKey.value = key.value
  if (props.status.status === 'rolled-back')
    emit('dismissRollback')
}
</script>

<template>
  <div v-if="notice && closedKey !== key" class="toast" :class="{ bad: notice.bad }">
    <div class="row">
      <span class="title">{{ notice.title }}</span>
      <button title="Dismiss" @click="close">
        ×
      </button>
    </div>
    <div>{{ notice.body }}</div>
    <div v-if="notice.percent !== undefined" class="bar">
      <div :style="{ width: `${notice.percent}%` }" />
    </div>
    <div v-if="notice.action" class="row end">
      <button class="primary" @click="emit('apply')">
        {{ notice.action }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.toast { position: fixed; left: 16px; bottom: 16px; width: 300px; background: rgba(20, 20, 24, .92); color: #fff; border-radius: 12px; padding: 12px 14px; box-shadow: 0 8px 30px rgba(0, 0, 0, .3); font-size: 13px; }
.toast.bad { background: rgba(150, 30, 30, .95); }
.title { font-weight: 600; margin-bottom: 6px; }
.bar { height: 6px; border-radius: 3px; background: rgba(255, 255, 255, .2); overflow: hidden; margin: 8px 0 4px; }
.bar > div { height: 100%; background: #7cf; transition: width .15s; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.row.end { justify-content: flex-end; margin-top: 8px; }
button { font: inherit; border: 0; border-radius: 7px; padding: 6px 12px; cursor: pointer; background: rgba(255, 255, 255, .15); color: #fff; }
button.primary { background: #fff; color: #111; }
</style>
