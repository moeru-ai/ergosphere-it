declare module 'virtual:highlighted-samples' {
  interface HighlightedToken {
    color?: string
    content: string
    /** Flags: italic 1, bold 2. */
    fontStyle?: number
  }

  /** For each theme, one entry per sample in src/code/samples.ts: its lines, each a list of tokens. */
  const samples: Record<'dark' | 'light', HighlightedToken[][][]>
  export default samples
}

declare module 'virtual:stack-icons' {
  import type { IconifyIcon } from '@iconify/vue'

  /** Icon data by Iconify name, for the icons in src/stack/stack.ts. */
  const icons: Record<string, IconifyIcon>
  export default icons
}

interface Window {
  /** Set in capture mode: draws the hero at a time of its loop, for the animated banner. */
  __heroAt?: (t: number) => void
}
