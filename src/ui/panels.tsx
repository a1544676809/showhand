import { useCallback, useEffect, useMemo, useState } from 'react'
import { cardId, cardText, verifyShuffle } from '../engine/cards'
import { exportStateJSON, renderCompactText, renderSummaryText, renderTableText } from '../engine/text'
import type { GameState, LogEntry } from '../engine/types'

// ------------------------------------------------------------------- modal

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  narrow,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  narrow?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${narrow ? ' narrow' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <div className="modal-title">{title}</div>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          <div className="spacer" />
          <button className="btn ghost small" onClick={onClose}>
            关闭 ESC
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------- text export

type ExportFormat = 'summary' | 'full' | 'compact' | 'json'

const FORMAT_LABELS: Record<ExportFormat, string> = {
  summary: '速览',
  full: '完整',
  compact: '简洁',
  json: 'JSON',
}

const FORMAT_HINTS: Record<ExportFormat, string> = {
  summary: '一行一位玩家：牌型、下注、筹码，适合直接贴给 AI 或群聊',
  full: '完整的牌局报告，含行动记录与公正性信息',
  compact: '四行摘要',
  json: '结构化数据，供程序读取',
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function TextExportPanel({
  state,
  perspective: initialPerspective,
  initialFormat = 'summary',
  onClose,
}: {
  state: GameState
  perspective: number | null
  initialFormat?: ExportFormat
  onClose: () => void
}) {
  const [format, setFormat] = useState<ExportFormat>(initialFormat)
  const [includeHistory, setIncludeHistory] = useState(true)
  const [includeHints, setIncludeHints] = useState(true)
  const [includeProof, setIncludeProof] = useState(true)
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')

  // Deliberately local: picking a seat here must NOT rotate the table or reveal
  // that player's 暗牌 on screen.
  const [perspective, setPerspective] = useState<number | null>(initialPerspective)

  const text = useMemo(() => {
    if (format === 'summary') return renderSummaryText(state, perspective)
    if (format === 'compact') return renderCompactText(state, perspective)
    if (format === 'json') return exportStateJSON(state, perspective)
    return renderTableText(state, {
      perspective,
      includeHistory,
      includeHints,
      includeProof,
    })
  }, [state, perspective, format, includeHistory, includeHints, includeProof])

  const handleCopy = useCallback(async () => {
    const ok = await copyText(text)
    setCopied(ok ? 'ok' : 'fail')
    setTimeout(() => setCopied('idle'), 1800)
  }, [text])

  const filename = `showhand-hand${state.handNo}-seat${perspective ?? 'obs'}-${format}.${format === 'json' ? 'json' : 'txt'}`

  return (
    <Modal
      title="按玩家视角导出局面"
      subtitle={FORMAT_HINTS[format]}
      onClose={onClose}
      footer={
        <>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {text.split('\n').length} 行 · {text.length} 字符
          </span>
          <div className="spacer" />
          <button className="btn" onClick={() => downloadText(filename, text)}>
            下载文件
          </button>
          <button className="btn primary" onClick={handleCopy}>
            {copied === 'ok' ? '✓ 已复制' : copied === 'fail' ? '复制失败' : '复制到剪贴板'}
          </button>
        </>
      }
    >
      <div className="export-controls">
        <div className="control-group">
          <span className="control-label">视角</span>
          <div className="seg">
            {state.players.map((player) => (
              <button
                key={player.seat}
                className={perspective === player.seat ? 'on' : ''}
                onClick={() => setPerspective(player.seat)}
              >
                {player.name}
              </button>
            ))}
            <button className={perspective === null ? 'on' : ''} onClick={() => setPerspective(null)}>
              观战者
            </button>
          </div>
        </div>

        <div className="control-group">
          <span className="control-label">格式</span>
          <div className="seg">
            {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((key) => (
              <button key={key} className={format === key ? 'on' : ''} onClick={() => setFormat(key)}>
                {FORMAT_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        {format === 'full' && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeHistory}
                onChange={(e) => setIncludeHistory(e.target.checked)}
              />
              行动记录
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeHints}
                onChange={(e) => setIncludeHints(e.target.checked)}
              />
              牌型提示
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeProof}
                onChange={(e) => setIncludeProof(e.target.checked)}
              />
              公正性信息
            </label>
          </>
        )}
      </div>

      <pre className="text-output">{text}</pre>
    </Modal>
  )
}

// ------------------------------------------------------------- log drawer

/** Full log in a modal — used on narrow screens where the side panel is hidden. */
export function LogModal({ state, onClose }: { state: GameState; onClose: () => void }) {
  return (
    <Modal title="行动记录" subtitle={`第 ${state.handNo} 手`} onClose={onClose} narrow>
      <LogList state={state} />
    </Modal>
  )
}

// -------------------------------------------------------------------- log

const LOG_MARKERS: Record<LogEntry['kind'], string> = {
  ante: '底注',
  deal: '发牌',
  action: '行动',
  street: '轮次',
  showdown: '开牌',
  payout: '派彩',
  info: '信息',
}

/** The scrolling entry list, shared by the side panel and the mobile drawer. */
export function LogList({ state }: { state: GameState }) {
  const entries = state.log.filter((entry) => entry.hand === state.handNo)
  return (
    <div className="log-list">
      {entries.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>尚未开始。</div>
      )}
      {entries.map((entry, i) => (
        <div key={i} className={`log-entry kind-${entry.kind}`}>
          <span className="marker">{LOG_MARKERS[entry.kind]}</span>
          <span>{entry.text}</span>
        </div>
      ))}
    </div>
  )
}

export function LogPanel({ state }: { state: GameState }) {
  return (
    <aside className="side-panel">
      <div className="side-panel-header">
        <span>行动记录</span>
        <span>第 {state.handNo} 手</span>
      </div>
      <LogList state={state} />
    </aside>
  )
}

// ------------------------------------------------------------------ rules

const RANKINGS: [string, string, string][] = [
  ['同花顺', 'Straight Flush', '五张同花色且连续，如 A♠K♠Q♠J♠10♠'],
  ['铁支', 'Four of a Kind', '四张同点数，如 4♣4♦4♥4♠9♥'],
  ['葫芦', 'Full House', '三条 + 一对，如 8♣8♦8♠K♥K♠'],
  ['同花', 'Flush', '五张同花色但不连续'],
  ['顺子', 'Straight', '五张连续，A 可作最大或最小（A2345 为 5 高）'],
  ['三条', 'Three of a Kind', '三张同点数'],
  ['二对', 'Two Pair', '两个对子'],
  ['对子', 'One Pair', '一个对子'],
  ['散牌', 'High Card', '以上皆非，比最大单张'],
]

export function RulesPanel({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="梭哈 · 五张规则" subtitle="Five-Card Stud" onClose={onClose} narrow={false}>
      <div className="rules">
        <section>
          <h3>牌局流程</h3>
          <ol>
            <li>每位玩家先下<b>底注</b>（本作默认 10）。</li>
            <li>
              从庄家左手边开始，每人发两张牌：<b>第一张暗牌</b>（底牌，只有自己看得到）、
              <b>第二张明牌</b>。
            </li>
            <li>
              此后每轮再发一张明牌，共发满 <b>五张</b>（一暗四明）。每发完一张明牌进行一轮下注，
              因此共 <b>四轮</b>下注。
            </li>
            <li>
              <b>由明牌最大者先说话</b>（明牌成对、成三条者优先；同点数比花色）。之后顺时针依次行动。
            </li>
            <li>五张发完后最后一轮下注结束，亮牌比大小；只剩一人未弃牌则直接获胜，无需亮牌。</li>
          </ol>
        </section>

        <section>
          <h3>可用动作</h3>
          <ul>
            <li><code>弃牌 fold</code> — 放弃本手已投入的筹码。</li>
            <li><code>过牌 check</code> — 无人下注时跳过，不投入筹码。</li>
            <li><code>跟注 call</code> — 补足到当前注额。</li>
            <li><code>加注 raise</code> — 提高到更高的注额，加注幅度不得低于上一次的加注幅度。</li>
            <li><code>梭哈 allin</code> — 押上全部剩余筹码。筹码不足时只能跟到自己的上限，多余部分形成<b>边池</b>。</li>
          </ul>
        </section>

        <section>
          <h3>牌型大小</h3>
          <table className="rank-table">
            <thead>
              <tr>
                <th>牌型</th>
                <th>English</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {RANKINGS.map(([zh, en, desc]) => (
                <tr key={zh}>
                  <td>{zh}</td>
                  <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{en}</td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3>花色大小（本作关键规则）</h3>
          <p>
            与德州扑克不同，梭哈的<b>花色分大小</b>，并且是最后的平局判定依据：先比点数，
            点数完全相同时比较该张牌的花色。
          </p>
          <p>
            <span className="suit-order">
              <span className="suit-chip">♠</span> 黑桃
              <span style={{ color: 'var(--text-dim)' }}>＞</span>
              <span className="suit-chip red">♥</span> 红桃
              <span style={{ color: 'var(--text-dim)' }}>＞</span>
              <span className="suit-chip">♣</span> 梅花
              <span style={{ color: 'var(--text-dim)' }}>＞</span>
              <span className="suit-chip red">♦</span> 方块
            </span>
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
            例：A♠ K♥ Q♦ J♣ 9♠ 与 A♥ K♦ Q♣ J♠ 9♥ 点数完全相同，黑桃 A 一方获胜。
            同花之间则比较该花色的高低。因为花色也参与比较，
            <b>两副不同的五张牌永远不会完全平局</b>，所以本作不会出现平分底池。
          </p>
        </section>

        <section>
          <h3>边池（Side Pot）</h3>
          <p>
            当某位玩家全下的筹码少于其他人的投入时，底池会被切分：全下玩家只能争夺他
            跟得上的那一部分（<b>主池</b>），其余部分由筹码更多的玩家单独争夺（<b>边池</b>）。
            已弃牌玩家投入的筹码留在池中，但不参与分配。
          </p>
        </section>

        <section>
          <h3>公平性</h3>
          <p>
            每手牌开始时先公布 <code>SHA-256(serverSeed)</code> 作为承诺，
            发牌使用 <code>SHA-256(serverSeed:clientSeed)</code> 作为随机种子。
            本手结束后公布 <code>serverSeed</code>，任何人都可以复现整副牌的顺序，
            证明发牌在公布承诺之后没有被改动。
          </p>
        </section>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ proof

export function ProofPanel({ state, onClose }: { state: GameState; onClose: () => void }) {
  const check = useMemo(() => {
    if (!state.shuffle.serverSeed) return null
    const rebuilt = verifyShuffle(state.shuffle.serverSeed, state.shuffle.clientSeed, state.config.deckSize)
    const same =
      rebuilt.deck.length === state.deck.length &&
      rebuilt.deck.every((card, i) => cardId(card) === cardId(state.deck[i]))
    return {
      same,
      hashMatches: rebuilt.serverSeedHash === state.shuffle.serverSeedHash,
      deck: rebuilt.deck,
    }
  }, [state])

  return (
    <Modal
      title="洗牌公正性"
      subtitle="Provably fair — 承诺 / 揭示 / 复现"
      onClose={onClose}
      footer={
        check && (
          <span style={{ fontSize: 13 }}>
            {check.hashMatches && check.same ? (
              <span style={{ color: 'var(--green)' }}>
                ✓ 校验通过：公布的种子能完整复现本手牌序，且哈希与发牌前的承诺一致。
              </span>
            ) : (
              <span style={{ color: 'var(--red)' }}>✗ 校验失败，牌序与种子不一致。</span>
            )}
          </span>
        )
      }
    >
      <div className="proof-grid">
        <div className="proof-row">
          <span className="proof-key">clientSeed（你提供的随机数）</span>
          <span className="proof-val">{state.shuffle.clientSeed || '—'}</span>
        </div>
        <div className="proof-row">
          <span className="proof-key">SHA-256(serverSeed) — 发牌前公布</span>
          <span className="proof-val">{state.shuffle.serverSeedHash || '—'}</span>
        </div>
        <div className="proof-row">
          <span className="proof-key">
            serverSeed {state.shuffle.revealed ? '（本手已结束，已公布）' : '（本手进行中，暂不公布）'}
          </span>
          <span className="proof-val">
            {state.shuffle.revealed && state.shuffle.serverSeed ? state.shuffle.serverSeed : '■■■■■■■■（本手结束后公布）'}
          </span>
        </div>
        <div className="proof-row">
          <span className="proof-key">SHA-256(serverSeed:clientSeed) — 实际使用的随机种子</span>
          <span className="proof-val">{state.shuffle.revealed ? state.shuffle.combinedHash : '—'}</span>
        </div>

        {state.shuffle.revealed && check && (
          <div className="proof-row">
            <span className="proof-key">复现出的牌序（共 {check.deck.length} 张）</span>
            <span className="proof-val" style={{ lineHeight: 1.9 }}>
              {check.deck.map(cardText).join(' ')}
            </span>
          </div>
        )}

        {state.burned.length > 0 && (
          <div className="proof-row">
            <span className="proof-key">本手销牌（{state.burned.length} 张）</span>
            <span className="proof-val">{state.burned.map(cardText).join(' ')}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------ result band

export function ResultBand({ state }: { state: GameState }) {
  if (state.potResults.length === 0) return null
  return (
    <div className="result-band">
      <span className="result-title">
        {state.stage === 'gameOver' ? '牌局结束' : `第 ${state.handNo} 手结果`}
      </span>
      {state.potResults.map((result, i) =>
        result.winners.map((winner) => (
          <span key={`${i}-${winner.seat}`} className="result-winner">
            <b>{state.players[winner.seat].name}</b>
            <span className="amt">+{winner.amount.toLocaleString('en-US')}</span>
            <span className="result-hand">
              {result.label} · {winner.handLabel}
            </span>
          </span>
        )),
      )}
    </div>
  )
}

// ----------------------------------------------------------- privacy gate

export function PrivacyGate({
  name,
  seat,
  onReveal,
  cardCount,
}: {
  name: string
  seat: number
  onReveal: () => void
  cardCount: number
}) {
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-eyebrow">同屏轮流 · 请勿偷看</div>
        <div className="gate-name">{name}</div>
        <div className="gate-hint">
          轮到座位 {seat} 的 <b>{name}</b> 行动。
          <br />
          请把设备交给该玩家，其他人请回避，然后点击下方按钮查看自己的底牌。
        </div>
        <div className="gate-cards">
          {Array.from({ length: Math.max(cardCount, 1) }, (_, i) => (
            <div
              key={i}
              style={{
                width: 46,
                height: 64,
                borderRadius: 6,
                background: 'repeating-linear-gradient(45deg,#1d4f8a 0 5px,#163d6c 5px 10px)',
                border: '2px solid #f2f4f6',
              }}
            />
          ))}
        </div>
        <button className="btn primary" style={{ padding: '11px 26px', fontSize: 15 }} onClick={onReveal}>
          我是 {name}，显示我的牌
        </button>
      </div>
    </div>
  )
}
