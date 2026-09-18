import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chooseAction } from '../engine/ai'
import {
  applyAction,
  autoStep,
  createGame,
  dealNextCard,
  isAutoStep,
  legalActions,
  settleHand,
  startHand,
  stepDelayMs,
  stepLabel,
} from '../engine/game'
import type { PlayerSetup } from '../engine/game'
import { newClientSeed } from '../engine/rng'
import type { GameConfig, GameState, PlayerAction } from '../engine/types'
import {
  clearBankroll,
  loadBankroll,
  recordChips,
  saveBankroll,
  type Bankroll,
} from './bankroll'

/**
 * Both modes are the same engine with different defaults; the per-seat AI
 * toggle is what lets you move between them mid-game.
 *
 *   同屏轮流 — every seat starts human, hands are hidden behind a gate.
 *   上帝视角 — every seat starts as AI, no gate, hole cards peek-only.
 */
export type GameMode = 'hotseat' | 'god'

export interface SeatSetup {
  name: string
  /** Stable identifier for chip persistence. Empty = anonymous, never stored. */
  playerId: string
  /** Buy-in for this seat, used when the identifier has no saved bankroll. */
  chips: number
  isBot: boolean
}

export interface TableSetup {
  mode: GameMode
  seats: SeatSetup[]
  config: GameConfig
  /** Optional fixed seed for replaying an identical session. */
  seed?: string
}

export type Speed = 0 | 1 | 2 | 4

const SPEED_LABEL: Record<Speed, string> = { 0: '手动', 1: '正常', 2: '快', 4: '极快' }
export { SPEED_LABEL }

const SETUP_KEY = 'showhand:lastSetup'
const MAX_SEATS = 5

/** Runs exactly one engine step; shared by auto-play and the 下一步 button. */
function performStep(state: GameState): GameState {
  const step = autoStep(state)
  switch (step.kind) {
    case 'deal':
      return dealNextCard(state)
    case 'bot':
      return applyAction(state, step.seat, chooseAction(state, step.seat))
    case 'settle':
      return settleHand(state)
    default:
      return state
  }
}

export function defaultSeat(index: number, mode: GameMode): SeatSetup {
  const hotseatNames = ['东家', '南家', '西家', '北家', '中家']
  const godNames = ['一号位', '二号位', '三号位', '四号位', '五号位']
  return {
    name: mode === 'hotseat' ? hotseatNames[index] : godNames[index],
    playerId: '',
    chips: 1000,
    isBot: mode === 'god',
  }
}

export function defaultSetup(mode: GameMode = 'hotseat', count = 3): TableSetup {
  return {
    mode,
    seats: Array.from({ length: count }, (_, i) => defaultSeat(i, mode)),
    config: {
      ante: 10,
      smallBet: 20,
      bigBet: 40,
      maxRaisesPerStreet: 0,
      bettingMode: 'no-limit',
      deckSize: 52,
    },
  }
}

export function loadLastSetup(): TableSetup | null {
  try {
    const raw = window.localStorage.getItem(SETUP_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TableSetup>
    if (parsed?.mode !== 'hotseat' && parsed?.mode !== 'god') return null
    if (!Array.isArray(parsed.seats) || parsed.seats.length < 2) return null
    const seats = parsed.seats.slice(0, MAX_SEATS).map((seat, i): SeatSetup => {
      const base = defaultSeat(i, parsed.mode as GameMode)
      return {
        name: typeof seat?.name === 'string' && seat.name ? seat.name.slice(0, 12) : base.name,
        playerId: typeof seat?.playerId === 'string' ? seat.playerId.slice(0, 24) : '',
        chips:
          typeof seat?.chips === 'number' && Number.isFinite(seat.chips)
            ? Math.max(100, Math.round(seat.chips))
            : base.chips,
        isBot: typeof seat?.isBot === 'boolean' ? seat.isBot : base.isBot,
      }
    })
    return {
      mode: parsed.mode as GameMode,
      seats,
      config: { ...defaultSetup(parsed.mode as GameMode).config, ...(parsed.config ?? {}) },
      seed: typeof parsed.seed === 'string' ? parsed.seed : undefined,
    }
  } catch {
    return null
  }
}

function saveLastSetup(setup: TableSetup): void {
  try {
    window.localStorage.setItem(SETUP_KEY, JSON.stringify(setup))
  } catch {
    /* private mode — ignore */
  }
}

/** Resolves each seat's buy-in: the bankroll wins for identified players. */
function toPlayerSetups(setup: TableSetup, bankroll: Bankroll): PlayerSetup[] {
  return setup.seats.map((seat): PlayerSetup => {
    const id = seat.playerId.trim()
    const saved = id ? bankroll[id] : undefined
    return {
      name: seat.name.trim() || '玩家',
      isBot: seat.isBot,
      playerId: id,
      chips: saved ? saved.chips : Math.max(1, seat.chips),
    }
  })
}

export interface Controller {
  state: GameState | null
  setup: TableSetup | null
  /** 1-based index of the current game; bumps on every 重新开始. */
  sessionNo: number
  /** Seat whose eyes we are looking through, after privacy rules. */
  perspective: number | null
  /** Seat the table rotates around (bottom-centre). */
  anchorSeat: number
  /** Explicit (unfiltered) perspective — what the text export should use. */
  exportPerspective: number | null
  isGod: boolean
  /** Hole cards the user explicitly uncovered in 上帝视角. */
  peekedSeats: number[]
  /** Whether the per-seat action buttons are shown. */
  showSeatControls: boolean
  setShowSeatControls: (value: boolean) => void
  speed: Speed
  setSpeed: (speed: Speed) => void
  setPerspective: (seat: number | null) => void
  advance: () => void
  act: (action: PlayerAction) => void
  nextHand: () => void
  /** New game, same table: chips come from the bankroll, session counter +1. */
  restart: () => void
  /** Start a fresh table from the setup screen. */
  newSession: (setup: TableSetup) => void
  /** Leave the table and return to the setup screen. */
  leave: () => void
  setSeatBot: (seat: number, isBot: boolean) => void
  togglePeek: (seat: number) => void
  gateSeat: number | null
  clearGate: () => void
  nextStepLabel: string
  hasPendingStep: boolean
  bankroll: Bankroll
  resetBankroll: () => void
}

export function useGameController(): Controller {
  const [state, setState] = useState<GameState | null>(null)
  const [setup, setSetup] = useState<TableSetup | null>(null)
  const [sessionNo, setSessionNo] = useState(1)
  const [perspective, setPerspective] = useState<number | null>(0)
  const [anchorSeat, setAnchorSeat] = useState(0)
  const [speed, setSpeed] = useState<Speed>(1)
  const [gateSeat, setGateSeat] = useState<number | null>(null)
  const [clearedGate, setClearedGate] = useState<string | null>(null)
  const [peekedSeats, setPeekedSeats] = useState<number[]>([])
  const [showSeatControls, setShowSeatControls] = useState(false)
  const [bankroll, setBankroll] = useState<Bankroll>(() => loadBankroll())

  const isGod = setup?.mode === 'god'
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---------------------------------------------------------------- helpers
  const beginGame = useCallback(
    (next: TableSetup, session: number, source: Bankroll) => {
      const game = createGame({
        players: toPlayerSetups(next, source),
        startingChips: next.seats[0]?.chips ?? 1000,
        config: next.config,
        clientSeed: next.seed ?? newClientSeed(),
        serverSeed: next.seed,
      })
      setSetup(next)
      setSessionNo(session)
      setClearedGate(null)
      setGateSeat(null)
      setPeekedSeats([])
      setShowSeatControls(next.mode === 'god')
      setSpeed(next.mode === 'god' ? 0 : 1)
      // 上帝视角 looks through nobody's eyes: every 暗牌 starts face down and is
      // uncovered seat by seat. Leaving this at 0 made seat 0 permanently visible.
      setPerspective(next.mode === 'god' ? null : 0)
      setAnchorSeat(next.mode === 'god' ? 0 : 0)
      setState(startHand(game))
      saveLastSetup(next)
    },
    [],
  )

  const snapshotBankroll = useCallback(
    (game: GameState | null) => {
      setBankroll((current) => {
        if (!game) return current
        const next = recordChips(current, game.players)
        if (next !== current) saveBankroll(next)
        return next
      })
    },
    [],
  )

  // -------------------------------------------------------------- game loop
  useEffect(() => {
    if (!state) return
    if (speed === 0) return
    const step = autoStep(state)
    if (step.kind === 'idle' || step.kind === 'wait') return

    const delay = stepDelayMs(step) / speed
    timer.current = setTimeout(() => {
      setState((current) => (current ? performStep(current) : current))
    }, delay)

    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [state, speed])

  // Persist chip counts whenever a hand settles.
  useEffect(() => {
    if (!state) return
    if (state.stage === 'handOver' || state.stage === 'gameOver') snapshotBankroll(state)
  }, [state?.stage, state?.handNo, state, snapshotBankroll])

  // -------------------------------------------------- hot-seat privacy gate
  const gateKey =
    state && state.toActSeat !== null
      ? `${state.handNo}:${state.street}:${state.toActSeat}`
      : null

  useEffect(() => {
    if (!setup || !state || setup.mode !== 'hotseat') {
      setGateSeat(null)
      return
    }
    if (state.stage !== 'betting' || state.toActSeat === null) return
    if (state.players[state.toActSeat].isBot) return
    if (gateKey !== null && gateKey === clearedGate) return
    setGateSeat(state.toActSeat)
  }, [setup, state, gateKey, clearedGate])

  // In hot-seat the camera follows the player who is acting.
  const actorSeat = state?.toActSeat ?? null
  useEffect(() => {
    if (!setup) return
    if (setup.mode === 'hotseat' && actorSeat !== null) setAnchorSeat(actorSeat)
    else if (setup.mode === 'god') setAnchorSeat(0)
  }, [setup, actorSeat])

  const revealSeat =
    setup?.mode === 'hotseat'
      ? gateKey !== null && gateKey === clearedGate
        ? actorSeat
        : null
      : perspective

  // ---------------------------------------------------------------- actions
  const newSession = useCallback(
    (next: TableSetup) => {
      beginGame(next, 1, bankroll)
    },
    [beginGame, bankroll],
  )

  const restart = useCallback(() => {
    if (!setup) return
    // Chips come from the bankroll, so a restart continues the same standings.
    beginGame(setup, sessionNo + 1, bankroll)
  }, [beginGame, setup, sessionNo, bankroll])

  const leave = useCallback(() => {
    snapshotBankroll(state)
    setState(null)
    setGateSeat(null)
    setClearedGate(null)
    setPeekedSeats([])
  }, [snapshotBankroll, state])

  const act = useCallback((action: PlayerAction) => {
    setState((current) => {
      if (!current || current.stage !== 'betting' || current.toActSeat === null) return current
      return applyAction(current, current.toActSeat, action)
    })
  }, [])

  const nextHand = useCallback(() => {
    if (state?.stage === 'gameOver') {
      // The table is over — treat 下一手 as "restart with the same players".
      restart()
      return
    }
    setState((current) => {
      if (!current || current.stage === 'gameOver') return current
      return startHand(current)
    })
    setClearedGate(null)
    setGateSeat(null)
  }, [restart, state?.stage])

  const advance = useCallback(() => {
    setState((current) => (current ? performStep(current) : current))
  }, [])

  const setSeatBot = useCallback((seat: number, isBot: boolean) => {
    setState((current) => {
      if (!current) return current
      const player = current.players[seat]
      if (!player || player.isBot === isBot) return current
      return {
        ...current,
        players: current.players.map((p) => (p.seat === seat ? { ...p, isBot } : p)),
        revision: current.revision + 1,
      }
    })
  }, [])

  const togglePeek = useCallback((seat: number) => {
    setPeekedSeats((current) =>
      current.includes(seat) ? current.filter((s) => s !== seat) : [...current, seat],
    )
  }, [])

  const clearGate = useCallback(() => {
    setClearedGate(gateKey)
    setGateSeat(null)
  }, [gateKey])

  const resetBankroll = useCallback(() => {
    setBankroll(clearBankroll())
  }, [])

  const nextStepLabel = useMemo(() => (state ? stepLabel(state) : '—'), [state])
  const hasPendingStep = useMemo(() => (state ? isAutoStep(state) : false), [state])

  return {
    state,
    setup,
    sessionNo,
    perspective: revealSeat,
    anchorSeat,
    exportPerspective: perspective,
    isGod: isGod ?? false,
    peekedSeats,
    showSeatControls,
    setShowSeatControls,
    speed,
    setSpeed,
    setPerspective,
    advance,
    act,
    nextHand,
    restart,
    newSession,
    leave,
    setSeatBot,
    togglePeek,
    gateSeat,
    clearGate,
    nextStepLabel,
    hasPendingStep,
    bankroll,
    resetBankroll,
  }
}

/** Legal actions for whoever is on turn right now, or null. */
export function useLegalActions(state: GameState | null) {
  return useMemo(() => {
    if (!state || state.stage !== 'betting' || state.toActSeat === null) return null
    return legalActions(state, state.toActSeat)
  }, [state])
}
