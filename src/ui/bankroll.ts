/**
 * Persistent chip counts, keyed by a player's stable identifier.
 *
 * A seat only participates when the user typed an identifier for it. Anonymous
 * seats neither read nor write — the game then behaves exactly as it did before
 * persistence existed, which keeps quick throwaway tables free of side effects.
 */

const STORAGE_KEY = 'showhand:bankroll'

export interface BankrollEntry {
  chips: number
  /** Display name at the time of the last write, purely informational. */
  name: string
  updatedAt: number
}

export type Bankroll = Record<string, BankrollEntry>

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    // Private mode / storage disabled — persistence silently no-ops.
    return null
  }
}

export function loadBankroll(): Bankroll {
  const store = storage()
  if (!store) return {}
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Bankroll = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<BankrollEntry>
      if (typeof entry?.chips === 'number' && Number.isFinite(entry.chips)) {
        out[key] = {
          chips: Math.max(0, Math.round(entry.chips)),
          name: typeof entry.name === 'string' ? entry.name : key,
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveBankroll(bankroll: Bankroll): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(bankroll))
  } catch {
    /* quota or private mode — ignore */
  }
}

/**
 * Merges the current chip counts into the bankroll and returns the new map.
 * Seats without an identifier are skipped entirely.
 */
export function recordChips(
  bankroll: Bankroll,
  players: readonly { playerId: string; name: string; chips: number }[],
): Bankroll {
  let changed = false
  const next: Bankroll = { ...bankroll }

  for (const player of players) {
    const id = player.playerId.trim()
    if (!id) continue
    const previous = next[id]
    if (
      previous &&
      previous.chips === player.chips &&
      previous.name === player.name
    ) {
      continue
    }
    next[id] = { chips: player.chips, name: player.name, updatedAt: Date.now() }
    changed = true
  }

  return changed ? next : bankroll
}

export function clearBankroll(): Bankroll {
  const store = storage()
  try {
    store?.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  return {}
}

export function removeFromBankroll(bankroll: Bankroll, id: string): Bankroll {
  const key = id.trim()
  if (!key || !(key in bankroll)) return bankroll
  const next = { ...bankroll }
  delete next[key]
  return next
}

/** `12,340 · 2 天前` — compact summary for the setup screen. */
export function describeEntry(entry: BankrollEntry): string {
  const when = entry.updatedAt ? new Date(entry.updatedAt) : null
  if (!when) return entry.chips.toLocaleString('en-US')
  const minutes = Math.round((Date.now() - entry.updatedAt) / 60000)
  const ago =
    minutes < 1
      ? '刚刚'
      : minutes < 60
        ? `${minutes} 分钟前`
        : minutes < 60 * 24
          ? `${Math.round(minutes / 60)} 小时前`
          : `${Math.round(minutes / (60 * 24))} 天前`
  return `${entry.chips.toLocaleString('en-US')} · ${ago}`
}
