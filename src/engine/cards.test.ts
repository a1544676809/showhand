import { describe, expect, it } from 'vitest'
import {
  buildShuffledDeck,
  cardId,
  cardText,
  cardsText,
  makeDeck,
  parseCard,
  parseCards,
  verifyShuffle,
} from './cards'
import { DeterministicRandom } from './rng'
import { sha256Hex } from './sha256'

describe('card notation', () => {
  it('round-trips every card in the deck', () => {
    for (const card of makeDeck(52)) {
      expect(parseCard(cardId(card))).toEqual(card)
      expect(parseCard(cardText(card))).toEqual(card)
    }
  })

  it('accepts several spellings', () => {
    expect(parseCard('AS')).toEqual({ rank: 14, suit: 'S' })
    expect(parseCard('as')).toEqual({ rank: 14, suit: 'S' })
    expect(parseCard('A♠')).toEqual({ rank: 14, suit: 'S' })
    expect(parseCard('TD')).toEqual({ rank: 10, suit: 'D' })
    expect(parseCard('10 h')).toEqual({ rank: 10, suit: 'H' })
  })

  it('rejects nonsense', () => {
    expect(() => parseCard('ZS')).toThrow()
    expect(() => parseCard('AX')).toThrow()
    expect(() => parseCard('A')).toThrow()
  })

  it('parses whitespace and comma separated lists', () => {
    expect(parseCards('AS, KH  10C')).toHaveLength(3)
  })

  it('formats compactly', () => {
    expect(cardsText(parseCards('AS KH 10C'))).toBe('A♠ K♥ 10♣')
  })
})

describe('deck construction', () => {
  it('builds a 52-card deck with no duplicates', () => {
    const deck = makeDeck(52)
    expect(deck).toHaveLength(52)
    expect(new Set(deck.map(cardId)).size).toBe(52)
  })

  it('builds the 28-card 港式五张 deck from 8 through A', () => {
    const deck = makeDeck(28)
    expect(deck).toHaveLength(28)
    expect(Math.min(...deck.map((c) => c.rank))).toBe(8)
    expect(Math.max(...deck.map((c) => c.rank))).toBe(14)
    expect(new Set(deck.map(cardId)).size).toBe(28)
  })
})

describe('provably-fair shuffle', () => {
  it('is a permutation of the full deck', () => {
    const { deck } = buildShuffledDeck('server', 'client')
    expect(deck).toHaveLength(52)
    expect(new Set(deck.map(cardId)).size).toBe(52)
    expect(new Set(deck.map(cardId))).toEqual(new Set(makeDeck(52).map(cardId)))
  })

  it('is fully reproducible from the seeds', () => {
    const a = buildShuffledDeck('server-1', 'client-1').deck
    const b = buildShuffledDeck('server-1', 'client-1').deck
    expect(a.map(cardId)).toEqual(b.map(cardId))
    expect(verifyShuffle('server-1', 'client-1').deck.map(cardId)).toEqual(a.map(cardId))
  })

  it('changes the deck when either seed changes', () => {
    const base = buildShuffledDeck('server-1', 'client-1').deck.map(cardId).join()
    expect(buildShuffledDeck('server-2', 'client-1').deck.map(cardId).join()).not.toBe(base)
    expect(buildShuffledDeck('server-1', 'client-2').deck.map(cardId).join()).not.toBe(base)
  })

  it('publishes a commitment that matches the revealed seed', () => {
    const { proof } = buildShuffledDeck('top-secret', 'player-nonce')
    expect(proof.serverSeedHash).toBe(sha256Hex('top-secret'))
    expect(proof.combinedHash).toBe(sha256Hex('top-secret:player-nonce'))
    expect(proof.serverSeedHash).not.toContain('top-secret')
    expect(verifyShuffle('top-secret', 'player-nonce').serverSeedHash).toBe(proof.serverSeedHash)
  })

  it('puts no card at a predictable position (chi-square uniformity)', () => {
    // 5,200 shuffles: the ace of spades should land in each of the 52
    // positions ~100 times. Chi-square with 51 degrees of freedom rejects a
    // biased Fisher-Yates or a biased nextBelow().
    const counts = new Array(52).fill(0)
    const trials = 5200
    for (let t = 0; t < trials; t++) {
      const { deck } = buildShuffledDeck(`s${t}`, 'c')
      counts[deck.findIndex((c) => c.rank === 14 && c.suit === 'S')] += 1
    }
    const expected = trials / 52
    const chiSquare = counts.reduce((sum, o) => sum + (o - expected) ** 2 / expected, 0)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(trials)
    expect(counts.every((c) => c > 0)).toBe(true)
    // Critical value for 51 df at p = 0.001 is ~90.6.
    expect(chiSquare).toBeLessThan(95)
  })
})

describe('DeterministicRandom', () => {
  it('is reproducible', () => {
    const a = new DeterministicRandom('seed')
    const b = new DeterministicRandom('seed')
    for (let i = 0; i < 100; i++) expect(a.nextUint32()).toBe(b.nextUint32())
  })

  it('produces different streams for different seeds', () => {
    expect(new DeterministicRandom('a').nextUint32()).not.toBe(
      new DeterministicRandom('b').nextUint32(),
    )
  })

  it('respects the bound of nextBelow', () => {
    const rng = new DeterministicRandom('bounds')
    for (let i = 0; i < 5000; i++) {
      const value = rng.nextBelow(6)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(6)
    }
  })

  it('rejects a non-positive bound', () => {
    const rng = new DeterministicRandom('x')
    expect(() => rng.nextBelow(0)).toThrow(RangeError)
    expect(() => rng.nextBelow(-3)).toThrow(RangeError)
    expect(() => rng.nextBelow(1.5)).toThrow(RangeError)
    expect(rng.nextBelow(1)).toBe(0)
  })

  it('has no modulo bias for a bound that does not divide 2^32', () => {
    const rng = new DeterministicRandom('bias')
    const counts = new Array(7).fill(0)
    const trials = 70_000
    for (let i = 0; i < trials; i++) counts[rng.nextBelow(7)] += 1
    const expected = trials / 7
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.08)
    }
  })

  it('shuffles without mutating the input', () => {
    const input = [1, 2, 3, 4, 5]
    const copy = input.slice()
    const out = new DeterministicRandom('s').shuffle(input)
    expect(input).toEqual(copy)
    expect(out).not.toBe(input)
    expect(out.slice().sort()).toEqual(copy)
  })

  it('produces floats in [0, 1)', () => {
    const rng = new DeterministicRandom('floats')
    for (let i = 0; i < 1000; i++) {
      const value = rng.nextFloat()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
