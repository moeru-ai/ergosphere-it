import type { Shade } from '@proj-airi/chromatic'

import { chromaticColorFrom } from '@proj-airi/chromatic'

// The accents come from @proj-airi/chromatic, the palette of Project AIRI: one OKLCH hue each, and a shade per use.
// Neutrals stay in style.css. The build turns this file into CSS custom properties (virtual:palette.css).

/** OKLCH hues of the accents. New: cyan. Activity: orange. Failure: red. Works: green. */
const HUES = { cyan: 218, green: 155, orange: 51, red: 28 }

type Accent = keyof typeof HUES

const hex = (accent: Accent, shade: Shade, saturation = 100): string => chromaticColorFrom(HUES[accent], { saturation, shade }).toHex()

function channels(color: string): string {
  const n = Number.parseInt(color.slice(1, 7), 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

function tokens(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(map)) {
    out[name] = value
    // Colors that take an alpha also come as channels: rgb(var(--cyan-rgb) / 20%).
    if (['cyan', 'orange', 'red'].includes(name))
      out[`${name}-rgb`] = channels(value)
  }
  return out
}

/** Dark accents are light shades that glow on black. */
const dark = tokens({
  'channel-hi': hex('cyan', 900, 60),
  'channel-lo': hex('cyan', 950, 60),
  'cyan': hex('cyan', 300),
  'cyan-ink': hex('cyan', 300),
  'green': hex('green', 400),
  'on-cyan': hex('cyan', 950),
  'on-green': hex('green', 950),
  'on-red': hex('red', 950),
  'orange': hex('orange', 400),
  'red': hex('red', 400),
  'red-soft-bg': hex('red', 950, 50),
})

/** Light accents: fills in the middle, ink a step darker for text, and pale shades for soft grounds. */
const light = tokens({
  'channel-hi': hex('cyan', 100),
  'channel-lo': hex('cyan', 200),
  'cyan': hex('cyan', 400),
  'cyan-ink': hex('cyan', 700),
  'green': hex('green', 200),
  'on-cyan': hex('cyan', 950),
  'on-green': hex('green', 700),
  'on-red': hex('red', 950),
  'orange': hex('orange', 500),
  'red': hex('red', 500),
  'red-soft-bg': hex('red', 100),
})

/** The colors of the code theme that follow the accents. */
export const CODE_ACCENTS = {
  dark: { cyan: hex('cyan', 300), orange: hex('orange', 400) },
  light: { cyan: hex('cyan', 700), orange: hex('orange', 700) },
}

export function paletteCss(): string {
  const block = (selector: string, values: Record<string, string>): string =>
    `${selector} {\n${Object.entries(values).map(([k, v]) => `  --${k}: ${v};`).join('\n')}\n}`
  return [block(':root', dark), block(':root[data-theme=\'light\']', light)].join('\n\n')
}
