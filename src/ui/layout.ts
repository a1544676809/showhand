import { useEffect, useState } from 'react'

/**
 * Board geometry.
 *
 * The table is sized in JS rather than CSS so it can respect *both* axes of its
 * container: an oval that fills the available box, with cards scaled
 * proportionally. That keeps five-card rows readable from a phone in portrait up
 * to a wide desktop without the page ever scrolling.
 */
export const TABLE_RATIO = 1.62

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/** Widest and tallest the board may be relative to its box. */
export const MIN_TABLE_RATIO = 0.85
export const MAX_TABLE_RATIO = 1.62

/**
 * Pick the table's aspect ratio to *fill* the stage, clamped to a sane range.
 *
 * A fixed ratio per breakpoint left a 4:3 portrait iPad (810x1080) with ~300px
 * of dead space, because its stage is taller than 1/1.38. Solving for the ratio
 * that exactly fills the box uses the space at every aspect — 16:9, 4:3, or a
 * phone's 9:19.5 — instead of only the landscape ones.
 */
export function tableRatioFor(stageWidth: number, stageHeight?: number): number {
  if (!stageHeight || stageHeight <= 0) {
    // Legacy single-argument call: fall back to a width-only heuristic.
    if (stageWidth < 520) return 1.05
    if (stageWidth < 820) return 1.38
    return TABLE_RATIO
  }
  return clamp(stageWidth / stageHeight, MIN_TABLE_RATIO, MAX_TABLE_RATIO)
}

export interface TableSize {
  width: number
  height: number
}

/**
 * Fewer seats need less width. Two players sit above and below each other, so a
 * 16:10 oval leaves two thirds of the felt empty and makes the cards look small
 * against it; a squarer table suits heads-up better.
 */
export function maxRatioForPlayers(playerCount: number): number {
  if (playerCount <= 2) return 1.15
  if (playerCount === 3) return 1.4
  return MAX_TABLE_RATIO
}

export function computeTableSize(
  stageWidth: number,
  stageHeight: number,
  playerCount = 5,
): TableSize {
  if (stageWidth <= 0 || stageHeight <= 0) return { width: 0, height: 0 }
  const ratio = Math.min(tableRatioFor(stageWidth, stageHeight), maxRatioForPlayers(playerCount))
  const width = Math.min(stageWidth, stageHeight * ratio)
  return { width, height: width / ratio }
}

/** How far each additional card advances in a fan, as a fraction of card width. */
export const FAN_STEP = 0.78
/** Cards per full 梭哈 hand — the longest row a seat ever has to show. */
export const FAN_LENGTH = 5
/** Width of a full fan, in card widths. */
export const FAN_SPAN = (FAN_LENGTH - 1) * FAN_STEP + 1
/** Fraction of the available half-width a fan is allowed to consume. */
const FAN_FILL = 0.94
/** Smallest card the solver will shrink to before giving up. */
export const MIN_CARD = 22
/**
 * Largest card, so the board never looks like a pile of posters.
 *
 * This used to be 96, which turned out to be the *binding* constraint on a
 * large display: heads-up on a 2560px monitor has ~640px of clear room either
 * side of the centre line yet still drew 96px cards inside a 1120px-tall felt,
 * so the table read as a huge empty oval. The collision solver below still
 * shrinks cards on cramped stages, so raising the ceiling only affects screens
 * that genuinely have the room.
 */
export const MAX_CARD = 176
/** The anchor seat shows five cards in a row, so it may run slightly larger. */
export const MAX_HERO_CARD = 190

/**
 * Card width the chrome was drawn against: nameplates, the pot and the badges
 * all read correctly at this size. `--ui-scale` is 1 here and grows above it.
 */
export const CHROME_CARD = 96
export const MAX_UI_SCALE = 1.7

/**
 * How much to enlarge the table furniture for a given card width.
 *
 * Never drops below 1: shrinking the nameplates on a phone would undo the
 * touch-target work, and every small-screen layout is already verified at 1.
 */
export function uiScaleFor(cardWidth: number): number {
  return clamp(cardWidth / CHROME_CARD, 1, MAX_UI_SCALE)
}

/** Largest |cos θ| over the seats — how far the outermost seat sits from centre. */
export function maxSeatReach(playerCount: number): number {
  const n = Math.max(2, playerCount)
  let reach = 0
  for (let i = 0; i < n; i++) {
    reach = Math.max(reach, Math.abs(Math.cos(Math.PI / 2 + (i * 2 * Math.PI) / n)))
  }
  return reach
}

export interface FanBlock {
  left: number
  right: number
  top: number
  bottom: number
  name: string
}

/**
 * Bounding boxes of every seat's hand, in table-box pixels.
 *
 * Seats are anchored by their inner edge (see `.seat` in styles.css): a seat in
 * the upper half starts *at* its ellipse point and grows downward, one in the
 * lower half ends there and grows upward. So each block runs from the anchor to
 * `plateReach + cardHeight` inward — never the other side of it.
 */
export function fanBlocks(
  tableWidth: number,
  tableHeight: number,
  playerCount: number,
  rx: number,
  ry: number,
  cardWidth: number,
  heroCardWidth = 0,
): FanBlock[] {
  // Nameplate + gap + status badge. The seat buttons sit further in and are
  // only present in director mode, so they are not counted. The plate grows
  // with `--ui-scale`, so this budget has to follow the card width.
  const plateReach = 52

  return Array.from({ length: playerCount }, (_, i) => {
    const angle = Math.PI / 2 + (i * 2 * Math.PI) / playerCount
    const xPercent = 50 + rx * Math.cos(angle)
    const yPercent = 50 + ry * Math.sin(angle)
    const x = (xPercent / 100) * tableWidth
    const y = (yPercent / 100) * tableHeight

    // Seat 0 is the anchor, i.e. whoever the camera is behind. That seat's row
    // is not fanned, so it is five full card widths plus the gaps between them.
    const isHero = heroCardWidth > 0 && i === 0
    const width = isHero ? heroCardWidth : cardWidth
    const reach = plateReach * uiScaleFor(width) + width * 1.4
    const half = isHero ? (FAN_LENGTH * width + 12) / 2 : (FAN_SPAN / 2) * width

    const growsDown = yPercent <= 55
    return {
      left: x - half,
      right: x + half,
      top: growsDown ? y : y - reach,
      bottom: growsDown ? y + reach : y,
      name: `seat${i}`,
    }
  })
}

export function fansCollide(blocks: readonly FanBlock[]): boolean {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]
      const b = blocks[j]
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        return true
      }
    }
  }
  return false
}

export interface BoardMetrics {
  /** Seat ellipse radii, as a percentage of the table box. */
  rx: number
  ry: number
  heroCardWidth: number
  otherCardWidth: number
  /** Multiplier for the table furniture, derived from the card size. */
  uiScale: number
}

/**
 * Solves the board geometry.
 *
 * The binding constraint is horizontal: the outermost seat sits `rx·reach`
 * percent from the centre line, and a five-card fan is `FAN_SPAN` card widths
 * wide and centred on that seat. So the largest card that still fits comes from
 * the *room left over*, not from a flat fraction of the table — which is what
 * lets the cards be roughly twice as large as a naive scale factor would allow
 * while keeping every fan on the table.
 *
 * `ry` is deliberately larger than `rx` so the upper and lower rows separate
 * vertically; the collision loop then trims the size on short, wide viewports
 * where that separation alone is not enough.
 */
export function computeBoardMetrics(
  tableWidth: number,
  tableHeight: number,
  playerCount: number,
): BoardMetrics {
  if (tableWidth <= 0 || tableHeight <= 0) {
    return { rx: 0, ry: 0, heroCardWidth: 0, otherCardWidth: 0, uiScale: 1 }
  }

  // `ry` is a compromise. It tracks the felt's own half-height well enough that
  // seats sit on the rail rather than adrift from it (~40% of the box), while
  // still leaving the vertical gap that keeps a five-card fan clear of the seat
  // opposite. Bigger values fit short, wide windows but push the top and bottom
  // seats off the felt; smaller ones strand them in the middle.
  const ry = 40
  const rx = tableWidth >= 440 ? 34 : 31

  // The anchor seat's row is not fanned, so it is five full card widths wide
  // plus gaps. Every player ends up with five cards, so this is the *widest*
  // row any seat ever has to draw: if it does not fit, nothing does. Solving it
  // first also bounds the fanned seats below — without that, a raised ceiling
  // made the hero's row hang off the edge of a narrow portrait table, because
  // `heroCardWidth` is never allowed to drop below `otherCardWidth`.
  const heroRoom = (tableWidth * 0.88 - 12) / FAN_LENGTH
  const widestRow = Math.max(MIN_CARD, Math.floor(heroRoom))

  // Distance from the table's centre line to the outermost seat, in pixels.
  const seatOffset = (rx * maxSeatReach(playerCount) * tableWidth) / 100
  const room = Math.max(48, tableWidth / 2 - seatOffset)
  let otherCardWidth = clamp(
    Math.round((room * FAN_FILL) / (FAN_SPAN / 2)),
    MIN_CARD,
    Math.min(MAX_CARD, widestRow),
  )

  // Two seats facing each other need `2 x plateReach` of clear height plus both
  // hands. On a tiny stage (a 360px phone with four or five seats) that budget
  // runs out before the cards get small enough — the loop bottoms out at
  // MIN_CARD and the layout is simply tight. Every realistic size resolves.
  while (
    otherCardWidth > MIN_CARD &&
    fansCollide(fanBlocks(tableWidth, tableHeight, playerCount, rx, ry, otherCardWidth))
  ) {
    otherCardWidth -= 2
  }

  const heroTarget = Math.min(
    Math.round(otherCardWidth * 1.12),
    widestRow,
    MAX_HERO_CARD,
  )
  let heroCardWidth = Math.max(otherCardWidth, heroTarget)
  while (
    heroCardWidth > otherCardWidth &&
    fansCollide(
      fanBlocks(tableWidth, tableHeight, playerCount, rx, ry, otherCardWidth, heroCardWidth),
    )
  ) {
    heroCardWidth -= 2
  }
  heroCardWidth = Math.max(heroCardWidth, otherCardWidth)

  return {
    rx,
    ry,
    heroCardWidth,
    otherCardWidth,
    uiScale: uiScaleFor(otherCardWidth),
  }
}

/**
 * Observes an element's content box.
 *
 * Uses a *callback* ref rather than a `useRef` object: the table stage does not
 * exist until a game starts, so an effect keyed on a stable ref object would
 * never re-attach and the board would measure 0×0 forever.
 */
export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  { width: number; height: number },
] {
  const [element, setElement] = useState<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    if (!element) {
      setSize({ width: 0, height: 0 })
      return
    }

    const measure = () => {
      const rect = element.getBoundingClientRect()
      setSize((previous) =>
        Math.abs(previous.width - rect.width) < 0.5 && Math.abs(previous.height - rect.height) < 0.5
          ? previous
          : { width: rect.width, height: rect.height },
      )
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return [setElement, size]
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false)

  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}
