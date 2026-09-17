import { DeterministicRandom } from './rng'
import { sha256Hex } from './sha256'
import {
  RANKS,
  RANK_LABEL,
  SUITS,
  SUIT_SYMBOL,
  type Card,
  type Rank,
  type ShuffleProof,
  type Suit,
} from './types'

/** 港式五张 uses a 28-card deck: 8, 9, 10, J, Q, K, A in four suits. */
export const SHORT_DECK_RANKS: readonly Rank[] = [8, 9, 10, 11, 12, 13, 14]

export function makeDeck(size: 52 | 28 = 52): Card[] {
  const ranks = size === 28 ? SHORT_DECK_RANKS : RANKS
  const deck: Card[] = []
  for (const suit of SUITS) {
    for (const rank of ranks) deck.push({ rank, suit })
  }
  return deck
}

/**
 * Short, stable asset id: `AS`, `10H`, `KD`. Matches the downloaded
 * `public/cards/<id>.svg` filenames.
 */
export function cardId(card: Card): string {
  return `${RANK_LABEL[card.rank]}${card.suit}`
}

/** `A♠` — the compact display form used in the UI and in text exports. */
export function cardText(card: Card): string {
  return `${RANK_LABEL[card.rank]}${SUIT_SYMBOL[card.suit]}`
}

/** `A♠ K♥ 10♣` */
export function cardsText(cards: readonly Card[], separator = ' '): string {
  return cards.map(cardText).join(separator)
}

const RANK_FROM_LABEL: Readonly<Record<string, Rank>> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  J: 11, Q: 12, K: 13, A: 14, T: 10,
}

const SUIT_FROM_LABEL: Readonly<Record<string, Suit>> = {
  S: 'S', H: 'H', C: 'C', D: 'D',
  '♠': 'S', '♥': 'H', '♣': 'C', '♦': 'D',
  s: 'S', h: 'H', c: 'C', d: 'D',
}

/** Parses `AS`, `10h`, `A♠`, `TD`. Throws on anything unrecognised. */
export function parseCard(text: string): Card {
  const trimmed = text.trim()
  if (trimmed.length < 2) throw new Error(`Not a card: ${JSON.stringify(text)}`)
  const suitChar = trimmed.slice(-1)
  const rankPart = trimmed.slice(0, -1).trim()
  const suit = SUIT_FROM_LABEL[suitChar]
  const rank = RANK_FROM_LABEL[rankPart.toUpperCase()]
  if (!suit) throw new Error(`Unknown suit in ${JSON.stringify(text)}`)
  if (!rank) throw new Error(`Unknown rank in ${JSON.stringify(text)}`)
  return { rank, suit }
}

/** Parses whitespace/comma separated card list: `"AS KH 10C"`. */
export function parseCards(text: string): Card[] {
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(parseCard)
}

export const HIDDEN_CARD = '★'

/** Commits to a shuffle before the deal and reveals the seed afterwards. */
export function createShuffleProof(serverSeed: string, clientSeed: string): ShuffleProof {
  return {
    serverSeed,
    serverSeedHash: sha256Hex(serverSeed),
    clientSeed,
    combinedHash: sha256Hex(`${serverSeed}:${clientSeed}`),
    revealed: false,
  }
}

export interface BuiltDeck {
  deck: Card[]
  proof: ShuffleProof
}

/**
 * Builds the shuffled deck for one hand.
 *
 * The seed is `SHA256(serverSeed:clientSeed)`, so publishing
 * `SHA256(serverSeed)` up front commits to the order without revealing it.
 */
export function buildShuffledDeck(
  serverSeed: string,
  clientSeed: string,
  size: 52 | 28 = 52,
): BuiltDeck {
  const proof = createShuffleProof(serverSeed, clientSeed)
  const deck = new DeterministicRandom(proof.combinedHash).shuffle(makeDeck(size))
  return { deck, proof }
}

/** Re-derives the deck for verification after a hand is revealed. */
export function verifyShuffle(
  serverSeed: string,
  clientSeed: string,
  size: 52 | 28 = 52,
): { ok: boolean; deck: Card[]; serverSeedHash: string } {
  const combined = sha256Hex(`${serverSeed}:${clientSeed}`)
  const deck = new DeterministicRandom(combined).shuffle(makeDeck(size))
  return { ok: true, deck, serverSeedHash: sha256Hex(serverSeed) }
}
