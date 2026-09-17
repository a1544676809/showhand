import { describe, expect, it } from 'vitest'
import { makeDeck, parseCards } from './cards'
import { compareHandValues, evaluateHand, handStrength } from './evaluator'
import { DeterministicRandom } from './rng'
import { HandCategory, type Card } from './types'

const H = (text: string) => evaluateHand(parseCards(text))
const cmp = (a: string, b: string) => compareHandValues(H(a), H(b))

describe('梭哈 hand categories', () => {
  it('classifies every category', () => {
    expect(H('AS KS QS JS 10S').category).toBe(HandCategory.StraightFlush)
    expect(H('9S 9H 9D 9C 4S').category).toBe(HandCategory.Quads)
    expect(H('8S 8H 8D KC KS').category).toBe(HandCategory.FullHouse)
    expect(H('KS JS 8S 4S 3S').category).toBe(HandCategory.Flush)
    expect(H('9S 8H 7D 6C 5S').category).toBe(HandCategory.Straight)
    expect(H('7S 7H 7D KC 2S').category).toBe(HandCategory.Trips)
    expect(H('AS AH 8D 8C QS').category).toBe(HandCategory.TwoPair)
    expect(H('9S 9H AD JC 4S').category).toBe(HandCategory.Pair)
    expect(H('AS 10H 9D 5C 4S').category).toBe(HandCategory.HighCard)
  })

  it('orders categories 同花顺 > 铁支 > 葫芦 > 同花 > 顺子 > 三条 > 二对 > 对子 > 散牌', () => {
    const ladder = [
      'AS KS QS JS 10S', // 同花顺
      '9S 9H 9D 9C 4S', //  铁支
      '8S 8H 8D KC KS', //  葫芦
      'KS JS 8S 4S 3S', //  同花
      '9S 8H 7D 6C 5S', //  顺子
      '7S 7H 7D KC 2S', //  三条
      'AS AH 8D 8C QS', //  二对
      '9S 9H AD JC 4S', //  对子
      'AS 10H 9D 5C 4S', // 散牌
    ]
    for (let i = 0; i < ladder.length - 1; i++) {
      expect(cmp(ladder[i], ladder[i + 1])).toBeGreaterThan(0)
      expect(cmp(ladder[i + 1], ladder[i])).toBeLessThan(0)
    }
  })
})

describe('straights', () => {
  it('treats A-2-3-4-5 as a five-high straight (the wheel)', () => {
    const wheel = H('AS 2H 3D 4C 5S')
    expect(wheel.category).toBe(HandCategory.Straight)
    expect(wheel.ranks[0]).toBe(5)
  })

  it('does not wrap A-K-Q-J-10 around to the bottom', () => {
    expect(H('AS KH QD JC 10S').ranks[0]).toBe(14)
  })

  it('ranks the wheel below a six-high straight', () => {
    expect(cmp('6S 5H 4D 3C 2S', 'AS 2H 3D 4C 5S')).toBeGreaterThan(0)
  })

  it('rejects a broken run', () => {
    expect(H('AS KH QD JC 9S').category).toBe(HandCategory.HighCard)
  })

  it('makes the wheel a straight flush when suited', () => {
    expect(H('AS 2S 3S 4S 5S').category).toBe(HandCategory.StraightFlush)
  })
})

describe('梭哈 suit tie-break (♠ > ♥ > ♣ > ♦)', () => {
  it('breaks an identical high card by the top card suit', () => {
    // Same ranks, so the spade ace wins.
    expect(cmp('AS KH QD JC 9S', 'AH KD QC JS 9H')).toBeGreaterThan(0)
    expect(cmp('AH KD QC JS 9H', 'AD KC QH JS 9D')).toBeGreaterThan(0)
    expect(cmp('AC KH QD JS 9C', 'AH KD QC JS 9H')).toBeLessThan(0)
  })

  it('breaks identical straights by the suit of the highest card', () => {
    const spadeTop = 'AS KH QD JC 10S'
    const heartTop = 'AH KD QC JS 10H'
    expect(cmp(spadeTop, heartTop)).toBeGreaterThan(0)
  })

  it('breaks identical flushes by the flush suit', () => {
    expect(cmp('AS KS QS JS 9S', 'AH KH QH JH 9H')).toBeGreaterThan(0)
    expect(cmp('AH KH QH JH 9H', 'AC KC QC JC 9C')).toBeGreaterThan(0)
    expect(cmp('AC KC QC JC 9C', 'AD KD QD JD 9D')).toBeGreaterThan(0)
  })

  it('breaks identical pairs by the highest suit inside the pair', () => {
    // Both pair nines with an ace kicker; 9♥ beats 9♣.
    expect(cmp('9H 9C AS JD 4C', '9S 9D AH JC 4D')).toBeLessThan(0)
    // 9♠+9♦ has the higher best-suit (♠) than 9♥+9♣ (♥).
    expect(cmp('9S 9D AH JC 4D', '9H 9C AS JD 4C')).toBeGreaterThan(0)
  })

  it('breaks identical two pair by the top pair suit', () => {
    expect(cmp('AS AD 8H 8C QS', 'AH AC 8S 8D QH')).toBeGreaterThan(0)
  })

  it('never returns a tie for two distinct five-card hands', () => {
    // Exhaustive-ish: compare a shuffled sample pair-wise.
    const deck: string[] = []
    for (const suit of ['S', 'H', 'C', 'D']) {
      for (const rank of ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2']) {
        deck.push(`${rank}${suit}`)
      }
    }
    const hands: string[] = []
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 5; j++) {
        hands.push([deck[i], deck[j], deck[10], deck[20], deck[30]].join(' '))
      }
    }
    for (const a of hands) {
      for (const b of hands) {
        if (a === b) continue
        expect(cmp(a, b)).not.toBe(0)
      }
    }
  })
})

describe('within-category comparisons', () => {
  it('compares quads by rank then kicker', () => {
    expect(cmp('AS AH AD AC 2S', 'KS KH KD KC AS')).toBeGreaterThan(0)
    expect(cmp('9S 9H 9D 9C AS', '9S 9H 9D 9C KS')).toBeGreaterThan(0)
  })

  it('compares a full house by trips first, then the pair', () => {
    expect(cmp('8S 8H 8D 2C 2S', '7S 7H 7D AC AS')).toBeGreaterThan(0)
    expect(cmp('8S 8H 8D AC AS', '8C 8D 8S KC KS')).toBeGreaterThan(0)
  })

  it('uses the higher trips when a player holds two sets', () => {
    // 9-9-9 + 5-5-5 must be read as nines full of fives.
    const value = H('9S 9H 9D 5C 5S')
    expect(value.category).toBe(HandCategory.FullHouse)
    expect(value.ranks).toEqual([9, 5])
  })

  it('compares two pair by high pair, low pair, then kicker', () => {
    expect(cmp('AS AH 2D 2C 3S', 'KS KH QD QC AS')).toBeGreaterThan(0)
    expect(cmp('AS AH QD QC 3S', 'AS AH JD JC KS')).toBeGreaterThan(0)
    expect(cmp('AS AH QD QC KS', 'AS AH QD QC JS')).toBeGreaterThan(0)
  })

  it('compares trips by kicker sequence', () => {
    expect(cmp('7S 7H 7D AS 2C', '7C 7D 7S KS QC')).toBeGreaterThan(0)
  })

  it('compares flushes card by card before suits', () => {
    expect(cmp('KS JS 8S 4S 3S', 'KH JH 8H 4H 2H')).toBeGreaterThan(0)
  })
})

describe('partial hands (visible boards)', () => {
  /**
   * Regression: four same-rank 明牌 on the last street is a legal stud board
   * with no kicker, and the quads branch used to dereference a missing card.
   */
  it('handles bare four of a kind with no kicker', () => {
    const value = H('AS AH AD AC')
    expect(value.category).toBe(HandCategory.Quads)
    expect(value.cards).toHaveLength(4)
    expect(value.ranks).toEqual([14])
  })

  it('handles every partial hand the deck can produce', () => {
    // Exhaustive over all 1-, 2-, 3- and 4-card subsets (294,203 hands). These
    // are exactly the inputs the betting-order lookup feeds in, so "does not
    // throw" plus a well-formed comparison key is the property that matters.
    // The assertions are hoisted out of the loop — 1.5M expect() calls would
    // dominate the runtime.
    const deck = makeDeck(52)
    const buffer: Card[] = []
    let checked = 0
    let malformed = 0

    const walk = (start: number, size: number): void => {
      if (buffer.length === size) {
        const value = evaluateHand(buffer)
        if (
          value.cards.length !== size ||
          value.ranks.length === 0 ||
          value.suits.length !== value.ranks.length ||
          value.category < 0 ||
          value.category > 8
        ) {
          malformed++
        }
        checked++
        return
      }
      for (let i = start; i < deck.length; i++) {
        buffer.push(deck[i])
        walk(i + 1, size)
        buffer.pop()
      }
    }

    for (const size of [1, 2, 3, 4]) walk(0, size)

    expect(malformed).toBe(0)
    expect(checked).toBe(294_203)
  })

  it('never throws on a sampled set of full five-card hands', () => {
    const deck = makeDeck(52)
    const rng = new DeterministicRandom('evaluator-property')
    const used = new Set<number>()
    const picked: Card[] = []
    let malformed = 0

    for (let trial = 0; trial < 60_000; trial++) {
      used.clear()
      picked.length = 0
      while (picked.length < 5) {
        const index = rng.nextBelow(52)
        if (used.has(index)) continue
        used.add(index)
        picked.push(deck[index])
      }
      const value = evaluateHand(picked)
      if (value.cards.length !== 5 || value.suits.length !== value.ranks.length) malformed++
    }

    expect(malformed).toBe(0)
  })

  it('scores a bare high card', () => {
    const value = H('KS')
    expect(value.category).toBe(HandCategory.HighCard)
    expect(value.ranks).toEqual([13])
  })

  it('treats a visible pair as beating a higher high card', () => {
    expect(cmp('9H 9C', 'AS KD')).toBeGreaterThan(0)
  })

  it('never reports a flush with fewer than five cards', () => {
    expect(H('AS KS QS JS').category).toBe(HandCategory.HighCard)
  })

  it('never reports a straight with fewer than five cards', () => {
    expect(H('9S 8H 7D 6C').category).toBe(HandCategory.HighCard)
  })

  it('handles an empty board', () => {
    const value = evaluateHand([])
    expect(value.ranks).toEqual([])
    expect(handStrength(value)).toBe(0)
  })
})

describe('handStrength', () => {
  it('is monotone across categories', () => {
    const scores = [
      'AS 10H 9D 5C 4S',
      '9S 9H AD JC 4S',
      'AS AH 8D 8C QS',
      '7S 7H 7D KC 2S',
      '9S 8H 7D 6C 5S',
      'KS JS 8S 4S 3S',
      '8S 8H 8D KC KS',
      '9S 9H 9D 9C 4S',
      'AS KS QS JS 10S',
    ].map((text) => handStrength(H(text)))
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeLessThan(scores[i + 1])
    }
  })

  it('stays inside 0..1', () => {
    for (const text of ['AS KS QS JS 10S', '2S 3H 4D 5C 7S', 'AS AH AD AC KS']) {
      const score = handStrength(H(text))
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})

describe('describe labels', () => {
  it('produces Chinese category names', () => {
    expect(H('9S 9H 9D 9C 4S').label).toContain('铁支')
    expect(H('8S 8H 8D KC KS').label).toContain('葫芦')
    expect(H('AS KS QS JS 10S').label).toContain('同花顺')
    expect(H('AS AH 8D 8C QS').label).toContain('二对')
  })
})
