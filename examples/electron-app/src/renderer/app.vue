<script setup lang="ts">
import { onMounted } from 'vue'

import UpdateDialog from './components/update-dialog.vue'
import UpdateToast from './components/update-toast.vue'

import { useUpdate } from './composables/use-update'

const query = new URLSearchParams(location.search)
const version = __APP_VERSION__
const info = `core ${query.get('seq')} (${query.get('kind')}) · pid ${query.get('pid')}`
// Each version gets its own color, so a page update is easy to see.
const hue = [...version].reduce((sum, char) => sum + char.charCodeAt(0) * 37, 0) % 360

const { apply, closeDialog, dialogOpen, dismissToast, status, toastOpen } = useUpdate()

document.title = `ergosphere-it example ${version}`

// Report health after the page mounted. A core whose page never mounts is rolled back.
onMounted(() => window.example.mounted({ version }))
</script>

<template>
  <div class="page" :style="{ background: `hsl(${hue} 55% 42%)` }">
    <main>
      <div class="caption">
        page
      </div>
      <h1>{{ version }}</h1>
      <p class="info">
        {{ info }}
      </p>
    </main>

    <UpdateToast v-if="toastOpen" :status="status" @apply="apply" @close="dismissToast" />
    <UpdateDialog
      v-if="dialogOpen && status.state === 'ready'"
      :activation="status.activation"
      :version="status.version"
      @apply="apply"
      @later="closeDialog"
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
