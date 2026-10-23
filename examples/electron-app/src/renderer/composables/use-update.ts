import type { UpdateStatus } from '@ergosphere-it/driver-electron/core'

import { computed, ref } from 'vue'

/**
 * The update notice of the page: the status from main, and whether the toast and the dialog show.
 *
 * The dialog opens once for each ready core. A closed toast stays closed until the status means something new.
 */
export function useUpdate() {
  const status = ref<UpdateStatus>({ state: 'idle' })
  const dialogOpen = ref(false)
  const dismissed = ref<string>()
  let readySeq: number | undefined

  window.example.onStatus((next) => {
    status.value = next
    // Every check reports `ready` again until the user applies the update.
    if (next.state === 'ready' && next.seq !== readySeq) {
      readySeq = next.seq
      dialogOpen.value = true
    }
    if (next.state === 'applying')
      dialogOpen.value = false
  })

  const key = computed(() => noticeKey(status.value))
  const toastOpen = computed(() => status.value.state !== 'idle' && dismissed.value !== key.value)

  return {
    apply(): void {
      dialogOpen.value = false
      void window.example.apply()
    },
    closeDialog(): void {
      dialogOpen.value = false
    },
    dialogOpen,
    dismissToast(): void {
      dismissed.value = key.value
    },
    status,
    toastOpen,
  }
}

/** Names what a status means. Download progress of one core keeps the same name. */
function noticeKey(status: UpdateStatus): string {
  switch (status.state) {
    case 'applying':
    case 'downloading':
    case 'ready':
      return `${status.state}-${status.seq}`
    case 'error':
      return `error-${status.message}`
    case 'idle':
      return 'idle'
    case 'rolled-back':
      return `rolled-back-${status.from}-${status.to}`
  }
}
