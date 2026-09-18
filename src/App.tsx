import { useEffect, useMemo, useRef, useState } from 'react'
import { cardId, makeDeck } from './engine/cards'
import { legalActions } from './engine/game'
import { renderSummaryText } from './engine/text'
import type { PlayerAction } from './engine/types'
import { ActionBar, WaitingBar } from './ui/ActionBar'
import { computeTableSize, useElementSize } from './ui/layout'
import {
  LogList,
  LogModal,
  Modal,
  PrivacyGate,
  ProofPanel,
  ResultBand,
  RulesPanel,
  TextExportPanel,
  Toast,
  copyText,
} from './ui/panels'
import { SetupScreen } from './ui/SetupScreen'
import { Table } from './ui/Table'
import { useTheme } from './ui/theme'
import { readQuickStart } from './ui/quickstart'
import { SPEED_LABEL, useGameController, type Speed } from './ui/useGameController'

type ModalKind = 'none' | 'summary' | 'full' | 'rules' | 'proof' | 'log'

const SPEEDS: Speed[] = [0, 1, 2, 4]

/** Warm the browser cache so a showdown reveal never flashes empty. */
function usePreloadedCards() {
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const url of [
        ...makeDeck(52).map((card) => `/cards/${cardId(card)}.png`),
        '/cards/BACK.png',
      ]) {
        const img = new Image()
        img.src = url
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [])
}

/** Compact button: the icon always shows, the text label only when there is room. */
function ToolButton({
  icon,
  label,
  onClick,
  className = '',
  title,
  active,
  disabled,
}: {
  icon: string
  label: string
  onClick: () => void
  className?: string
  title?: string
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      className={`btn ghost small ${className}${active ? ' active' : ''}`}
      onClick={onClick}
      title={title ?? label}
      disabled={disabled}
    >
      <span className="btn-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="btn-label">{label}</span>
    </button>
  )
}

export default function App() {
  const controller = useGameController()
  const { theme, toggle: toggleTheme } = useTheme()
  const [modal, setModal] = useState<ModalKind>('none')
  /** Seat the export panel should open on, set by the topbar button. */
  const [exportSeat, setExportSeat] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [stageRef, stageSize] = useElementSize<HTMLDivElement>()
  usePreloadedCards()

  const showToast = (message: string) => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }

  const { state, setup, perspective, peekedSeats, anchorSeat, exportPerspective, speed } = controller

  const tableSize = useMemo(
    () => computeTableSize(stageSize.width, stageSize.height, state?.players.length ?? 5),
    [stageSize.width, stageSize.height, state?.players.length],
  )

  const legal = useMemo(
    () =>
      state && state.stage === 'betting' && state.toActSeat !== null
        ? legalActions(state, state.toActSeat)
        : null,
    [state],
  )

  const actorSeat = state?.stage === 'betting' ? state.toActSeat : null
  const actor = actorSeat === null || !state ? null : state.players[actorSeat]
  /** 上帝视角 is a director's seat: the person at the keyboard bets for anyone. */
  const directorMode = setup?.mode === 'god'

  // Who may press the betting buttons right now?
  //  - the seat's own player, when it is their turn and they are human, or
  //  - the director, in god mode, for whichever seat is on turn.
  const controlsActingSeat =
    actorSeat !== null &&
    actor !== null &&
    ((!actor.isBot && perspective === actorSeat) || directorMode)

  const handFinished = state?.stage === 'handOver' || state?.stage === 'gameOver'

  // ------------------------------------------------- shareable quick-start
  const quickStarted = useRef(false)
  useEffect(() => {
    if (quickStarted.current) return
    const quick = readQuickStart(window.location.search)
    if (!quick || !quick.autostart) return
    quickStarted.current = true
    controller.newSession(quick.setup)
    if (quick.perspective !== null) controller.setPerspective(quick.perspective)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --------------------------------------------------------- key shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === ' ' && handFinished) {
        e.preventDefault()
        controller.nextHand()
        return
      }
      if ((e.key === 'Enter' || e.key === 'ArrowRight') && speed === 0 && controller.hasPendingStep) {
        e.preventDefault()
        controller.advance()
        return
      }
      if (!controlsActingSeat || !legal) return
      const fire = (action: PlayerAction) => {
        e.preventDefault()
        controller.act(action)
      }
      switch (e.key.toLowerCase()) {
        case 'f':
          if (legal.fold) fire({ type: 'fold' })
          break
        case 'c':
          if (legal.check) fire({ type: 'check' })
          else if (legal.call) fire({ type: 'call' })
          break
        case 'r':
          if (legal.raise) fire({ type: 'raise', amount: legal.minRaiseTo })
          break
        case 'a':
          if (legal.allin) fire({ type: 'allin' })
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handFinished, controlsActingSeat, legal, speed, controller])

  // ------------------------------------------------------------------ views
  if (!state || !setup) {
    return (
      <div className="app">
        <SetupScreen
          initial={setup}
          bankroll={controller.bankroll}
          onStart={controller.newSession}
          onResetBankroll={controller.resetBankroll}
        />
      </div>
    )
  }

  const me = perspective === null ? null : state.players[perspective]
  const ranking = [...state.players].sort((a, b) => b.chips - a.chips)
  const manual = speed === 0
  const showActionBar = state.stage === 'betting' && legal !== null && controlsActingSeat && actorSeat !== null
  const showStepBar =
    !showActionBar && (state.stage === 'betting' || state.stage === 'deal' || state.stage === 'showdown')

  const openExport = (seat: number | null, kind: ModalKind = 'summary') => {
    setExportSeat(seat)
    setModal(kind)
  }

  /** Per-seat 📋 copies straight to the clipboard — no modal. */
  const copySeatSummary = async (seat: number) => {
    const name = state.players[seat]?.name ?? `座位 ${seat}`
    const ok = await copyText(renderSummaryText(state, seat))
    showToast(ok ? `已复制「${name}」视角的局面` : '复制失败，请改用顶栏的「复制战况」')
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-zh">梭哈</span>
          <span className="brand-en">Five-Card Stud</span>
        </div>

        <div className="topbar-stats">
          <div className="stat">
            <span className="stat-label">局 / 手</span>
            <span className="stat-value">
              第{controller.sessionNo}局 · {state.handNo}手
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">底池</span>
            <span className="stat-value gold">{state.pot.toLocaleString('en-US')}</span>
          </div>
          <div className="stat optional">
            <span className="stat-label">视角</span>
            <span className="stat-value" style={{ fontSize: 12.5 }}>
              {setup.mode === 'hotseat'
                ? `${state.players[anchorSeat]?.name ?? '—'}（轮流）`
                : (me?.name ?? '导演视角')}
            </span>
          </div>
          <div className="stat optional">
            <span className="stat-label">庄家</span>
            <span className="stat-value" style={{ fontSize: 12.5 }}>
              {state.players[state.dealerSeat]?.name ?? '—'}
            </span>
          </div>
        </div>

        <div className="topbar-spacer" />

        <div className="topbar-actions">
          <div className="seg" title="发牌与 AI 的节奏">
            {SPEEDS.map((s) => (
              <button key={s} className={speed === s ? 'on' : ''} onClick={() => controller.setSpeed(s)}>
                {SPEED_LABEL[s]}
              </button>
            ))}
          </div>

          <button className="btn small" onClick={() => openExport(exportPerspective, 'summary')}>
            <span className="btn-icon" aria-hidden="true">
              📋
            </span>
            <span className="btn-label">复制战况</span>
          </button>

          <ToolButton
            icon="🎛"
            label="座位控制"
            active={controller.showSeatControls}
            onClick={() => controller.setShowSeatControls(!controller.showSeatControls)}
            title="显示/隐藏每个座位旁边的操作按钮"
          />
          <ToolButton icon="📄" label="完整局面" onClick={() => openExport(exportPerspective, 'full')} className="wide-only" />
          <ToolButton icon="🧾" label="记录" onClick={() => setModal('log')} className="log-drawer-only" />
          <ToolButton icon="🔒" label="公正性" onClick={() => setModal('proof')} />
          <ToolButton icon="📖" label="规则" onClick={() => setModal('rules')} />

          <button
            className="btn primary"
            disabled={!handFinished}
            onClick={controller.nextHand}
            title="下一手（空格）"
          >
            {state.stage === 'gameOver' ? '牌局已结束' : '下一手'}
          </button>

          <ToolButton
            icon="↻"
            label="重新开始"
            onClick={controller.restart}
            title={`原地重开：保留座位与筹码记录，开始第 ${controller.sessionNo + 1} 局`}
          />
          <ToolButton icon="🚪" label="离开" onClick={controller.leave} title="回到设置界面" />

          <button
            className="btn ghost small"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
          >
            <span className="btn-icon" aria-hidden="true">
              {theme === 'dark' ? '☀️' : '🌙'}
            </span>
            <span className="btn-label">{theme === 'dark' ? '亮色' : '暗色'}</span>
          </button>
        </div>
      </header>

      <div className="app-body">
        <main className="app-main">
          <div className="table-stage" ref={stageRef}>
            <Table
              state={state}
              anchor={anchorSeat}
              perspective={perspective}
              peekedSeats={peekedSeats}
              showSeatControls={controller.showSeatControls}
              directedSeat={directorMode && showActionBar ? actorSeat : null}
              onToggleBot={(seat) => controller.setSeatBot(seat, !state.players[seat].isBot)}
              onTogglePeek={controller.togglePeek}
              onCopyPerspective={copySeatSummary}
              width={tableSize.width}
              height={tableSize.height}
            />
          </div>

          {handFinished && <ResultBand state={state} />}

          {/* Above the betting bar, so the bar itself is flush with the bottom
              of the screen where the thumbs are. */}
          <div className="hotkey-hint">
            快捷键：<b>F</b> 弃牌 · <b>C</b> 过牌/跟注 · <b>R</b> 最小加注 · <b>A</b> 梭哈 ·{' '}
            <b>空格</b> 下一手
            {manual && (
              <>
                {' · '}
                <b>Enter</b> 下一步
              </>
            )}
          </div>

          {showActionBar ? (
            <ActionBar
              state={state}
              legal={legal}
              seat={actorSeat}
              onAct={controller.act}
              speed={speed}
              onBehalfOf={directorMode && actor && actor.isBot ? actor.name : null}
            />
          ) : showStepBar ? (
            <WaitingBar
              state={state}
              speed={speed}
              nextStepLabel={controller.nextStepLabel}
              hasPendingStep={controller.hasPendingStep}
              onAdvance={controller.advance}
            />
          ) : (
            <div className="actionbar">
              <div className="actionbar-waiting">
                <span className="pulse-dot" />
                {state.stage === 'gameOver' ? '本局已结束' : '本手已结束'}
              </div>
              <div className="spacer" />
              <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                可导出「速览」分享战况，或按空格开始下一手。
              </span>
            </div>
          )}
        </main>

        <aside className="side-panel">
          <div className="side-panel-header">
            <span>行动记录</span>
            <span>
              第{controller.sessionNo}局 · {state.handNo}手
            </span>
          </div>
          <LogList state={state} />
        </aside>
      </div>

      {controller.gateSeat !== null && state.players[controller.gateSeat] && (
        <PrivacyGate
          name={state.players[controller.gateSeat].name}
          seat={controller.gateSeat}
          cardCount={state.players[controller.gateSeat].cards.length}
          onReveal={controller.clearGate}
        />
      )}

      {(modal === 'summary' || modal === 'full') && (
        <TextExportPanel
          state={state}
          perspective={exportSeat ?? exportPerspective}
          initialFormat={modal === 'summary' ? 'summary' : 'full'}
          onClose={() => setModal('none')}
        />
      )}
      {modal === 'rules' && <RulesPanel onClose={() => setModal('none')} />}
      {modal === 'proof' && <ProofPanel state={state} onClose={() => setModal('none')} />}
      {modal === 'log' && <LogModal state={state} onClose={() => setModal('none')} />}

      <Toast message={toast} />

      {state.stage === 'gameOver' && modal === 'none' && (
        <Modal
          title="本局结束"
          subtitle={`第 ${controller.sessionNo} 局 · 共进行 ${state.handNo} 手`}
          onClose={() => setModal('none')}
          narrow
          footer={
            <>
              <button className="btn" onClick={controller.leave}>
                离开
              </button>
              <div className="spacer" />
              <button className="btn primary" onClick={controller.restart}>
                重新开始（第 {controller.sessionNo + 1} 局）
              </button>
            </>
          }
        >
          <div className="rules">
            <ol>
              {ranking.map((player, index) => (
                <li key={player.seat}>
                  <b>{player.name}</b> — {player.chips.toLocaleString('en-US')} 筹码
                  {player.playerId ? `（标识符 ${player.playerId} 已记录）` : '（未记录）'}
                  {index === 0 && player.chips > 0 ? ' 🏆 赢下全部筹码' : ''}
                </li>
              ))}
            </ol>
          </div>
        </Modal>
      )}
    </div>
  )
}
