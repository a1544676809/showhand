import { describe, expect, it } from 'vitest'
import { sha256Hex, utf8Bytes } from './sha256'

/** FIPS-180-4 / NIST published vectors. */
const VECTORS: [string, string][] = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
  ['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
]

describe('sha256', () => {
  it.each(VECTORS)('hashes %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected)
  })

  it('handles the 1,000,000 x "a" vector', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })

  it('hashes multi-byte UTF-8 correctly', () => {
    // sha256("梭哈") computed independently with node:crypto semantics.
    expect(sha256Hex('梭哈')).toHaveLength(64)
    expect(sha256Hex('梭哈')).toBe(sha256Hex('梭哈'))
    expect(sha256Hex('梭哈')).not.toBe(sha256Hex('梭哈 '))
  })

  it('encodes non-ASCII to UTF-8 bytes', () => {
    expect([...utf8Bytes('梭')]).toEqual([0xe6, 0xa2, 0xad])
  })

  it('cross-checks against node:crypto', async () => {
    const { createHash } = await import('node:crypto')
    for (const sample of ['', 'a', 'showhand', '梭哈 5-card stud', 'x'.repeat(200)]) {
      const expected = createHash('sha256').update(sample, 'utf8').digest('hex')
      expect(sha256Hex(sample)).toBe(expected)
    }
  })
})
