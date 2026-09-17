import { cardText } from './cards'
import {
  CATEGORY_EN,
  CATEGORY_ZH,
  HandCategory,
  SUIT_STRENGTH,
  type Card,
  type HandValue,
  type Rank,
} from './types'

/**
 * 梭哈 hand evaluation for 1..5 cards.
 *
 * Two rules make this different from Texas Hold'em evaluation:
 *
 *  1. Suits are NOT equal. 梭哈 breaks every remaining tie with the suit order
 *     黑桃 ♠ > 红桃 ♥ > 梅花 ♣ > 方块 ♦.
 *  2. Consequently the comparison is a *total* order — two distinct five-card
 *     hands can never tie, so there are never split pots on hand strength
 *     (only on identical-best... which cannot happen with one deck).
 *
 * The function accepts fewer than five cards so the same code can score a
 * player's visible board (who leads the betting) and feed the AI. Straights,
 * flushes, full houses and straight flushes naturally require a full five.
 */

const compareCardsDesc = (a: Card, b: Card): number =>
  b.rank - a.rank || SUIT_STRENGTH[b.suit] - SUIT_STRENGTH[a.suit]

const maxSuit = (cards: readonly Card[]): number =>
  cards.reduce((best, c) => Math.max(best, SUIT_STRENGTH[c.suit]), -1)

interface RankGroup {
  rank: Rank
  cards: Card[]
}

function groupByRank(cards: readonly Card[]): RankGroup[] {
  const map = new Map<Rank, Card[]>()
  for (const card of cards) {
    const bucket = map.get(card.rank)
    if (bucket) bucket.push(card)
    else map.set(card.rank, [card])
  }
  return [...map.entries()]
    .map(([rank, group]) => ({ rank, cards: group }))
    .sort((a, b) => b.cards.length - a.cards.length || b.rank - a.rank)
}

/** Returns the straight's high rank, or null. `A-2-3-4-5` counts as five-high. */
function straightHigh(uniqueRanksDesc: readonly number[]): number | null {
  if (uniqueRanksDesc.length !== 5) return null
  if (uniqueRanksDesc[0] - uniqueRanksDesc[4] === 4) return uniqueRanksDesc[0]
  // Wheel: A K Q J T is invalid; A 5 4 3 2 is a five-high straight.
  const wheel = [14, 5, 4, 3, 2]
  if (wheel.every((r, i) => r === uniqueRanksDesc[i])) return 5
  return null
}

const label = (category: HandCategory, detail: string): [string, string] => [
  detail ? `${CATEGORY_ZH[category]}·${detail}` : CATEGORY_ZH[category],
  detail ? `${CATEGORY_EN[category]} (${detail})` : CATEGORY_EN[category],
]

const RANK_NAME: Readonly<Record<number, string>> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
}

/**
 * Evaluates a partial or complete 梭哈 hand.
 *
 * The returned `ranks` / `suits` arrays are the lexicographic comparison key:
 * category first, then ranks, then suits.
 */
export function evaluateHand(cards: readonly Card[]): HandValue {
  const sorted = cards.slice().sort(compareCardsDesc)
  const n = sorted.length

  if (n === 0) {
    return {
      category: HandCategory.HighCard,
      ranks: [],
      suits: [],
      cards: [],
      label: '无牌',
      labelEn: 'No cards',
    }
  }

  const groups = groupByRank(sorted) // ordered: most frequent first, then high rank
  const quads = groups.filter((g) => g.cards.length === 4)
  const trips = groups.filter((g) => g.cards.length === 3)
  const pairs = groups.filter((g) => g.cards.length === 2)
  const singles = groups.filter((g) => g.cards.length === 1).sort((a, b) => b.rank - a.rank)

  const isFlush = n === 5 && sorted.every((c) => c.suit === sorted[0].suit)
  const uniqueRanks = [...new Set(sorted.map((c) => c.rank))]
  const high = straightHigh(uniqueRanks)

  const finish = (
    category: HandCategory,
    ranks: number[],
    suits: number[],
    display: Card[],
    detail: string,
  ): HandValue => {
    const [zh, en] = label(category, detail)
    return { category, ranks, suits, cards: display, label: zh, labelEn: en }
  }

  // ---------------------------------------------------------- straight flush
  if (isFlush && high !== null) {
    const straightCards = straightDisplay(sorted, high)
    return finish(
      HandCategory.StraightFlush,
      [high],
      // 梭哈 tie-break is the suit of the *highest* card of the run, not the
      // strongest suit anywhere in the hand.
      [SUIT_STRENGTH[straightCards[0].suit]],
      straightCards,
      `${RANK_NAME[high]} 高`,
    )
  }

  // ------------------------------------------------------------------ quads
  // NOTE: a partial hand can be *only* the quads — four same-rank 明牌 on the
  // last street is a real (if rare) board in stud, and it has no kicker. The
  // kicker must therefore be optional or the betting-order lookup crashes.
  if (quads.length === 1) {
    const quad = quads[0]
    const kicker = singles[0]?.cards[0] ?? null
    return finish(
      HandCategory.Quads,
      kicker ? [quad.rank, kicker.rank] : [quad.rank],
      kicker
        ? [maxSuit(quad.cards), SUIT_STRENGTH[kicker.suit]]
        : [maxSuit(quad.cards)],
      kicker ? [...quad.cards, kicker] : [...quad.cards],
      `${RANK_NAME[quad.rank]}`,
    )
  }

  // ------------------------------------------------------------- full house
  if (trips.length >= 1 && (pairs.length >= 1 || trips.length >= 2)) {
    // With two sets of trips, the higher becomes the three-of-a-kind.
    const ordered = trips.length >= 2 ? trips.slice(0, 2) : [trips[0]]
    const trip = ordered[0]
    const pair = ordered.length === 2 ? ordered[1] : pairs[0]
    return finish(
      HandCategory.FullHouse,
      [trip.rank, pair.rank],
      [maxSuit(trip.cards), maxSuit(pair.cards)],
      [...trip.cards, ...pair.cards],
      `${RANK_NAME[trip.rank]} 带 ${RANK_NAME[pair.rank]}`,
    )
  }

  // ------------------------------------------------------------------ flush
  if (isFlush) {
    return finish(
      HandCategory.Flush,
      sorted.map((c) => c.rank),
      sorted.map((c) => SUIT_STRENGTH[c.suit]),
      sorted,
      `${RANK_NAME[sorted[0].rank]} 高`,
    )
  }

  // --------------------------------------------------------------- straight
  if (high !== null) {
    const straightCards = straightDisplay(sorted, high)
    return finish(
      HandCategory.Straight,
      [high],
      [SUIT_STRENGTH[straightCards[0].suit]],
      straightCards,
      `${RANK_NAME[high]} 高`,
    )
  }

  // ------------------------------------------------------------------ trips
  if (trips.length === 1) {
    const trip = trips[0]
    const kickers = singles.slice(0, 2).map((g) => g.cards[0])
    return finish(
      HandCategory.Trips,
      [trip.rank, ...kickers.map((c) => c.rank)],
      [maxSuit(trip.cards), ...kickers.map((c) => SUIT_STRENGTH[c.suit])],
      [...trip.cards, ...kickers],
      `${RANK_NAME[trip.rank]}`,
    )
  }

  // --------------------------------------------------------------- two pair
  if (pairs.length >= 2) {
    const [hiPair, loPair] = pairs
    const kicker = singles[0]?.cards[0] ?? null
    return finish(
      HandCategory.TwoPair,
      [hiPair.rank, loPair.rank, ...(kicker ? [kicker.rank] : [])],
      [maxSuit(hiPair.cards), maxSuit(loPair.cards), ...(kicker ? [SUIT_STRENGTH[kicker.suit]] : [])],
      [...hiPair.cards, ...loPair.cards, ...(kicker ? [kicker] : [])],
      `${RANK_NAME[hiPair.rank]} 与 ${RANK_NAME[loPair.rank]}`,
    )
  }

  // ------------------------------------------------------------------- pair
  if (pairs.length === 1) {
    const pair = pairs[0]
    const kickers = singles.map((g) => g.cards[0])
    return finish(
      HandCategory.Pair,
      [pair.rank, ...kickers.map((c) => c.rank)],
      [maxSuit(pair.cards), ...kickers.map((c) => SUIT_STRENGTH[c.suit])],
      [...pair.cards, ...kickers],
      `${RANK_NAME[pair.rank]}`,
    )
  }

  // -------------------------------------------------------------- high card
  return finish(
    HandCategory.HighCard,
    sorted.map((c) => c.rank),
    sorted.map((c) => SUIT_STRENGTH[c.suit]),
    sorted,
    `${RANK_NAME[sorted[0].rank]} 高`,
  )
}

/** Returns the five cards forming the straight, highest first. */
function straightDisplay(sorted: readonly Card[], high: number): Card[] {
  if (high === 5) {
    // Wheel: A plays low, so it belongs at the end and is the 5 that leads.
    const five = sorted.find((c) => c.rank === 5)
    const rest = sorted.filter((c) => c.rank !== 5 && c.rank !== 14).sort(compareCardsDesc)
    const ace = sorted.find((c) => c.rank === 14)
    const ordered = [five, ...rest, ace].filter(Boolean) as Card[]
    return ordered
  }
  return sorted.filter((c) => c.rank >= high - 4 && c.rank <= high)
}

/**
 * Total order over hands: category, then ranks, then suits.
 * Returns > 0 when `a` wins, < 0 when `b` wins, 0 only for identical hands.
 */
export function compareHandValues(a: HandValue, b: HandValue): number {
  if (a.category !== b.category) return a.category - b.category

  const len = Math.max(a.ranks.length, b.ranks.length)
  for (let i = 0; i < len; i++) {
    const ra = a.ranks[i]
    const rb = b.ranks[i]
    if (ra === undefined) return -1
    if (rb === undefined) return 1
    if (ra !== rb) return ra - rb
  }
  for (let i = 0; i < len; i++) {
    const sa = a.suits[i] ?? -1
    const sb = b.suits[i] ?? -1
    if (sa !== sb) return sa - sb
  }
  return 0
}

export function compareHands(a: readonly Card[], b: readonly Card[]): number {
  return compareHandValues(evaluateHand(a), evaluateHand(b))
}

/**
 * Rough 0..1 strength estimate used by the bots and by the "手牌强度" hint.
 * Not a probability — just a monotone-ish scale anchored on the category.
 */
export function handStrength(value: HandValue): number {
  const base: Record<HandCategory, number> = {
    [HandCategory.HighCard]: 0.0,
    [HandCategory.Pair]: 0.3,
    [HandCategory.TwoPair]: 0.5,
    [HandCategory.Trips]: 0.65,
    [HandCategory.Straight]: 0.78,
    [HandCategory.Flush]: 0.85,
    [HandCategory.FullHouse]: 0.92,
    [HandCategory.Quads]: 0.97,
    [HandCategory.StraightFlush]: 1.0,
  }
  let score = base[value.category]
  const top = value.ranks[0]
  if (top !== undefined) {
    // Within a category, nudge by how high the key card is.
    const span = value.category === HandCategory.HighCard ? 12 : 12
    score += ((top - 2) / span) * 0.05
  }
  return Math.max(0, Math.min(1, score))
}

/** `A♠ K♠ Q♠ J♠ 10♠` */
export function describeHand(value: HandValue): string {
  return `${value.label} [${value.cards.map(cardText).join(' ')}]`
}
