// Services that ergosphere-it works with out of the box, and the Iconify icon of each.
// The build reads the icons from @iconify-json, so the page loads nothing from the Iconify API.

export interface StackItem {
  /** The icon on a dark page. */
  icon: string
  /** The icon on a light page, when the brand draws itself differently there. */
  iconLight?: string
  name: string
}

/** All from selfh.st icons, under CC BY 4.0. The page footer credits them. */
export const STACK: StackItem[] = [
  { icon: 'selfhst:github-light', iconLight: 'selfhst:github', name: 'GitHub Actions' },
  { icon: 'selfhst:amazon-s3', name: 'Amazon S3' },
  { icon: 'selfhst:cloudflare', name: 'Cloudflare R2' },
  { icon: 'selfhst:garage', name: 'Garage' },
]

/** The check in the corner of each tile. */
export const CHECK_ICON = 'material-symbols:check-rounded'

/** The theme switch: the icon shows the theme it switches to. */
export const THEME_ICONS = {
  dark: 'material-symbols:dark-mode-rounded',
  light: 'material-symbols:light-mode-rounded',
}
