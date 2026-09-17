import { compareHandValues, evaluateHand } from './evaluator'
import type { Card, HandValue, PotResult, PotShare } from './types'

/**
 * Side-pot construction.
 *
 * Every chip a player pushed in during the hand is a claim on the pot, but a
 * player who is all-in for less can only win the portion of the pot they could
 * match. We therefore slice the contributions into layers and give each layer
 * its own eligibility list.
 */
export interface Pot {
  amount: number
  /** Seats that may win this layer. */
  eligible: number[]
  /** Human label: 主池 / 边池 1 / 边池 2 ... */
  label: string
}

export const MAIN_POT_LABEL = '主池'

/**
 * @param contributions total chips each seat put in this hand (folded seats included)
 * @param folded        whether each seat folded
 */
export function buildPots(contributions: readonly number[], folded: readonly boolean[]): Pot[] {
  const seats = contributions.map((_, i) => i)
  const levels = [...new Set(contributions.filter((c) => c > 0))].sort((a, b) => a - b)

  const layers: Pot[] = []
  let previous = 0

  for (const level of levels) {
    let amount = 0
    for (const seat of seats) {
      amount += Math.min(contributions[seat], level) - Math.min(contributions[seat], previous)
    }
    if (amount <= 0) {
      previous = level
      continue
    }
    const eligible = seats.filter((s) => !folded[s] && contributions[s] >= level)
    layers.push({ amount, eligible, label: '' })
    previous = level
  }

  // Merge neighbouring layers that share the same eligibility — these are not
  // distinct pots, just an artefact of one player's odd contribution size.
  const merged: Pot[] = []
  for (const layer of layers) {
    const last = merged[merged.length - 1]
    if (last && sameSeats(last.eligible, layer.eligible)) {
      last.amount += layer.amount
    } else {
      merged.push({ ...layer })
    }
  }

  // A layer nobody can win (everyone eligible folded) rolls into the one below.
  const resolved: Pot[] = []
  for (const pot of merged) {
    if (pot.eligible.length === 0 && resolved.length > 0) {
      resolved[resolved.length - 1].amount += pot.amount
    } else {
      resolved.push(pot)
    }
  }

  return resolved.map((pot, index) => ({
    ...pot,
    label: index === 0 ? MAIN_POT_LABEL : `边池 ${index}`,
  }))
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export interface ResolvedPot extends PotResult {
  label: string
}

/**
 * Awards each layer to its best hand.
 *
 * Because 梭哈 breaks ties down to suit, two distinct hands can never be equal,
 * so a layer always has exactly one winner — but the split path is kept for
 * safety and for the all-folded-to-one case.
 */
export function resolvePots(
  pots: readonly Pot[],
  hands: ReadonlyMap<number, Card[]>,
): ResolvedPot[] {
  const results: ResolvedPot[] = []

  for (const pot of pots) {
    const contenders: { seat: number; value: HandValue }[] = []
    for (const seat of pot.eligible) {
      const cards = hands.get(seat)
      if (!cards || cards.length === 0) continue
      contenders.push({ seat, value: evaluateHand(cards) })
    }

    if (contenders.length === 0) {
      // Nothing to compare (should not happen) — refund equally to contributors
      // is impossible here, so hand it back to the eligible seats evenly.
      const share = Math.floor(pot.amount / Math.max(1, pot.eligible.length))
      const winners: PotShare[] = pot.eligible.map((seat) => ({
        seat,
        amount: share,
        handLabel: '—',
      }))
      results.push({ amount: pot.amount, eligible: pot.eligible, winners, label: pot.label })
      continue
    }

    contenders.sort((a, b) => compareHandValues(b.value, a.value))
    const best = contenders[0]
    const tied = contenders.filter((c) => compareHandValues(c.value, best.value) === 0)

    const share = Math.floor(pot.amount / tied.length)
    let remainder = pot.amount - share * tied.length
    const winners: PotShare[] = tied.map((c) => {
      const bonus = remainder > 0 ? 1 : 0
      remainder -= bonus
      return { seat: c.seat, amount: share + bonus, handLabel: c.value.label }
    })

    results.push({
      amount: pot.amount,
      eligible: pot.eligible,
      winners,
      label: pot.label,
    })
  }

  return results
}
