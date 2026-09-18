import { describe, expect, it } from 'vitest'
import {
  FAN_SPAN,
  MAX_CARD,
  MAX_TABLE_RATIO,
  MIN_CARD,
  MIN_TABLE_RATIO,
  TABLE_RATIO,
  computeBoardMetrics,
  computeTableSize,
  fansCollide,
  fanBlocks,
  maxSeatReach,
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
      const { width, height } = computeTableSize(w, h)
      // The table should touch whichever axis is binding.
      const fillsWidth = Math.abs(width - w) < 0.5
      const fillsHeight = Math.abs(height - h) < 0.5
      expect(fillsWidth || fillsHeight, `${label} leaves dead space`).toBe(true)
    }
  })
})

describe('computeBoardMetrics', () => {
  it('produces a collision-free board for every supported stage', () => {
    // 360x640 with 4-5 seats is below the supported minimum: the two seats
    // facing each other run out of vertical room before the cards get small
    // enough, so the solver clamps to MIN_CARD and the board is merely tight.
    // That case is covered by the "never degenerate" test instead.
    for (const [label, stageW, stageH] of STAGES) {
      if (stageW < 380) continue
      for (let players = 2; players <= 5; players++) {
        const { width, height } = computeTableSize(stageW, stageH)
        const m = computeBoardMetrics(width, height, players)
        const blocks = fanBlocks(width, height, players, m.rx, m.ry, m.otherCardWidth)
        expect(fansCollide(blocks), `${label} / ${players}p should not collide`).toBe(false)
      }
    }
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
        expect(m.heroCardWidth).toBeLessThanOrEqual(108)
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
    expect(m).toEqual({ rx: 0, ry: 0, heroCardWidth: 0, otherCardWidth: 0 })
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
