import { cardsText, HIDDEN_CARD } from './cards'
import { evaluateHand } from './evaluator'
import { legalActions, potsFor } from './game'
import { HandCategory, SUIT_ZH, type Card, type GameState, type LegalActions, type PlayerState } from './types'

/**
 * Renders the current table as copy-pasteable text from one player's point of
 * view. Everything the perspective player could not legally know (other
 * players' 暗牌) is masked, so the output is safe to paste into a chat or an
 * LLM without leaking hidden information.
 */

export interface TextExportOptions {
  /** Seat whose eyes we are looking through, or null for a spectator. */
  perspective: number | null
  includeHistory?: boolean
  includeHints?: boolean
  includeProof?: boolean
  /** Wrap the whole thing in a titled box. */
  boxed?: boolean
}

// ------------------------------------------------------- CJK-aware alignment

/** East-Asian wide characters occupy two terminal columns. */
function charWidth(code: number): number {
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0)
  return width
}

function padEnd(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

function padStart(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? ' '.repeat(pad) + text : text
}

// ------------------------------------------------------------------ helpers

const RANK_ZH: Readonly<Record<number, string>> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
}

function visibleCards(player: PlayerState): Card[] {
  return player.cards.slice(1)
}

function holeCard(player: PlayerState): Card | null {
  return player.cards.length > 0 ? player.cards[0] : null
}

/** Is this seat's hole card known to the given perspective? */
function canSeeHole(state: GameState, seat: number, perspective: number | null): boolean {
  if (perspective === seat) return true
  if (state.revealedSeats.includes(seat)) return true
  // Once the hand is settled every showdown hand is public knowledge.
  if (state.stage === 'handOver' || state.stage === 'gameOver') {
    return state.revealedSeats.includes(seat)
  }
  return false
}

function statusLabel(player: PlayerState, state: GameState): string {
  if (player.outOfGame) return '已出局'
  if (player.folded) return '已弃牌'
  if (player.allIn) return '全下'
  if (state.stage === 'betting' && state.toActSeat === player.seat) return '待行动'
  if (player.lastActionLabel) return player.lastActionLabel
  return '—'
}

function cardList(cards: readonly Card[]): string {
  return cards.length === 0 ? '—' : cardsText(cards)
}

function line(char = '─', width = 58): string {
  return char.repeat(width)
}

function heading(text: string, width = 58): string {
  return `▌${text}\n${line('─', width)}`
}

function money(value: number): string {
  return value.toLocaleString('en-US')
}

// --------------------------------------------------------------- main render

export function renderTableText(state: GameState, options: TextExportOptions): string {
  const {
    perspective,
    includeHistory = true,
    includeHints = true,
    includeProof = true,
    boxed = true,
  } = options

  const out: string[] = []
  const me = perspective === null ? null : state.players[perspective]
  const streetName = state.street < 0 ? '发牌中' : `第 ${state.street + 1} 轮`
  const stageName = {
    idle: '未开局',
    deal: `发牌中（${state.dealRound === 0 ? '底牌' : `第 ${state.dealRound + 1} 张明牌`}）`,
    betting: `${streetName}下注`,
    showdown: '开牌',
    handOver: '本手结束',
    gameOver: '牌局结束',
  }[state.stage]

  if (boxed) {
    const title = `  梭哈 · FIVE-CARD STUD${state.handNo > 0 ? `   第 ${state.handNo} 手` : ''}`
    const who = me ? `  视角：${me.name}（座位 ${me.seat}）` : '  视角：观战者（仅公开信息）'
    out.push(line('═'))
    out.push(title)
    out.push(padEnd(who, 40) + `阶段：${stageName}`)
    out.push(line('═'))
    out.push('')
  }

  // ------------------------------------------------------------- table setup
  const config = state.config
  out.push(heading('牌局设置'))
  out.push(
    `  下注模式   ${config.bettingMode === 'no-limit' ? '无限注' : '有限注（固定注额）'}` +
      `        底注 ${money(config.ante)}`,
  )
  out.push(
    `  注额单位   第1-2轮 ${money(config.smallBet)} / 第3-4轮 ${money(config.bigBet)}` +
      `     封顶 ${config.maxRaisesPerStreet === 0 ? '不限' : `${config.maxRaisesPerStreet} 次加注`}`,
  )
  out.push(`  牌堆       ${config.deckSize} 张`)
  out.push(`  庄家座位   ${state.dealerSeat}${me ? `（${state.players[state.dealerSeat].name}）` : ''}`)
  out.push('')

  // ------------------------------------------------------------------- seats
  out.push(heading('座位与筹码'))
  const nameWidth = Math.max(...state.players.map((p) => displayWidth(p.name) + 1), 8)
  for (const p of state.players) {
    const isMe = perspective === p.seat
    const name = p.name + (isMe ? '（你）' : '')
    const hole = holeCard(p)
    const showHole = hole !== null && canSeeHole(state, p.seat, perspective)
    const holeText = hole === null ? '' : showHole ? cardsText([hole]) : HIDDEN_CARD

    const chips = padStart(money(p.chips), 7)
    const committed = padStart(money(p.totalCommitted), 5)
    const parts = [
      `  座位 ${p.seat}`,
      ` ${padEnd(name, nameWidth)}`,
      `筹码 ${chips}`,
      ` 本手投入 ${committed}`,
      ` 明牌 ${padEnd(cardList(visibleCards(p)), 14)}`,
    ]
    if (hole !== null && p.cards.length > 1) {
      parts.push(` 底牌 ${padEnd(holeText, 4)}`)
    }
    parts.push(` ${statusLabel(p, state)}`)
    if (isMe && state.stage === 'betting' && state.toActSeat === p.seat) parts.push('  ← 轮到你')
    out.push(parts.join(''))
  }
  out.push('')

  // -------------------------------------------------------------------- pot
  const pots = potsFor(state)
  out.push(heading('底池'))
  if (pots.length === 0) {
    out.push('  （空）')
  } else if (pots.length === 1) {
    out.push(`  主池 ${money(pots[0].amount)}`)
  } else {
    for (const pot of pots) {
      const who = pot.eligible.map((s) => state.players[s].name).join('、')
      out.push(`  ${padEnd(pot.label, 6)} ${padStart(money(pot.amount), 8)}   可争夺：${who}`)
    }
  }
  out.push(`  合计 ${money(state.pot)}`)
  out.push('')

  // --------------------------------------------------- perspective's hand
  if (me && includeHints) {
    out.push(heading('你的牌'))
    const hole = holeCard(me)
    const known = me.cards
    out.push(`  底牌 ${hole ? cardsText([hole]) : '—'}${hole ? `（${SUIT_ZH[hole.suit]}${RANK_ZH[hole.rank]}）` : ''}`)
    out.push(`  明牌 ${cardList(visibleCards(me))}`)
    if (known.length > 0) {
      const value = evaluateHand(known)
      out.push(`  当前牌型   ${value.label}   [${cardsText(value.cards)}]`)
    }
    const deficit = 5 - known.length
    if (deficit > 0) {
      out.push(`  还需 ${deficit} 张牌才能成局（全部 5 张后比大小）`)
    }
    out.push('')

    // Who is showing the strongest board right now.
    const ranked = state.players
      .filter((p) => !p.outOfGame && !p.folded && visibleCards(p).length > 0)
      .map((p) => ({ name: p.name, value: evaluateHand(visibleCards(p)), seat: p.seat }))
      .sort((a, b) => b.value.category - a.value.category || (b.value.ranks[0] ?? 0) - (a.value.ranks[0] ?? 0))
    if (ranked.length > 1) {
      out.push(heading('明牌强度对比'))
      ranked.forEach((entry, index) => {
        const tag = entry.seat === perspective ? '（你）' : ''
        out.push(
          `  ${index + 1}. ${padEnd(entry.name + tag, nameWidth + 2)} ${entry.value.label}` +
            `   [${cardsText(entry.value.cards)}]`,
        )
      })
      out.push('')
    }
  }

  // --------------------------------------------------------- acting / actions
  if (state.stage === 'betting' && state.toActSeat !== null) {
    const actor = state.players[state.toActSeat]
    const toCall = Math.max(0, state.currentBet - actor.streetCommitted)
    out.push(heading('行动信息'))
    out.push(
      `  当前注额 ${money(state.currentBet)}` +
        `    轮到 ${actor.name}${perspective === actor.seat ? '（你）' : ''}` +
        `    需跟注 ${money(toCall)}`,
    )

    if (perspective === actor.seat) {
      const legal = legalActions(state, actor.seat)
      out.push(...renderLegalActions(legal, state, actor))
    } else {
      out.push('  （不是你的回合）')
    }
    out.push('')
  }

  // ------------------------------------------------------------ hand history
  if (includeHistory) {
    const entries = state.log.filter((entry) => entry.hand === state.handNo)
    if (entries.length > 0) {
      out.push(heading('本手记录'))
      let lastStreet = -99
      for (const entry of entries) {
        if (entry.street !== lastStreet && entry.street >= 0) {
          if (lastStreet !== -99) out.push('')
          out.push(`  ── 第 ${entry.street + 1} 轮 ──`)
          lastStreet = entry.street
        }
        const marker = {
          ante: '底注',
          deal: '发牌',
          action: '行动',
          street: '轮次',
          showdown: '开牌',
          payout: '派彩',
          info: '信息',
        }[entry.kind]
        out.push(`  [${marker}] ${entry.text}`)
      }
      out.push('')
    }
  }

  // ------------------------------------------------------------- settlement
  if (state.potResults.length > 0) {
    out.push(heading('本手结果'))
    for (const result of state.potResults) {
      const winners = result.winners
        .map((w) => `${state.players[w.seat].name} +${money(w.amount)}（${w.handLabel}）`)
        .join('、')
      out.push(`  ${padEnd(result.label, 6)} ${padStart(money(result.amount), 8)}  →  ${winners}`)
    }
    out.push('')
  }

  // --------------------------------------------------------------- fairness
  if (includeProof) {
    out.push(heading('洗牌公正性'))
    out.push(`  clientSeed              ${state.shuffle.clientSeed}`)
    out.push(`  SHA-256(serverSeed)     ${state.shuffle.serverSeedHash}`)
    if (state.shuffle.revealed) {
      out.push(`  serverSeed（已公布）    ${state.shuffle.serverSeed}`)
      out.push(`  校验种子                SHA-256(serverSeed:clientSeed) = ${state.shuffle.combinedHash}`)
      out.push('  可用 scripts/verify-shuffle 复现整副牌序。')
    } else {
      out.push('  本手结束后公布 serverSeed，届时可完整复现牌序。')
    }
    out.push('')
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderLegalActions(legal: LegalActions, state: GameState, actor: PlayerState): string[] {
  const rows: [string, string][] = []
  if (legal.fold) rows.push(['fold', '弃牌'])
  if (legal.check) rows.push(['check', '过牌（无需投入）'])
  if (legal.call) rows.push(['call', `跟注 ${money(legal.callAmount)}`])
  if (legal.raise) {
    const range =
      legal.minRaiseTo === legal.maxRaiseTo
        ? `${money(legal.minRaiseTo)}`
        : `${money(legal.minRaiseTo)} ~ ${money(legal.maxRaiseTo)}`
    rows.push(['raise <amount>', `加注到 ${range}（总额，非增量）`])
  }
  if (legal.allin) rows.push(['allin', `全下 ${money(legal.allinAmount)}`])

  const lines = ['  可用动作：']
  const keyWidth = Math.max(...rows.map(([key]) => key.length), 6) + 2
  for (const [key, label] of rows) lines.push(`    ${padEnd(key, keyWidth)}${label}`)
  if (!legal.raise && legal.maxRaiseTo === 0 && state.config.maxRaisesPerStreet > 0) {
    lines.push('    （本轮加注已达封顶）')
  }
  if (actor.chips === 0) lines.push('    （你没有剩余筹码）')
  return lines
}

// ------------------------------------------------------------- compact form

/**
 * One-row-per-player situation report: cards, made hand, bets and stacks.
 *
 * This is the "copy the table for me" format — aligned, CJK-width aware, and
 * filtered by the same privacy rules as the long form, so from a player's own
 * seat it shows their 暗牌 plus everyone's 明牌 and nothing else.
 */
export function renderSummaryText(state: GameState, perspective: number | null): string {
  const stage = {
    idle: '未开局',
    deal: `发牌中（${state.dealRound === 0 ? '底牌' : `第 ${state.dealRound + 1} 张明牌`}）`,
    betting: `第 ${state.street + 1} 轮下注`,
    showdown: '开牌',
    handOver: '本手结束',
    gameOver: '牌局结束',
  }[state.stage]

  const rows = state.players.map((player) => {
    const isMe = perspective === player.seat
    const name = player.name + (isMe ? '（你）' : '')
    const hole = holeCard(player)
    const showHole = hole !== null && canSeeHole(state, player.seat, perspective)

    // Prefer the full five-card hand when it is knowable, otherwise rank only
    // what is face up.
    const known = showHole ? player.cards : visibleCards(player)
    const value = known.length > 0 ? evaluateHand(known) : null
    const handLabel = value ? `${value.label}${showHole ? '' : '（明牌）'}` : '—'

    let status: string
    if (player.outOfGame) status = '已出局'
    else if (player.folded) status = '已弃牌'
    else if (state.stage === 'betting' && state.toActSeat === player.seat) status = '待行动'
    else if (player.allIn) status = '全下'
    else status = player.lastActionLabel ?? '—'

    return {
      seat: String(player.seat),
      name,
      chips: money(player.chips),
      street: money(player.streetCommitted),
      total: money(player.totalCommitted),
      up: cardList(visibleCards(player)),
      hole: hole === null ? '—' : showHole ? cardsText([hole]) : HIDDEN_CARD,
      hand: handLabel,
      status,
      marker: state.stage === 'betting' && state.toActSeat === player.seat ? '←' : '',
      showdown: state.revealedSeats.includes(player.seat) && !player.folded,
    }
  })

  const w = {
    seat: Math.max(2, ...rows.map((r) => displayWidth(r.seat))),
    name: Math.max(4, ...rows.map((r) => displayWidth(r.name))),
    chips: Math.max(4, ...rows.map((r) => displayWidth(r.chips))),
    street: Math.max(4, ...rows.map((r) => displayWidth(r.street))),
    total: Math.max(4, ...rows.map((r) => displayWidth(r.total))),
    up: Math.max(4, ...rows.map((r) => displayWidth(r.up))),
    hole: Math.max(2, ...rows.map((r) => displayWidth(r.hole))),
    hand: Math.max(4, ...rows.map((r) => displayWidth(r.hand))),
  }

  const header =
    padEnd('座位', w.seat) +
    '  ' +
    padEnd('玩家', w.name) +
    '  ' +
    padStart('筹码', w.chips) +
    '  ' +
    padStart('本轮', w.street) +
    '  ' +
    padStart('累计', w.total) +
    '  ' +
    padEnd('明牌', w.up) +
    '  ' +
    padEnd('底牌', w.hole) +
    '  ' +
    padEnd('牌型', w.hand) +
    '  状态'

  const body = rows
    .map((r) => {
      const line =
        padEnd(r.seat, w.seat) +
        '  ' +
        padEnd(r.name, w.name) +
        '  ' +
        padStart(r.chips, w.chips) +
        '  ' +
        padStart(r.street, w.street) +
        '  ' +
        padStart(r.total, w.total) +
        '  ' +
        padEnd(r.up, w.up) +
        '  ' +
        padEnd(r.hole, w.hole) +
        '  ' +
        padEnd(r.hand, w.hand) +
        '  ' +
        r.status +
        (r.marker ? ' ' + r.marker : '')
      return r.showdown ? line + '  ★亮牌' : line
    })
    .join('\n')

  const pots = potsFor(state)
  const potLine =
    pots.length === 0
      ? '底池：空'
      : pots.length === 1
        ? `底池：${money(pots[0].amount)}`
        : `底池：${pots.map((p) => `${p.label} ${money(p.amount)}`).join(' · ')}（合计 ${money(state.pot)}）`

  const lines: string[] = [
    `梭哈 第 ${state.handNo} 手 · ${stage} · ${potLine}`,
    `视角：${perspective === null ? '观战者（仅公开信息）' : `${state.players[perspective]?.name ?? '?'}（座位 ${perspective}）`}`,
    '',
    header,
    '─'.repeat(displayWidth(header)),
    body,
  ]

  if (state.stage === 'betting' && state.toActSeat !== null) {
    const actor = state.players[state.toActSeat]
    const legal = legalActions(state, actor.seat)
    const toCall = Math.max(0, state.currentBet - actor.streetCommitted)
    const parts = [
      `轮到：${actor.name}${perspective === actor.seat ? '（你）' : ''}`,
      `当前注额 ${money(state.currentBet)}`,
      `需跟注 ${money(toCall)}`,
    ]
    if (legal.raise) {
      parts.push(
        legal.minRaiseTo === legal.maxRaiseTo
          ? `可加注到 ${money(legal.minRaiseTo)}`
          : `可加注到 ${money(legal.minRaiseTo)}~${money(legal.maxRaiseTo)}`,
      )
    }
    if (legal.allin) parts.push(`全下 ${money(legal.allinAmount)}`)
    lines.push('', parts.join('   '))
  }

  if (state.potResults.length > 0) {
    lines.push('', '本手结果：')
    for (const result of state.potResults) {
      const winners = result.winners
        .map((win) => `${state.players[win.seat].name} +${money(win.amount)}（${win.handLabel}）`)
        .join('、')
      lines.push(`  ${result.label} ${money(result.amount)} → ${winners}`)
    }
  }

  return lines.join('\n') + '\n'
}

/** One-screen summary — handy for a quick paste. */
export function renderCompactText(state: GameState, perspective: number | null): string {
  const me = perspective === null ? null : state.players[perspective]
  const stage = {
    idle: '未开局',
    deal: `发牌 ${state.dealRound}`,
    betting: `第${state.street + 1}轮下注`,
    showdown: '开牌',
    handOver: '本手结束',
    gameOver: '牌局结束',
  }[state.stage]

  const seats = state.players
    .map((p) => {
      const showHole = canSeeHole(state, p.seat, perspective)
      const hole = holeCard(p)
      const holeText = hole ? (showHole ? cardsText([hole]) : HIDDEN_CARD) : '-'
      const state_ = p.outOfGame ? '出局' : p.folded ? '弃牌' : p.allIn ? '全下' : ''
      return `${p.seat}:${p.name}(${p.chips})[${holeText}|${cardList(visibleCards(p))}]${state_}`
    })
    .join(' ')

  const actor = state.toActSeat === null ? '-' : state.players[state.toActSeat].name
  return [
    `梭哈 第${state.handNo}手 ${stage} 底池${state.pot}`,
    `视角 ${me ? me.name : '观战者'}`,
    seats,
    `注额${state.currentBet} 轮到${actor}`,
  ].join('\n')
}

// ---------------------------------------------------------------- JSON form

/** Structured snapshot, filtered to what the perspective player may know. */
export function exportStateJSON(state: GameState, perspective: number | null): string {
  const payload = {
    game: '梭哈 (five-card-stud)',
    handNo: state.handNo,
    stage: state.stage,
    street: state.street,
    dealerSeat: state.dealerSeat,
    config: state.config,
    pot: state.pot,
    pots: potsFor(state).map((p) => ({ label: p.label, amount: p.amount, eligible: p.eligible })),
    currentBet: state.currentBet,
    toActSeat: state.toActSeat,
    perspective,
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      chips: p.chips,
      committed: p.totalCommitted,
      streetCommitted: p.streetCommitted,
      folded: p.folded,
      allIn: p.allIn,
      outOfGame: p.outOfGame,
      holeCard: canSeeHole(state, p.seat, perspective) ? (holeCard(p) ?? null) : null,
      upCards: visibleCards(p),
      handLabel: p.cards.length > 0 && canSeeHole(state, p.seat, perspective)
        ? evaluateHand(p.cards).label
        : null,
      boardLabel: visibleCards(p).length > 0 ? evaluateHand(visibleCards(p)).label : null,
    })),
    legalActions:
      state.stage === 'betting' && state.toActSeat === perspective
        ? legalActions(state, perspective as number)
        : null,
    log: state.log.filter((e) => e.hand === state.handNo),
  }
  return JSON.stringify(payload, null, 2)
}

export { HandCategory }
