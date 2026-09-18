/**
 * Layout inspector.
 *
 * Loads the app at an arbitrary viewport, dumps the geometry of the board and
 * every seat part, asserts the invariants we care about, and writes a PNG.
 *
 *   node scripts/inspect.mjs --w 2560 --h 1299 --q "?quick=god&seats=2"
 *   node scripts/inspect.mjs --w 1280 --h 650  --q "?quick=hotseat&seats=5" --out screenshots/i.png
 *
 * Flags:
 *   --w --h    viewport size (default 1280x650)
 *   --q        query string (default "?quick=god&seats=2")
 *   --base     base URL (default http://127.0.0.1:5273)
 *   --out      screenshot path (default screenshots/inspect-<w>x<h>.png)
 *   --json     print the raw dump as JSON instead of a table
 *   --wait     extra settle time in ms (default 2600)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const W = Number(flag('w', 1280))
const H = Number(flag('h', 650))
const QUERY = flag('q', '?quick=god&seats=2')
const BASE = flag('base', 'http://127.0.0.1:5273')
const OUT = flag('out', join('screenshots', `inspect-${W}x${H}.png`))
const WAIT = Number(flag('wait', 2600))
const AS_JSON = argv.includes('--json')
const PORT = 9341

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
].find((p) => p && existsSync(p))

if (!CHROME) {
  console.error('no chrome found')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(process.env.TEMP, 'showhand-inspect-' + Date.now())}`,
    `--window-size=${W},${H}`,
    '--no-first-run',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

/** Runs in the page. Returns the full geometry report. */
const PROBE = `(() => {
  const round = (n) => Math.round(n);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: round(r.top), bottom: round(r.bottom), left: round(r.left), right: round(r.right),
             w: round(r.width), h: round(r.height) };
  };
  const overlaps = (a, b) =>
    !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  const board = document.querySelector('.table-wrap');
  const felt = document.querySelector('.table-felt');
  const pot = document.querySelector('.pot');

  const seats = [...document.querySelectorAll('.seat')].map((el, i) => {
    const part = (sel) => {
      const n = el.querySelector(sel);
      return n ? { ...box(n), order: getComputedStyle(n).order } : null;
    };
    const info = part('.seat-info');
    const cards = part('.seat-cards');
    const controls = part('.seat-controls');
    return {
      index: i,
      cls: el.className,
      // Read the flag the app actually set rather than re-deriving it: this is
      // inside a template literal, where a \s escape would collapse to "s".
      cardsBelow: el.classList.contains('cards-below'),
      name: (el.querySelector('.seat-name') || {}).textContent || '',
      flexDirection: getComputedStyle(el).flexDirection,
      box: box(el),
      info, cards, controls,
      controlsOverPot: overlaps(controls, box(pot)),
    };
  });

  const bb = box(board);

  // Where the shell puts its furniture: the table is centred inside the stage,
  // so a wide window plus a fixed sidebar can leave the felt looking off-centre.
  const chrome = {};
  for (const sel of ['.topbar', '.stage', '.actionbar, .step-bar', '.log', '.log-panel', '.sidebar']) {
    const el = document.querySelector(sel);
    if (el) chrome[sel] = box(el);
  }

  /*
   * A seat is only laid out correctly when it grows INWARD from its nameplate:
   * the plate hugs the rail, the hand reaches toward the middle, and the seat
   * buttons sit between the two. Getting this backwards is what once parked the
   * buttons on top of the pot.
   *
   * The direction comes from the class the app sets (cardsBelow = y <= 55), not
   * from guessing off the board centre: a four-handed seat sits exactly on the
   * centre line and would otherwise be misread.
   */
  for (const s of seats) {
    if (!s.info || !s.cards || !s.controls) continue;
    const upperHalf = s.cardsBelow;
    s.half = upperHalf ? 'upper' : 'lower';
    const outward =
      s.half === 'upper'
        ? { far: s.cards.top - s.info.bottom, near: s.controls.top - s.info.bottom,
            limit: s.cards.top - s.controls.bottom }
        : { far: s.info.top - s.cards.bottom, near: s.info.top - s.controls.bottom,
            limit: s.controls.top - s.cards.bottom };
    s.growsInward = outward.far >= -2;
    s.controlsBesidePlate = outward.near >= -2 && outward.limit >= -2;
  }

  const inverted = seats.filter((s) => s.growsInward === false).map((s) => s.name);
  const misplacedControls = seats.filter((s) => s.controlsBesidePlate === false).map((s) => s.name);

  /*
   * The collision solver in ui/layout.ts works on *modelled* seat blocks. This
   * measures the boxes the browser actually laid out, which is the only thing
   * that can catch the model under-counting a row it forgot about.
   */
  const collisions = [];
  let minGap = Infinity;
  let minGapPair = null;
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const a = seats[i].box;
      const b = seats[j].box;
      if (!a || !b) continue;
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const hOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        collisions.push({ a: seats[i].name, b: seats[j].name, vOverlap, hOverlap });
      }
      // Only a purely vertical separation is a usable "breathing room" measure.
      if (a.left < b.right && b.left < a.right) {
        const gap = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);
        if (gap < minGap) {
          minGap = gap;
          minGapPair = [seats[i].name, seats[j].name];
        }
      }
    }
  }

  const cardBox = (sel) => {
    const el = document.querySelector(sel);
    return el ? box(el) : null;
  };

  return {
    viewport: { w: innerWidth, h: innerHeight },
    chrome,
    // The two card sizes the solver picked, measured off the DOM.
    heroCard: cardBox('.seat.is-you .card') || cardBox('.seat .card'),
    otherCard: cardBox('.seat:not(.is-you) .card') || cardBox('.seat .card'),
    board: bb,
    boardRatio: bb ? +(bb.w / bb.h).toFixed(3) : null,
    felt: box(felt),
    pot: box(pot),
    scroll: { y: document.scrollingElement.scrollHeight - innerHeight },
    seats,
    inverted,
    misplacedControls,
    collisions,
    minGap: Number.isFinite(minGap) ? minGap : null,
    minGapPair,
    controlsOverPot: seats.filter((s) => s.controlsOverPot).map((s) => s.name),
  };
})()`

let ws
try {
  let version = null
  for (let i = 0; i < 80 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
    } catch {
      await sleep(250)
    }
  }
  if (!version) throw new Error('chrome debugger never came up')

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const target = list.find((t) => t.type === 'page') ?? list[0]
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res) => ws.addEventListener('open', res, { once: true }))

  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method, params }))
      setTimeout(() => pending.delete(n) && reject(new Error(`${method} timed out`)), 30000)
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const url = `${BASE}/${QUERY.startsWith('?') ? QUERY : '?' + QUERY}`
  await send('Page.navigate', { url })
  await sleep(WAIT)

  // Optional: deal a few cards so the report reflects a real hand, not the ante.
  const steps = Number(flag('steps', 0))
  for (let i = 0; i < steps; i++) {
    const clicked = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((n) => /翻出下一张|下一步/.test(n.textContent || ''));
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`)
    if (!clicked) break
    await sleep(160)
  }
  if (steps) await sleep(400)

  /*
   * `--drive N` plays the hand out: it shoves every seat all-in whenever the
   * betting controls are live, and advances the deal otherwise. That is the
   * only way to reach the end-of-hand state where every seat shows five cards,
   * which is the layout's worst case.
   *
   * "全下" only drives the slider to the maximum — committing it is a second
   * click on the wager button, so the loop remembers that it owes one.
   */
  const drive = Number(flag('drive', 0))
  const debugDrive = argv.includes('--debug-drive')
  if (drive) {
    const click = (re) =>
      evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find((n) => !n.disabled && ${re}.test((n.textContent || '').trim()));
        if (!b) return false;
        b.click();
        return true;
      })()`)

    let owesCommit = false
    for (let i = 0; i < drive; i++) {
      let action = null
      if (owesCommit) {
        owesCommit = false
        if (await click('/^(下注|加注到|加注|跟注|过牌)/')) action = 'commit'
      }
      if (!action && (await click('/^全下$/')) ) {
        owesCommit = true
        action = 'allin'
      }
      if (!action && (await click('/翻出下一张|下一步/'))) action = 'step'

      if (!action) {
        if (debugDrive) {
          const bar = await evaluate(`(() => {
            const b = document.querySelector('.actionbar, .step-bar');
            return b ? b.innerText.replace(/\\n/g, ' | ') : '(no bar)';
          })()`)
          console.log(`drive: stuck at step ${i}; bar = ${bar}`)
        }
        break
      }
      if (debugDrive) console.log(`drive ${i}: ${action}`)
      await sleep(action === 'allin' ? 140 : 220)
    }
    await sleep(900)
    const dealt = await evaluate(
      `(() => {
        const seats = [...document.querySelectorAll('.seat')];
        return Math.max(0, ...seats.map((s) => s.querySelectorAll('.card').length));
      })()`,
    )
    console.log(`drive: reached ${dealt} cards on the busiest seat`)
  }

  const report = await evaluate(PROBE)
  report.url = url
  report.steps = steps
  report.drive = drive

  mkdirSync(dirname(OUT), { recursive: true })
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  report.screenshot = OUT

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`url        ${url}`)
    console.log(`viewport   ${report.viewport.w}x${report.viewport.h}`)
    console.log(
      `board      ${report.board?.w}x${report.board?.h}  ratio ${report.boardRatio}  top ${report.board?.top}`,
    )
    console.log(`pot        ${report.pot ? `${report.pot.w}x${report.pot.h} @ y${report.pot.top}` : 'n/a'}`)
    console.log(
      `cards      hero ${report.heroCard?.w ?? '?'}x${report.heroCard?.h ?? '?'}   others ${report.otherCard?.w ?? '?'}x${report.otherCard?.h ?? '?'}`,
    )
    console.log(`scrollY    ${report.scroll.y}`)
    console.log('')
    for (const [sel, b] of Object.entries(report.chrome ?? {})) {
      console.log(`  chrome ${sel.padEnd(24)} x ${b.left}..${b.right}  y ${b.top}..${b.bottom}`)
    }
    console.log('')
    console.log('  seat            half    flexDir    info y      cards y     ctrls y     flags')
    for (const s of report.seats) {
      const y = (b) => (b ? `${b.top}-${b.bottom}` : '   -   ').padEnd(11)
      const flags = [
        s.controlsOverPot && 'CTRL-OVER-POT',
        s.growsInward === false && 'GROWS-OUTWARD',
        s.controlsBesidePlate === false && 'CTRLS-AWAY-FROM-PLATE',
      ]
        .filter(Boolean)
        .join(' ')
      console.log(
        `  ${s.name.padEnd(14)}  ${(s.half ?? '-').padEnd(6)}  ${s.flexDirection.padEnd(9)} ${y(s.info)} ${y(s.cards)} ${y(s.controls)} ${flags}`,
      )
    }
    console.log('')
    console.log(`seats growing outward:      ${report.inverted.length ? report.inverted.join(', ') : 'none'}`)
    console.log(`controls off their plate:   ${report.misplacedControls.length ? report.misplacedControls.join(', ') : 'none'}`)
    console.log(`seat controls over the pot: ${report.controlsOverPot.length ? report.controlsOverPot.join(', ') : 'none'}`)
    console.log(
      `seats overlapping:          ${
        report.collisions.length
          ? report.collisions.map((c) => `${c.a}/${c.b} (v${c.vOverlap} h${c.hOverlap})`).join(', ')
          : 'none'
      }`,
    )
    console.log(
      `smallest vertical gap:      ${report.minGap === null ? 'n/a' : `${report.minGap}px`}${
        report.minGapPair ? ` (${report.minGapPair.join(' / ')})` : ''
      }`,
    )
    console.log(`screenshot: ${OUT}`)
  }

  const bad =
    report.inverted.length +
    report.misplacedControls.length +
    report.controlsOverPot.length +
    report.collisions.length +
    (report.scroll.y > 0 ? 1 : 0)
  process.exitCode = bad ? 1 : 0
} finally {
  try {
    ws?.close()
  } catch {}
  child.kill()
  // The CDP socket and Chrome's helper processes can keep the loop alive after
  // the report is printed; the exit code is already decided by now.
  setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref()
}
