import { sha256Bytes, toHex, utf8Bytes } from './sha256'

/**
 * Deterministic, unbiased random source derived from a single seed string.
 *
 * Randomness comes from SHA-256 in counter mode: block i is
 * `SHA256(seed || uint32be(i))`. That makes the shuffle fully reproducible —
 * anyone holding (serverSeed, clientSeed) can rebuild the identical deck and
 * audit a hand they just played.
 */
export class DeterministicRandom {
  private counter = 0
  private pool: Uint8Array = new Uint8Array(0)
  private poolOffset = 0
  private readonly seedBytes: Uint8Array

  constructor(seed: string) {
    this.seedBytes = utf8Bytes(seed)
  }

  private refill(): void {
    const input = new Uint8Array(this.seedBytes.length + 4)
    input.set(this.seedBytes, 0)
    new DataView(input.buffer).setUint32(this.seedBytes.length, this.counter++, false)
    this.pool = sha256Bytes(input)
    this.poolOffset = 0
  }

  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number {
    if (this.poolOffset + 4 > this.pool.length) this.refill()
    const value = new DataView(
      this.pool.buffer,
      this.pool.byteOffset + this.poolOffset,
      4,
    ).getUint32(0, false)
    this.poolOffset += 4
    return value
  }

  /**
   * Uniform integer in [0, maxExclusive) via rejection sampling — no modulo
   * bias, unlike a naive `nextUint32() % n`.
   */
  nextBelow(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextBelow expects a positive integer, got ${maxExclusive}`)
    }
    if (maxExclusive === 1) return 0
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive
    let value = this.nextUint32()
    while (value >= limit) value = this.nextUint32()
    return value % maxExclusive
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / 0x100000000
  }

  /** Fisher-Yates. Returns a new array; the input is not mutated. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextBelow(i + 1)
      const tmp = out[i]
      out[i] = out[j]
      out[j] = tmp
    }
    return out
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextBelow(items.length)]
  }
}

const HEX = '0123456789abcdef'

/** Cryptographically random hex string of `bytes` bytes. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  const webCrypto = globalThis.crypto
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(buf)
  } else {
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256)
  }
  let s = ''
  for (let i = 0; i < bytes; i++) s += HEX[buf[i] >> 4] + HEX[buf[i] & 15]
  return s
}

/** Fresh 256-bit server seed. */
export const newServerSeed = (): string => randomHex(32)

/** Short, human-typeable client seed. */
export const newClientSeed = (): string => randomHex(4)

export { toHex }
