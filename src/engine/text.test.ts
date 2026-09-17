import { describe, expect, it } from 'vitest'
import { cardText } from './cards'
import { evaluateHand } from './evaluator'
import { applyAction, createGame, dealNextCard, legalActions, settleHand, startHand } from './game'
import {
  displayWidth,
  exportStateJSON,
  renderCompactText,
  renderSummaryText,
  renderTableText,
} from './text'
import type { GameState, PlayerAction } from './types'

function newGame(names: string[], chips = 1000): GameState {
  return createGame({
    players: names.map((name) => ({ name, isBot: true })),
    startingChips: chips,
    serverSeed: 'text-seed',
    clientSeed: 'client',
  })
}

function toBetting(state: GameState): GameState {
  let game = state
  while (game.stage === 'deal') game = dealNextCard(game)
  return game
}

function drive(state: GameState, decide: (s: GameState, seat: number) => PlayerAction): GameState {
  let current = state
  for (let i = 0; i < 2000; i++) {
    if (current.stage === 'deal') current = dealNextCard(current)
    else if (current.stage === 'showdown') current = settleHand(current)
    else if (current.stage === 'betting') {
      current = applyAction(current, current.toActSeat!, decide(current, current.toActSeat!))
    } else return current
  }
  throw new Error('runaway')
}

const checkCall = (s: GameState, seat: number): PlayerAction => {
  const legal = legalActions(s, seat)
  if (legal.check) return { type: 'check' }
  if (legal.call) return { type: 'call' }
  return { type: 'fold' }
}

describe('displayWidth', () => {
  it('counts CJK as two columns', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('阿明')).toBe(4)
    expect(displayWidth('阿明 ab')).toBe(7)
    expect(displayWidth('')).toBe(0)
  })

  it('counts suit symbols and card text as narrow', () => {
    expect(displayWidth('A♠')).toBe(2)
    expect(displayWidth('10♦')).toBe(3)
  })
})

describe('renderTableText — perspective isolation', () => {
  it("shows the perspective player's hole card and hides everyone else's", () => {
    const game = toBetting(startHand(newGame(['阿明', '小李', '白鲨'])))
    const text = renderTableText(game, { perspective: 0 })

    expect(text).toContain(cardText(game.players[0].cards[0]))
    for (const seat of [1, 2]) {
      const hidden = cardText(game.players[seat].cards[0])
      expect(text).not.toContain(hidden)
    }
    // Everyone's up cards stay public.
    for (const player of game.players) {
      for (const card of player.cards.slice(1)) {
        expect(text).toContain(cardText(card))
      }
    }
  })

  it('hides every hole card from a spectator', () => {
    const game = toBetting(startHand(newGame(['阿明', '小李', '白鲨'])))
    const text = renderTableText(game, { perspective: null })
    for (const player of game.players) {
      expect(text).not.toContain(cardText(player.cards[0]))
    }
    expect(text).toContain('观战者')
  })

  it('reveals showdown hands to everyone', () => {
    const game = drive(startHand(newGame(['A', 'B'])), checkCall)
    const text = renderTableText(game, { perspective: null })
    for (const seat of game.revealedSeats) {
      expect(text).toContain(cardText(game.players[seat].cards[0]))
    }
  })

  it('masks the hole card of a player who folded even at the end', () => {
    const game = drive(startHand(newGame(['A', 'B', 'C'])), (s, seat) =>
      seat === 2 ? { type: 'fold' } : checkCall(s, seat),
    )
    const text = renderTableText(game, { perspective: 0 })
    expect(text).not.toContain(cardText(game.players[2].cards[0]))
  })

  it('keeps the seat-to-perspective mapping consistent for every seat', () => {
    const game = toBetting(startHand(newGame(['A', 'B', 'C', 'D'])))
    for (const seat of [0, 1, 2, 3]) {
      const text = renderTableText(game, { perspective: seat })
      expect(text).toContain(cardText(game.players[seat].cards[0]))
      for (const other of [0, 1, 2, 3]) {
        if (other === seat) continue
        expect(text).not.toContain(cardText(game.players[other].cards[0]))
      }
    }
  })
})

describe('renderTableText — content', () => {
  const game = toBetting(startHand(newGame(['阿明', '小李', '白鲨'])))

  it('includes the core sections', () => {
    const text = renderTableText(game, { perspective: 0 })
    for (const section of ['牌局设置', '座位与筹码', '底池', '你的牌', '行动信息', '本手记录', '洗牌公正性']) {
      expect(text).toContain(section)
    }
  })

  it('names the perspective player and marks them', () => {
    const text = renderTableText(game, { perspective: 1 })
    expect(text).toContain('视角：小李（座位 1）')
    expect(text).toContain('小李（你）')
  })

  it('lists legal actions only for the player on turn', () => {
    const actor = game.toActSeat!
    const mine = renderTableText(game, { perspective: actor })
    const theirs = renderTableText(game, { perspective: (actor + 1) % 3 })
    expect(mine).toContain('可用动作')
    expect(mine).toContain('fold')
    expect(theirs).toContain('（不是你的回合）')
    expect(theirs).not.toContain('可用动作')
  })

  it('reports the amount needed to call', () => {
    let raised = game
    const opener = raised.toActSeat!
    raised = applyAction(raised, opener, { type: 'bet', amount: 100 })
    const caller = raised.toActSeat!
    const text = renderTableText(raised, { perspective: caller })
    expect(text).toContain('需跟注 100')
  })

  it('can omit the history, hints and proof', () => {
    const text = renderTableText(game, {
      perspective: 0,
      includeHistory: false,
      includeHints: false,
      includeProof: false,
    })
    expect(text).not.toContain('本手记录')
    expect(text).not.toContain('洗牌公正性')
    expect(text).toContain('底池')
  })

  it('publishes the commitment but not the seed while the hand runs', () => {
    const text = renderTableText(game, { perspective: 0 })
    expect(text).toContain(game.shuffle.serverSeedHash)
    expect(text).not.toContain(game.shuffle.serverSeed)
  })

  it('publishes the seed after the hand', () => {
    const settled = drive(startHand(newGame(['A', 'B'])), checkCall)
    const text = renderTableText(settled, { perspective: 0 })
    expect(text).toContain(settled.shuffle.serverSeed)
  })

  it('renders every stage without throwing', () => {
    let g = startHand(newGame(['A', 'B', 'C'], 300))
    for (let i = 0; i < 200; i++) {
      expect(() => renderTableText(g, { perspective: 0 })).not.toThrow()
      if (g.stage === 'deal') g = dealNextCard(g)
      else if (g.stage === 'showdown') g = settleHand(g)
      else if (g.stage === 'betting') g = applyAction(g, g.toActSeat!, checkCall(g, g.toActSeat!))
      else break
    }
  })

  it('renders the idle game', () => {
    expect(() => renderTableText(newGame(['A', 'B']), { perspective: 0 })).not.toThrow()
  })

  it('ends with exactly one newline', () => {
    const text = renderTableText(game, { perspective: 0 })
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })
})

describe('renderSummaryText — one row per player', () => {
  const game = toBetting(startHand(newGame(['阿明', '小李', '白鲨'])))

  it('lists chips, bets, cards, hand type and status for every seat', () => {
    const text = renderSummaryText(game, 0)
    for (const heading of ['筹码', '本轮', '累计', '明牌', '底牌', '牌型', '状态']) {
      expect(text).toContain(heading)
    }
    for (const player of game.players) {
      expect(text).toContain(player.name)
    }
  })

  it('reports the made hand for the perspective player but only the board for others', () => {
    const text = renderSummaryText(game, 0)
    // Own hand is fully known…
    expect(text).toContain(evaluateHand(game.players[0].cards).label)
    // …opponents are explicitly marked as board-only.
    expect(text).toContain('（明牌）')
  })

  it('masks other hole cards but shows the perspective player own', () => {
    const text = renderSummaryText(game, 0)
    expect(text).toContain(cardText(game.players[0].cards[0]))
    for (const seat of [1, 2]) {
      expect(text).not.toContain(cardText(game.players[seat].cards[0]))
    }
    expect(text).toContain('★')
  })

  it('hides every hole card from a spectator', () => {
    const text = renderSummaryText(game, null)
    for (const player of game.players) {
      expect(text).not.toContain(cardText(player.cards[0]))
    }
    expect(text).toContain('观战者')
  })

  it('shows all hole cards once they are revealed', () => {
    const settled = drive(startHand(newGame(['A', 'B'])), checkCall)
    const text = renderSummaryText(settled, null)
    for (const seat of settled.revealedSeats) {
      expect(text).toContain(cardText(settled.players[seat].cards[0]))
    }
    expect(text).toContain('★亮牌')
  })

  it('includes the to-act line with the call amount', () => {
    let raised = game
    const opener = raised.toActSeat!
    raised = applyAction(raised, opener, { type: 'bet', amount: 100 })
    const caller = raised.toActSeat!
    const text = renderSummaryText(raised, caller)
    expect(text).toContain('需跟注 100')
    expect(text).toContain('轮到：')
  })

  it('keeps the table structure aligned', () => {
    const lines = renderSummaryText(game, 0).split('\n')
    const headerIndex = lines.findIndex((line) => line.startsWith('座位'))
    expect(headerIndex).toBeGreaterThan(-1)

    const header = lines[headerIndex]
    const rule = lines[headerIndex + 1]
    const rows = lines.slice(headerIndex + 2, headerIndex + 2 + game.players.length)

    expect(rows).toHaveLength(game.players.length)
    // The ─ rule must exactly underline the header, CJK widths included.
    expect(displayWidth(rule)).toBe(displayWidth(header))
    // Header and every data row must expose the same number of columns.
    const headerColumns = header.split(/\s{2,}/).length
    expect(headerColumns).toBeGreaterThanOrEqual(8)
    for (const row of rows) {
      expect(row.split(/\s{2,}/).length).toBe(headerColumns)
    }
  })

  it('is valid for every stage', () => {
    let g = startHand(newGame(['A', 'B', 'C'], 250))
    for (let i = 0; i < 200; i++) {
      expect(() => renderSummaryText(g, 0)).not.toThrow()
      expect(renderSummaryText(g, 0).length).toBeGreaterThan(0)
      if (g.stage === 'deal') g = dealNextCard(g)
      else if (g.stage === 'showdown') g = settleHand(g)
      else if (g.stage === 'betting') g = applyAction(g, g.toActSeat!, checkCall(g, g.toActSeat!))
      else break
    }
  })
})

describe('renderCompactText', () => {  it('fits the whole table onto a few lines and still hides hole cards', () => {
    const game = toBetting(startHand(newGame(['阿明', '小李', '白鲨'])))
    const text = renderCompactText(game, 0)
    expect(text.split('\n').length).toBeLessThanOrEqual(6)
    expect(text).toContain(cardText(game.players[0].cards[0]))
    expect(text).not.toContain(cardText(game.players[1].cards[0]))
  })
})

describe('exportStateJSON', () => {
  it('nulls out hole cards the perspective may not see', () => {
    const game = toBetting(startHand(newGame(['A', 'B', 'C'])))
    const payload = JSON.parse(exportStateJSON(game, 0))
    expect(payload.players[0].holeCard).not.toBeNull()
    expect(payload.players[1].holeCard).toBeNull()
    expect(payload.players[1].upCards).toHaveLength(1)
    expect(payload.perspective).toBe(0)
  })

  it('exposes legal actions only when it is the perspective player turn', () => {
    const game = toBetting(startHand(newGame(['A', 'B'])))
    const actor = game.toActSeat!
    const mine = JSON.parse(exportStateJSON(game, actor))
    const theirs = JSON.parse(exportStateJSON(game, (actor + 1) % 2))
    expect(mine.legalActions).not.toBeNull()
    expect(theirs.legalActions).toBeNull()
  })

  it('is valid JSON for every stage', () => {
    let g = startHand(newGame(['A', 'B'], 200))
    for (let i = 0; i < 200; i++) {
      expect(() => JSON.parse(exportStateJSON(g, 0))).not.toThrow()
      if (g.stage === 'deal') g = dealNextCard(g)
      else if (g.stage === 'showdown') g = settleHand(g)
      else if (g.stage === 'betting') g = applyAction(g, g.toActSeat!, checkCall(g, g.toActSeat!))
      else break
    }
  })
})
