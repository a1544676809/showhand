/**
 * Core domain types for 梭哈 (Chinese Five-Card Stud).
 *
 * Terminology used throughout:
 *   暗牌 / 底牌  hole card  — dealt face down on the first deal
 *   明牌        up card    — the four face-up cards
 *   底注        ante
 *   跟注/加注/弃牌/梭哈  call / raise / fold / all-in
 *   铁支=四条   four of a kind      葫芦=满堂红  full house
 *   二对=两对   two pair
 */

export type Suit = 'S' | 'H' | 'C' | 'D'

/** 2..10 = pip cards, 11=J, 12=Q, 13=K, 14=A */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14

export interface Card {
  readonly rank: Rank
  readonly suit: Suit
}

// ---------------------------------------------------------------- suit order

/** 梭哈 ranks the suits: 黑桃 ♠ > 红桃 ♥ > 梅花 ♣ > 方块 ♦. */
export const SUIT_STRENGTH: Readonly<Record<Suit, number>> = { S: 3, H: 2, C: 1, D: 0 }

export const SUITS: readonly Suit[] = ['S', 'H', 'C', 'D']
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

export const SUIT_SYMBOL: Readonly<Record<Suit, string>> = { S: '♠', H: '♥', C: '♣', D: '♦' }
export const SUIT_ZH: Readonly<Record<Suit, string>> = { S: '黑桃', H: '红桃', C: '梅花', D: '方块' }
export const SUIT_EN: Readonly<Record<Suit, string>> = {
  S: 'spades',
  H: 'hearts',
  C: 'clubs',
  D: 'diamonds',
}

export const RANK_LABEL: Readonly<Record<number, string>> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
}

// -------------------------------------------------------------- hand classes

export const HandCategory = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  Trips: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  Quads: 7,
  StraightFlush: 8,
} as const

export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory]

export const CATEGORY_ZH: Readonly<Record<HandCategory, string>> = {
  0: '散牌',
  1: '一对',
  2: '二对',
  3: '三条',
  4: '顺子',
  5: '同花',
  6: '葫芦',
  7: '铁支',
  8: '同花顺',
}

export const CATEGORY_EN: Readonly<Record<HandCategory, string>> = {
  0: 'High Card',
  1: 'One Pair',
  2: 'Two Pair',
  3: 'Three of a Kind',
  4: 'Straight',
  5: 'Flush',
  6: 'Full House',
  7: 'Four of a Kind',
  8: 'Straight Flush',
}

export interface HandValue {
  category: HandCategory
  /** Comparison ranks, most significant first. */
  ranks: number[]
  /** Suit strengths parallel to `ranks`, used as the final 梭哈 tie-break. */
  suits: number[]
  /** The cards that produced this value (ordered for display). */
  cards: Card[]
  label: string
  labelEn: string
}

// ------------------------------------------------------------------- actions

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'

export interface PlayerAction {
  type: ActionType
  /** For bet/raise: the total amount the player wants committed on this street. */
  amount?: number
}

/** What a player is allowed to do right now. */
export interface LegalActions {
  fold: boolean
  check: boolean
  /** Chips required to call; 0 when checking is free. */
  callAmount: number
  call: boolean
  /** A bet or raise is available. */
  raise: boolean
  /** Total street commitment of the smallest legal raise. */
  minRaiseTo: number
  /** Total street commitment of the largest legal raise (all-in). */
  maxRaiseTo: number
  allin: boolean
  /** Chips the player would commit by shoving. */
  allinAmount: number
}

// ---------------------------------------------------------------- game model

export type BettingMode = 'no-limit' | 'fixed-limit'

export interface GameConfig {
  /** 底注 — posted by every player before the deal. */
  ante: number
  /** Minimum opening bet on streets 1-2 (also the fixed-limit small bet). */
  smallBet: number
  /** Minimum opening bet on streets 3-4 (also the fixed-limit big bet). */
  bigBet: number
  /** 0 = unlimited raises per street. */
  maxRaisesPerStreet: number
  bettingMode: BettingMode
  /** 52 = full deck, 28 = 港式五张 (8,9,10,J,Q,K,A only). */
  deckSize: 52 | 28
}

export interface PlayerState {
  readonly id: string
  /**
   * Caller-supplied stable identifier, independent of the display name. When
   * set, the seat's chip count is persisted under this key and restored on the
   * next visit; when empty the seat is anonymous and nothing is written.
   */
  playerId: string
  name: string
  isBot: boolean
  /** Fixed physical seat, 0-based, clockwise. */
  readonly seat: number
  chips: number
  /** cards[0] is the 暗牌 (face down); the rest are 明牌. */
  cards: Card[]
  folded: boolean
  allIn: boolean
  /** Busted out of the session. */
  outOfGame: boolean
  /** Chips committed on the current betting street. */
  streetCommitted: number
  /** Chips committed across the whole hand (drives side pots). */
  totalCommitted: number
  hasActedThisStreet: boolean
  /** Human-readable summary of the last thing this player did. */
  lastActionLabel: string | null
  /** Number of chips won in the most recently settled hand. */
  lastWin: number
}

export type Stage =
  | 'idle' // no hand in progress
  | 'deal' // dealing cards one at a time
  | 'betting' // waiting on a player
  | 'showdown' // cards revealed, pots being resolved
  | 'handOver' // settled, waiting for the next hand
  | 'gameOver' // only one player has chips left

export interface LogEntry {
  hand: number
  street: number
  kind: 'ante' | 'deal' | 'action' | 'street' | 'showdown' | 'payout' | 'info'
  text: string
  seat?: number
}

export interface PotShare {
  seat: number
  amount: number
  handLabel: string
}

export interface PotResult {
  /** 主池 / 边池 1 / 边池 2 … */
  label: string
  amount: number
  eligible: number[]
  winners: PotShare[]
}

export interface ShuffleProof {
  /** Revealed once the hand is over. */
  serverSeed: string
  /** Published before the deal — SHA-256(serverSeed). */
  serverSeedHash: string
  /** Caller-supplied entropy mixed into the shuffle. */
  clientSeed: string
  /** SHA-256(serverSeed:clientSeed) — the value that actually seeded the shuffle. */
  combinedHash: string
  revealed: boolean
}

export interface GameState {
  config: GameConfig
  players: PlayerState[]
  /** Full ordered deck for this hand. */
  deck: Card[]
  /** How many cards have been consumed from `deck`. */
  deckIndex: number
  /** Cards removed from the top of the deck between betting rounds. */
  burned: Card[]

  handNo: number
  dealerSeat: number

  stage: Stage
  /** Betting round index, 0..3. -1 before the first betting round. */
  street: number
  /** Which deal round is in progress: 0 = hole cards, 1..4 = up cards. */
  dealRound: number
  /** How many players have received a card in the current deal round. */
  dealCursor: number
  /** Seat that receives the first card of the current deal round. */
  dealLeadSeat: number

  toActSeat: number | null
  currentBet: number
  /** Size of the last full bet/raise increment; sets the minimum re-raise. */
  lastRaiseSize: number
  raiseCount: number
  lastAggressorSeat: number | null

  /** Total chips in the middle (derived from totalCommitted, kept for display). */
  pot: number
  potResults: PotResult[]
  /** Seats that must show their 暗牌 at the end of the hand. */
  revealedSeats: number[]
  winners: number[]

  log: LogEntry[]
  shuffle: ShuffleProof
  /**
   * When set, every hand derives its server seed from this value instead of
   * using fresh entropy — used by tests, replays and "重放本手".
   */
  seedOverride: string | null
  /** Monotonic counter bumped on every mutation — useful for animation keys. */
  revision: number
}

export interface WinnerSummary {
  seat: number
  amount: number
  potIndex: number
  handLabel: string
}
