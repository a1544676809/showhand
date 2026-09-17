import { useEffect, useState } from 'react'
import { cardId } from '../engine/cards'
import { RANK_LABEL, SUIT_SYMBOL, type Card } from '../engine/types'

/**
 * Card faces come from the public-domain deck in `public/cards`
 * (Wikimedia Commons, CC0). If an asset is missing the component degrades to a
 * typographic fallback so the game stays playable without the download step.
 */

const RED_SUITS = new Set(['H', 'D'])

function FaceFallback({ card }: { card: Card }) {
  return (
    <div className={`card-fallback${RED_SUITS.has(card.suit) ? ' red' : ''}`}>
      <span className="r">{RANK_LABEL[card.rank]}</span>
      <span className="s">{SUIT_SYMBOL[card.suit]}</span>
    </div>
  )
}

function BackFallback() {
  return <div className="card-fallback-back" />
}

export interface PlayingCardProps {
  card: Card | null
  faceDown?: boolean
  /** Marks the 暗牌 so it reads differently from the four 明牌. */
  isHole?: boolean
  /**
   * Play the deal-in animation once on mount. On by default: the engine deals
   * one card at a time, so each mount *is* a fresh card arriving at the table.
   */
  animate?: boolean
  /** Card size in pixels. */
  width?: number
  height?: number
  title?: string
}

export function PlayingCard({
  card,
  faceDown = false,
  isHole = false,
  animate = true,
  width = 52,
  height = 73,
  title,
}: PlayingCardProps) {
  const [faceError, setFaceError] = useState(false)
  const [backError, setBackError] = useState(false)
  const [entering, setEntering] = useState(animate)

  useEffect(() => {
    if (!entering) return
    const timer = setTimeout(() => setEntering(false), 460)
    return () => clearTimeout(timer)
  }, [entering])

  const label = card ? `${RANK_LABEL[card.rank]}${SUIT_SYMBOL[card.suit]}` : '牌背'

  return (
    <div
      className={[
        'card-slot',
        entering ? 'just-dealt' : '',
        isHole ? 'is-hole' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ ['--card-w' as string]: `${width}px`, ['--card-h' as string]: `${height}px` }}
      title={title ?? label}
    >
      <div className={`card${faceDown ? ' face-down' : ''}`}>
        <div className="card-face">
          {card && !faceError ? (
            <img
              src={`/cards/${cardId(card)}.png`}
              alt={label}
              draggable={false}
              loading="lazy"
              decoding="async"
              onError={() => setFaceError(true)}
            />
          ) : card ? (
            <FaceFallback card={card} />
          ) : null}
        </div>
        <div className="card-back">
          {backError ? (
            <BackFallback />
          ) : (
            <img
              src="/cards/BACK.png"
              alt="牌背"
              draggable={false}
              decoding="async"
              onError={() => setBackError(true)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** A row of face-down cards used on the privacy gate and the setup screen. */
export function CardFan({ count = 5, width = 46, height = 64 }: { count?: number; width?: number; height?: number }) {
  return (
    <div className="gate-cards">
      {Array.from({ length: count }, (_, i) => (
        <PlayingCard key={i} card={null} faceDown width={width} height={height} />
      ))}
    </div>
  )
}

const CHIP_TIERS: [number, string][] = [
  [1000, 'c1000'],
  [500, 'c500'],
  [100, 'c100'],
  [25, 'c25'],
  [5, 'c5'],
  [1, 'c1'],
]

/** Small stack of chip discs sized to the amount. */
export function ChipStack({ amount, max = 6 }: { amount: number; max?: number }) {
  if (amount <= 0) return null
  const chips: string[] = []
  let remaining = amount
  for (const [value, cls] of CHIP_TIERS) {
    while (remaining >= value && chips.length < max) {
      chips.push(cls)
      remaining -= value
    }
  }
  if (chips.length === 0) chips.push('c1')
  return (
    <span className="chips" title={`${amount}`}>
      {chips.map((cls, i) => (
        <span key={i} className={`chip ${cls}`} />
      ))}
    </span>
  )
}
