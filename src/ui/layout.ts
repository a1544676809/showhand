import { useEffect, useState } from 'react'

/**
 * Board geometry.
 *
 * The table is sized in JS rather than CSS so it can respect *both* axes of its
 * container: an oval that fits the available width and height, with cards scaled
 * proportionally. That keeps five-card rows readable from a phone in portrait up
 * to a wide desktop without the page ever scrolling.
 */
export const TABLE_RATIO = 1.62

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/**
 * Phones are width-constrained, so a wide oval would leave most of the screen
 * empty — and with five seats the *vertical* gap between rows is what limits
 * the card size. A near-square table on a narrow stage spends the spare height
 * on that gap.
 */
export function tableRatioFor(stageWidth: number): number {
  if (stageWidth < 520) return 1.05
  if (stageWidth < 820) return 1.38
  return TABLE_RATIO
}

export interface TableSize {
  width: number
  height: number
}

export function computeTableSize(stageWidth: number, stageHeight: number): TableSize {
  if (stageWidth <= 0 || stageHeight <= 0) return { width: 0, height: 0 }
  const ratio = tableRatioFor(stageWidth)
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
/** Largest card, so the board never looks like a pile of posters. */
export const MAX_CARD = 96

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
 * Bounding boxes of every seat's hand, in table-box pixels. Hands sit *below*
 * the nameplate for seats in the upper half and *above* it for seats in the
 * lower half, so the block edges depend on which side of the table we are on.
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
  // Nameplate + gap + room for the status badge under it.
  const plateReach = 54

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
    const cardHeight = width * 1.4
    const half = isHero ? (FAN_LENGTH * width + 12) / 2 : (FAN_SPAN / 2) * width

    const above = yPercent > 55
    return {
      left: x - half,
      right: x + half,
      top: above ? y - plateReach - cardHeight : y + plateReach,
      bottom: above ? y - plateReach : y + plateReach + cardHeight,
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
    return { rx: 0, ry: 0, heroCardWidth: 0, otherCardWidth: 0 }
  }

  // `ry` is generous on purpose: the vertical gap between one seat's hand and
  // the next is what keeps a five-card fan from touching its neighbour, and a
  // rounder (phone) table has proportionally less height to spend.
  const ry = 44
  const rx = tableWidth >= 440 ? 34 : 31

  // Distance from the table's centre line to the outermost seat, in pixels.
  const seatOffset = (rx * maxSeatReach(playerCount) * tableWidth) / 100
  const room = Math.max(48, tableWidth / 2 - seatOffset)
  let otherCardWidth = clamp(Math.round((room * FAN_FILL) / (FAN_SPAN / 2)), MIN_CARD, 96)

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

  // The anchor seat's row is not fanned, so it is five full card widths wide
  // plus gaps. It may never end up smaller than everyone else's cards.
  const heroRoom = (tableWidth * 0.88 - 12) / FAN_LENGTH
  const heroTarget = Math.min(
    Math.round(otherCardWidth * 1.12),
    Math.round(heroRoom),
    108,
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

  return { rx, ry, heroCardWidth, otherCardWidth }
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
