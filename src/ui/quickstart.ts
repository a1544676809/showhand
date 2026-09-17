import { DEFAULT_CONFIG } from '../engine/game'
import type { BettingMode, GameConfig } from '../engine/types'
import { defaultSeat, type GameMode, type SeatSetup, type TableSetup } from './useGameController'

/**
 * Deep links:
 *   ?quick=hotseat&seats=4&chips=1000&ante=10&speed=2&seed=abc&p0=阿明&id0=alice
 *
 * Gives a shareable "jump straight into a table" URL, and doubles as the entry
 * point the screenshot harness drives.
 */

const MODES: GameMode[] = ['hotseat', 'god']

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min

export interface QuickStartOptions {
  setup: TableSetup
  speed: number
  /** Force the initial perspective (used by the screenshot harness). */
  perspective: number | null
  autostart: boolean
}

export function readQuickStart(search: string): QuickStartOptions | null {
  const params = new URLSearchParams(search)
  const quick = params.get('quick')
  if (!quick) return null

  const mode: GameMode = (MODES as string[]).includes(quick) ? (quick as GameMode) : 'hotseat'
  const seats = clamp(Math.round(Number(params.get('seats')) || 3), 2, 5)
  const startingChips = clamp(Math.round(Number(params.get('chips')) || 1000), 100, 1_000_000)
  const ante = clamp(Math.round(Number(params.get('ante')) || DEFAULT_CONFIG.ante), 1, 100_000)
  const smallBet = clamp(Math.round(Number(params.get('small')) || DEFAULT_CONFIG.smallBet), 1, 100_000)
  const bigBet = clamp(Math.round(Number(params.get('big')) || DEFAULT_CONFIG.bigBet), 1, 100_000)
  const bettingMode: BettingMode = params.get('limit') === '1' ? 'fixed-limit' : 'no-limit'

  const config: GameConfig = {
    ante,
    smallBet,
    bigBet,
    maxRaisesPerStreet: bettingMode === 'fixed-limit' ? 4 : 0,
    bettingMode,
    deckSize: params.get('deck') === '28' ? 28 : 52,
  }

  const seatSetups: SeatSetup[] = Array.from({ length: seats }, (_, index) => {
    const base = defaultSeat(index, mode)
    const name = params.get(`p${index}`)
    return {
      name: name ? name.slice(0, 12) : base.name,
      playerId: (params.get(`id${index}`) ?? '').slice(0, 24),
      chips: clamp(Math.round(Number(params.get(`chips${index}`)) || startingChips), 1, 100_000_000),
      isBot: params.get(`bot${index}`) ? params.get(`bot${index}`) !== '0' : base.isBot,
    }
  })

  return {
    setup: {
      mode,
      seats: seatSetups,
      config,
      seed: params.get('seed') ?? undefined,
    },
    // 上帝视角 defaults to manual stepping so cards only turn over on request;
    // an explicit ?speed= always wins.
    speed: params.has('speed')
      ? clamp(Number(params.get('speed')), 0, 4)
      : mode === 'god'
        ? 0
        : 1,
    perspective:
      mode === 'god' ? null : clamp(Number(params.get('view') ?? '0'), 0, seats - 1),
    autostart: params.get('start') !== '0',
  }
}
