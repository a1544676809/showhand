import { useEffect, useMemo, useState } from 'react'
import type { BettingMode, GameConfig } from '../engine/types'
import { describeEntry, type Bankroll } from './bankroll'
import { defaultSeat, type GameMode, type SeatSetup, type TableSetup } from './useGameController'

const MODES: { id: GameMode; title: string; desc: string; icon: string }[] = [
  {
    id: 'hotseat',
    title: '同屏轮流',
    desc: '每个座位默认由真人控制，轮到谁就切到谁的视角，并弹出遮挡页防止偷看。',
    icon: '🧑‍🤝‍🧑',
  },
  {
    id: 'god',
    title: '上帝视角',
    desc: '每个座位默认由 AI 控制，逐张手动推进；底牌默认隐藏，想看谁的牌就点谁旁边的眼睛。',
    icon: '👁️',
  },
]

const DEFAULT_CONFIG: GameConfig = {
  ante: 10,
  smallBet: 20,
  bigBet: 40,
  maxRaisesPerStreet: 0,
  bettingMode: 'no-limit',
  deckSize: 52,
}

function clampNumber(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function SetupScreen({
  initial,
  bankroll,
  onStart,
  onResetBankroll,
}: {
  initial: TableSetup | null
  bankroll: Bankroll
  onStart: (setup: TableSetup) => void
  onResetBankroll: () => void
}) {
  const [mode, setMode] = useState<GameMode>(initial?.mode ?? 'hotseat')
  const [seats, setSeats] = useState<SeatSetup[]>(
    () => initial?.seats ?? Array.from({ length: 3 }, (_, i) => defaultSeat(i, 'hotseat')),
  )
  const [config, setConfig] = useState<GameConfig>(initial?.config ?? DEFAULT_CONFIG)
  const [useSeed, setUseSeed] = useState(Boolean(initial?.seed))
  const [seed, setSeed] = useState(initial?.seed ?? '')

  // Late-arriving prefill when the controller restores the last table.
  useEffect(() => {
    if (!initial) return
    setMode(initial.mode)
    setSeats(initial.seats)
    setConfig(initial.config)
    setSeed(initial.seed ?? '')
    setUseSeed(Boolean(initial.seed))
  }, [initial])

  const playerCount = seats.length

  const patchSeat = (index: number, patch: Partial<SeatSetup>) => {
    setSeats((current) => current.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)))
  }

  const changeMode = (next: GameMode) => {
    setMode(next)
    setSeats((current) =>
      current.map((seat, i) => {
        const base = defaultSeat(i, next)
        // Only swap names still coming from one of the default pools.
        const isDefaultName =
          seat.name === defaultSeat(i, 'hotseat').name || seat.name === defaultSeat(i, 'god').name
        return { ...seat, name: isDefaultName ? base.name : seat.name, isBot: base.isBot }
      }),
    )
  }

  const changeCount = (count: number) => {
    setSeats((current) => {
      if (count <= current.length) return current.slice(0, count)
      const extra = Array.from({ length: count - current.length }, (_, i) =>
        defaultSeat(current.length + i, mode),
      )
      return [...current, ...extra]
    })
  }

  /**
   * Typing a known identifier pulls that player's bankroll back in. The inputs
   * stay editable, so the amount can still be overridden for this session.
   */
  const applyIdentity = (index: number, raw: string) => {
    const id = raw.slice(0, 24)
    const entry = id.trim() ? bankroll[id.trim()] : undefined
    setSeats((current) =>
      current.map((seat, i) => {
        if (i !== index) return seat
        if (!entry) return { ...seat, playerId: id }
        const isDefaultName =
          seat.name === defaultSeat(i, 'hotseat').name || seat.name === defaultSeat(i, 'god').name
        return {
          ...seat,
          playerId: id,
          chips: entry.chips,
          name: isDefaultName && entry.name ? entry.name : seat.name,
        }
      }),
    )
  }

  const identifiedCount = useMemo(
    () => seats.filter((seat) => seat.playerId.trim()).length,
    [seats],
  )
  const savedCount = useMemo(
    () => seats.filter((seat) => seat.playerId.trim() && bankroll[seat.playerId.trim()]).length,
    [seats, bankroll],
  )

  const start = () => {
    onStart({
      mode,
      seats: seats.map((seat) => ({ ...seat, chips: Math.max(1, seat.chips) })),
      config,
      seed: useSeed && seed.trim() ? seed.trim() : undefined,
    })
  }

  const humanSeats = seats.filter((seat) => !seat.isBot).length

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-hero">
          <h1 className="setup-title">梭哈</h1>
          <p className="setup-tagline">
            经典五张梭哈（Five-Card Stud）：一张暗牌加四张明牌，四轮下注，
            由明牌最大者先说话。支持 2–5 人、底注与加注封顶、全下与边池，
            并且每一手牌的发牌顺序都可以事后复现验证。
          </p>
        </div>

        <div className="setup-body">
          <div className="field-group">
            <span className="field-label">对战方式</span>
            <div className="mode-grid">
              {MODES.map((option) => (
                <button
                  key={option.id}
                  className={`mode-card${mode === option.id ? ' on' : ''}`}
                  onClick={() => changeMode(option.id)}
                >
                  <div className="mode-card-title">
                    <span>{option.icon}</span>
                    {option.title}
                  </div>
                  <div className="mode-card-desc">{option.desc}</div>
                </button>
              ))}
            </div>
            <p className="field-hint">
              两种模式只是初始值不同 —— 开局后打开顶栏的 <b>「座位控制」</b>
              ，每个座位旁边会出现按钮，可以随时把任意座位在 AI 与真人之间来回切换，
              两种模式由此无缝互通。
            </p>
          </div>

          <div className="field-group">
            <span className="field-label">玩家人数</span>
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              {[2, 3, 4, 5].map((count) => (
                <button
                  key={count}
                  className={playerCount === count ? 'on' : ''}
                  onClick={() => changeCount(count)}
                >
                  {count} 人
                </button>
              ))}
            </div>
          </div>

          <div className="field-group">
            <span className="field-label">
              座位 · 标识符与筹码
              <span className="field-note">
                填写标识符才会记录该玩家的筹码；留空则本局既不读取也不写入
              </span>
            </span>
            <div className="player-rows">
              <div className="player-row player-row-head">
                <span />
                <span>昵称</span>
                <span>标识符（可选）</span>
                <span>筹码</span>
                <span>筹码记录</span>
                <span>控制</span>
              </div>
              {seats.map((seat, index) => {
                const id = seat.playerId.trim()
                const entry = id ? bankroll[id] : undefined
                return (
                  <div className="player-row" key={index}>
                    <span className="seat-index">{index}</span>
                    <input
                      className="text-input"
                      value={seat.name}
                      maxLength={12}
                      placeholder={`玩家 ${index}`}
                      onChange={(e) => patchSeat(index, { name: e.target.value })}
                    />
                    <input
                      className="text-input mono"
                      value={seat.playerId}
                      maxLength={24}
                      placeholder="例如 alice"
                      onChange={(e) => applyIdentity(index, e.target.value)}
                    />
                    <input
                      className="number-input"
                      type="number"
                      min={1}
                      step={100}
                      value={seat.chips}
                      onChange={(e) =>
                        patchSeat(index, {
                          chips: clampNumber(e.target.value, 1, 100_000_000, seat.chips),
                        })
                      }
                    />
                    <span className={`bank-cell${entry ? ' saved' : ''}`}>
                      {id ? (entry ? describeEntry(entry) : '— 尚未记录') : '不记录'}
                    </span>
                    <button
                      className={`ctl-toggle${seat.isBot ? '' : ' human'}`}
                      onClick={() => patchSeat(index, { isBot: !seat.isBot })}
                      title={
                        seat.isBot
                          ? 'AI 控制 —— 点击改为真人控制'
                          : '真人控制 —— 点击改为 AI 控制'
                      }
                    >
                      {seat.isBot ? '🤖 AI' : '🧑 真人'}
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="field-actions">
              <span className="field-note">
                已填标识符 {identifiedCount} 位 · 命中记录 {savedCount} 位
              </span>
              <div className="spacer" />
              <button
                className="btn ghost small"
                onClick={onResetBankroll}
                disabled={Object.keys(bankroll).length === 0}
                title="清空本机保存的所有筹码记录"
              >
                清除全部筹码记录（{Object.keys(bankroll).length}）
              </button>
            </div>
          </div>

          <div className="field-group">
            <span className="field-label">牌局参数</span>
            <div className="param-grid">
              <label className="param">
                <span className="param-label">底注（每人先投入）</span>
                <input
                  className="number-input"
                  type="number"
                  min={1}
                  step={5}
                  value={config.ante}
                  onChange={(e) =>
                    setConfig({ ...config, ante: clampNumber(e.target.value, 1, 100_000, 10) })
                  }
                />
              </label>
              <label className="param">
                <span className="param-label">第 1–2 轮最小注</span>
                <input
                  className="number-input"
                  type="number"
                  min={1}
                  step={5}
                  value={config.smallBet}
                  onChange={(e) =>
                    setConfig({ ...config, smallBet: clampNumber(e.target.value, 1, 100_000, 20) })
                  }
                />
              </label>
              <label className="param">
                <span className="param-label">第 3–4 轮最小注</span>
                <input
                  className="number-input"
                  type="number"
                  min={1}
                  step={5}
                  value={config.bigBet}
                  onChange={(e) =>
                    setConfig({ ...config, bigBet: clampNumber(e.target.value, 1, 100_000, 40) })
                  }
                />
              </label>
              <div className="param">
                <span className="param-label">下注模式</span>
                <div className="seg" style={{ alignSelf: 'flex-start' }}>
                  {(['no-limit', 'fixed-limit'] as BettingMode[]).map((id) => (
                    <button
                      key={id}
                      className={config.bettingMode === id ? 'on' : ''}
                      onClick={() =>
                        setConfig({
                          ...config,
                          bettingMode: id,
                          maxRaisesPerStreet: id === 'fixed-limit' ? 4 : 0,
                        })
                      }
                    >
                      {id === 'no-limit' ? '无限注' : '有限注'}
                    </button>
                  ))}
                </div>
              </div>
              <label className="param">
                <span className="param-label">每轮加注封顶（0 = 不限）</span>
                <input
                  className="number-input"
                  type="number"
                  min={0}
                  step={1}
                  value={config.maxRaisesPerStreet}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      maxRaisesPerStreet: clampNumber(e.target.value, 0, 20, 0),
                    })
                  }
                />
              </label>
              <div className="param">
                <span className="param-label">牌堆</span>
                <div className="seg" style={{ alignSelf: 'flex-start' }}>
                  {([52, 28] as const).map((size) => (
                    <button
                      key={size}
                      className={config.deckSize === size ? 'on' : ''}
                      onClick={() => setConfig({ ...config, deckSize: size })}
                    >
                      {size === 52 ? '52 张' : '28 张（港式）'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="field-group">
            <span className="field-label">可复现种子（可选）</span>
            <div className="field-row">
              <label className="checkbox">
                <input type="checkbox" checked={useSeed} onChange={(e) => setUseSeed(e.target.checked)} />
                固定种子
              </label>
              <input
                className="text-input"
                value={seed}
                disabled={!useSeed}
                placeholder="留空则使用随机种子；填写后每一手都可完整复现"
                onChange={(e) => setSeed(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ borderTop: '1px solid var(--line)' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            {playerCount} 人 · 底注 {config.ante} · 最小注 {config.smallBet}/{config.bigBet} ·{' '}
            {config.bettingMode === 'no-limit' ? '无限注' : '有限注'} · 真人 {humanSeats} 位
          </span>
          <div className="spacer" />
          <button className="btn primary" style={{ padding: '10px 28px', fontSize: 14.5 }} onClick={start}>
            开始牌局
          </button>
        </div>
      </div>
    </div>
  )
}
