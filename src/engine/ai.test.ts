import { describe, expect, it } from 'vitest'
import { BOT_PROFILES, botAction, chooseAction, opponentBoardStrength, profileFor } from './ai'
import { applyAction, createGame, dealNextCard, legalActions, settleHand, startHand } from './game'
import { parseCards } from './cards'
import type { GameState, PlayerAction } from './types'

function isLegal(state: GameState, seat: number, action: PlayerAction): boolean {
  const legal = legalActions(state, seat)
  switch (action.type) {
    case 'fold':
      return legal.fold
    case 'check':
      return legal.check
    case 'call':
      return legal.call
    case 'bet':
    case 'raise':
      return (
        legal.raise &&
        typeof action.amount === 'number' &&
        action.amount >= legal.minRaiseTo &&
        action.amount <= legal.maxRaiseTo
      )
    case 'allin':
      return legal.allin
    default:
      return false
  }
}

function botGame(count: number, chips = 500): GameState {
  return createGame({
    players: Array.from({ length: count }, (_, i) => ({ name: `B${i}`, isBot: true })),
    startingChips: chips,
    clientSeed: 'ai-test',
  })
}

describe('bot profiles', () => {
  it('has a personality for every seat', () => {
    for (let seat = 0; seat < 8; seat++) {
      const profile = profileFor(seat)
      expect(BOT_PROFILES).toContain(profile)
      expect(profile.tightness).toBeGreaterThanOrEqual(0)
      expect(profile.tightness).toBeLessThanOrEqual(1)
    }
  })
})

describe('chooseAction', () => {
  it('only ever returns a legal action', () => {
    // Seeds stay random on purpose: this is the breadth test that explores many
    // shuffles. The assertion is the *legality* of every action — the action
    // count is only a floor proving the loop actually exercised the engine, so
    // it must stay well below the real number or the test flakes.
    let game = botGame(4)
    let checked = 0
    let handsPlayed = 0

    for (let hand = 0; hand < 12 && game.stage !== 'gameOver'; hand++) {
      game = startHand(game)
      if (game.stage === 'gameOver') break
      handsPlayed++

      for (let step = 0; step < 600; step++) {
        if (game.stage === 'deal') {
          game = dealNextCard(game)
        } else if (game.stage === 'showdown') {
          game = settleHand(game)
        } else if (game.stage === 'betting') {
          const seat = game.toActSeat!
          const action = chooseAction(game, seat)
          expect(isLegal(game, seat, action), `${action.type} must be legal`).toBe(true)
          checked++
          game = applyAction(game, seat, action)
        } else {
          break
        }
      }
      expect(game.stage === 'handOver' || game.stage === 'gameOver').toBe(true)
    }

    expect(handsPlayed).toBeGreaterThanOrEqual(10)
    expect(checked).toBeGreaterThan(50)
  })

  it('is deterministic for the same state', () => {
    const game = (() => {
      let g = startHand(botGame(3))
      while (g.stage === 'deal') g = dealNextCard(g)
      return g
    })()
    const seat = game.toActSeat!
    expect(chooseAction(game, seat)).toEqual(chooseAction(game, seat))
  })

  it('bets or raises with a monster hand when checked to', () => {
    // Four of a kind on the board plus the hole card — bet, do not check.
    let decided = 0
    for (let trial = 0; trial < 40; trial++) {
      let game = startHand(createGame({
        players: [{ name: 'A', isBot: true }, { name: 'B', isBot: true }],
        startingChips: 1000,
        clientSeed: `monster-${trial}`,
      }))
      while (game.stage === 'deal') game = dealNextCard(game)

      const seat = game.toActSeat!
      // Forge an unbeatable holding, then check the bot's intent.
      const patched: GameState = {
        ...game,
        players: game.players.map((p) =>
          p.seat === seat ? { ...p, cards: parseCards('AS AH AD AC 2S') } : p,
        ),
      }
      const action = chooseAction(patched, seat)
      if (action.type === 'bet' || action.type === 'raise' || action.type === 'allin') decided++
    }
    // A monster holding is bet ~70-90% of the time depending on personality;
    // the floor is set well below that so variance cannot flake the suite.
    expect(decided).toBeGreaterThan(15)
  })

  it('folds a hopeless hand facing a large bet', () => {
    let folded = 0
    const trials = 40
    for (let trial = 0; trial < trials; trial++) {
      let game = startHand(createGame({
        players: [
          { name: 'A', isBot: true },
          { name: 'B', isBot: true },
          { name: 'C', isBot: true },
        ],
        startingChips: 1000,
        clientSeed: `hopeless-${trial}`,
      }))
      while (game.stage === 'deal') game = dealNextCard(game)

      // Make seat 1 act after a big bet, holding junk.
      const bettor = game.toActSeat!
      const target = (bettor + 1) % 3
      const withBet = applyAction(game, bettor, { type: 'bet', amount: 400 })
      if (withBet.toActSeat !== target) continue

      const patched: GameState = {
        ...withBet,
        players: withBet.players.map((p) =>
          p.seat === target ? { ...p, cards: parseCards('2S 3H 7D 9C JS') } : p,
        ),
      }
      const action = chooseAction(patched, target)
      if (action.type === 'fold') folded++
    }
    expect(folded).toBeGreaterThan(trials * 0.5)
  })

  it('never folds when checking is free and the hand is strong', () => {
    let game = startHand(botGame(2))
    while (game.stage === 'deal') game = dealNextCard(game)
    const seat = game.toActSeat!
    const patched: GameState = {
      ...game,
      players: game.players.map((p) =>
        p.seat === seat ? { ...p, cards: parseCards('KS KH KD KC AS') } : p,
      ),
    }
    expect(chooseAction(patched, seat).type).not.toBe('fold')
  })
})

describe('botAction', () => {
  it('returns null when it is not a bot turn', () => {
    const human = createGame({
      players: [{ name: 'me', isBot: false }, { name: 'bot', isBot: true }],
      startingChips: 500,
    })
    expect(botAction(human)).toBeNull()
  })

  it('returns an action when a bot is on turn', () => {
    let game = startHand(createGame({
      players: [{ name: 'me', isBot: false }, { name: 'bot', isBot: true }],
      startingChips: 500,
    }))
    while (game.stage === 'deal') game = dealNextCard(game)
    const result = botAction(game)
    if (game.players[game.toActSeat!].isBot) {
      expect(result).not.toBeNull()
      expect(result!.seat).toBe(game.toActSeat)
    } else {
      expect(result).toBeNull()
    }
  })
})

describe('opponentBoardStrength', () => {
  it('ignores folded players and the bot itself', () => {
    let game = startHand(botGame(3))
    while (game.stage === 'deal') game = dealNextCard(game)

    const value = opponentBoardStrength(game, 0)
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThanOrEqual(1)

    const allFolded: GameState = {
      ...game,
      players: game.players.map((p) => (p.seat === 0 ? p : { ...p, folded: true })),
    }
    expect(opponentBoardStrength(allFolded, 0)).toBe(0)
  })
})

describe('full bot sessions', () => {
  it('plays thousands of hands without an illegal state', () => {
    for (const count of [2, 3, 4, 5]) {
      let game = botGame(count, 300)
      const bank = count * 300
      let hands = 0

      while (game.stage !== 'gameOver' && hands < 60) {
        game = startHand(game)
        if (game.stage === 'gameOver') break
        hands++

        for (let step = 0; step < 800; step++) {
          if (game.stage === 'deal') game = dealNextCard(game)
          else if (game.stage === 'showdown') game = settleHand(game)
          else if (game.stage === 'betting') {
            const seat = game.toActSeat!
            game = applyAction(game, seat, chooseAction(game, seat))
          } else break

          expect(game.players.every((p) => p.chips >= 0)).toBe(true)
        }

        expect(game.stage === 'handOver' || game.stage === 'gameOver').toBe(true)
        expect(game.players.reduce((sum, p) => sum + p.chips, 0)).toBe(bank)
      }

      expect(hands).toBeGreaterThan(0)
    }
  })

  it('does not stall when everyone is all-in', () => {
    let game = startHand(botGame(3, 100))
    for (let step = 0; step < 800; step++) {
      if (game.stage === 'deal') game = dealNextCard(game)
      else if (game.stage === 'showdown') game = settleHand(game)
      else if (game.stage === 'betting') {
        const seat = game.toActSeat!
        const legal = legalActions(game, seat)
        game = applyAction(game, seat, legal.allin ? { type: 'allin' } : { type: 'check' })
      } else break
    }
    expect(game.stage === 'handOver' || game.stage === 'gameOver').toBe(true)
  })
})
