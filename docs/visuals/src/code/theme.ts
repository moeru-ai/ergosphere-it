import type { Theme } from '@pierre/highlights'

import { CODE_ACCENTS } from '../palette.ts'

interface Palette {
  background: string
  cyan: string
  muted: string
  orange: string
  quiet: string
  soft: string
  text: string
}

/**
 * The page palette as a Zed theme: strings are cyan like new bundles, numbers and constants are orange like the
 * activity lights, and keywords and punctuation step back so the names read first.
 */
function ergosphereTheme(appearance: 'dark' | 'light', { background, cyan, muted, orange, quiet, soft, text }: Palette): Theme {
  return {
    appearance,
    name: `ergosphere-${appearance}`,
    style: {
      'editor.background': background,
      'editor.foreground': soft,
      'syntax': {
        'attribute': muted,
        'boolean': orange,
        'class': soft,
        'comment': quiet,
        'comment.doc': quiet,
        'constant': orange,
        'constructor': soft,
        'function': text,
        'function.builtin': text,
        'function.call': text,
        'function.method': text,
        'function.method.call': text,
        'keyword': muted,
        'keyword.operator': quiet,
        'number': orange,
        'operator': quiet,
        'property': soft,
        'property_identifier': soft,
        'punctuation': quiet,
        'punctuation.bracket': quiet,
        'punctuation.delimiter': quiet,
        'string': cyan,
        'string.escape': cyan,
        'string.special': cyan,
        'string.template': cyan,
        'tag': muted,
        'type': soft,
        'type.builtin': soft,
        'variable': text,
        'variable.builtin': text,
        'variable.member': soft,
        'variable.parameter': soft,
      },
    },
  }
}

export const CODE_THEMES = {
  dark: ergosphereTheme('dark', { ...CODE_ACCENTS.dark, background: '#0d0d12', muted: '#9a978f', quiet: '#7a7771', soft: '#d9d5cc', text: '#ece9e2' }),
  light: ergosphereTheme('light', { ...CODE_ACCENTS.light, background: '#fbfbfc', muted: '#62626a', quiet: '#8d8d95', soft: '#3f3f46', text: '#18181b' }),
}
