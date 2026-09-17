import { evaluateHand } from '../engine/evaluator'
import type { Card, GameState, PlayerState } from '../engine/types'
import { computeBoardMetrics } from './layout'
import { ChipStack, PlayingCard } from './PlayingCard'

/**
 * Seats are placed on an ellipse. The perspective player is always anchored at
 * the bottom so the table reads the same way the text export does.
 */
export function seatPosition(
  index: number,
  count: number,
  anchor: number,
  rx = 40,
  ry = 40,
) {
  const rel = (((index - anchor) % count) + count) % count
  const angle = Math.PI / 2 + (rel * 2 * Math.PI) / count
  return {
    x: 50 + rx * Math.cos(angle),
    y: 50 + ry * Math.sin(angle),
  }
}

/**
 * Who may see a seat's 暗牌.
 *
 * There is deliberately no "reveal everything" mode: even in 上帝视角 a hole
 * card stays face down until that seat is peeked at, or the hand is settled.
 */
export function holeVisible(
  state: GameState,
  seat: number,
  perspective: number | null,
  peekedSeats: readonly number[],
): boolean {
  if (perspective === seat) return true
  if (peekedSeats.includes(seat)) return true
  return state.revealedSeats.includes(seat)
}

export interface SeatProps {
  player: PlayerState
  state: GameState
  isYou: boolean
  showHole: boolean
  isWinner: boolean
  /** Hang the hand below the nameplate instead of above it. */
  cardsBelow: boolean
  /** Show the per-seat action buttons. */
  showControls: boolean
  isPeeked: boolean
  onToggleBot: () => void
  onTogglePeek: () => void
  onCopyPerspective: () => void
  cardWidth: number
  cardHeight: number
  x: number
  y: number
}

function Seat({
  player,
  state,
  isYou,
  showHole,
  isWinner,
  cardsBelow,
  showControls,
  isPeeked,
  onToggleBot,
  onTogglePeek,
  onCopyPerspective,
  cardWidth,
  cardHeight,
  x,
  y,
}: SeatProps) {
  const hole: Card | undefined = player.cards[0]
  const upCards = player.cards.slice(1)
  const isActive = state.stage === 'betting' && state.toActSeat === player.seat
  const revealed = showHole && player.cards.length > 0

  const handLabel =
    revealed && state.revealedSeats.includes(player.seat) ? evaluateHand(player.cards).label : null

  const statusClass = player.outOfGame ? 'is-out' : player.folded ? 'is-folded' : ''
  const showBet = player.streetCommitted > 0 && !player.folded

  return (
    <div
      className={[
        'seat',
        isActive ? 'is-active' : '',
        isYou ? 'is-you' : '',
        cardsBelow ? 'cards-below' : '',
        statusClass,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: `${x}%`,
        top: `${y}%`,
        ['--card-w' as string]: `${cardWidth}px`,
        ['--card-h' as string]: `${cardHeight}px`,
      }}
    >
      <div className="seat-cards">
        {hole !== undefined && (
          <PlayingCard
            card={showHole || state.revealedSeats.includes(player.seat) ? hole : null}
            faceDown={!showHole && !state.revealedSeats.includes(player.seat)}
            isHole
            width={cardWidth}
            height={cardHeight}
            title="暗牌"
          />
        )}
        {upCards.map((card, i) => (
          <PlayingCard
            key={`${card.rank}${card.suit}-${i}`}
            card={card}
            width={cardWidth}
            height={cardHeight}
            title="明牌"
          />
        ))}
      </div>

      {/* Plate, bet and status stay together so the badge never drifts away
          from the name it belongs to. */}
      <div className="seat-info">
        <div className="seat-plate">
          {state.dealerSeat === player.seat && !player.outOfGame && (
            <span className="dealer-btn" title="庄家">
              D
            </span>
          )}
          <span className="seat-name">{player.name}</span>
          {isYou && player.name !== '你' ? (
            <span className="seat-you-tag">你</span>
          ) : player.isBot ? (
            <span className="seat-bot-tag">AI</span>
          ) : null}
          <span className={`seat-chips${player.chips === 0 ? ' is-broke' : ''}`}>
            {player.chips.toLocaleString('en-US')}
          </span>
        </div>

        {showBet && (
          <div className="seat-bet">
            <ChipStack amount={player.streetCommitted} max={4} />{' '}
            {player.streetCommitted.toLocaleString('en-US')}
          </div>
        )}

        {isWinner && (
          <div className="seat-badge winner">赢 {player.lastWin.toLocaleString('en-US')}</div>
        )}

        {!isWinner && handLabel && <div className="seat-hand-label">{handLabel}</div>}

        {!isWinner && !handLabel && player.allIn && !player.folded && (
          <div className="seat-badge allin">全下</div>
        )}

        {!isWinner && !handLabel && !player.allIn && player.folded && (
          <div className="seat-badge folded">弃牌</div>
        )}

        {!isWinner && !handLabel && !player.allIn && !player.folded && player.lastActionLabel && (
          <div className="seat-badge action">{player.lastActionLabel}</div>
        )}
      </div>

      {showControls && (
        <div className="seat-controls">
          <button
            className={`seat-ctl${player.isBot ? '' : ' on'}`}
            onClick={onToggleBot}
            title={player.isBot ? '改为真人控制' : '改为 AI 控制'}
          >
            {player.isBot ? '🤖' : '🧑'}
          </button>
          <button
            className={`seat-ctl${isPeeked ? ' on' : ''}`}
            onClick={onTogglePeek}
            title={isPeeked ? '隐藏该玩家的底牌' : '观看该玩家的底牌'}
          >
            {isPeeked ? '🙈' : '👁'}
          </button>
          <button
            className="seat-ctl"
            onClick={onCopyPerspective}
            title={`复制以 ${player.name} 视角的局面（对家底牌会被隐藏）`}
          >
            📋
          </button>
        </div>
      )}
    </div>
  )
}

export interface TableProps {
  state: GameState
  /** Seat the table is rotated around (placed at bottom-centre). */
  anchor: number
  /** Seat whose 暗牌 may be shown, or null for a public-only view. */
  perspective: number | null
  /** Seats the user explicitly uncovered. */
  peekedSeats: readonly number[]
  showSeatControls: boolean
  onToggleBot: (seat: number) => void
  onTogglePeek: (seat: number) => void
  onCopyPerspective: (seat: number) => void
  /** Board box, measured from the stage it sits in. */
  width: number
  height: number
}

export function Table({
  state,
  anchor,
  perspective,
  peekedSeats,
  showSeatControls,
  onToggleBot,
  onTogglePeek,
  onCopyPerspective,
  width,
  height,
}: TableProps) {
  const anchorSeat = state.players[anchor] ? anchor : 0
  const playerCount = state.players.length
  const { rx, ry, heroCardWidth: hero, otherCardWidth: other } = computeBoardMetrics(
    width,
    height,
    playerCount,
  )
  const ratio = 1.4

  if (width <= 0) return <div className="table-wrap" />

  return (
    <div className="table-wrap" style={{ width, height }}>
      <div className="table-rail">
        <div className="table-felt">
          <div className="pot">
            <div className="pot-label">底池 POT</div>
            <div className="pot-amount">{state.pot.toLocaleString('en-US')}</div>
            {state.potResults.length > 1 && (
              <div className="pot-breakdown">
                {state.potResults.map((result, i) => (
                  <span key={i} className="pot-chip">
                    {result.label} {result.amount.toLocaleString('en-US')}
                  </span>
                ))}
              </div>
            )}
            <div className="pot-breakdown">
              {state.stage === 'betting' && state.currentBet > 0 && (
                <span className="pot-chip">当前注额 {state.currentBet.toLocaleString('en-US')}</span>
              )}
              {state.stage === 'betting' && state.street >= 0 && (
                <span className="pot-chip">第 {state.street + 1} 轮</span>
              )}
              {state.stage === 'deal' && (
                <span className="pot-chip">
                  发牌中 · {state.dealRound === 0 ? '底牌' : `第 ${state.dealRound + 1} 张`}
                </span>
              )}
              {state.stage === 'showdown' && <span className="pot-chip">开牌中</span>}
            </div>
          </div>
        </div>
      </div>

      {state.players.map((player) => {
        const { x, y } = seatPosition(player.seat, playerCount, anchorSeat, rx, ry)
        const isYou = perspective === player.seat
        const cardWidth = isYou ? hero : other
        return (
          <Seat
            key={player.seat}
            player={player}
            state={state}
            isYou={isYou}
            showHole={holeVisible(state, player.seat, perspective, peekedSeats)}
            isWinner={
              state.winners.includes(player.seat) &&
              state.stage !== 'betting' &&
              state.stage !== 'deal'
            }
            // Hands grow toward the middle of the table: seats in the lower
            // half keep their cards above the nameplate, seats in the upper
            // half hang them below.
            cardsBelow={y <= 55}
            showControls={showSeatControls}
            isPeeked={peekedSeats.includes(player.seat)}
            onToggleBot={() => onToggleBot(player.seat)}
            onTogglePeek={() => onTogglePeek(player.seat)}
            onCopyPerspective={() => onCopyPerspective(player.seat)}
            cardWidth={cardWidth}
            cardHeight={Math.round(cardWidth * ratio)}
            x={x}
            y={y}
          />
        )
      })}
    </div>
  )
}
