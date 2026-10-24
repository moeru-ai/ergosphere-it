# Electron tests with Sparkle

The end-to-end test and the demo of Sparkle as the installer of `@ergosphere-it/electron`, on macOS. They build the [Sparkle example app](../../examples/electron-sparkle-app) twice, as 1.0.0 and 1.1.0, and package both with electron-builder.

## What a run does

1. It makes a key of ergosphere-it and a Sparkle key, and builds and packages both versions with them.
2. It makes the appcast and the delta with `generate_appcast`.
3. It registers 1.1.0 with `ergosphere-it register installer --sparkle`, and serves the update tree and the Sparkle files on port 4200.
4. It installs 1.0.0 in its work directory, outside the repository.

The e2e test then starts 1.0.0, presses Install through the DevTools protocol when the page shows that 1.1.0 is ready, and checks that the app on disk is 1.1.0, that it passes `codesign --verify`, and that Sparkle downloaded the delta and not the archive. The demo starts 1.0.0 for a person to press Install.

## Run it

On macOS, with the Xcode command line tools, after `pnpm -r build`:

```sh
pnpm -F @ergosphere-it/tests-electron-sparkle e2e
pnpm -F @ergosphere-it/tests-electron-sparkle demo
```

`--dir <dir>` keeps the keys, the builds, the served files, and the installed app in a directory. Each run empties it. The default is a new temporary directory.

These are scripts, not Vitest tests: they package real apps and wait for Sparkle to replace one, which takes minutes.
