import { describe, expect, it } from 'vitest'
import { createGame, dealNextCard, legalActions, settleHand, startHand, applyAction, autoStep, betUnit, type PlayerSetup } from './game'
import { cardId } from './cards'
import { evaluateHand } from './evaluator'
import type { GameState, PlayerAction } from './types'
// --------------------------------------------------------------- test driver

const seats = (...names: string[]): PlayerSetup[] => names.map((name) => ({ name, isBot: true }))

function newGame(names: string[], chips = 1000, config = {}): GameState {
  return createGame({ players: seats(...names), startingChips: chips, serverSeed: 'test-seed', clientSeed: 'test-client', config })
}

/** Chips on the table plus chips committed but not yet paid out. */
function totalChips(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.chips + p.totalCommitted, 0)
}

function drive(
  state: GameState,
  decide: (state: GameState, seat: number) => PlayerAction,
  maxSteps = 4000,
): GameState {
  let current = state
  for (let step = 0; step < maxSteps; step++) {
    switch (current.stage) {
      case 'deal':
        current = dealNextCard(current)
        break
      case 'betting':
        if (current.toActSeat === null) throw new Error('betting with no actor')
        current = applyAction(current, current.toActSeat, decide(current, current.toActSeat))
        break
      case 'showdown':
        current = settleHand(current)
        break
      default:
        return current
    }
  }
  throw new Error('hand did not finish')
}

const checkCall = (state: GameState, seat: number): PlayerAction => {
  const legal = legalActions(state, seat)
  if (legal.check) return { type: 'check' }
  if (legal.call) return { type: 'call' }
  return { type: 'fold' }
}

const alwaysFold = (): PlayerAction => ({ type: 'fold' })

// -------------------------------------------------------------------- setup

describe('createGame', () => {
  it('seats the players with their starting stacks', () => {
    const game = newGame(['A', 'B', 'C'], 500)
    expect(game.players).toHaveLength(3)
    expect(game.players.map((p) => p.seat)).toEqual([0, 1, 2])
    expect(game.players.every((p) => p.chips === 500)).toBe(true)
    expect(game.stage).toBe('idle')
    expect(game.handNo).toBe(0)
  })

  it('supports 2 to 5 players', () => {
    for (const count of [2, 3, 4, 5]) {
      const game = newGame(Array.from({ length: count }, (_, i) => `P${i}`))
      expect(game.players).toHaveLength(count)
      expect(startHand(game).stage).toBe('deal')
    }
  })

  it('honours per-seat buy-ins and falls back to the shared default', () => {
    const game = createGame({
      players: [
        { name: 'rich', isBot: false, chips: 5000 },
        { name: 'poor', isBot: false, chips: 250, playerId: 'p2' },
        { name: 'default', isBot: true },
      ],
      startingChips: 1000,
    })
    expect(game.players.map((p) => p.chips)).toEqual([5000, 250, 1000])
    expect(game.players.map((p) => p.playerId)).toEqual(['', 'p2', ''])
  })

  it('carries player identity through the hand', () => {
    let game = createGame({
      players: [
        { name: 'A', isBot: false, playerId: 'alice' },
        { name: 'B', isBot: false },
      ],
      startingChips: 500,
      serverSeed: 'id-seed',
    })
    game = settleHand(drive(startHand(game), checkCall))
    expect(game.players[0].playerId).toBe('alice')
    expect(game.players[1].playerId).toBe('')
  })
})

describe('startHand', () => {
  it('posts the ante and builds a shuffled deck', () => {
    const game = startHand(newGame(['A', 'B', 'C']))
    expect(game.handNo).toBe(1)
    expect(game.deck).toHaveLength(52)
    expect(game.players.every((p) => p.totalCommitted === 10)).toBe(true)
    expect(game.players.every((p) => p.chips === 990)).toBe(true)
    expect(game.pot).toBe(30)
    expect(game.stage).toBe('deal')
    expect(game.shuffle.serverSeedHash).toHaveLength(64)
    expect(game.shuffle.revealed).toBe(false)
  })

  it('rotates the dealer each hand', () => {
    let game = startHand(newGame(['A', 'B', 'C']))
    const first = game.dealerSeat
    game = settleHand(drive(game, alwaysFold))
    game = startHand(game)
    expect(game.dealerSeat).not.toBe(first)
  })

  it('deals the first card to the seat left of the dealer', () => {
    const game = startHand(newGame(['A', 'B', 'C']))
    expect(game.dealLeadSeat).toBe((game.dealerSeat + 1) % 3)
  })

  it('gives a fresh, unrevealed server seed on every hand', () => {
    let game = startHand(newGame(['A', 'B', 'C']))
    const hash1 = game.shuffle.serverSeedHash
    game = settleHand(drive(game, alwaysFold))
    game = startHand(game)
    expect(game.shuffle.serverSeedHash).not.toBe(hash1)
    expect(game.shuffle.revealed).toBe(false)
  })
})

// ------------------------------------------------------------------ dealing

describe('dealing', () => {
  it('deals one hole card plus four up cards to every player', () => {
    const game = drive(startHand(newGame(['A', 'B', 'C'])), checkCall)
    for (const player of game.players) {
      expect(player.cards).toHaveLength(5)
    }
  })

  it('deals round-robin, one card at a time', () => {
    let game = startHand(newGame(['A', 'B', 'C']))
    const lead = game.dealLeadSeat
    game = dealNextCard(game)
    expect(game.players[lead].cards).toHaveLength(1)
    expect(game.players.every((p) => p.cards.length <= 1)).toBe(true)

    game = dealNextCard(game)
    expect(game.players[(lead + 1) % 3].cards).toHaveLength(1)
  })

  it('uses 52 distinct cards with no repeats', () => {
    const game = drive(startHand(newGame(['A', 'B', 'C', 'D', 'E'])), checkCall)
    const dealt = game.players.flatMap((p) => p.cards.map(cardId))
    expect(dealt).toHaveLength(25)
    expect(new Set(dealt).size).toBe(25)
    expect(game.deckIndex).toBe(25 + game.burned.length)
  })

  it('burns one card before each of the later up-card rounds', () => {
    const game = drive(startHand(newGame(['A', 'B', 'C'])), checkCall)
    expect(game.burned).toHaveLength(3)
  })

  it('skips folded players when dealing later rounds', () => {
    const game = drive(startHand(newGame(['A', 'B', 'C'])), (state, seat) =>
      seat === 1 ? { type: 'fold' } : checkCall(state, seat),
    )
    expect(game.players[1].cards.length).toBeLessThan(5)
    expect(game.players[1].folded).toBe(true)
  })
})

// ------------------------------------------------------------------ betting

describe('betting', () => {
  it('opens with the highest visible card', () => {
    let game = startHand(newGame(['A', 'B', 'C']))
    while (game.stage === 'deal') game = dealNextCard(game)

    expect(game.stage).toBe('betting')
    const leader = game.players.reduce((best, p) =>
      evaluateHand(p.cards.slice(1)).ranks[0] > evaluateHand(best.cards.slice(1)).ranks[0] ? p : best,
    )
    expect(game.toActSeat).toBe(leader.seat)
  })

  it('sets the minimum opening bet from the street', () => {
    const game = newGame(['A', 'B'], 1000, { smallBet: 25, bigBet: 50 })
    expect(betUnit(game.config, 0)).toBe(25)
    expect(betUnit(game.config, 1)).toBe(25)
    expect(betUnit(game.config, 2)).toBe(50)
    expect(betUnit(game.config, 3)).toBe(50)
  })

  it('ends the round once everyone has matched', () => {
    let game = startHand(newGame(['A', 'B', 'C']))
    while (game.stage === 'deal') game = dealNextCard(game)
    const street = game.street
    const first = game.toActSeat!

    game = applyAction(game, first, { type: 'check' })
    // Still two players to speak.
    expect(game.stage).toBe('betting')
    expect(game.street).toBe(street)

    const second = game.toActSeat!
    game = applyAction(game, second, { type: 'check' })
    const third = game.toActSeat!
    game = applyAction(game, third, { type: 'check' })

    // Round closed, next street dealt.
    expect(game.street).toBe(street + 1)
  })

  it('rejects an out-of-turn or illegal action', () => {
    let game = startHand(newGame(['A', 'B', 'C']))
    while (game.stage === 'deal') game = dealNextCard(game)
    const actor = game.toActSeat!
    const other = (actor + 1) % 3

    expect(() => applyAction(game, other, { type: 'check' })).toThrow()
    expect(() => applyAction(game, actor, { type: 'call' })).toThrow() // nothing to call
  })

  it('forces a re-response after a full raise', () => {
    let game = startHand(newGame(['A', 'B', 'C']))
    while (game.stage === 'deal') game = dealNextCard(game)

    const order: number[] = []
    let guard = 0
    while (game.stage === 'betting' && guard++ < 10) {
      const seat = game.toActSeat!
      order.push(seat)
      const legal = legalActions(game, seat)
      game = applyAction(game, seat, legal.check ? { type: 'check' } : { type: 'call' })
    }
    // Everyone checks once and the round is over.
    expect(order).toHaveLength(3)

    // Same street, but with a bet and a raise: the opener must speak again.
    let raised = startHand(newGame(['A', 'B', 'C']))
    while (raised.stage === 'deal') raised = dealNextCard(raised)

    const speakers: number[] = []
    const opener = raised.toActSeat!
    raised = applyAction(raised, opener, { type: 'bet', amount: 100 })
    speakers.push(opener)

    const raiser = raised.toActSeat!
    raised = applyAction(raised, raiser, { type: 'raise', amount: 300 })
    speakers.push(raiser)

    guard = 0
    while (raised.stage === 'betting' && raised.street === 0 && guard++ < 10) {
      const seat = raised.toActSeat!
      speakers.push(seat)
      raised = applyAction(raised, seat, { type: 'call' })
    }

    // bet → raise → call → the opener calls the raise.
    expect(speakers).toHaveLength(4)
    expect(new Set(speakers).size).toBe(3)
    expect(speakers[3]).toBe(opener)
    expect(raised.players.every((p) => p.streetCommitted === 300)).toBe(true)
  })

  it('honours the raise cap in fixed-limit mode', () => {
    const config = { bettingMode: 'fixed-limit' as const, maxRaisesPerStreet: 2, smallBet: 20, bigBet: 40 }
    let game = startHand(newGame(['A', 'B'], 1000, config))
    while (game.stage === 'deal') game = dealNextCard(game)

    let raises = 0
    let guard = 0
    while (game.stage === 'betting' && game.street === 0 && guard++ < 12) {
      const seat = game.toActSeat!
      const legal = legalActions(game, seat)
      if (legal.raise && raises < 2) {
        raises++
        game = applyAction(game, seat, { type: 'raise', amount: legal.minRaiseTo })
      } else {
        expect(legal.raise).toBe(false)
        game = applyAction(game, seat, legal.check ? { type: 'check' } : { type: 'call' })
      }
    }
    expect(raises).toBe(2)
  })

  it('caps a fixed-limit raise at exactly one bet unit', () => {
    const config = { bettingMode: 'fixed-limit' as const, maxRaisesPerStreet: 0, smallBet: 20, bigBet: 40 }
    let game = startHand(newGame(['A', 'B'], 1000, config))
    while (game.stage === 'deal') game = dealNextCard(game)
    const seat = game.toActSeat!
    const legal = legalActions(game, seat)
    expect(legal.minRaiseTo).toBe(legal.maxRaiseTo)
    expect(legal.minRaiseTo).toBe(20)
  })
})

// ------------------------------------------------------------ chip integrity

describe('chip conservation', () => {
  it('never creates or destroys chips during a calling hand', () => {
    const start = newGame(['A', 'B', 'C'], 1000)
    const bank = start.players.length * 1000
    let game = startHand(start)

    for (let step = 0; step < 400; step++) {
      if (game.stage === 'handOver' || game.stage === 'gameOver') break
      // Chips in stacks plus chips in the middle must equal the buy-in.
      expect(totalChips(game)).toBe(bank)
      if (game.stage === 'deal') game = dealNextCard(game)
      else if (game.stage === 'showdown') game = settleHand(game)
      else if (game.stage === 'betting') {
        game = applyAction(game, game.toActSeat!, checkCall(game, game.toActSeat!))
      } else break
    }

    expect(game.stage).toBe('handOver')
    expect(game.players.reduce((sum, p) => sum + p.chips, 0)).toBe(bank)
  })

  it('conserves chips across 25 random hands with mixed policies', () => {
    let game = newGame(['A', 'B', 'C', 'D'], 400)
    const bank = 4 * 400

    for (let hand = 0; hand < 25 && game.stage !== 'gameOver'; hand++) {
      game = startHand(game)
      if (game.stage === 'gameOver') break
      game = drive(game, (state, seat) => {
        const legal = legalActions(state, seat)
        const roll = (state.revision * 31 + seat * 17 + state.handNo) % 11
        if (roll === 0 && legal.fold) return { type: 'fold' }
        if (roll === 1 && legal.raise) return { type: 'raise', amount: legal.minRaiseTo }
        if (roll === 2 && legal.allin) return { type: 'allin' }
        if (legal.check) return { type: 'check' }
        if (legal.call) return { type: 'call' }
        return { type: 'fold' }
      })
      expect(game.players.reduce((sum, p) => sum + p.chips, 0)).toBe(bank)
      expect(game.players.every((p) => p.chips >= 0)).toBe(true)
    }
  })
})

// ----------------------------------------------------------------- showdown

describe('showdown', () => {
  it('awards the whole pot when everyone else folds', () => {
    let game = startHand(newGame(['A', 'B', 'C']))
    // Only seat 1 stays in, so the hand ends with no showdown.
    game = drive(game, (state, seat) => (seat === 1 ? checkCall(state, seat) : alwaysFold()))

    expect(game.stage).toBe('handOver')
    expect(game.revealedSeats).toEqual([])
    expect(game.winners).toEqual([1])
    expect(game.players[0].chips).toBe(990)
    expect(game.players[2].chips).toBe(990)
    // The winner collects the 30-chip ante pot without showing a card.
    expect(game.players[1].chips).toBe(1020)
  })

  it('reveals the surviving hands when two or more reach the end', () => {
    const game = drive(startHand(newGame(['A', 'B'])), checkCall)
    expect(game.revealedSeats.sort()).toEqual([0, 1])
    expect(game.potResults.length).toBeGreaterThan(0)
  })

  it('gives the winner exactly the pot', () => {
    const game = drive(startHand(newGame(['A', 'B', 'C'])), checkCall)
    const winner = game.players.find((p) => p.seat === game.winners[0])!
    // Everyone checked all the way, so the pot is just the antes.
    expect(winner.chips).toBe(990 + 30)
  })

  it('settles a real side pot end to end', () => {
    let game = startHand(newGame(['short', 'mid', 'big'], 200))
    // Re-stack after the ante so the seats have 40 / 190 / 190 behind.
    game = {
      ...game,
      players: game.players.map((p) => ({
        ...p,
        chips: [40, 190, 190][p.seat],
        totalCommitted: 10,
      })),
      pot: 30,
    }
    const bank = 40 + 190 + 190 + 30

    game = drive(game, (state, seat) => {
      const legal = legalActions(state, seat)
      if (state.street === 0 && seat === 0) return { type: 'allin' }
      if (state.street === 1 && seat === 1 && state.players[1].streetCommitted === 0) {
        return { type: 'bet', amount: 100 }
      }
      if (legal.check) return { type: 'check' }
      if (legal.call) return { type: 'call' }
      return { type: 'fold' }
    })

    expect(game.stage).toBe('handOver')
    const contributions = game.players.map((p) => p.totalCommitted)
    expect(contributions).toEqual([50, 150, 150])

    // Main pot 150 (all three eligible) + side pot 200 (the two big stacks).
    expect(game.potResults.map((r) => r.amount)).toEqual([150, 200])
    expect(game.potResults[0].eligible).toEqual([0, 1, 2])
    expect(game.potResults[1].eligible).toEqual([1, 2])
    expect(game.players.reduce((sum, p) => sum + p.chips, 0)).toBe(bank)

    // The short stack can never win more than the 150 main pot.
    const shortWin = game.potResults.flatMap((r) => r.winners).filter((w) => w.seat === 0)
    expect(shortWin.reduce((sum, w) => sum + w.amount, 0)).toBeLessThanOrEqual(150)
  })

  it('marks busted players out and ends the session', () => {
    let game = newGame(['A', 'B'], 100)
    game = startHand(game)
    // Both players shove; the loser is left with nothing.
    game = drive(game, (state, seat) => {
      const legal = legalActions(state, seat)
      if (legal.allin) return { type: 'allin' }
      return checkCall(state, seat)
    })
    expect(game.players.some((p) => p.outOfGame)).toBe(true)
    expect(game.stage).toBe('gameOver')
  })

  it('reveals the shuffle seed once the hand is settled', () => {
    const game = drive(startHand(newGame(['A', 'B'])), checkCall)
    expect(game.shuffle.revealed).toBe(true)
    expect(game.shuffle.serverSeed.length).toBeGreaterThan(0)
  })
})

// -------------------------------------------------------------- edge cases

describe('short stacks and session flow', () => {
  it('lets a player who cannot cover the ante play all-in for less', () => {
    // Cut the stack to 4 *before* the hand starts, so the 10-chip ante can only
    // be posted in part.
    const base = newGame(['tiny', 'big'], 1000)
    const rigged: GameState = {
      ...base,
      players: base.players.map((p) => (p.seat === 0 ? { ...p, chips: 4 } : p)),
    }
    let game = startHand(rigged)

    expect(game.players[0].chips).toBe(0)
    expect(game.players[0].totalCommitted).toBe(4)
    expect(game.players[0].allIn).toBe(true)

    game = drive(game, checkCall)
    expect(game.stage === 'handOver' || game.stage === 'gameOver').toBe(true)

    // The short stack put in 4, so the main pot it can win holds 4 from each
    // contributor — never the full pot.
    const tinyWin = game.potResults.flatMap((r) => r.winners).filter((w) => w.seat === 0)
    expect(tinyWin.reduce((sum, w) => sum + w.amount, 0)).toBeLessThanOrEqual(8)
  })

  it('still deals five cards to a player who is all-in from the ante', () => {
    const base = newGame(['tiny', 'big'], 1000)
    const rigged: GameState = {
      ...base,
      players: base.players.map((p) => (p.seat === 0 ? { ...p, chips: 4 } : p)),
    }
    const finished = drive(startHand(rigged), checkCall)
    expect(finished.players[0].cards).toHaveLength(5)
    expect(finished.players[0].folded).toBe(false)
  })

  it('skips busted players when rotating the dealer', () => {
    let game = newGame(['A', 'B', 'C'], 200)
    game = startHand(game)
    // Bust seat 1 between hands.
    const busted: GameState = {
      ...game,
      players: game.players.map((p) => (p.seat === 1 ? { ...p, chips: 0, outOfGame: true } : p)),
      dealerSeat: 0,
    }
    const next = startHand(busted)
    expect(next.dealerSeat).not.toBe(1)
    expect(next.players[1].cards).toHaveLength(0)
    expect(next.players[1].totalCommitted).toBe(0)
  })

  it('does not deal to players who are out of the session', () => {
    let game = newGame(['A', 'B', 'C'], 200)
    game = startHand(game)
    const twoLeft: GameState = {
      ...game,
      players: game.players.map((p) => (p.seat === 2 ? { ...p, chips: 0, outOfGame: true } : p)),
    }
    const next = startHand(twoLeft)
    expect(next.players[2].totalCommitted).toBe(0)
    // Only the two live players pay the ante.
    expect(next.pot).toBe(20)
    const dealt = drive(next, checkCall)
    expect(dealt.players[2].cards).toHaveLength(0)
  })

  it('ends the session when only one player has chips left', () => {
    let game = newGame(['A', 'B'], 100)
    game = startHand(game)
    game = drive(game, (state, seat) => {
      const legal = legalActions(state, seat)
      return legal.allin ? { type: 'allin' } : checkCall(state, seat)
    })
    expect(game.stage).toBe('gameOver')
    expect(startHand(game).stage).toBe('gameOver')
  })
})

// ------------------------------------------------------------------ autoStep

describe('autoStep', () => {
  it('reports dealing, then waiting, then settling', () => {
    const game = startHand(newGame(['A', 'B']))
    expect(autoStep(game)).toMatchObject({ kind: 'deal', round: 0 })

    const betting = (() => {
      let g = game
      while (g.stage === 'deal') g = dealNextCard(g)
      return g
    })()
    expect(autoStep(betting)).toMatchObject({ kind: 'bot', seat: betting.toActSeat })
  })

  it('never reports an actor when nobody can act', () => {
    const game = drive(startHand(newGame(['A', 'B'])), checkCall)
    expect(autoStep(game).kind).toBe('idle')
  })
})
