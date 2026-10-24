import { defaultClientConditions, defaultServerConditions } from 'vite'

/** The export condition that points workspace packages at their sources. Published packages never set it. */
const SOURCE_CONDITION = '@ergosphere-it/source'

/** Resolves workspace packages to their sources, so tests run without a build of the packages that they import. */
export const sourceConditions = {
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
}
