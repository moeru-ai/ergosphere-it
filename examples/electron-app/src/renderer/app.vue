<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import UpdateDialog from './components/update-dialog.vue'
import UpdateToast from './components/update-toast.vue'

import { markBundleHealthy, useUpdates } from './composables/use-updates'

const { apply: applyUpdate, bundle, dismissRollback, status } = useUpdates()

const version = computed(() => bundle.value?.version ?? '…')
const origin = computed(() => (bundle.value?.fromInstaller ? 'from the installer' : 'downloaded'))
// Each version gets its own color, so a page update is easy to see.
const hue = computed(() => [...version.value].reduce((sum, char) => sum + char.charCodeAt(0) * 37, 0) % 360)

// The dialog asks once for each ready update. "Later" keeps the toast.
const dialogFor = ref<number>()
const dialogOpen = ref(false)
watch(status, (next) => {
  if (next.status === 'ready' && next.update.releaseId !== dialogFor.value) {
    dialogFor.value = next.update.releaseId
    dialogOpen.value = true
  }
})

function apply(): void {
  dialogOpen.value = false
  void applyUpdate()
}

// The app is usable once the first screen rendered. A real app waits for its stores and data here too.
onMounted(async () => {
  await nextTick()
  markBundleHealthy()
})
</script>

<template>
  <div class="page" :style="{ background: `hsl(${hue} 55% 42%)` }">
    <main>
      <div class="caption">
        bundle
      </div>
      <h1>{{ version }}</h1>
      <p class="info">
        {{ origin }} · release {{ bundle?.releaseId }}
      </p>
    </main>

    <UpdateToast :status="status" @apply="apply" @dismiss-rollback="dismissRollback" />
    <UpdateDialog
      v-if="dialogOpen && status.status === 'ready'"
      :update="status.update"
      @apply="apply"
      @later="dialogOpen = false"
    />
  </div>
</template>

<style>
body { font-family: system-ui; margin: 0; overflow: hidden; }
</style>

<style scoped>
.page { height: 100vh; display: grid; place-items: center; color: #fff; }
main { text-align: center; }
h1 { font-size: 72px; margin: 0; }
.caption { font-size: 14px; opacity: .8; }
.info { font: 16px ui-monospace, monospace; opacity: .85; }
</style>
