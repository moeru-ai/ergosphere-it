// Copies the repository README to the README of @ergosphere-it/electron, the package that apps install, so npm shows
// the same guide. Run it through `pnpm docs:update` after a change of README.md.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const repository = 'https://github.com/moeru-ai/ergosphere-it/blob/main'

const readme = readFileSync(join(root, 'README.md'), 'utf8')
// A relative link of the repository README breaks in the package and on npm, so it points to GitHub instead.
const synced = readme.replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_match, path: string) => `](${repository}/${path.replace(/^\.\//, '')})`)

writeFileSync(join(root, 'packages', 'electron', 'README.md'), `<!-- Generated from README.md of the repository by \`pnpm docs:update\`. Edit README.md instead. -->\n\n${synced}`)
