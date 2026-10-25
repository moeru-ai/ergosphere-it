// The sizes of the README banners. The page renders each scene at its size, and scripts/banners.ts screenshots it.
// Most banners are 3:1. The machine needs more height, so it is 2:1.

export const CAPTURE_SIZES = {
  features: { height: 480, width: 1440 },
  hero: { height: 480, width: 1440 },
  how: { height: 640, width: 1280 },
  setup: { height: 480, width: 1440 },
}

export type CaptureScene = keyof typeof CAPTURE_SIZES
