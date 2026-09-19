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
/**
 * Horizontal inset of the felt inside the board, matching `.table-rail`.
 *
 * The fans have to clear the *felt*, not the board box. Measuring the room to
 * the board edge left the outermost card of a five-handed fan sitting on the
 * brown rail, which is what this constant exists to prevent.
 */
export const RAIL_INSET_X = 2.5
/** `.table-rail`'s own padding, which the felt sits inside of. */
export const RAIL_PADDING = 9
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
 * Vertical budget a seat spends between its anchor and its first card, in
 * design pixels (i.e. at `--ui-scale` 1). These mirror styles.css exactly; if
 * the CSS changes, these must follow or the solver silently overlaps seats.
 *
 *   .seat-info     plate + gap + status badge           -> SEAT_PLATE_REACH
 *   .seat          gap between rows                     -> SEAT_GAP
 *   .seat-cards    min-height: calc(--card-h + 4px)     -> CARD_BOX_EXTRA
 *
 * The per-seat buttons used to be their own row here, costing 31px of budget
 * per seat. They now hang off the side of the plate (`.seat-plate-row`), so
 * they consume none of it — which is exactly what buys the cards their size
 * back on a short table.
 */
export const SEAT_PLATE_REACH = 53
export const SEAT_GAP = 5
export const CARD_BOX_EXTRA = 4
/**
 * Slop for the browser's own rounding.
 *
 * `Table.tsx` renders `cardHeight = round(cardWidth * 1.4)` while the model
 * uses the unrounded product, so a real seat can be a fraction of a pixel
 * taller than modelled. At 1400x850 that was enough to leave two side seats
 * clipping by 1px after the solver had declared the board clean.
 */
export const SEAT_REACH_SLACK = 2

/** Everything above the hand: the nameplate row and the gap below it. */
export function plateReachFor(cardWidth: number): number {
  return (SEAT_PLATE_REACH + SEAT_GAP) * uiScaleFor(cardWidth) + SEAT_REACH_SLACK
}

/**
 * Half-height and half-width of the pot's reserved block, in design pixels.
 *
 * The pot sits dead centre, and for heads-up both hands are centred on the same
 * axis, so without this the two rows met in the middle *on top of the pot* —
 * the pot ended up completely hidden behind the cards. Measured against the
 * rendered pot (65px tall at scale 1) with a few pixels of clearance.
 */
export const POT_HALF_HEIGHT = 38
/**
 * Deliberately tight. The pot's rendered box is ~51px wide at scale 1, and the
 * width only decides *whether* the vertical constraint applies to a seat. A
 * generous value made the reserve reach the side seats of a 410px phone, which
 * clip it by a few pixels and then had their cards halved for no visible gain.
 */
export const POT_HALF_WIDTH = 30

/**
 * Table height at which the pot is drawn at full size.
 *
 * The pot's amount used `clamp(20px, 2.6vw, 30px)`, which keys off the
 * *viewport*: on a short window it stayed 30px tall while the table shrank, so
 * its reserved lane was a huge slice of a 430px-tall felt and squeezed the
 * cards down to ~30px. Tying it to the table instead keeps the proportion.
 */
export const POT_REFERENCE_HEIGHT = 900
export const MIN_POT_SCALE = 0.62

export function potScaleFor(cardWidth: number, tableHeight: number): number {
  const heightFactor = clamp(tableHeight / POT_REFERENCE_HEIGHT, MIN_POT_SCALE, 1)
  return uiScaleFor(cardWidth) * heightFactor
}

/** The pot's exclusion box, so a fan can be kept off it like any other seat. */
export function potBlock(tableWidth: number, tableHeight: number, cardWidth: number): FanBlock {
  const scale = potScaleFor(cardWidth, tableHeight)
  const halfH = POT_HALF_HEIGHT * scale
  const halfW = POT_HALF_WIDTH * scale
  const cx = tableWidth / 2
  const cy = tableHeight / 2
  return {
    left: cx - halfW,
    right: cx + halfW,
    top: cy - halfH,
    bottom: cy + halfH,
    name: 'pot',
  }
}

/**
 * Every fan plus the pot, as one list.
 *
 * `fansCollide` is a plain pairwise AABB test, so folding the pot in as one
 * more block means a single call enforces both "seats must not overlap each
 * other" and "no hand may cover the pot".
 */
export function boardBlocks(
  tableWidth: number,
  tableHeight: number,
  playerCount: number,
  rx: number,
  ry: number,
  cardWidth: number,
  heroCardWidth = 0,
): FanBlock[] {
  return [
    ...fanBlocks(tableWidth, tableHeight, playerCount, rx, ry, cardWidth, heroCardWidth),
    potBlock(tableWidth, tableHeight, cardWidth),
  ]
}

/**
 * Bounding boxes of every seat's hand, in table-box pixels.
 *
 * Seats are anchored by their inner edge (see `.seat` in styles.css): a seat in
 * the upper half starts *at* its ellipse point and grows downward, one in the
 * lower half ends there and grows upward. So each block runs from the anchor to
 * `plateReach + cardHeight` inward — never the other side of it.
 *
 * Use `boardBlocks` rather than this when solving: it folds the pot in as one
 * more obstacle.
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
    const reach = plateReachFor(width) + width * 1.4 + CARD_BOX_EXTRA
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
  /**
   * Multiplier for the pot specifically. Matches `uiScale` on a tall table but
   * shrinks on a short one, where a full-size pot would eat the whole middle.
   */
  potScale: number
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
    return { rx: 0, ry: 0, heroCardWidth: 0, otherCardWidth: 0, uiScale: 1, potScale: 1 }
  }

  // `ry` is a compromise. It tracks the felt's own half-height well enough that
  // seats sit on the rail rather than adrift from it, while still leaving the
  // vertical gap that keeps a five-card fan clear of the seat opposite. It was
  // 40 while the rail was inset 9%; the rail now sits at 5% so the seats can
  // spread to 7%..93%, which is worth about 8% more card on a table where the
  // facing seats, not the width, are the binding constraint.
  const ry = 43
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
  // Room from that seat to the edge of the *felt*: the board inset plus the
  // rail's own padding, not just half the board.
  const room = Math.max(
    48,
    tableWidth * (0.5 - RAIL_INSET_X / 100) - RAIL_PADDING - seatOffset,
  )
  let otherCardWidth = clamp(
    Math.round((room * FAN_FILL) / (FAN_SPAN / 2)),
    MIN_CARD,
    Math.min(MAX_CARD, widestRow),
  )

  // Two seats facing each other need `2 x plateReach` of clear height plus both
  // hands, and the pot needs its own lane down the middle. On a tiny stage
  // (a 360px phone with four or five seats) that budget runs out before the
  // cards get small enough — the loop bottoms out at MIN_CARD and the layout is
  // simply tight. Every realistic size resolves.
  //
  // The anchor seat is modelled at its *widest* — a five-card row, not a fan —
  // because `heroCardWidth` is never allowed below `otherCardWidth`, so the row
  // is already that wide at the smallest value this loop can pick. Modelling it
  // as a fan under-counted it by ~20% and left the side seats clipping the
  // anchor's row at 1400x850.
  while (
    otherCardWidth > MIN_CARD &&
    fansCollide(
      boardBlocks(
        tableWidth,
        tableHeight,
        playerCount,
        rx,
        ry,
        otherCardWidth,
        otherCardWidth,
      ),
    )
  ) {
    // Clamped, not just decremented: an odd starting width would otherwise step
    // straight past MIN_CARD (23 -> 21) and never be corrected.
    otherCardWidth = Math.max(MIN_CARD, otherCardWidth - 2)
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
      boardBlocks(
        tableWidth,
        tableHeight,
        playerCount,
        rx,
        ry,
        otherCardWidth,
        heroCardWidth,
      ),
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
    potScale: potScaleFor(otherCardWidth, tableHeight),
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
