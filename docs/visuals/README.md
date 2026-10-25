# ergosphere-it visuals

The ergosphere-it page, made with Vue: an over-the-air updater that always finds its way back, told with a few shapes.

- The hero: the title, what it does, and the services it works with, with their [Iconify](https://iconify.design) icons. The build takes the icons out of `@iconify-json` packages, so the page never calls the Iconify API. Beside it, your app is a rounded square, and the bundle that it runs is a disc. A new bundle comes down the channel from the right and takes over, and the old one waits in a corner. Then a bad bundle comes, crashes, and drops out, and the app goes back on its own. Progressive blur stands for distance: releases far down the channel and bundles that drop out are blurred.
- How it works: one machine of three boxes, CI, a bucket, and your app. A release is built and signed, uploaded as files, a manifest, and a channel switch, checked by the app, fetched file by file, applied, and then kept or sent back by the health check. Numbered lights follow the steps, and pointing at one holds that step.
- Three cards: only the bundle moves, a few installs go first, and no update server. Each figure moves when you hover or focus its card.
- Set it up: the four files you touch, from the README, with notes on their lines. Point at a note and its lines light up. [@pierre/highlights](https://diffs.com/docs#highlights) highlights the code at build time with a theme in the page palette (`src/code/theme.ts`), so the page ships colored tokens and no WebAssembly.

It is plain DOM and CSS, in a dark and a light theme. The accents come from [@proj-airi/chromatic](https://github.com/proj-airi/chromatic) (`src/palette.ts`), and the build puts them into the page as CSS custom properties. The page follows the system, and a switch in the corner of the hero keeps the choice of the viewer. The fonts are Gabarito and Maple Mono, from Fontsource, so the page loads nothing from other hosts.

## Run

```bash
pnpm install
pnpm -F @ergosphere-it/docs-visuals dev
```

`pnpm -F @ergosphere-it/docs-visuals build` writes a static site to `docs/visuals/dist`. It uses relative paths, so any static host works, for example GitHub Pages.

## Banners

The README shows four banners and six section figures, each in a dark and a light theme, from `docs/assets/banners`. The hero and how-it-works are animated. Each banner has rounded corners on a transparent ground, so it sits well on any README background. Render them again after a change of the page:

```bash
pnpm -F @ergosphere-it/docs-visuals banners
```

The script builds the page and serves it with `vite preview`. Still banners are screenshots of `?capture=<scene>` from headless Chrome at 2x, converted with `cwebp`. The animated ones are drawn one frame at a time through the Chrome DevTools protocol, and `img2webp` joins the frames into a looping, lossless WebP: lossy frames show bands in the dark gradients. The hero plays its 11-second loop at 15 frames a second, and how-it-works plays both rounds of the machine, 26 seconds, at 12. Both tools come with `brew install webp`. `CHROME` points to another Chrome binary.

| Banner | Size | URL |
| --- | --- | --- |
| hero, animated | 1440×480 (3:1) | `?capture=hero` |
| setup | 1440×480 (3:1) | `?capture=setup` |
| how-it-works, animated | 1280×640 (2:1) | `?capture=how&at=6.6&round=0` |
| features | 1440×480 (3:1) | `?capture=features` |
| figure-keys, figure-build, figure-windows, figure-prompt, figure-host, figure-publish | 1440×480 (3:1) | `?capture=figure-<name>` |

`src/capture.ts` holds the sizes. `?figures` shows the six figures under the README headings they belong to. Add `&theme=light` for the light theme, and `&at=<seconds>` for a still hero. `scripts/sync-readme.ts` points the banners of the package README at raw.githubusercontent.com, so they show on npm too.

## Credits

The service icons come from [selfh.st icons](https://github.com/selfhst/icons), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The page footer credits it too.
