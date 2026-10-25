// The "how it works" machine, as a pure function of time. The stage is 1000 × 440.
// Two rounds alternate: in the first the new bundle stays, in the second it never reports healthy and goes back.

export const STAGE = { height: 440, width: 1000 }

export const CI = { h: 140, w: 180, x: 40, y: 150 }
export const BUCKET = { h: 260, w: 220, x: 390, y: 90 }
export const APP = { size: 180, x: 780, y: 130 }

const CI_DISC = { x: CI.x + CI.w / 2, y: CI.y + CI.h / 2 }
export const SOCKET = { x: APP.x + APP.size / 2, y: APP.y + APP.size / 2 }
export const SPARE = { x: APP.x + 34, y: APP.y + APP.size - 32 }
export const STAGED = { x: APP.x + APP.size - 34, y: APP.y + 34 }
export const LAMP = { x: BUCKET.x + 40, y: BUCKET.y + 212 }

/** The object grid in the top tray: 5 × 2 squares. The last four are the files of the new release. */
export const CELL = 20
export const OBJECTS = Array.from({ length: 10 }, (_, i) => ({ x: BUCKET.x + 25 + (i % 5) * 30, y: BUCKET.y + 34 + Math.floor(i / 5) * 30 }))
const NEW_OBJECTS = [6, 7, 8, 9]
/** Which new objects the app lacks. It already has the others in its local store. */
const MISSING = [6, 7]

/** Manifests in the middle tray: one bar per release, the last one new. */
export const MANIFESTS = Array.from({ length: 3 }, (_, i) => ({ x: BUCKET.x + 25 + i * 44, y: BUCKET.y + 142 }))

/** Files the app already has, in a corner. */
export const LOCAL = Array.from({ length: 3 }, (_, i) => ({ x: APP.x + APP.size - 60 + i * 16, y: APP.y + APP.size - 28 }))

export const ROUND = 13

export const STEPS = [
  { at: 0, name: 'build' },
  { at: 2, name: 'upload' },
  { at: 4.5, name: 'check' },
  { at: 6, name: 'download' },
  { at: 8.5, name: 'apply' },
  { at: 9.6, name: 'health' },
]

const OUTCOME_AT = 11.2

const ease = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))
const span = (t: number, from: number, to: number): number => ease((t - from) / (to - from))
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u

export interface Frame {
  /** Glow of the CI box while it builds. */
  ciGlow: number
  discs: DiscState[]
  /** Progress of the health timer around the socket, and whether it is running out. */
  health: { failing: boolean, progress: number }
  /** The lamp of the channel is lit once the new release is live. */
  lamp: boolean
  /** Files in the app's local store flash when they are reused. */
  localFlash: number
  /** The new manifest is uploaded. */
  manifest: boolean
  /** Moving squares: new objects on their way up, and missing objects on their way down. */
  movers: { opacity: number, x: number, y: number }[]
  /** The app is checking the channel: a dot between the app and the lamp. */
  ping: { opacity: number, x: number, y: number }
  /** Rings that draw around a disc: the signature in CI, the check in the app. */
  rings: { progress: number, r: number, x: number, y: number }[]
  step: number
  /** New objects that sit in the bucket. */
  stored: boolean[]
}

export interface Round {
  good: boolean
  next: string
  previous: string
  running: string
}

interface DiscState {
  label: string
  opacity: number
  r: number
  tone: Tone
  x: number
  y: number
}

type Tone = 'bad' | 'new' | 'old' | 'run'

export const ROUNDS: Round[] = [
  { good: true, next: '1.0.4', previous: '1.0.2', running: '1.0.3' },
  { good: false, next: '1.0.5', previous: '1.0.3', running: '1.0.4' },
]

/** Fades the discs in at the start of a round and out at its end, so the rounds join cleanly. */
const roundFade = (t: number): number => Math.min(span(t, 0, 0.4), 1 - span(t, ROUND - 0.5, ROUND))

export function captionAt(t: number, round: Round): string {
  if (t >= OUTCOME_AT) {
    return round.good
      ? `The app reports healthy in time. ${round.next} stays.`
      : `${round.next} never reports healthy. The app drops it and goes back to ${round.running}.`
  }
  return [
    'CI builds the bundle and signs it.',
    'It uploads the files, then the manifest, then switches the channel.',
    'Your app checks the channel.',
    'It fetches only the files it lacks, and checks every hash and signature.',
    `${round.next} takes the socket. ${round.running} waits as the fallback.`,
    'The app has a few seconds to report that it works.',
  ][STEPS.findLastIndex(s => s.at <= t)]!
}

export function frameAt(t: number, round: Round): Frame {
  const step = STEPS.findLastIndex(s => s.at <= t)

  // The running bundle: in the socket, then aside as the fallback, and back if the new one fails.
  const toSpare = span(t, 8.5, 9.3)
  let running: DiscState = {
    label: round.running,
    opacity: roundFade(t),
    r: lerp(40, 14, toSpare),
    tone: toSpare > 0.5 ? 'old' : 'run',
    x: lerp(SOCKET.x, SPARE.x, toSpare),
    y: lerp(SOCKET.y, SPARE.y, toSpare),
  }
  if (!round.good && t > OUTCOME_AT + 0.4) {
    const back = span(t, OUTCOME_AT + 0.4, OUTCOME_AT + 1.2)
    running = { ...running, r: lerp(14, 40, back), tone: back > 0.4 ? 'run' : 'old', x: lerp(SPARE.x, SOCKET.x, back), y: lerp(SPARE.y, SOCKET.y, back) }
  }

  // The bundle before it waits in the spare corner until the running one takes its place.
  const previous: DiscState = { label: round.previous, opacity: roundFade(t) * (1 - span(t, 8.5, 9.0)), r: 14, tone: 'old', x: SPARE.x, y: SPARE.y }

  // The new bundle: built in CI, split into objects, put together again in the app, then into the socket.
  let next: DiscState
  if (t < 2.2) {
    next = { label: round.next, opacity: span(t, 0.3, 0.6) * (1 - span(t, 1.9, 2.2)), r: lerp(4, 30, span(t, 0.3, 0.9)), tone: 'new', x: CI_DISC.x, y: CI_DISC.y }
  }
  else if (t < 7.1) {
    next = { label: round.next, opacity: 0, r: 16, tone: 'new', x: STAGED.x, y: STAGED.y }
  }
  else if (t < 8.5) {
    next = { label: round.next, opacity: span(t, 7.1, 7.4), r: lerp(4, 16, span(t, 7.1, 7.5)), tone: 'new', x: STAGED.x, y: STAGED.y }
  }
  else {
    const into = span(t, 8.6, 9.4)
    next = { label: round.next, opacity: roundFade(t), r: lerp(16, 40, into), tone: 'new', x: lerp(STAGED.x, SOCKET.x, into), y: lerp(STAGED.y, SOCKET.y, into) }
    if (round.good && t > OUTCOME_AT)
      next.tone = 'run'
    if (!round.good && t > OUTCOME_AT) {
      const drop = span(t, OUTCOME_AT + 0.2, OUTCOME_AT + 1.2)
      next = { ...next, opacity: 1 - span(t, OUTCOME_AT + 0.7, OUTCOME_AT + 1.2), tone: 'bad', y: lerp(SOCKET.y, STAGE.height + 30, drop) }
    }
  }

  // Squares in flight: the new objects go up to the bucket, and the missing ones come down to the app.
  const movers: Frame['movers'] = []
  NEW_OBJECTS.forEach((cell, i) => {
    const from = 2.0 + i * 0.25
    const u = span(t, from, from + 0.9)
    if (u > 0 && u < 1)
      movers.push({ opacity: 1, x: lerp(CI_DISC.x, OBJECTS[cell]!.x + CELL / 2, u), y: lerp(CI_DISC.y, OBJECTS[cell]!.y + CELL / 2, u) })
  })
  MISSING.forEach((cell, i) => {
    const from = 6.0 + i * 0.25
    const u = span(t, from, from + 0.9)
    if (u > 0 && u < 1)
      movers.push({ opacity: 1, x: lerp(OBJECTS[cell]!.x + CELL / 2, STAGED.x, u), y: lerp(OBJECTS[cell]!.y + CELL / 2, STAGED.y, u) })
  })

  const stored = OBJECTS.map((_, cell) => {
    const i = NEW_OBJECTS.indexOf(cell)
    return i < 0 || t >= 2.9 + i * 0.25
  })

  // The app asks the channel, and the answer comes back.
  const out = span(t, 4.6, 5.25)
  const home = span(t, 5.3, 5.95)
  const pingVisible = t > 4.6 && t < 5.95
  const ping = {
    opacity: pingVisible ? 1 : 0,
    x: t < 5.3 ? lerp(APP.x, LAMP.x, out) : lerp(LAMP.x, APP.x, home),
    y: t < 5.3 ? lerp(SOCKET.y, LAMP.y, out) : lerp(LAMP.y, SOCKET.y, home),
  }

  const rings = [
    { progress: span(t, 0.9, 1.6) * (1 - span(t, 1.9, 2.2)), r: 38, x: CI_DISC.x, y: CI_DISC.y },
    { progress: span(t, 7.5, 8.2) * (1 - span(t, 8.5, 8.7)), r: 23, x: STAGED.x, y: STAGED.y },
  ]

  const healthProgress = t < 9.6 ? 0 : round.good ? span(t, 9.6, OUTCOME_AT) : span(t, 9.6, OUTCOME_AT + 0.2)
  const healthFade = round.good ? 1 - span(t, OUTCOME_AT + 0.6, OUTCOME_AT + 1.2) : 1 - span(t, OUTCOME_AT + 0.2, OUTCOME_AT + 0.6)

  return {
    ciGlow: Math.sin(Math.PI * Math.min(1, Math.max(0, t / 2))),
    discs: [previous, running, next],
    health: { failing: !round.good && t > 10.4, progress: healthProgress * healthFade },
    lamp: t >= 4.1,
    localFlash: span(t, 6.1, 6.4) * (1 - span(t, 6.8, 7.2)),
    manifest: t >= 3.7,
    movers,
    ping,
    rings,
    step,
    stored,
  }
}
