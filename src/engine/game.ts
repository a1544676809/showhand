import { buildShuffledDeck, cardsText } from './cards'
import { evaluateHand } from './evaluator'
import { buildPots, resolvePots, MAIN_POT_LABEL, type Pot } from './pots'
import { newClientSeed, newServerSeed } from './rng'
import {
  type ActionType,
  type Card,
  type GameConfig,
  type GameState,
  type LegalActions,
  type LogEntry,
  type PlayerAction,
  type PlayerState,
} from './types'

// --------------------------------------------------------------- constants

export const DEFAULT_CONFIG: GameConfig = {
  ante: 10,
  smallBet: 20,
  bigBet: 40,
  maxRaisesPerStreet: 0,
  bettingMode: 'no-limit',
  deckSize: 52,
}

/** Maximum bets allowed before the cap closes the action (fixed-limit). */
export const FIXED_LIMIT_RAISE_CAP = 4

export const MAX_PLAYERS = 5
export const MIN_PLAYERS = 2

/** The four betting rounds: units double on the last two streets. */
export function betUnit(config: GameConfig, street: number): number {
  return street < 2 ? config.smallBet : config.bigBet
}

export function totalPot(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.totalCommitted, 0)
}

// ------------------------------------------------------------------ helpers

/** Deep-enough clone so every reducer can mutate its copy freely. */
function draft(state: GameState): GameState {
  return {
    ...state,
    config: { ...state.config },
    shuffle: { ...state.shuffle },
    players: state.players.map((p) => ({ ...p, cards: p.cards.slice() })),
    deck: state.deck.slice(),
    burned: state.burned.slice(),
    log: state.log.slice(),
    potResults: state.potResults.map((r) => ({ ...r, winners: r.winners.map((w) => ({ ...w })) })),
    revealedSeats: state.revealedSeats.slice(),
    winners: state.winners.slice(),
  }
}

function pushLog(
  state: GameState,
  kind: LogEntry['kind'],
  text: string,
  seat?: number,
): void {
  state.log.push({ hand: state.handNo, street: state.street, kind, text, seat })
  if (state.log.length > 800) state.log.splice(0, state.log.length - 800)
}

const inHand = (p: PlayerState): boolean => !p.outOfGame && !p.folded
const canAct = (p: PlayerState): boolean => inHand(p) && !p.allIn

/** Next in-game seat strictly after `seat` (wrapping). */
function seatAfter(state: GameState, seat: number, predicate: (p: PlayerState) => boolean): number | null {
  const n = state.players.length
  for (let i = 1; i <= n; i++) {
    const s = (seat + i) % n
    if (predicate(state.players[s])) return s
  }
  return null
}

/** Highest visible board among players still contesting — deals and acts lead here. */
export function highestBoardSeat(state: GameState): number | null {
  let best: { seat: number; score: number; key: number[] } | null = null
  for (const p of state.players) {
    if (!inHand(p) || p.cards.length < 2) continue
    const value = evaluateHand(p.cards.slice(1))
    const key = [...value.ranks, ...value.suits.map((s) => s + 100)]
    if (
      !best ||
      value.category > best.score ||
      (value.category === best.score && lexGreater(key, best.key))
    ) {
      best = { seat: p.seat, score: value.category, key }
    }
  }
  return best ? best.seat : null
}

function lexGreater(a: readonly number[], b: readonly number[]): boolean {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1
    const y = b[i] ?? -1
    if (x !== y) return x > y
  }
  return false
}

/** Who must speak first this street — highest board that can still act. */
export function firstToActSeat(state: GameState): number | null {
  let best: { seat: number; score: number; key: number[] } | null = null
  for (const p of state.players) {
    if (!canAct(p) || p.cards.length < 2) continue
    const value = evaluateHand(p.cards.slice(1))
    const key = [...value.ranks, ...value.suits.map((s) => s + 100)]
    if (
      !best ||
      value.category > best.score ||
      (value.category === best.score && lexGreater(key, best.key))
    ) {
      best = { seat: p.seat, score: value.category, key }
    }
  }
  return best ? best.seat : null
}

/** Seats receiving a card in the deal round currently in progress. */
export function currentDealOrder(state: GameState): number[] {
  const n = state.players.length
  const order: number[] = []
  for (let i = 0; i < n; i++) {
    const s = (state.dealLeadSeat + i) % n
    const p = state.players[s]
    if (p.outOfGame || p.folded) continue
    order.push(s)
  }
  return order
}

function drawCard(state: GameState): Card {
  if (state.deckIndex >= state.deck.length) {
    throw new Error('Deck exhausted — more players than the deck can serve')
  }
  return state.deck[state.deckIndex++]
}

// ------------------------------------------------------------ game creation

export interface PlayerSetup {
  name: string
  isBot: boolean
  /** Optional per-seat buy-in; falls back to `CreateGameOptions.startingChips`. */
  chips?: number
  /** Optional stable identity used by the UI's bankroll persistence. */
  playerId?: string
}

export interface CreateGameOptions {
  players: PlayerSetup[]
  startingChips: number
  config?: Partial<GameConfig>
  clientSeed?: string
  /** Fix the server seed for reproducible hands (tests, replays). */
  serverSeed?: string
  dealerSeat?: number
}

export function createGame(options: CreateGameOptions): GameState {
  const players = options.players.map<PlayerState>((p, index) => ({
    id: `p${index}`,
    playerId: p.playerId ?? '',
    name: p.name,
    isBot: p.isBot,
    seat: index,
    chips: p.chips ?? options.startingChips,
    cards: [],
    folded: false,
    allIn: false,
    outOfGame: false,
    streetCommitted: 0,
    totalCommitted: 0,
    hasActedThisStreet: false,
    lastActionLabel: null,
    lastWin: 0,
  }))

  return {
    config: { ...DEFAULT_CONFIG, ...options.config },
    players,
    deck: [],
    deckIndex: 0,
    burned: [],
    handNo: 0,
    // Dealer rotates on the first startHand, so seed it one seat "behind".
    dealerSeat: options.dealerSeat ?? players.length - 1,
    stage: 'idle',
    street: -1,
    dealRound: 0,
    dealCursor: 0,
    dealLeadSeat: 0,
    toActSeat: null,
    currentBet: 0,
    lastRaiseSize: 0,
    raiseCount: 0,
    lastAggressorSeat: null,
    pot: 0,
    potResults: [],
    revealedSeats: [],
    winners: [],
    log: [],
    shuffle: {
      serverSeed: '',
      serverSeedHash: '',
      clientSeed: options.clientSeed ?? '',
      combinedHash: '',
      revealed: false,
    },
    seedOverride: options.serverSeed ?? null,
    revision: 0,
  }
}

/** Convenience wrapper for the "N bots" quick-start used by the setup screen. */
export function createBotGame(botCount: number, startingChips = 1000): GameState {
  const names = ['电脑·白鲨', '电脑·老K', '电脑·铁支', '电脑·同花']
  const players: PlayerSetup[] = [{ name: '你', isBot: false }]
  for (let i = 0; i < botCount; i++) {
    players.push({ name: names[i % names.length], isBot: true })
  }
  return createGame({ players, startingChips, clientSeed: newClientSeed() })
}

// ------------------------------------------------------------------- dealing

export function startHand(state: GameState): GameState {
  const next = draft(state)

  const contenders = next.players.filter((p) => !p.outOfGame && p.chips > 0)
  if (contenders.length < MIN_PLAYERS) {
    next.stage = 'gameOver'
    pushLog(next, 'info', '牌局结束：不足两名玩家仍有筹码。')
    next.revision++
    return next
  }

  // Anyone who cannot cover the ante is out of the session.
  for (const p of next.players) {
    if (!p.outOfGame && p.chips <= 0) {
      p.outOfGame = true
      pushLog(next, 'info', `${p.name} 筹码耗尽，退出牌局。`, p.seat)
    }
  }

  const dealer = seatAfter(next, next.dealerSeat, (p) => !p.outOfGame)
  if (dealer === null) {
    next.stage = 'gameOver'
    next.revision++
    return next
  }
  next.dealerSeat = dealer

  next.handNo += 1
  next.street = -1
  next.stage = 'deal'
  next.dealRound = 0
  next.dealCursor = 0
  next.toActSeat = null
  next.currentBet = 0
  next.raiseCount = 0
  next.lastAggressorSeat = null
  next.potResults = []
  next.revealedSeats = []
  next.winners = []
  next.burned = []
  next.deckIndex = 0

  for (const p of next.players) {
    p.cards = []
    p.folded = p.outOfGame
    p.allIn = false
    p.streetCommitted = 0
    p.totalCommitted = 0
    p.hasActedThisStreet = false
    p.lastActionLabel = null
    p.lastWin = 0
  }

  const serverSeed = next.seedOverride
    ? `${next.seedOverride}#${next.handNo}`
    : newServerSeed()
  const clientSeed = next.shuffle.clientSeed || newClientSeed()
  const { deck, proof } = buildShuffledDeck(serverSeed, clientSeed, next.config.deckSize)
  next.deck = deck
  next.shuffle = proof

  pushLog(next, 'info', `—— 第 ${next.handNo} 手 · 庄家座位 ${dealer} ——`)

  // 底注
  for (const p of next.players) {
    if (p.outOfGame) continue
    const posted = Math.min(next.config.ante, p.chips)
    if (posted > 0) {
      p.chips -= posted
      p.totalCommitted += posted
      if (p.chips === 0) p.allIn = true
    }
  }
  next.pot = totalPot(next)
  pushLog(next, 'ante', `底注 ${next.config.ante}：每人投入 ${next.config.ante}，底池 ${next.pot}`)

  const lead = seatAfter(next, dealer, (p) => !p.outOfGame)
  next.dealLeadSeat = lead ?? dealer

  next.revision++
  return next
}

/** Deals exactly one card and advances the round when the round completes. */
export function dealNextCard(state: GameState): GameState {
  if (state.stage !== 'deal') return state
  const next = draft(state)
  const order = currentDealOrder(next)
  const roundLabel = next.dealRound === 0 ? '底牌' : `第 ${next.dealRound + 1} 张明牌`

  if (next.dealCursor === 0) {
    pushLog(next, 'deal', `发${roundLabel}`)
  }

  if (next.dealCursor < order.length) {
    const seat = order[next.dealCursor]
    const card = drawCard(next)
    next.players[seat].cards.push(card)
    next.dealCursor += 1
    next.revision++
    return next
  }

  // Round finished — either move on to the next deal round or open betting.
  if (next.dealRound === 0) {
    next.dealRound = 1
    next.dealCursor = 0
    const lead = seatAfter(next, next.dealerSeat, (p) => !p.outOfGame)
    next.dealLeadSeat = lead ?? next.dealerSeat
    next.revision++
    return next
  }

  return beginBetting(next, next.dealRound - 1)
}

function beginBetting(state: GameState, street: number): GameState {
  const next = draft(state)
  next.street = street
  next.currentBet = 0
  next.raiseCount = 0
  next.lastAggressorSeat = null
  next.lastRaiseSize = betUnit(next.config, street)
  next.pot = totalPot(next)

  for (const p of next.players) {
    p.streetCommitted = 0
    p.hasActedThisStreet = false
  }

  const first = firstToActSeat(next)
  if (first === null) {
    // Everyone still in is all-in — run the remaining cards out.
    pushLog(next, 'street', `第 ${street + 1} 轮：所有玩家已全下，直接发完剩余牌。`)
    return advanceAfterBetting(next)
  }

  next.toActSeat = first
  next.stage = 'betting'
  const names = { 0: '第 1 轮', 1: '第 2 轮', 2: '第 3 轮', 3: '第 4 轮（最后一轮）' }[street]
  pushLog(
    next,
    'street',
    `${names}下注开始 · 明牌最大者 ${next.players[first].name} 先说话 · 最小注 ${betUnit(next.config, street)}`,
  )
  next.revision++
  return next
}

// ------------------------------------------------------------------ betting

export function legalActions(state: GameState, seat: number): LegalActions {
  const none: LegalActions = {
    fold: false,
    check: false,
    callAmount: 0,
    call: false,
    raise: false,
    minRaiseTo: 0,
    maxRaiseTo: 0,
    allin: false,
    allinAmount: 0,
  }
  if (state.stage !== 'betting' || state.toActSeat !== seat) return none

  const p = state.players[seat]
  if (!canAct(p)) return none

  const unit = betUnit(state.config, state.street)
  const cap = state.config.maxRaisesPerStreet
  const toCall = Math.max(0, state.currentBet - p.streetCommitted)
  const maxTo = p.streetCommitted + p.chips
  const capReached = cap > 0 && state.raiseCount >= cap
  const canRaiseAtAll = maxTo > state.currentBet && !capReached

  let minRaiseTo = 0
  let maxRaiseTo = 0
  if (canRaiseAtAll) {
    if (state.config.bettingMode === 'fixed-limit') {
      const target = state.currentBet === 0 ? unit : state.currentBet + unit
      minRaiseTo = Math.min(target, maxTo)
      maxRaiseTo = minRaiseTo
    } else {
      minRaiseTo =
        state.currentBet === 0
          ? Math.min(unit, maxTo)
          : Math.min(state.currentBet + state.lastRaiseSize, maxTo)
      maxRaiseTo = maxTo
    }
  }

  return {
    fold: true,
    check: toCall === 0,
    callAmount: Math.min(toCall, p.chips),
    call: toCall > 0 && p.chips > 0,
    raise: canRaiseAtAll && minRaiseTo > state.currentBet,
    minRaiseTo,
    maxRaiseTo,
    // Under a hard raise cap a shove is only legal if it is effectively a call.
    allin: p.chips > 0 && (!capReached || maxTo <= state.currentBet),
    allinAmount: p.chips,
  }
}

function commit(state: GameState, seat: number, amount: number): number {
  const p = state.players[seat]
  const actual = Math.max(0, Math.min(amount, p.chips))
  p.chips -= actual
  p.streetCommitted += actual
  p.totalCommitted += actual
  if (p.chips === 0) p.allIn = true
  state.pot = totalPot(state)
  return actual
}

export function applyAction(state: GameState, seat: number, action: PlayerAction): GameState {
  if (state.stage !== 'betting' || state.toActSeat !== seat) {
    throw new Error(`座位 ${seat} 现在不能行动`)
  }
  const legal = legalActions(state, seat)
  const next = draft(state)
  const p = next.players[seat]
  const previousBet = next.currentBet

  switch (action.type) {
    case 'fold': {
      if (!legal.fold) throw new Error('当前不能弃牌')
      p.folded = true
      p.hasActedThisStreet = true
      p.lastActionLabel = '弃牌'
      pushLog(next, 'action', `${p.name} 弃牌`, seat)
      break
    }

    case 'check': {
      if (!legal.check) throw new Error('当前不能过牌')
      p.hasActedThisStreet = true
      p.lastActionLabel = '过牌'
      pushLog(next, 'action', `${p.name} 过牌`, seat)
      break
    }

    case 'call': {
      if (!legal.call) throw new Error('当前不能跟注')
      const paid = commit(next, seat, legal.callAmount)
      p.hasActedThisStreet = true
      p.lastActionLabel = p.allIn ? `全下跟注 ${paid}` : `跟注 ${paid}`
      pushLog(
        next,
        'action',
        p.allIn ? `${p.name} 以全部筹码跟注 ${paid}（全下）` : `${p.name} 跟注 ${paid}`,
        seat,
      )
      break
    }

    case 'bet':
    case 'raise':
    case 'allin': {
      const wantsAllIn = action.type === 'allin'
      if (wantsAllIn && !legal.allin) throw new Error('当前不能全下')
      if (!wantsAllIn && !legal.raise) throw new Error('当前不能加注')

      const maxTo = p.streetCommitted + p.chips
      let target: number
      if (wantsAllIn) {
        target = maxTo
      } else {
        const requested = action.amount ?? legal.minRaiseTo
        target = Math.max(legal.minRaiseTo, Math.min(requested, legal.maxRaiseTo))
      }
      if (target <= next.currentBet && !wantsAllIn) throw new Error('加注额必须高于当前注额')

      const isRaise = target > next.currentBet
      const paid = commit(next, seat, target - p.streetCommitted)

      if (isRaise) {
        const increment = p.streetCommitted - previousBet
        const isFullRaise = increment >= next.lastRaiseSize
        if (isFullRaise) {
          next.lastRaiseSize = increment
          next.raiseCount += 1
          next.lastAggressorSeat = seat
          // A full raise reopens the action for everyone else.
          for (const other of next.players) {
            if (other.seat !== seat && canAct(other)) other.hasActedThisStreet = false
          }
        } else {
          // Short all-in raise: legal, but it does not reopen the betting.
          next.lastAggressorSeat = seat
        }
        p.lastActionLabel = p.allIn
          ? `全下 ${target}`
          : next.currentBet === 0
            ? `下注 ${target}`
            : `加注到 ${target}`
        pushLog(
          next,
          'action',
          p.allIn
            ? `${p.name} 梭哈！全下 ${target}`
            : `${p.name} ${previousBet === 0 ? '下注' : '加注到'} ${target}${isFullRaise ? '' : '（不足最小加注）'}`,
          seat,
        )
      } else {
        p.lastActionLabel = `全下跟注 ${paid}`
        pushLog(next, 'action', `${p.name} 全下 ${paid}`, seat)
      }
      p.hasActedThisStreet = true
      break
    }

    default: {
      const exhaustive: never = action.type
      throw new Error(`未知动作 ${String(exhaustive)}`)
    }
  }

  next.currentBet = next.players.reduce(
    (max, other) => (inHand(other) ? Math.max(max, other.streetCommitted) : max),
    0,
  )

  const nextSeat = nextToActSeat(next, seat)
  if (nextSeat === null) {
    return advanceAfterBetting(next)
  }
  next.toActSeat = nextSeat
  next.revision++
  return next
}

function nextToActSeat(state: GameState, fromSeat: number): number | null {
  const n = state.players.length
  for (let i = 1; i <= n; i++) {
    const s = (fromSeat + i) % n
    const p = state.players[s]
    if (!canAct(p)) continue
    if (!p.hasActedThisStreet || p.streetCommitted < state.currentBet) return s
  }
  return null
}

function advanceAfterBetting(state: GameState): GameState {
  const next = draft(state)
  const live = next.players.filter(inHand)
  next.toActSeat = null

  if (live.length <= 1) {
    return settleHand(next)
  }

  if (next.street >= 3) {
    next.stage = 'showdown'
    next.revision++
    return next
  }

  // Advance the street immediately so `street` names the round being prepared
  // for the whole deal — the UI and the text export both rely on that.
  next.street += 1
  next.dealRound = next.street + 1
  next.dealCursor = 0

  // Burn one card before the next up-card round, as in live stud.
  const burned = drawCard(next)
  next.burned.push(burned)
  pushLog(next, 'deal', `销牌 1 张`)

  next.stage = 'deal'
  next.dealLeadSeat = highestBoardSeat(next) ?? next.dealerSeat
  next.revision++
  return next
}

// ----------------------------------------------------------------- showdown

export function settleHand(state: GameState): GameState {
  const next = draft(state)
  const live = next.players.filter(inHand)

  for (const p of next.players) {
    p.streetCommitted = 0
    p.hasActedThisStreet = false
  }
  next.toActSeat = null

  const contributions = next.players.map((p) => p.totalCommitted)
  const folded = next.players.map((p) => p.folded || p.outOfGame)
  const pots: Pot[] = buildPots(contributions, folded)
  next.pot = contributions.reduce((a, b) => a + b, 0)

  const hands = new Map<number, Card[]>()
  for (const p of live) hands.set(p.seat, p.cards)

  if (live.length > 1) {
    const results = resolvePots(pots, hands)
    next.potResults = results
    next.revealedSeats = live.map((p) => p.seat)
    pushLog(next, 'showdown', '开牌比大小')
    for (const p of live) {
      pushLog(next, 'showdown', `${p.name}：${cardsText(p.cards)} → ${evaluateHand(p.cards).label}`, p.seat)
    }
  } else {
    // Everyone folded — the last player standing takes it without showing.
    const results = resolvePots(pots, hands)
    next.potResults = results
    next.revealedSeats = []
    pushLog(next, 'showdown', `${live[0]?.name ?? '—'} 未开牌赢得底池（其他玩家均已弃牌）`)
  }

  const winTotals = new Map<number, number>()
  for (const result of next.potResults) {
    for (const winner of result.winners) {
      next.players[winner.seat].chips += winner.amount
      winTotals.set(winner.seat, (winTotals.get(winner.seat) ?? 0) + winner.amount)
      pushLog(
        next,
        'payout',
        `${next.players[winner.seat].name} 赢得 ${result.label} ${winner.amount}（${winner.handLabel}）`,
        winner.seat,
      )
    }
  }

  for (const p of next.players) {
    p.lastWin = winTotals.get(p.seat) ?? 0
    if (p.chips <= 0) p.outOfGame = true
  }

  next.winners = [...winTotals.keys()]
  next.shuffle = { ...next.shuffle, revealed: true }
  next.stage = 'handOver'

  if (next.players.filter((p) => p.chips > 0).length < MIN_PLAYERS) {
    next.stage = 'gameOver'
    const champion = next.players.find((p) => p.chips > 0)
    pushLog(next, 'info', `牌局结束！${champion ? `${champion.name} 赢下全部筹码。` : '无人剩余筹码。'}`)
  }

  next.revision++
  return next
}

/** Public alias so the UI can trigger the showdown step. */
export const showdown = settleHand

export function startNextHand(state: GameState): GameState {
  if (state.stage === 'gameOver') return state
  return startHand(state)
}

// ---------------------------------------------------------------- auto drive

export type AutoStep =
  | { kind: 'deal'; seat: number; round: number }
  | { kind: 'bot'; seat: number }
  | { kind: 'settle' }
  | { kind: 'wait' }
  | { kind: 'idle' }

/**
 * Describes what the UI should do next and how long to wait.
 * Keeping this in the engine means the animation pacing is testable.
 */
export function autoStep(state: GameState): AutoStep {
  switch (state.stage) {
    case 'deal': {
      const order = currentDealOrder(state)
      return { kind: 'deal', seat: order[state.dealCursor] ?? -1, round: state.dealRound }
    }
    case 'betting':
      if (state.toActSeat === null) return { kind: 'wait' }
      return state.players[state.toActSeat].isBot
        ? { kind: 'bot', seat: state.toActSeat }
        : { kind: 'wait' }
    case 'showdown':
      return { kind: 'settle' }
    default:
      return { kind: 'idle' }
  }
}

/** Deal pacing, in milliseconds. */
export function stepDelayMs(step: AutoStep): number {
  switch (step.kind) {
    case 'deal':
      return step.round === 0 ? 150 : 260
    case 'bot':
      return 850
    case 'settle':
      return 700
    default:
      return 0
  }
}

/**
 * Human description of the pending engine step, for the step-through control:
 * "发第 3 张明牌 → 电脑·白鲨", "电脑·老K 行动", "开牌结算".
 */
export function stepLabel(state: GameState): string {
  const step = autoStep(state)
  const nameOf = (seat: number) => state.players[seat]?.name ?? `座位 ${seat}`
  switch (step.kind) {
    case 'deal':
      return `${step.round === 0 ? '发底牌' : `发第 ${step.round + 1} 张明牌`} → ${nameOf(step.seat)}`
    case 'bot':
      return `${nameOf(step.seat)} 行动`
    case 'settle':
      return state.players.filter(inHand).length > 1 ? '开牌比大小' : '结算底池'
    case 'wait':
      return state.toActSeat === null ? '等待中' : `${nameOf(state.toActSeat)} 行动（真人）`
    default:
      return state.stage === 'handOver' || state.stage === 'gameOver' ? '本手已结束' : '就绪'
  }
}

/** True when the engine is waiting on the UI to advance it. */
export function isAutoStep(state: GameState): boolean {
  const kind = autoStep(state).kind
  return kind === 'deal' || kind === 'bot' || kind === 'settle'
}

// ------------------------------------------------------------------ queries

export function potsFor(state: GameState): Pot[] {
  const contributions = state.players.map((p) => p.totalCommitted)
  const folded = state.players.map((p) => p.folded || p.outOfGame)
  return buildPots(contributions, folded)
}

export function potLabel(state: GameState): string {
  const pots = potsFor(state)
  if (pots.length === 0) return '0'
  if (pots.length === 1) return `${pots[0].amount}`
  return pots.map((p) => `${p.label} ${p.amount}`).join(' · ')
}

export function describeAction(type: ActionType): string {
  return (
    {
      fold: '弃牌',
      check: '过牌',
      call: '跟注',
      bet: '下注',
      raise: '加注',
      allin: '梭哈',
    } as const
  )[type]
}

export { MAIN_POT_LABEL }
