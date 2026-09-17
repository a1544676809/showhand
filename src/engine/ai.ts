import { betUnit, legalActions, totalPot } from './game'
import { evaluateHand, handStrength } from './evaluator'
import { DeterministicRandom } from './rng'
import type { GameState, PlayerAction, PlayerState } from './types'

/**
 * Heuristic 梭哈 bots.
 *
 * A bot can only see its own 暗牌 plus every 明牌 on the table, which is
 * exactly the information the engine's `evaluateHand` can score directly — so
 * the policy is: score my made hand, compare it against the best visible board,
 * then price the call against the pot. Personalities shift the thresholds and
 * add a little unpredictability.
 *
 * Decisions are derived from a hash of the shuffle commitment, the seat, the
 * street and the revision counter, which keeps every bot move reproducible
 * from the hand's seeds (important for replays and tests).
 */

export interface BotProfile {
  label: string
  /** Higher = folds weak hands sooner. */
  tightness: number
  /** Higher = raises and bets more readily. */
  aggression: number
  /** Chance of firing with nothing. */
  bluff: number
}

export const BOT_PROFILES: readonly BotProfile[] = [
  { label: '紧凶', tightness: 0.62, aggression: 0.78, bluff: 0.1 },
  { label: '松凶', tightness: 0.28, aggression: 0.72, bluff: 0.26 },
  { label: '稳健', tightness: 0.5, aggression: 0.45, bluff: 0.08 },
  { label: '跟注站', tightness: 0.2, aggression: 0.18, bluff: 0.03 },
  { label: '赌徒', tightness: 0.1, aggression: 0.9, bluff: 0.38 },
]

export function profileFor(seat: number): BotProfile {
  return BOT_PROFILES[seat % BOT_PROFILES.length]
}

function botRng(state: GameState, seat: number): DeterministicRandom {
  const seed = [
    state.shuffle.combinedHash || 'noseed',
    state.handNo,
    seat,
    state.street,
    state.revision,
  ].join(':')
  return new DeterministicRandom(seed)
}

/** 0..1 strength of what the bot actually holds (hole card included). */
export function myStrength(me: PlayerState): number {
  if (me.cards.length === 0) return 0
  return handStrength(evaluateHand(me.cards))
}

/** 0..1 strength of the best *visible* board among the opponents. */
export function opponentBoardStrength(state: GameState, seat: number): number {
  let best = 0
  for (const other of state.players) {
    if (other.seat === seat || other.outOfGame || other.folded) continue
    const up = other.cards.slice(1)
    if (up.length === 0) continue
    best = Math.max(best, handStrength(evaluateHand(up)))
  }
  return best
}

function roundNice(value: number, step: number): number {
  const unit = Math.max(1, step)
  return Math.max(unit, Math.round(value / unit) * unit)
}

export function chooseAction(state: GameState, seat: number): PlayerAction {
  const me = state.players[seat]
  const legal = legalActions(state, seat)
  const profile = profileFor(seat)
  const rng = botRng(state, seat)

  if (!legal.fold && !legal.check && !legal.call && !legal.raise) {
    // Should never happen; folding is always legal so this is a safety net.
    return { type: 'fold' }
  }

  const pot = Math.max(1, totalPot(state))
  const toCall = legal.callAmount
  const strength = myStrength(me)
  const board = opponentBoardStrength(state, seat)

  // How many players still contest the pot — more callers need a better hand.
  const liveCount = state.players.filter((p) => !p.outOfGame && !p.folded).length
  const crowdPenalty = Math.max(0, liveCount - 2) * 0.06

  // Relative strength: my made hand measured against what is showing.
  const relative = strength - board * 0.55 - crowdPenalty

  // ---------------------------------------------------------- facing a bet
  if (toCall > 0) {
    const potOdds = toCall / (pot + toCall)
    const needed = potOdds + profile.tightness * 0.12
    const alreadyIn = me.streetCommitted > 0

    if (legal.raise && strength > 0.72 && rng.nextFloat() < profile.aggression) {
      return { type: 'raise', amount: raiseTarget(state, legal, 0.8, rng) }
    }
    if (legal.raise && relative > 0.22 && rng.nextFloat() < profile.aggression * 0.45) {
      return { type: 'raise', amount: raiseTarget(state, legal, 0.6, rng) }
    }

    // Committing the last chips needs a real hand unless the bot is a gambler.
    const isShoveCall = toCall >= me.chips
    if (isShoveCall && strength < 0.55 + profile.tightness * 0.2) {
      return legal.fold ? { type: 'fold' } : { type: 'call' }
    }

    if (strength >= needed) return legal.call ? { type: 'call' } : { type: 'check' }

    // Cheap calls with a live draw are worth taking.
    const cheap = potOdds < 0.12 + profile.tightness * 0.08
    if (cheap && me.cards.length < 5) return legal.call ? { type: 'call' } : { type: 'check' }

    // Occasionally float one street to stay unpredictable.
    if (!alreadyIn && rng.nextFloat() < profile.bluff * 0.35 && legal.call) {
      return { type: 'call' }
    }

    return legal.fold ? { type: 'fold' } : legal.call ? { type: 'call' } : { type: 'check' }
  }

  // ------------------------------------------------------- no bet to call
  const betThreshold = 0.52 - profile.aggression * 0.16
  if (legal.raise) {
    if (strength >= betThreshold && rng.nextFloat() < 0.55 + profile.aggression * 0.45) {
      return { type: 'bet', amount: raiseTarget(state, legal, 0.65, rng) }
    }
    if (relative > 0.28 && rng.nextFloat() < profile.aggression * 0.4) {
      return { type: 'bet', amount: raiseTarget(state, legal, 0.5, rng) }
    }
    if (rng.nextFloat() < profile.bluff * 0.5) {
      return { type: 'bet', amount: raiseTarget(state, legal, 0.45, rng) }
    }
  }

  return legal.check ? { type: 'check' } : { type: 'call' }
}

/**
 * Picks a raise size: a fraction of the pot above the current bet, rounded to a
 * friendly number and clamped to the legal window. Shoves when the raise would
 * leave almost nothing behind.
 */
function raiseTarget(
  state: GameState,
  legal: ReturnType<typeof legalActions>,
  potFraction: number,
  rng: DeterministicRandom,
): number {
  const unit = betUnit(state.config, state.street)
  const maxTo = legal.maxRaiseTo

  const jitter = 0.85 + rng.nextFloat() * 0.4
  const pot = totalPot(state)
  const desired = Math.max(
    state.currentBet + unit,
    state.currentBet + (pot * potFraction + state.currentBet) * jitter,
  )

  let target = roundNice(desired, Math.max(unit, 5))
  target = Math.max(legal.minRaiseTo, Math.min(target, maxTo))

  // If raising leaves less than a bet unit behind, just commit it all.
  const behind = maxTo - target
  if (behind > 0 && behind < unit && legal.allin) return maxTo

  return target
}

/** Convenience for the UI: the action a bot wants to take right now. */
export function botAction(state: GameState): { seat: number; action: PlayerAction } | null {
  if (state.stage !== 'betting' || state.toActSeat === null) return null
  const seat = state.toActSeat
  if (!state.players[seat].isBot) return null
  return { seat, action: chooseAction(state, seat) }
}
