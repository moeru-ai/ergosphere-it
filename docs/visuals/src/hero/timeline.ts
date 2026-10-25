// The hero story, as a pure function of time, so a still frame at any moment needs no simulation.
// The stage is 640 × 480. The app is a rounded square, a bundle is a disc, and the channel is a line from the right.

export const STAGE = { height: 480, width: 640 }

/** The app: a rounded square. */
export const APP = { size: 220, x: 140, y: 130 }

/** Where the running bundle sits, and its size. */
const SLOT = { r: 56, x: APP.x + APP.size / 2, y: APP.y + APP.size / 2 }
/** Where the previous bundle waits, in a corner of the app. */
const SPARE = { r: 18, x: APP.x + 34, y: APP.y + APP.size - 34 }
/** Where a new bundle enters the stage, far down the channel. */
const FAR = { r: 26, x: STAGE.width + 30, y: SLOT.y }
/** Where a new bundle waits at the edge of the app before it takes over. */
const EDGE = { r: 26, x: APP.x + APP.size + 34, y: SLOT.y }
/** Where a bad bundle ends after it drops out of the app. */
const DROP = { r: 30, x: SLOT.x + 90, y: STAGE.height + 40 }

/** One loop, in seconds. */
export const LOOP = 11

export interface Disc {
  label: string
  opacity: number
  r: number
  /** A sideways shake, in pixels, while a bundle crashes. */
  shake: number
  tone: Tone
  x: number
  y: number
}

type Tone = 'bad' | 'new' | 'old' | 'run'

const ease = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))
const span = (t: number, from: number, to: number): number => ease((t - from) / (to - from))

interface Point { r: number, x: number, y: number }

export function discsAt(t: number): Disc[] {
  return [first(t), second(t), third(t)]
}

function between(a: Point, b: Point, u: number): Point {
  return { r: a.r + (b.r - a.r) * u, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
}

function disc(p: Point, label: string, tone: Tone, opacity: number, shake = 0): Disc {
  return { label, opacity, r: p.r, shake, tone, x: p.x, y: p.y }
}

/** 1.0.3 runs at the start, then waits as the previous bundle, then is dropped when another takes its place. */
function first(t: number): Disc {
  if (t < 2.8)
    return disc(SLOT, '1.0.3', 'run', loopFade(t))
  if (t < 3.6) {
    // It changes color halfway, so the change reads as part of the move.
    const u = span(t, 2.8, 3.6)
    return disc(between(SLOT, SPARE, u), '1.0.3', u < 0.5 ? 'run' : 'old', 1)
  }
  return disc(SPARE, '1.0.3', 'old', 1 - span(t, 6.2, 6.8))
}

/** Fades everything out at the end of the loop and in at the start, so the loop restarts cleanly. */
function loopFade(t: number): number {
  return Math.min(span(t, 0, 0.5), 1 - span(t, LOOP - 0.6, LOOP))
}

/** 1.0.4 comes down the channel, takes over, steps aside for 1.0.5, and takes over again when 1.0.5 fails. */
function second(t: number): Disc {
  if (t < 1.2)
    return disc(FAR, '1.0.4', 'new', 0)
  if (t < 2.8)
    return disc(between(FAR, EDGE, span(t, 1.2, 2.8)), '1.0.4', 'new', span(t, 1.2, 1.6))
  if (t < 3.6)
    return disc(between(EDGE, SLOT, span(t, 2.8, 3.6)), '1.0.4', 'new', 1)
  if (t < 6.2)
    return disc(SLOT, '1.0.4', t < 4.4 ? 'new' : 'run', 1)
  if (t < 6.8) {
    const u = span(t, 6.2, 6.8)
    return disc(between(SLOT, SPARE, u), '1.0.4', u < 0.5 ? 'run' : 'old', 1)
  }
  if (t < 7.9)
    return disc(SPARE, '1.0.4', 'old', 1)
  if (t < 8.7) {
    const u = span(t, 7.9, 8.7)
    return disc(between(SPARE, SLOT, u), '1.0.4', u < 0.5 ? 'old' : 'run', 1)
  }
  return disc(SLOT, '1.0.4', 'run', loopFade(t))
}

/** 1.0.5 comes down the channel the same way, crashes, and drops out of the app. */
function third(t: number): Disc {
  if (t < 4.6)
    return disc(FAR, '1.0.5', 'new', 0)
  if (t < 6.2)
    return disc(between(FAR, EDGE, span(t, 4.6, 6.2)), '1.0.5', 'new', span(t, 4.6, 5.0))
  if (t < 6.8)
    return disc(between(EDGE, SLOT, span(t, 6.2, 6.8)), '1.0.5', 'new', 1)
  if (t < 7.6) {
    const crash = span(t, 6.9, 7.1)
    return disc(SLOT, '1.0.5', crash > 0 ? 'bad' : 'new', 1, Math.sin(t * 70) * 5 * crash * (1 - span(t, 7.3, 7.6)))
  }
  const u = span(t, 7.6, 9.2)
  return disc(between(SLOT, DROP, u), '1.0.5', 'bad', 1 - span(t, 8.4, 9.2))
}

/** What the figure says at each part of the loop. */
export const CAPTIONS = [
  { at: 0, text: 'Your app runs 1.0.3.' },
  { at: 1.2, text: '1.0.4 comes over the air.' },
  { at: 2.8, text: 'It takes over. 1.0.3 waits in case.' },
  { at: 4.6, text: '1.0.5 comes the same way.' },
  { at: 6.9, text: '1.0.5 crashes.' },
  { at: 7.6, text: 'The app drops it and goes back to 1.0.4 on its own.' },
]

/** How visible a caption is at a time: it fades in after it starts and out before the next one, over 0.4 seconds. */
export function captionOpacity(index: number, t: number): number {
  const start = CAPTIONS[index]!.at
  const end = CAPTIONS[index + 1]?.at ?? LOOP
  return Math.min(span(t, start, start + 0.4), 1 - span(t, end - 0.4, end))
}
