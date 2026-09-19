/**
 * Visual check harness.
 *
 * Drives a headless Chrome over the DevTools Protocol to capture the running
 * Vite dev server at a few key states. Node 22 ships a global WebSocket, so
 * this needs no dependencies.
 *
 *   node scripts/screenshot.mjs [baseUrl] [outDir]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:5273'
const OUT = process.argv[3] ?? join(process.cwd(), 'screenshots')
const PORT = 9333

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...args) => console.log('[shot]', ...args)

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id)
        if (entry) {
          this.pending.delete(msg.id)
          msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
        }
      } else {
        this.events.push(msg)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 30000)
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`eval failed: ${result.exceptionDetails.text}`)
    }
    return result.result.value
  }
}

async function fetchJson(url) {
  const res = await fetch(url)
  return res.json()
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p))
  if (!chrome) throw new Error('No Chrome/Edge binary found')

  const profile = join(tmpdir(), `showhand-shot-${Date.now()}`)
  log('launching', chrome)
  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1680,1050',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )

  try {
    // Wait for the debugging endpoint.
    let version = null
    for (let i = 0; i < 60; i++) {
      try {
        version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`)
        break
      } catch {
        await sleep(250)
      }
    }
    if (!version) throw new Error('Chrome debugger never came up')
    log('browser', version.Browser)

    const target = await fetchJson(`http://127.0.0.1:${PORT}/json/list`).then(
      (list) => list.find((t) => t.type === 'page') ?? list[0],
    )

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const cdp = new Cdp(ws)

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1680,
      height: 1050,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const capture = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const file = join(OUT, `${name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      log('saved', file)
    }

    const goto = async (url) => {
      await cdp.send('Page.navigate', { url })
      await sleep(1400)
    }

    const clickText = async (text, tag = 'button') => {
      const ok = await cdp.eval(`(() => {
        const el = [...document.querySelectorAll('${tag}')]
          .find((n) => n.textContent && n.textContent.includes(${JSON.stringify(text)}));
        if (!el) return false;
        el.click();
        return true;
      })()`)
      if (!ok) log(`WARN: no ${tag} matching ${JSON.stringify(text)}`)
      await sleep(450)
      return ok
    }

    /** Clicks one of a seat's action buttons by its tooltip. */
    const clickSeatControl = async (seatIndex, titleFragment) => {
      const ok = await cdp.eval(`(() => {
        const seat = document.querySelectorAll('.seat')[${seatIndex}];
        if (!seat) return false;
        const btn = [...seat.querySelectorAll('.seat-ctl')]
          .find((b) => (b.getAttribute('title') || '').includes(${JSON.stringify(titleFragment)}));
        if (!btn) return false;
        btn.click();
        return true;
      })()`)
      if (!ok) errors.push(`seat ${seatIndex}: no control matching ${titleFragment}`)
      await sleep(450)
      return ok
    }

    /**
     * Hot-seat pops the privacy gate whenever a human seat is on turn, which
     * would otherwise be all a screenshot captures. Dismiss it if present.
     */
    const passGate = async () => {
      const present = await cdp.eval(`!!document.querySelector('.gate')`)
      if (!present) return false
      await cdp.eval(`document.querySelector('.gate button')?.click()`)
      await sleep(450)
      return true
    }

    /**
     * Seats are anchored by their inner edge, so a seat carrying five cards must
     * still finish inside the board. Centring them used to push the top seat's
     * nameplate onto the topbar and the bottom seat's onto the betting bar.
     */
    const assertSeatsClearOfChrome = async (label) => {
      const m = await cdp.eval(`(() => {
        const wrap = document.querySelector('.table-wrap');
        const board = wrap ? wrap.getBoundingClientRect() : null;
        const topbar = document.querySelector('.topbar');
        const bar = document.querySelector('.actionbar, .step-bar');
        return {
          board: board ? { top: board.top, bottom: board.bottom } : null,
          topbarBottom: topbar ? topbar.getBoundingClientRect().bottom : 0,
          barTop: bar ? bar.getBoundingClientRect().top : window.innerHeight,
          seats: [...document.querySelectorAll('.seat')].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              name: (el.querySelector('.seat-name') || {}).textContent || '?',
              top: r.top,
              bottom: r.bottom,
            };
          }),
        };
      })()`)
      if (!m.board) {
        errors.push(`${label}: no board rendered`)
        return
      }
      let bad = 0
      for (const s of m.seats) {
        if (s.top < m.topbarBottom - 1) {
          errors.push(
            `${label}: seat ${s.name} overlaps the topbar by ${Math.round(m.topbarBottom - s.top)}px`,
          )
          bad++
        }
        if (s.bottom > m.barTop + 1) {
          errors.push(
            `${label}: seat ${s.name} overlaps the betting bar by ${Math.round(s.bottom - m.barTop)}px`,
          )
          bad++
        }
      }
      if (!bad) log(`${label}: ${m.seats.length} seat(s) clear of the topbar and betting bar`)
    }

    /**
     * The seat buttons belong next to their own nameplate. They used to land on
     * the far side of the hand, which parked them in the middle of the table on
     * top of the pot.
     */
    /**
     * The seat buttons ride *beside* the plate — same band vertically, just
     * outside it horizontally. They used to be a row of their own below the
     * plate, which cost the layout solver 31px of vertical budget per seat.
     * Also asserts the buttons stay on the board and off the pot.
     */
    const assertControlsBesidePlates = async (label) => {
      const rows = await cdp.eval(`(() => {
        const board = document.querySelector('.table-wrap');
        const br = board ? board.getBoundingClientRect() : null;
        const pot = document.querySelector('.pot');
        const pr = pot ? pot.getBoundingClientRect() : null;
        return [...document.querySelectorAll('.seat')].map((el) => {
          const plate = el.querySelector('.seat-plate');
          const ctl = el.querySelector('.seat-controls');
          if (!plate || !ctl) return null;
          const p = plate.getBoundingClientRect();
          const c = ctl.getBoundingClientRect();
          const hGap =
            c.left >= p.right ? c.left - p.right : p.left >= c.right ? p.left - c.right : -1;
          const vOff = Math.abs((c.top + c.bottom) / 2 - (p.top + p.bottom) / 2);
          const overPot = pr
            ? !(c.right < pr.left || c.left > pr.right || c.bottom < pr.top || c.top > pr.bottom)
            : false;
          const offBoard = br
            ? !(c.left >= br.left - 1 && c.right <= br.right + 1)
            : false;
          return {
            name: (el.querySelector('.seat-name') || {}).textContent || '?',
            hGap: Math.round(hGap),
            vOff: Math.round(vOff),
            overPot,
            offBoard,
          };
        }).filter(Boolean);
      })()`)

      if (!rows.length) return
      let bad = 0
      for (const r of rows) {
        if (r.hGap < 0 || r.hGap > 40) {
          errors.push(`${label}: seat ${r.name} buttons sit ${r.hGap}px beside its nameplate`)
          bad++
        }
        if (r.vOff > 6) {
          errors.push(`${label}: seat ${r.name} buttons are ${r.vOff}px off the nameplate's row`)
          bad++
        }
        if (r.overPot) {
          errors.push(`${label}: seat ${r.name} buttons overlap the pot`)
          bad++
        }
        if (r.offBoard) {
          errors.push(`${label}: seat ${r.name} buttons hang off the board`)
          bad++
        }
      }
      if (!bad) log(`${label}: ${rows.length} seat button row(s) beside their plates, clear of the pot`)
    }

    /**
     * No two seats may overlap, and no hand may cover the pot.
     *
     * This is the invariant the layout solver models, but it is checked here
     * against the boxes the browser actually laid out — the solver once
     * under-counted a whole row and two heads-up seats overlapped by 30px.
     */
    const assertSeatsClear = async (label) => {
      const result = await cdp.eval(`(() => {
        const seats = [...document.querySelectorAll('.seat')].map((el) => ({
          name: (el.querySelector('.seat-name') || {}).textContent || '?',
          r: el.getBoundingClientRect(),
        }));
        const pot = document.querySelector('.pot');
        const pr = pot ? pot.getBoundingClientRect() : null;
        const hits = [];
        for (let i = 0; i < seats.length; i++) {
          for (let j = i + 1; j < seats.length; j++) {
            const a = seats[i].r, b = seats[j].r;
            if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
              hits.push(seats[i].name + '/' + seats[j].name);
            }
          }
        }
        const overPot = [];
        if (pr) {
          for (const el of document.querySelectorAll('.seat')) {
            const cards = el.querySelector('.seat-cards');
            if (!cards) continue;
            const c = cards.getBoundingClientRect();
            if (c.left < pr.right && pr.left < c.right && c.top < pr.bottom && pr.top < c.bottom) {
              overPot.push((el.querySelector('.seat-name') || {}).textContent || '?');
            }
          }
        }
        return { hits, overPot };
      })()`)

      if (result.hits.length) errors.push(`${label}: seats overlap (${result.hits.join(', ')})`)
      if (result.overPot.length) {
        errors.push(`${label}: a hand covers the pot (${result.overPot.join(', ')})`)
      }
      if (!result.hits.length && !result.overPot.length) {
        log(`${label}: no seat overlaps, no hand over the pot`)
      }
    }

    /** How many hole cards are currently face up, per seat index. */
    const peekState = () =>
      cdp.eval(`(() => [...document.querySelectorAll('.seat')].map((seat) => {
        const hole = seat.querySelector('.card-slot.is-hole');
        if (!hole) return 'none';
        return hole.querySelector('.card.face-down') ? 'down' : 'up';
      }))()`)

    const errors = []
    const collectErrors = async () => {
      const found = await cdp.eval(`(() => {
        const el = document.querySelector('#vite-error-overlay');
        return el ? (el.shadowRoot ? el.shadowRoot.textContent : el.textContent) : null;
      })()`)
      if (found) errors.push(found.slice(0, 400))
    }

    /** The shell is one viewport tall — nothing should ever need page scrolling. */
    const assertNoPageScroll = async (label) => {
      const metrics = await cdp.eval(`(() => {
        const d = document.documentElement;
        return {
          scrollH: d.scrollHeight,
          innerH: window.innerHeight,
          bodyScrollH: document.body.scrollHeight,
        };
      })()`)
      const overflow = Math.max(metrics.scrollH, metrics.bodyScrollH) - metrics.innerH
      if (overflow > 2) {
        errors.push(`${label}: page overflows vertically by ${overflow}px`)
      } else {
        log(`${label}: fits the viewport (no page scroll)`)
      }
    }

    const setTheme = async (theme) => {
      await cdp.eval(`(() => { localStorage.setItem('showhand:theme', ${JSON.stringify(theme)}); })()`)
    }

    /**
     * localStorage is per-origin, so the theme can only be set after a first
     * visit. Headless Chrome otherwise reports `prefers-color-scheme: light`,
     * which would silently make every "dark" capture a light one.
     */
    const startInTheme = async (theme) => {
      await goto(`${BASE}/`)
      await setTheme(theme)
    }

    const setViewport = async (width, height, mobile = false) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      })
    }

    // 1 — setup screen
    await startInTheme('dark')
    await goto(`${BASE}/`)
    await capture('01-setup')
    await assertNoPageScroll('setup 1680x1050')

    // 2 — hot-seat table
    await goto(`${BASE}/?quick=hotseat&seats=3&speed=2&seed=demo-a`)
    await sleep(3200)
    await passGate()
    await capture('02-table-hotseat')
    await assertNoPageScroll('table 1680x1050')
    await assertSeatsClearOfChrome('table 1680x1050')
    await assertSeatsClear('table 1680x1050')

    // 3 — five-handed hot-seat with the privacy gate visible
    await goto(`${BASE}/?quick=hotseat&seats=5&speed=1&seed=demo-b`)
    await sleep(3000)
    await capture('03-hotseat-gate')

    // 4 — through the gate and onto the table
    await clickText('显示我的牌')
    await sleep(600)
    await passGate()
    await capture('04-hotseat-table')

    // 5 — the per-player situation report
    await goto(`${BASE}/?quick=hotseat&seats=4&speed=2&seed=demo-c`)
    await sleep(3000)
    await clickText('复制战况')
    await sleep(700)
    await capture('05-summary-export')

    // 6 — rules modal
    await cdp.eval(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('关闭'))?.click()`,
    )
    await sleep(400)
    await clickText('规则')
    await sleep(600)
    await capture('06-rules')

    // 7 — 上帝视角: manual stepping only, and hole cards stay face down.
    await goto(`${BASE}/?quick=god&seats=5&seed=demo-d`)
    await sleep(1500)
    const before = await cdp.eval(`document.querySelectorAll('.card-face img').length`)
    await sleep(2000)
    const afterIdle = await cdp.eval(`document.querySelectorAll('.card-face img').length`)
    if (before !== afterIdle) {
      errors.push(`god view advanced on its own (${before} -> ${afterIdle})`)
    }
    await clickText('翻出下一张')
    await clickText('翻出下一张')
    await clickText('翻出下一张')
    await clickText('翻出下一张')
    await sleep(400)

    const idle = await peekState()
    if (idle.some((s) => s === 'up')) {
      errors.push(`god view showed a hole card without peeking: ${JSON.stringify(idle)}`)
    } else {
      log(`god view: hole cards hidden by default ${JSON.stringify(idle)}`)
    }
    await capture('07-god-hidden')

    // Peek at a seat that actually holds a hole card, then hide it again.
    const peekTarget = idle.findIndex((s) => s === 'down')
    if (peekTarget === -1) {
      errors.push('no seat had a face-down hole card to peek at')
    } else {
      await clickSeatControl(peekTarget, '观看')
      const peeked = await peekState()
      if (peeked[peekTarget] !== 'up') {
        errors.push(`peeking seat ${peekTarget} did not reveal its hole card: ${JSON.stringify(peeked)}`)
      } else if (peeked.some((s, i) => s === 'up' && i !== peekTarget)) {
        errors.push(`peeking seat ${peekTarget} leaked another seat: ${JSON.stringify(peeked)}`)
      } else {
        log(`god view: peek revealed only seat ${peekTarget} ${JSON.stringify(peeked)}`)
      }
      await capture('08-god-peeked')

      await clickSeatControl(peekTarget, '隐藏')
      const hiddenAgain = await peekState()
      if (hiddenAgain[peekTarget] !== 'down') {
        errors.push(`second click did not hide seat ${peekTarget} again: ${JSON.stringify(hiddenAgain)}`)
      } else {
        log('god view: second click hid the hole card again')
      }
    }

    // Toggling a seat between AI and human must be reversible.
    const botBefore = await cdp.eval(
      `!!document.querySelectorAll('.seat')[1].querySelector('.seat-bot-tag')`,
    )
    await clickSeatControl(1, '改为真人')
    const asHuman = await cdp.eval(
      `!!document.querySelectorAll('.seat')[1].querySelector('.seat-bot-tag')`,
    )
    await clickSeatControl(1, '改为 AI')
    const asBot = await cdp.eval(
      `!!document.querySelectorAll('.seat')[1].querySelector('.seat-bot-tag')`,
    )
    if (!(botBefore && !asHuman && asBot)) {
      errors.push(`seat AI toggle not reversible: ${botBefore} -> ${asHuman} -> ${asBot}`)
    } else {
      log('seat AI toggle: bot -> human -> bot')
    }
    await clickSeatControl(2, '观看')
    await capture('09-god-seat-controls')

    // 10 — narrow viewport, check nothing overflows
    await setViewport(430, 900, true)
    await goto(`${BASE}/?quick=hotseat&seats=3&speed=2&seed=demo-e`)
    await sleep(3200)
    await passGate()
    await capture('10-mobile')
    await assertNoPageScroll('table 430x900')
    await assertSeatsClearOfChrome('table 430x900')
    await assertSeatsClear('table 430x900')

    await setViewport(1366, 768)
    await goto(`${BASE}/?quick=hotseat&seats=5&speed=2&seed=demo-h`)
    await sleep(3200)
    await passGate()
    await capture('11-laptop-1366')
    await assertNoPageScroll('table 1366x768')
    await assertSeatsClearOfChrome('table 1366x768')
    await assertSeatsClear('table 1366x768')

    // 12-14 — iPad, which is 4:3 in both orientations.
    await setViewport(1366, 1024)
    await goto(`${BASE}/?quick=hotseat&seats=5&speed=2&seed=demo-i`)
    await sleep(3200)
    await passGate()
    await capture('12-ipad-landscape-4x3')
    await assertNoPageScroll('iPad landscape 1366x1024')
    await assertSeatsClearOfChrome('iPad landscape 1366x1024')
    await assertSeatsClear('iPad landscape 1366x1024')

    await setViewport(1024, 768)
    await goto(`${BASE}/?quick=hotseat&seats=5&speed=2&seed=demo-h`)
    await sleep(3400)
    await passGate()
    await capture('13-ipad-1024x768')
    await assertNoPageScroll('iPad 1024x768')
    await assertSeatsClearOfChrome('iPad 1024x768')
    await assertSeatsClear('iPad 1024x768')

    await setViewport(810, 1080)
    await goto(`${BASE}/?quick=hotseat&seats=4&speed=2&seed=demo-j`)
    await sleep(3400)
    await passGate()
    await capture('14-ipad-portrait-4x3')
    await assertNoPageScroll('iPad portrait 810x1080')
    await assertSeatsClearOfChrome('iPad portrait 810x1080')
    await assertSeatsClear('iPad portrait 810x1080')

    // 15 — the director can bet for whichever seat is on turn. Step through the
    // deal, then confirm the betting bar targets that seat and actually works.
    await setViewport(1680, 1050)
    await setTheme('dark')
    await goto(`${BASE}/?quick=god&seats=4&seed=demo-l`)
    await sleep(1600)
    for (let i = 0; i < 10; i++) await clickText('翻出下一张')
    await sleep(500)

    const directing = await cdp.eval(`(() => {
      const bar = document.querySelector('.actionbar.is-directing');
      const seat = document.querySelector('.seat.is-directed .seat-name');
      return {
        bar: !!bar,
        label: bar ? (bar.querySelector('.actionbar-directing')?.textContent || '').trim() : null,
        seat: seat ? seat.textContent : null,
        buttons: bar ? [...bar.querySelectorAll('button')].map((b) => b.textContent.trim()) : [],
      };
    })()`)
    if (!directing.bar) {
      errors.push('god mode: no director betting bar appeared for the seat on turn')
    } else {
      const matchesSeat =
        directing.label && directing.seat && directing.label.includes(directing.seat)
      if (!matchesSeat) {
        errors.push(
          `god mode: betting bar labels "${directing.label}" but the marked seat is "${directing.seat}"`,
        )
      }
      if (!directing.buttons.some((b) => b.includes('弃牌'))) {
        errors.push(`god mode: director bar has no fold button (${directing.buttons.join('|')})`)
      }
      if (!directing.buttons.some((b) => b.includes('加注') || b.includes('下注'))) {
        errors.push(`god mode: no raise control on the director bar (${directing.buttons.join('|')})`)
      }
      log(`god mode director bar: "${directing.label}" -> seat ${directing.seat}`)
    }
    await capture('15-god-director-betting')
    await assertControlsBesidePlates('director 4p')

    // Press a betting button and confirm it applied to the seat on turn.
    const acted = await cdp.eval(`(() => {
      const bar = document.querySelector('.actionbar.is-directing');
      if (!bar) return 'no bar';
      const btn = [...bar.querySelectorAll('button')].find((b) => /过牌|跟注/.test(b.textContent));
      if (!btn) return 'no check/call button';
      const label = btn.textContent.trim();
      btn.click();
      return label;
    })()`)
    await sleep(700)
    if (String(acted).startsWith('no ')) {
      errors.push(`god mode: could not act on behalf of the seat (${acted})`)
    } else {
      const logHasIt = await cdp.eval(
        `[...document.querySelectorAll('.log-entry')].some((e) => /过牌|跟注/.test(e.textContent))`,
      )
      if (!logHasIt) errors.push(`god mode: pressed "${acted}" but nothing was logged`)
      else log(`god mode: director pressed "${acted}" and the engine accepted it`)
    }

    // Narrow and tall: the shape that exposed the seat-anchoring bug.
    await setViewport(350, 1127, true)
    await goto(`${BASE}/?quick=god&seats=3&seed=demo-m`)
    await sleep(1800)
    for (let i = 0; i < 8; i++) await clickText('翻出下一张')
    await sleep(400)
    await capture('16-narrow-tall-350x1127')
    await assertNoPageScroll('narrow 350x1127')
    await assertSeatsClearOfChrome('narrow 350x1127')
    await assertSeatsClear('narrow 350x1127')

    // Heads-up on a wide stage: two seats facing each other across the felt is
    // where the buttons drifted into the middle of the table.
    await setViewport(1280, 650)
    await goto(`${BASE}/?quick=god&seats=2&seed=demo-n`)
    await sleep(1800)
    for (let i = 0; i < 6; i++) await clickText('翻出下一张')
    await sleep(400)
    await capture('17-headsup-wide-1280x650')
    await assertNoPageScroll('heads-up 1280x650')
    await assertSeatsClearOfChrome('heads-up 1280x650')
    await assertSeatsClear('heads-up 1280x650')
    await assertControlsBesidePlates('heads-up 1280x650')

    // 18+ — light theme
    await setViewport(1680, 1050)
    await setTheme('light')
    await goto(`${BASE}/`)
    await sleep(500)
    await capture('18-light-setup')
    await goto(`${BASE}/?quick=god&seats=5&speed=4&seed=demo-f`)
    await sleep(6500)
    await capture('19-light-table')
    await assertNoPageScroll('light table 1680x1050')
    const lightTheme = await cdp.eval(`document.documentElement.dataset.theme`)
    if (lightTheme !== 'light') errors.push(`expected light theme for light capture, got ${lightTheme}`)

    await clickText('复制战况')
    await sleep(700)
    await capture('20-light-summary')
    await cdp.eval(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('关闭'))?.click()`,
    )
    await sleep(400)
    await clickText('规则')
    await sleep(600)
    await capture('21-light-rules')

    await setViewport(430, 900, true)
    await setTheme('light')
    await goto(`${BASE}/?quick=hotseat&seats=3&speed=2&seed=demo-e`)
    await sleep(3000)
    await passGate()
    await capture('22-light-mobile')
    await assertNoPageScroll('light mobile 430x900')
    await assertSeatsClearOfChrome('light mobile 430x900')
    await assertSeatsClear('light mobile 430x900')

    // DOM-level invariants on the god view: every rendered card face must be
    // unique, and no seat may show more than five cards.
    await setViewport(1680, 1050)
    await setTheme('dark')
    await goto(`${BASE}/?quick=god&seats=5&speed=4&seed=demo-f`)
    await sleep(9000)
    const board = await cdp.eval(`(() => {
      const seats = [...document.querySelectorAll('.seat')].map((seat) => ({
        name: seat.querySelector('.seat-name')?.textContent ?? '?',
        faces: [...seat.querySelectorAll('.card-face img')]
          .map((img) => img.getAttribute('src'))
          .filter((src) => src && !src.endsWith('BACK.png')),
        backs: seat.querySelectorAll('.card.face-down').length,
      }));
      return { seats };
    })()`)

    const allFaces = board.seats.flatMap((s) => s.faces)
    const duplicates = allFaces.filter((src, i) => allFaces.indexOf(src) !== i)
    const oversized = board.seats.filter((s) => s.faces.length + s.backs > 5)
    log(`god view: ${board.seats.length} seats, ${allFaces.length} face-up cards`)
    if (duplicates.length) {
      errors.push(`duplicate card faces rendered: ${[...new Set(duplicates)].join(', ')}`)
    }
    if (oversized.length) {
      errors.push(`seats with more than 5 cards: ${oversized.map((s) => s.name).join(', ')}`)
    }

    // Hidden information must not exist in the DOM for a spectator, and every
    // visible card on the hero's own row must be a distinct card.
    await goto(`${BASE}/?quick=hotseat&seats=4&speed=2&seed=demo-g`)
    await sleep(3000)
    await clickText('显示我的牌')
    const solo = await cdp.eval(`(() => {
      const hidden = [...document.querySelectorAll('.card.face-down')];
      const heroSeat = document.querySelector('.seat.is-you');
      const heroFaces = heroSeat
        ? [...heroSeat.querySelectorAll('.card-face img')].map((img) => img.getAttribute('src'))
        : [];
      return {
        leaked: hidden.filter((c) => c.querySelector('.card-face img')).length,
        heroFaces,
        heroDown: heroSeat ? heroSeat.querySelectorAll('.card.face-down').length : -1,
      };
    })()`)
    if (solo.leaked > 0) {
      errors.push(`${solo.leaked} face-down card(s) still carry their face image in the DOM`)
    } else {
      log('privacy: no face image rendered behind a face-down card')
    }
    if (new Set(solo.heroFaces).size !== solo.heroFaces.length) {
      errors.push(`hero row repeats a card: ${solo.heroFaces.join(', ')}`)
    } else {
      log(`hero row: ${solo.heroFaces.length} distinct face(s), ${solo.heroDown} face-down`)
    }

    await collectErrors()
    if (errors.length) {
      console.log('\n=== PAGE ERRORS ===')
      for (const e of errors) console.log(e)
      process.exitCode = 1
    } else {
      log('no Vite error overlays detected')
    }

    ws.close()
  } finally {
    child.kill()
    await sleep(400)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* profile cleanup is best-effort */
    }
  }
}

main().catch((error) => {
  console.error('[shot] FAILED:', error)
  process.exit(1)
})
