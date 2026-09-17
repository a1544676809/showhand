import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { buildPots, resolvePots } from './pots'
import type { Card } from './types'

describe('buildPots', () => {
  it('makes a single main pot when contributions are equal', () => {
    const pots = buildPots([100, 100, 100], [false, false, false])
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(300)
    expect(pots[0].label).toBe('主池')
    expect(pots[0].eligible).toEqual([0, 1, 2])
  })

  it('keeps folded chips in the pot but removes eligibility', () => {
    const pots = buildPots([100, 100, 40], [false, false, true])
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(240)
    expect(pots[0].eligible).toEqual([0, 1])
  })

  it('splits into a main pot and a side pot for an all-in short stack', () => {
    // Seat 0 is all-in for 50; seats 1 and 2 contest the extra 150 each.
    const pots = buildPots([50, 200, 200], [false, false, false])
    expect(pots).toHaveLength(2)
    expect(pots[0]).toMatchObject({ amount: 150, eligible: [0, 1, 2], label: '主池' })
    expect(pots[1]).toMatchObject({ amount: 300, eligible: [1, 2], label: '边池 1' })
    expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(450)
  })

  it('handles two all-in levels', () => {
    const pots = buildPots([50, 120, 300, 300], [false, false, false, false])
    expect(pots.map((p) => p.amount)).toEqual([200, 210, 360])
    expect(pots[0].eligible).toEqual([0, 1, 2, 3])
    expect(pots[1].eligible).toEqual([1, 2, 3])
    expect(pots[2].eligible).toEqual([2, 3])
    expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(770)
  })

  it('merges layers that share an eligibility set', () => {
    // Seat 2's odd extra chip must not create a phantom third pot.
    const pots = buildPots([100, 100, 100], [false, false, false])
    expect(pots).toHaveLength(1)

    const withOdd = buildPots([100, 100, 105], [false, false, false])
    expect(withOdd.reduce((s, p) => s + p.amount, 0)).toBe(305)
    expect(withOdd[withOdd.length - 1].eligible).toEqual([2])
  })

  it('ignores seats that never contributed', () => {
    const pots = buildPots([100, 100, 0], [false, false, true])
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(200)
    expect(pots[0].eligible).toEqual([0, 1])
  })

  it('handles an empty hand', () => {
    expect(buildPots([0, 0], [false, false])).toEqual([])
  })

  it('rolls an unwinnable layer down into the previous pot', () => {
    // Seat 2 folded after over-committing; nobody live can win that sliver.
    const pots = buildPots([100, 100, 150], [false, false, true])
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(350)
    expect(pots[0].eligible).toEqual([0, 1])
  })
})

describe('resolvePots', () => {
  const hands = (entries: Record<number, string>): Map<number, Card[]> =>
    new Map(Object.entries(entries).map(([seat, text]) => [Number(seat), parseCards(text)]))

  it('awards the whole pot to the best hand', () => {
    const pots = buildPots([100, 100], [false, false])
    const results = resolvePots(
      pots,
      hands({ 0: 'AS AH AD AC KS', 1: '2S 3H 4D 5C 7S' }),
    )
    expect(results).toHaveLength(1)
    expect(results[0].winners).toEqual([{ seat: 0, amount: 200, handLabel: expect.any(String) }])
  })

  it('gives the short stack only the main pot', () => {
    const pots = buildPots([50, 200, 200], [false, false, false])
    const results = resolvePots(
      pots,
      hands({
        0: 'AS AH AD AC KS', // best hand, but only 50 behind it
        1: 'KS KH KD 2C 3S', // second best — takes the side pot
        2: '2S 3H 4D 5C 7S', // worst
      }),
    )
    expect(results).toHaveLength(2)
    expect(results[0].winners[0].seat).toBe(0)
    expect(results[0].winners[0].amount).toBe(150)
    expect(results[1].winners[0].seat).toBe(1)
    expect(results[1].winners[0].amount).toBe(300)
  })

  it('uses the 梭哈 suit tie-break instead of splitting', () => {
    const pots = buildPots([100, 100], [false, false])
    const results = resolvePots(
      pots,
      hands({ 0: 'AS KH QD JC 9S', 1: 'AH KD QC JS 9H' }), // identical ranks, spade ace wins
    )
    expect(results[0].winners).toHaveLength(1)
    expect(results[0].winners[0].seat).toBe(0)
    expect(results[0].winners[0].amount).toBe(200)
  })
})
