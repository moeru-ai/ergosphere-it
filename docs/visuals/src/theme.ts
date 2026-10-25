import { ref, watch } from 'vue'

export type ThemeName = 'dark' | 'light'

const KEY = 'ergosphere-it:theme'

function stored(): ThemeName | undefined {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'dark' || value === 'light' ? value : undefined
  }
  catch {
    return undefined
  }
}

const system = window.matchMedia('(prefers-color-scheme: light)')
// `?theme=light` wins, for screenshots of the banner. Then the choice of the viewer, then the system.
const forced = new URLSearchParams(location.search).get('theme')

/** The theme of the page. index.html sets the attribute before the first paint, so the page never flashes. */
export const theme = ref<ThemeName>(forced === 'light' || forced === 'dark' ? forced : stored() ?? (system.matches ? 'light' : 'dark'))

watch(theme, (value) => {
  document.documentElement.dataset.theme = value
}, { immediate: true })

system.addEventListener('change', (event) => {
  if (!forced && !stored())
    theme.value = event.matches ? 'light' : 'dark'
})

export function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem(KEY, theme.value)
  }
  catch {}
}
