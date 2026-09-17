import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearBankroll,
  describeEntry,
  loadBankroll,
  recordChips,
  removeFromBankroll,
  saveBankroll,
  type Bankroll,
} from './bankroll'

/** Minimal in-memory Storage so the round-trip can be exercised under Node. */
function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

const originalWindow = (globalThis as { window?: unknown }).window

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = { localStorage: fakeStorage() }
})

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

describe('bankroll persistence', () => {
  it('round-trips through storage', () => {
    const bankroll: Bankroll = { alice: { chips: 1240, name: '阿明', updatedAt: 1700000000000 } }
    saveBankroll(bankroll)
    expect(loadBankroll()).toEqual(bankroll)
  })

  it('returns an empty map when nothing is stored', () => {
    expect(loadBankroll()).toEqual({})
  })

  it('survives a corrupt payload', () => {
    fakeStorageSet('showhand:bankroll', '{ not json')
    expect(loadBankroll()).toEqual({})
  })

  it('drops entries with a non-numeric chip count', () => {
    fakeStorageSet(
      'showhand:bankroll',
      JSON.stringify({ good: { chips: 500, name: 'A' }, bad: { chips: 'lots', name: 'B' } }),
    )
    const loaded = loadBankroll()
    expect(Object.keys(loaded)).toEqual(['good'])
    expect(loaded.good.chips).toBe(500)
  })

  it('clears everything', () => {
    saveBankroll({ alice: { chips: 10, name: 'a', updatedAt: 1 } })
    expect(Object.keys(loadBankroll())).toHaveLength(1)
    expect(clearBankroll()).toEqual({})
    expect(loadBankroll()).toEqual({})
  })

  it('removes a single entry', () => {
    const bankroll: Bankroll = {
      a: { chips: 1, name: 'a', updatedAt: 1 },
      b: { chips: 2, name: 'b', updatedAt: 1 },
    }
    expect(Object.keys(removeFromBankroll(bankroll, 'a'))).toEqual(['b'])
    expect(removeFromBankroll(bankroll, 'missing')).toBe(bankroll)
  })

  it('no-ops instead of throwing when storage is unavailable', () => {
    ;(globalThis as { window?: unknown }).window = undefined
    expect(loadBankroll()).toEqual({})
    expect(() => saveBankroll({ a: { chips: 1, name: 'a', updatedAt: 1 } })).not.toThrow()
    expect(clearBankroll()).toEqual({})
  })
})

function fakeStorageSet(key: string, value: string) {
  ;(globalThis as { window?: { localStorage: Storage } }).window?.localStorage.setItem(key, value)
}

describe('recordChips', () => {
  it('writes only seats that carry an identifier', () => {
    const next = recordChips({}, [
      { playerId: 'alice', name: '阿明', chips: 900 },
      { playerId: '', name: '匿名', chips: 500 },
      { playerId: '   ', name: '空白', chips: 700 },
    ])
    expect(Object.keys(next)).toEqual(['alice'])
    expect(next.alice.chips).toBe(900)
  })

  it('updates an existing entry with the latest stack', () => {
    const before: Bankroll = { alice: { chips: 1000, name: '阿明', updatedAt: 1 } }
    const after = recordChips(before, [{ playerId: 'alice', name: '阿明', chips: 640 }])
    expect(after.alice.chips).toBe(640)
    expect(after.alice.updatedAt).toBeGreaterThan(1)
  })

  it('returns the same map when nothing changed, so callers can skip a write', () => {
    const before: Bankroll = { alice: { chips: 640, name: '阿明', updatedAt: 5 } }
    const after = recordChips(before, [{ playerId: 'alice', name: '阿明', chips: 640 }])
    expect(after).toBe(before)
  })

  it('ignores anonymous tables entirely', () => {
    const before: Bankroll = {}
    const after = recordChips(before, [
      { playerId: '', name: 'A', chips: 100 },
      { playerId: '', name: 'B', chips: 200 },
    ])
    expect(after).toBe(before)
    expect(Object.keys(after)).toHaveLength(0)
  })

  it('does not mutate the input map', () => {
    const before: Bankroll = { alice: { chips: 1, name: 'a', updatedAt: 1 } }
    recordChips(before, [{ playerId: 'bob', name: 'b', chips: 2 }])
    expect(Object.keys(before)).toEqual(['alice'])
  })
})

describe('describeEntry', () => {
  it('formats chips and a relative time', () => {
    expect(describeEntry({ chips: 12340, name: 'a', updatedAt: Date.now() })).toContain('12,340')
    expect(describeEntry({ chips: 12340, name: 'a', updatedAt: Date.now() })).toContain('刚刚')
    expect(
      describeEntry({ chips: 5, name: 'a', updatedAt: Date.now() - 3 * 60 * 60 * 1000 }),
    ).toContain('3 小时前')
    expect(
      describeEntry({ chips: 5, name: 'a', updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 }),
    ).toContain('3 天前')
  })

  it('falls back to a bare amount when there is no timestamp', () => {
    expect(describeEntry({ chips: 700, name: 'a', updatedAt: 0 })).toBe('700')
  })
})
