import type { Plugin } from 'vite'

import vue from '@vitejs/plugin-vue'

import { icons as materialSymbols } from '@iconify-json/material-symbols'
import { icons as selfhst } from '@iconify-json/selfhst'
import { getIconData } from '@iconify/utils'
import { codeToTokens } from '@pierre/highlights'
import { defineConfig } from 'vite'

import { SAMPLES } from './src/code/samples.ts'
import { CODE_THEMES } from './src/code/theme.ts'
import { paletteCss } from './src/palette.ts'
import { CHECK_ICON, FIGURE_ICONS, STACK, THEME_ICONS } from './src/stack/stack.ts'

const HIGHLIGHTED = 'virtual:highlighted-samples'
const ICONS = 'virtual:stack-icons'

/**
 * Highlights the code tour at build time with @pierre/highlights, so the page ships colored tokens and no
 * WebAssembly. The module exports, for the dark and the light theme, one entry per sample: its lines, each a list of tokens.
 */
function highlightedSamples(): Plugin {
  return {
    load(id) {
      if (id !== `\0${HIGHLIGHTED}`)
        return
      const highlight = (theme: keyof typeof CODE_THEMES) => SAMPLES.map(sample => codeToTokens(sample.code, { lang: sample.lang, theme: CODE_THEMES[theme] }).tokens.map(line =>
        line.map(token => ({ color: token.color, content: token.content, fontStyle: token.fontStyle })),
      ))
      return `export default ${JSON.stringify({ dark: highlight('dark'), light: highlight('light') })}`
    },
    name: 'highlighted-samples',
    resolveId(id) {
      return id === HIGHLIGHTED ? `\0${HIGHLIGHTED}` : undefined
    },
  }
}

const ICON_SETS = { 'material-symbols': materialSymbols, 'selfhst': selfhst }

/** Puts the accent colors of src/palette.ts into the page head, as CSS custom properties for both themes. */
function palette(): Plugin {
  return {
    name: 'palette',
    transformIndexHtml: () => [{ children: paletteCss(), injectTo: 'head', tag: 'style' }],
  }
}

/**
 * Takes the few Iconify icons that the page uses out of their sets at build time, so the page ships only those
 * and never calls the Iconify API. The module exports icon data by name, for the Icon component of @iconify/vue.
 */
function stackIcons(): Plugin {
  return {
    load(id) {
      if (id !== `\0${ICONS}`)
        return
      const data = Object.fromEntries([...STACK.flatMap(s => [s.icon, s.iconLight ?? s.icon]), CHECK_ICON, ...Object.values(THEME_ICONS), ...Object.values(FIGURE_ICONS)].map((name) => {
        const [prefix, icon] = name.split(':') as [keyof typeof ICON_SETS, string]
        const found = getIconData(ICON_SETS[prefix], icon)
        if (!found)
          throw new Error(`Unknown icon ${name}`)
        return [name, found]
      }))
      return `export default ${JSON.stringify(data)}`
    },
    name: 'stack-icons',
    resolveId(id) {
      return id === ICONS ? `\0${ICONS}` : undefined
    },
  }
}

export default defineConfig({
  // Relative asset paths, so the build works from any directory, for example GitHub Pages under /ergosphere-it/
  base: './',
  plugins: [vue(), palette(), highlightedSamples(), stackIcons()],
})
