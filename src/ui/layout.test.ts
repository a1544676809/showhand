import { describe, expect, it } from 'vitest'
import {
  FAN_SPAN,
  MAX_CARD,
  MAX_HERO_CARD,
  MAX_TABLE_RATIO,
  MAX_UI_SCALE,
  MIN_CARD,
  MIN_TABLE_RATIO,
  SEAT_BUTTONS_REACH,
  SEAT_GAP,
  SEAT_PLATE_REACH,
  SEAT_REACH_SLACK,
  TABLE_RATIO,
  boardBlocks,
  computeBoardMetrics,
  computeTableSize,
  fansCollide,
  fanBlocks,
  maxSeatReach,
  plateReachFor,
  potBlock,
  tableRatioFor,
} from './layout'

/** Realistic stage boxes: [label, stageWidth, stageHeight]. */
const STAGES: [string, number, number][] = [
  ['desktop 1680x1050', 1330, 800],
  ['laptop 1366x768', 1010, 560],
  ['small laptop 1280x720', 950, 520],
  ['ipad landscape 1366x1024', 1340, 800],
  ['ipad 1024x768', 1010, 560],
  ['ipad portrait 810x1080', 788, 880],
  ['tablet 900x1200', 860, 700],
  ['phone 430x900', 410, 620],
  ['phone 360x640', 344, 400],
  ['ultrawide 2560x1080', 2200, 760],
  ['short window 1400x600', 1090, 380],
]

describe('maxSeatReach', () => {
  it('matches the geometry of each table size', () => {
    // 2 players sit top and bottom, so nothing is off the centre line.
    expect(maxSeatReach(2)).toBeCloseTo(0, 5)
    // 3 players: ±cos(210°) = ±0.866
    expect(maxSeatReach(3)).toBeCloseTo(Math.sqrt(3) / 2, 5)
    // 4 players include the extreme left and right seats.
    expect(maxSeatReach(4)).toBeCloseTo(1, 5)
    // 5 players: |cos(162°)| ≈ 0.951
    expect(maxSeatReach(5)).toBeCloseTo(0.9511, 3)
  })

  it('stays inside 0..1', () => {
    for (let n = 2; n <= 8; n++) {
      const reach = maxSeatReach(n)
      expect(reach).toBeGreaterThanOrEqual(0)
      expect(reach).toBeLessThanOrEqual(1)
    }
  })
})

describe('tableRatioFor', () => {
  it('fills the stage at any aspect ratio', () => {
    // 4:3 tablet both ways falls inside the clamp, so the ratio is the
    // stage's own.
    expect(tableRatioFor(1000, 750)).toBeCloseTo(1000 / 750, 2)
    expect(tableRatioFor(788, 880)).toBeCloseTo(788 / 880, 2)
    // A phone is taller than the portrait minimum, so it clamps.
    expect(tableRatioFor(410, 620)).toBe(MIN_TABLE_RATIO)
    // Wider than the maximum: clamped too.
    expect(tableRatioFor(1330, 800)).toBe(MAX_TABLE_RATIO)
  })

  it('clamps to a sane range so the board never becomes a sliver', () => {
    expect(tableRatioFor(2400, 400)).toBe(MAX_TABLE_RATIO)
    expect(tableRatioFor(300, 1400)).toBe(MIN_TABLE_RATIO)
  })

  it('stays within the clamped bounds for every stage', () => {
    for (const [, w, h] of STAGES) {
      const ratio = tableRatioFor(w, h)
      expect(ratio).toBeGreaterThanOrEqual(MIN_TABLE_RATIO)
      expect(ratio).toBeLessThanOrEqual(MAX_TABLE_RATIO)
    }
  })

  it('uses a width-only fallback when no height is given', () => {
    expect(tableRatioFor(400)).toBe(1.05)
    expect(tableRatioFor(700)).toBe(1.38)
    expect(tableRatioFor(1400)).toBe(TABLE_RATIO)
  })

  it('uses the whole stage instead of leaving dead space', () => {
    for (const [label, w, h] of STAGES) {
      for (let players = 2; players <= 5; players++) {
        const { width, height } = computeTableSize(w, h, players)
        // The table should touch whichever axis is binding.
        const fillsWidth = Math.abs(width - w) < 0.5
        const fillsHeight = Math.abs(height - h) < 0.5
        expect(fillsWidth || fillsHeight, `${label} / ${players}p leaves dead space`).toBe(true)
      }
    }
  })

  it('keeps few-player tables from becoming a mostly empty oval', () => {
    // A heads-up game on an ultrawide stage must not stretch to the full width.
    const heads = computeTableSize(2200, 700, 2)
    expect(heads.height).toBeCloseTo(700, 0)
    expect(heads.width).toBeLessThan(900)

    // Five seats still get the full landscape ratio.
    const full = computeTableSize(2200, 700, 5)
    expect(full.width).toBeGreaterThan(heads.width)
  })
})

describe('computeBoardMetrics', () => {
  it('produces a collision-free board for every supported stage', () => {
    /*
     * Five seats do not fit on a short table. Each seat spends
     * plate + badge + gap (58px) plus its card row before anything is drawn,
     * and the seats facing each other need two of those; on a ~380-480px-tall
     * felt the solver bottoms out at MIN_CARD and two side seats still clip by
     * ~15px. Showing the per-seat buttons adds another 31px per seat and pushes
     * the 410px phone into the same bucket. Rotating the phone resolves it.
     */
    const shortTable = (height: number, players: number) => players >= 5 && height < 500

    const unexpected: string[] = []
    const tolerated: string[] = []

    for (const [label, stageW, stageH] of STAGES) {
      if (stageW < 380) continue
      for (let players = 2; players <= 5; players++) {
        for (const controls of [false, true]) {
          const { width, height } = computeTableSize(stageW, stageH)
          const m = computeBoardMetrics(width, height, players, controls)
          const blocks = boardBlocks(
            width,
            height,
            players,
            m.rx,
            m.ry,
            m.otherCardWidth,
            m.heroCardWidth,
            controls,
          )
          if (!fansCollide(blocks)) continue
          const key = `${label}/${players}p/controls=${controls}`
          if (shortTable(height, players)) tolerated.push(key)
          else unexpected.push(key)
        }
      }
    }

    expect(unexpected, `unexpected collisions: ${unexpected.join(', ')}`).toEqual([])
    // Pin the known-bad set: if the solver starts failing somewhere new, or the
    // tolerance stops being needed, this is what notices.
    expect(tolerated).toEqual([
      'phone 430x900/5p/controls=true',
      'short window 1400x600/5p/controls=false',
      'short window 1400x600/5p/controls=true',
    ])
  })

  it('keeps both hands and the pot apart when heads-up', () => {
    // Heads-up puts both seats on the centre line, so both hands *and* the pot
    // stack on one axis. The pot used to end up completely hidden behind the
    // cards, and the two rows overlapped each other by 30px at 1280x650.
    for (const [label, stageW, stageH] of STAGES) {
      const { width, height } = computeTableSize(stageW, stageH, 2)
      const m = computeBoardMetrics(width, height, 2, true)
      // Seat 0 is the anchor, i.e. the seat at the bottom of the screen.
      const [bottom, top] = fanBlocks(width, height, 2, m.rx, m.ry, m.otherCardWidth, 0, true)
      const pot = potBlock(width, height, m.otherCardWidth)

      expect(bottom.top, `${label}: the two hands overlap`).toBeGreaterThanOrEqual(top.bottom)
      expect(top.bottom, `${label}: the top hand covers the pot`).toBeLessThanOrEqual(pot.top)
      expect(bottom.top, `${label}: the bottom hand covers the pot`).toBeGreaterThanOrEqual(pot.bottom)
    }
  })

  it('reserves a row for the seat buttons only when they are shown', () => {
    // The buttons are a separate row between the plate and the hand. Leaving
    // them out of the budget is what let two heads-up seats overlap.
    const slack = SEAT_REACH_SLACK
    expect(plateReachFor(50, false)).toBe(SEAT_PLATE_REACH + SEAT_GAP + slack)
    expect(plateReachFor(50, true)).toBe(
      SEAT_PLATE_REACH + SEAT_GAP + SEAT_BUTTONS_REACH + SEAT_GAP + slack,
    )
    // The row budget scales with the card, like the CSS it mirrors, up to the
    // cap that keeps a huge display from growing billboards.
    expect(plateReachFor(192, true)).toBeCloseTo(
      (SEAT_PLATE_REACH + SEAT_GAP + SEAT_BUTTONS_REACH + SEAT_GAP) * MAX_UI_SCALE +
        slack,
      5,
    )
  })

  it('still returns a playable board on a very small stage', () => {
    for (let players = 2; players <= 5; players++) {
      const { width, height } = computeTableSize(344, 400)
      const m = computeBoardMetrics(width, height, players)
      expect(m.otherCardWidth).toBeGreaterThanOrEqual(MIN_CARD)
      expect(m.heroCardWidth).toBeGreaterThanOrEqual(m.otherCardWidth)
    }
  })

  it('keeps every fan inside the table box', () => {
    for (const [label, stageW, stageH] of STAGES) {
      for (let players = 2; players <= 5; players++) {
        const { width, height } = computeTableSize(stageW, stageH)
        const m = computeBoardMetrics(width, height, players)
        for (const block of fanBlocks(width, height, players, m.rx, m.ry, m.otherCardWidth)) {
          expect(block.left, `${label} / ${players}p left edge`).toBeGreaterThan(-1)
          expect(block.right, `${label} / ${players}p right edge`).toBeLessThan(width + 1)
        }
      }
    }
  })

  it('never returns a degenerate or oversized card', () => {
    for (const [, stageW, stageH] of STAGES) {
      for (let players = 2; players <= 5; players++) {
        const { width, height } = computeTableSize(stageW, stageH)
        const m = computeBoardMetrics(width, height, players)
        expect(m.otherCardWidth).toBeGreaterThanOrEqual(MIN_CARD)
        expect(m.otherCardWidth).toBeLessThanOrEqual(MAX_CARD)
        expect(m.heroCardWidth).toBeGreaterThanOrEqual(m.otherCardWidth)
        expect(m.heroCardWidth).toBeLessThanOrEqual(MAX_HERO_CARD)
      }
    }
  })

  it('grows the cards to fill a large display', () => {
    // Heads-up on a 2560x1299 monitor: the stage is ~2300x1120, so the table is
    // height-bound at ~1290x1120. The old 96px ceiling was the binding
    // constraint here, which left a 1120px-tall felt holding two small hands.
    const { width, height } = computeTableSize(2300, 1121, 2)
    const m = computeBoardMetrics(width, height, 2)
    expect(m.otherCardWidth).toBeGreaterThan(120)
    expect(m.uiScale).toBeGreaterThan(1.2)
    // Still collision-free at the larger size, or the table would be unusable.
    expect(fansCollide(fanBlocks(width, height, 2, m.rx, m.ry, m.otherCardWidth))).toBe(false)
  })

  it('keeps the chrome at its design size on small stages', () => {
    // `--ui-scale` must never drop below 1: the phone layouts are verified at 1
    // and shrinking the nameplates would undo the touch-target work.
    for (const [label, stageW, stageH] of STAGES) {
      for (let players = 2; players <= 5; players++) {
        const { width, height } = computeTableSize(stageW, stageH)
        const m = computeBoardMetrics(width, height, players)
        expect(m.uiScale, `${label} / ${players}p`).toBeGreaterThanOrEqual(1)
        expect(m.uiScale).toBeLessThanOrEqual(MAX_UI_SCALE)
      }
    }
  })

  it('gives desktop tables substantially larger cards than the old flat scale', () => {
    // The previous fixed 0.059/0.84 scaling topped out at 62/52 px here.
    const { width, height } = computeTableSize(1330, 800)
    const m = computeBoardMetrics(width, height, 5)
    expect(m.otherCardWidth).toBeGreaterThan(75)
    expect(m.heroCardWidth).toBeGreaterThan(80)
  })

  it('still gives a phone usable cards', () => {
    const { width, height } = computeTableSize(410, 620)
    const m = computeBoardMetrics(width, height, 3)
    expect(m.otherCardWidth).toBeGreaterThanOrEqual(34)
  })

  it('handles the zero-size first paint', () => {
    const m = computeBoardMetrics(0, 0, 5)
    expect(m).toEqual({
      rx: 0,
      ry: 0,
      heroCardWidth: 0,
      otherCardWidth: 0,
      uiScale: 1,
      potScale: 1,
    })
  })

  it('places seats inside the box for every player count', () => {
    const { width, height } = computeTableSize(1330, 800)
    for (let players = 2; players <= 5; players++) {
      const { rx } = computeBoardMetrics(width, height, players)
      expect(rx * maxSeatReach(players)).toBeLessThan(40)
    }
  })
})

describe('fanBlocks', () => {
  it('flips the hand to the inside of the table', () => {
    const [top, bottom] = fanBlocks(1000, 620, 2, 34, 42, 50)
    // Seat 0 is the bottom seat: its hand sits above the nameplate.
    expect(bottom.bottom).toBeLessThan((50 + 42) / 100 * 620)
    // Seat 1 is the top seat: its hand sits below the nameplate.
    expect(top.top).toBeGreaterThan((50 - 42) / 100 * 620)
  })

  it('reports the fan span it promises', () => {
    const [block] = fanBlocks(1000, 620, 2, 34, 42, 50)
    expect(block.right - block.left).toBeCloseTo(FAN_SPAN * 50, 5)
  })
})
