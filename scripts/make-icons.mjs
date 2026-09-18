/**
 * Renders assets/icon.svg into the PNG sizes the iOS app and the web shell need.
 *
 * Uses the same headless-Chrome-over-CDP trick as the screenshot harness, so
 * there is no image toolchain to install — SVG in, PNG out.
 *
 *   node scripts/make-icons.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9336

/**
 * Each entry renders one SVG into one or more PNGs. The iOS paths are skipped
 * when the platform has not been generated yet, so the script is safe to run
 * before `npx cap add ios`.
 */
const RENDERS = [
  {
    svg: join(ROOT, 'assets', 'icon.svg'),
    targets: [
      // Single-size iOS app icon (iOS 14+ reads 1024x1024 and downsamples).
      ['ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024],
      // Web shell extras.
      ['public/apple-touch-icon.png', 180],
      ['public/icon-192.png', 192],
      ['public/icon-512.png', 512],
    ],
  },
  {
    svg: join(ROOT, 'assets', 'splash.svg'),
    targets: [
      // A single-scale imageset entry (see the Contents.json written below).
      // Capacitor's stock template ships the *same* 2732x2732 PNG three times
      // as 1x/2x/3x, which is 5.4 MB of identical pixels in the bundle.
      ['ios/App/App/Assets.xcassets/Splash.imageset/splash.png', 2048],
    ],
    // Xcode accepts an image entry with no `scale` key, which means "any scale".
    contentsJson: {
      images: [{ filename: 'splash.png', idiom: 'universal' }],
      info: { version: 1, author: 'xcode' },
    },
    prune: ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'],
  },
]

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...args) => console.log('[icon]', ...args)

function connect(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === undefined) return
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
  })
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id
      pending.set(next, { resolve, reject })
      ws.send(JSON.stringify({ id: next, method, params }))
      setTimeout(() => {
        if (pending.delete(next)) reject(new Error(`${method} timed out`))
      }, 30000)
    })
}

async function main() {
  for (const render of RENDERS) {
    if (!existsSync(render.svg)) throw new Error(`missing ${render.svg}`)
  }

  const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p))
  if (!chrome) throw new Error('No Chrome/Chromium binary found')

  const profile = join(tmpdir(), `showhand-icon-${Date.now()}`)
  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    let version = null
    for (let i = 0; i < 60 && !version; i++) {
      try {
        version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
      } catch {
        await sleep(250)
      }
    }
    if (!version) throw new Error('Chrome debugger never came up')
    log('browser', version.Browser)

    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const target = list.find((t) => t.type === 'page') ?? list[0]

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const send = connect(ws)

    await send('Page.enable')
    await send('Runtime.enable')

    for (const render of RENDERS) {
      const svg = readFileSync(render.svg, 'utf8')
      // The SVG scales to the viewport, so one page serves every size.
      const page = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:100vw;height:100vh}</style>${svg}`

      await send('Page.navigate', {
        url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page),
      })
      await sleep(900)

      for (const [relative, size] of render.targets) {
        const out = join(ROOT, relative)
        // ios/App/App/... — skip until `cap add ios` has run.
        if (relative.startsWith('ios/') && !existsSync(join(ROOT, 'ios', 'App', 'App'))) {
          log(`skipped ${relative} (iOS project not generated yet)`)
          continue
        }
        mkdirSync(dirname(out), { recursive: true })
        await send('Emulation.setDeviceMetricsOverride', {
          width: size,
          height: size,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await sleep(320)
        const { data } = await send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
          fromSurface: true,
        })
        writeFileSync(out, Buffer.from(data, 'base64'))
        log(`wrote ${relative} (${size}x${size})`)
      }

      if (render.contentsJson) {
        const dir = dirname(join(ROOT, render.targets[0][0]))
        writeFileSync(join(dir, 'Contents.json'), JSON.stringify(render.contentsJson, null, 2) + '\n')
        log(`wrote ${render.targets[0][0].replace(/\/[^/]+$/, '/Contents.json')}`)
      }
      for (const stale of render.prune ?? []) {
        const victim = dirname(join(ROOT, render.targets[0][0])) + '/' + stale
        if (existsSync(victim)) {
          rmSync(victim)
          log(`pruned stale ${stale}`)
        }
      }
    }

    ws.close()
  } finally {
    child.kill()
    await sleep(300)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

main().catch((error) => {
  console.error('[icon] FAILED:', error.message)
  process.exit(1)
})
