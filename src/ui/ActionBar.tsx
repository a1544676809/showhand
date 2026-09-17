import { useEffect, useMemo, useState } from 'react'
import { betUnit } from '../engine/game'
import type { GameState, LegalActions, PlayerAction } from '../engine/types'

export interface ActionBarProps {
  state: GameState
  legal: LegalActions
  seat: number
  onAct: (action: PlayerAction) => void
  speed: number
}

/**
 * The betting controls for whoever is on turn. Amounts are always expressed as
 * a *total street commitment* (what the engine wants), while the UI shows the
 * incremental cost so it matches how players think about a call.
 */
export function ActionBar({ state, legal, seat, onAct }: ActionBarProps) {
  const player = state.players[seat]
  const unit = betUnit(state.config, state.street)

  const min = legal.raise ? legal.minRaiseTo : 0
  const max = legal.raise ? legal.maxRaiseTo : 0
  const [raiseTo, setRaiseTo] = useState(min)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    setRaiseTo(min)
    setTouched(false)
  }, [min, max, state.revision])

  const presets = useMemo(() => {
    if (!legal.raise) return []
    const pot = Math.max(state.pot, unit)
    const options: { label: string; value: number }[] = [
      { label: '最小', value: min },
      { label: '½ 池', value: state.currentBet + Math.round(pot * 0.5) },
      { label: '⅔ 池', value: state.currentBet + Math.round(pot * 0.66) },
      { label: '1 池', value: state.currentBet + pot },
      { label: '全下', value: max },
    ]
    const seen = new Set<number>()
    return options
      .map((option) => ({
        ...option,
        value: Math.max(min, Math.min(max, Math.round(option.value / 5) * 5)),
      }))
      .filter((option) => {
        if (seen.has(option.value)) return false
        seen.add(option.value)
        return true
      })
  }, [legal.raise, min, max, state.pot, state.currentBet, unit])

  const effectiveRaiseTo = Math.max(min, Math.min(max, raiseTo))
  const raiseCost = effectiveRaiseTo - player.streetCommitted
  const toCall = legal.callAmount

  if (state.stage === 'deal' || state.stage === 'showdown') {
    return (
      <div className="actionbar">
        <div className="actionbar-waiting">
          <span className="pulse-dot" />
          {state.stage === 'deal' ? '发牌中……' : '正在开牌比大小……'}
        </div>
      </div>
    )
  }

  return (
    <div className="actionbar">
      <div className="actionbar-main">
        <button className="btn danger" onClick={() => onAct({ type: 'fold' })} disabled={!legal.fold}>
          弃牌
        </button>

        {legal.check ? (
          <button className="btn" onClick={() => onAct({ type: 'check' })}>
            过牌
          </button>
        ) : (
          <button className="btn" onClick={() => onAct({ type: 'call' })} disabled={!legal.call}>
            {toCall >= player.chips
              ? `全下跟注 ${toCall.toLocaleString('en-US')}`
              : `跟注 ${toCall.toLocaleString('en-US')}`}
          </button>
        )}
      </div>

      {legal.raise && (
        <div className="raise-control">
          <span className="control-label" style={{ whiteSpace: 'nowrap' }}>
            加注到
          </span>
          <input
            type="range"
            min={min}
            max={max}
            step={Math.max(1, Math.min(5, unit))}
            value={effectiveRaiseTo}
            onChange={(e) => {
              setTouched(true)
              setRaiseTo(Number(e.target.value))
            }}
          />
          <span className="raise-value">{effectiveRaiseTo.toLocaleString('en-US')}</span>
          <div className="preset-row">
            {presets.map((preset) => (
              <button
                key={preset.label}
                className={`btn tiny${touched && effectiveRaiseTo === preset.value ? ' active' : ''}`}
                onClick={() => {
                  setTouched(true)
                  setRaiseTo(preset.value)
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button
            className="btn primary"
            onClick={() => onAct({ type: 'raise', amount: effectiveRaiseTo })}
          >
            {state.currentBet === 0 ? '下注' : '加注'} {raiseCost.toLocaleString('en-US')}
          </button>
        </div>
      )}

      <div className="spacer" />

      {legal.allin && (
        <button className="btn danger" onClick={() => onAct({ type: 'allin' })}>
          梭哈 {legal.allinAmount.toLocaleString('en-US')}
        </button>
      )}
    </div>
  )
}

/**
 * Shown when the engine is waiting on someone else — or, in 手动 mode, when it
 * is waiting on the user to release the next step.
 */
export function WaitingBar({
  state,
  speed,
  nextStepLabel,
  hasPendingStep,
  onAdvance,
}: {
  state: GameState
  speed: number
  nextStepLabel: string
  hasPendingStep: boolean
  onAdvance: () => void
}) {
  const actor = state.toActSeat === null ? null : state.players[state.toActSeat]
  const manual = speed === 0

  return (
    <div className={manual ? 'step-bar' : 'actionbar'}>
      <div className="actionbar-waiting">
        <span className="pulse-dot" />
        {manual ? '逐张推进' : actor ? `等待 ${actor.name} 行动……` : '等待中……'}
      </div>

      {manual && (
        <>
          <span className="step-next">
            下一步
            <span className="step-chip">{nextStepLabel}</span>
          </span>
          <div className="spacer" />
          <button className="btn primary" onClick={onAdvance} disabled={!hasPendingStep}>
            翻出下一张 ▸
          </button>
        </>
      )}
    </div>
  )
}
