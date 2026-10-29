#!/usr/bin/env node
/**
 * browser-verify.mjs — real-browser verification of the dsh-loop-manager client
 * half, driven through the Chrome DevTools Protocol (no npm dependencies:
 * Node 24 ships a global WebSocket).
 *
 * What it proves, against a running DSH web host that serves the plugin:
 *   1. the app shell boots in a real browser with no uncaught exception;
 *   2. the left sidebar carries exactly one `Loop Manager` row (the
 *      `sidebar.panellist` registration; the host renders its label as the
 *      button's aria-label);
 *   3. clicking that row selects our `main` panel and the page renders
 *      (header + the "新建 Pipeline" call to action);
 *   4. the v9 Loop tab (CONTRACT.md §13.7) sits right after Agent Pipeline,
 *      switches the page to the Loop list (heading + `新建 Loop`), and its
 *      count badge matches `GET /api/state.loops`;
 *   5. the new-Loop editor opens with the step editor, adds and removes a
 *      Pipeline + gate group, and exposes name/pipeline/gate/autoLoop fields
 *      (CONTRACT.md §13.8.4);
 *   6. a probe Loop saved through the API shows up as a list row after a poll
 *      and its detail view renders the pipeline card, gate card and loop policy
 *      (the probe is deleted again at the end);
 *   7. screenshots of the sidebar, the opened panel, the Loop tab, the editor
 *      and the Loop detail are written to disk.
 *
 * Usage:
 *   node dist/scripts/browser-verify.mjs --base http://127.0.0.1:58099 --token <launch-token>
 *                                   [--chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
 *                                   [--debug-port 9222] [--out scripts]
 *                                   [--keep-chrome]
 *
 * The script starts Chrome headless itself and always tears it down unless
 * `--keep-chrome` is passed. Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const LABEL = 'Loop Manager'

/** Parsed command line. @returns {Record<string, string|boolean>} */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  /** @type {Record<string, string|boolean>} */
  const out: Record<string, string | boolean> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      index += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help === true) {
  console.log(
    'usage: node dist/scripts/browser-verify.mjs --base <url> --token <token> [--chrome <path>] [--debug-port 9222] [--out dir] [--keep-chrome]',
  )
  process.exit(0)
}
const BASE = String(args.base ?? 'http://127.0.0.1:58099').replace(/\/+$/, '')
const TOKEN = typeof args.token === 'string' ? args.token : ''
const CHROME = String(args.chrome ?? CHROME_DEFAULT)
const DEBUG_PORT = Number(args['debug-port'] ?? 9222)
const OUT_DIR = resolve(String(args.out ?? join(import.meta.dirname, '../../scripts')))
const KEEP_CHROME = args['keep-chrome'] === true

if (TOKEN === '') {
  console.error(
    'browser-verify: --token is required (read it from the host\'s "dsh web: <url>?token=..." startup line)',
  )
  process.exit(2)
}

const results: Array<{ name: string; ok: boolean; detail: string }> = []
/** Record one check. @param {string} name @param {boolean} ok @param {string} detail */
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`)
}

/**
 * Poll until `probe` returns truthy or the deadline passes.
 * @template T
 * @param {() => Promise<T|null>} probe - async probe returning T when satisfied.
 * @param {number} timeoutMs - budget.
 * @param {number} [intervalMs] - poll period.
 * @returns {Promise<T|null>}
 */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs: number = 250,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null && value !== undefined && value !== false) return value
    await delay(intervalMs)
  }
  return null
}

/** A minimal CDP client over one page WebSocket. */
class CdpPage {
  socket: WebSocket
  nextId: number
  pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>
  events: Array<{ method: string; params: any }>
  ready: Promise<void>
  closed: Promise<void>

  /** @param {string} url - tab webSocketDebuggerUrl. */
  constructor(url: string) {
    /** @type {WebSocket} */
    this.socket = new WebSocket(url)
    this.nextId = 1
    /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>} */
    this.pending = new Map()
    /** @type {Array<{method: string, params: any}>} */
    this.events = []
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener('open', () => resolveReady(undefined), { once: true })
      this.socket.addEventListener('error', () => rejectReady(new Error('CDP socket error')), { once: true })
    })
    this.closed = new Promise((resolveClosed) => {
      this.socket.addEventListener(
        'close',
        () => {
          // Fail every in-flight command instead of leaving the process with an
          // unsettled top-level await when Chrome disappears mid-run.
          for (const [id, entry] of this.pending)
            entry.reject(new Error(`CDP socket closed before command ${id} answered`))
          this.pending.clear()
          resolveClosed(undefined)
        },
        { once: true },
      )
    })
    this.socket.addEventListener('message', (event) => {
      let payload
      try {
        payload = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (payload.id !== undefined && this.pending.has(payload.id)) {
        const entry = this.pending.get(payload.id)!
        this.pending.delete(payload.id)
        if (payload.error !== undefined) entry.reject(new Error(payload.error.message))
        else entry.resolve(payload.result)
        return
      }
      if (typeof payload.method === 'string') this.events.push({ method: payload.method, params: payload.params })
    })
  }

  /**
   * Send one CDP command.
   * @param {string} method - CDP method name.
   * @param {Record<string, unknown>} [params] - params.
   * @returns {Promise<any>}
   */
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++
    const message = JSON.stringify({ id, method, params })
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectSend(new Error(`CDP command ${method} timed out`))
      }, 15_000)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveSend(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectSend(error)
        },
      })
      this.socket.send(message)
    })
  }

  /**
   * Evaluate an expression in the page's main world.
   * @param {string} expression - JS source.
   * @returns {Promise<any>} the JSON-serialized value.
   */
  async evaluate(expression: string): Promise<any> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed'
      throw new Error(text)
    }
    return result.result?.value
  }

  /**
   * Capture a PNG of the current viewport.
   * @param {string} file - output path.
   * @returns {Promise<number>} byte length written.
   */
  async screenshot(file: string): Promise<number> {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const bytes = Buffer.from(String(result.data), 'base64')
    writeFileSync(file, bytes)
    return bytes.length
  }

  /** Close the socket. @returns {void} */
  close(): void {
    try {
      this.socket.close()
    } catch {
      // already closed
    }
  }
}

/** Chrome and the tab, torn down by the finally block. */
let chrome = null
let page: CdpPage = null!
let profileDir = null

try {
  mkdirSync(OUT_DIR, { recursive: true })
  profileDir = mkdtempSync(join(tmpdir(), 'chrome-dsh-loop-'))

  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      // The DSH file sandbox denies writes below ~/Library, where Chrome's crash
      // reporter would otherwise open dumps and abort the whole browser process.
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1440,900',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let chromeStderr = ''
  chrome.stderr?.on('data', (chunk) => {
    chromeStderr += String(chunk)
  })

  const version = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(1000) })
      return response.ok ? await response.json() : null
    } catch {
      return null
    }
  }, 20_000)
  if (version === null) {
    console.error(`browser-verify: Chrome did not open its debugging port\n${chromeStderr.slice(-2000)}`)
    process.exit(2)
  }
  console.log(`Chrome ${version.Browser ?? ''} ready on :${DEBUG_PORT}`)

  // Open a blank tab, attach, THEN navigate to the authenticated app URL: the
  // host exchanges `?token=` for a cookie and redirects to the shell.
  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  })
  if (!created.ok) {
    console.error(`browser-verify: could not open a tab (${created.status})`)
    process.exit(2)
  }
  const target = await created.json()
  page = new CdpPage(target.webSocketDebuggerUrl)
  await page.ready
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Log.enable')
  const targetUrl = `${BASE}/?token=${encodeURIComponent(TOKEN)}`
  await page.send('Page.navigate', { url: targetUrl })

  // The shell is a SPA: wait for the boot graph global and the sidebar shell.
  const booted = await waitFor(async () => {
    try {
      return await page.evaluate('Boolean(globalThis.__DSH_BOOT__) && document.readyState !== "loading"')
    } catch {
      return null
    }
  }, 30_000)
  check(
    'app shell boots',
    booted === true,
    booted === true ? 'window.__DSH_BOOT__ present' : 'boot graph never appeared',
  )

  // A first-run "Preview Notice" dialog covers the panel on a fresh profile.
  // Dismiss it so the panel and the screenshots show the real page.
  await page.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent && candidate.textContent.trim() === 'Continue')
    if (button) button.click()
  })()`)
  await delay(300)

  // Sidebar row: the host renders each panellist label as the row's aria-label.
  const rowCount = await waitFor(async () => {
    try {
      const count = await page.evaluate(
        `document.querySelectorAll('button[aria-label=${JSON.stringify(LABEL)}]').length`,
      )
      return count > 0 ? count : null
    } catch {
      return null
    }
  }, 20_000)
  check('sidebar Loop Manager row', rowCount === 1, `found ${String(rowCount ?? 0)} button[aria-label="${LABEL}"]`)
  const sidebarBytes = await page.screenshot(join(OUT_DIR, 'verify-sidebar.png'))
  console.log(`      wrote ${join(OUT_DIR, 'verify-sidebar.png')} (${sidebarBytes} bytes)`)

  // Click the row and wait for our page.
  if (rowCount === 1) {
    await page.evaluate(`document.querySelector('button[aria-label=${JSON.stringify(LABEL)}]').click()`)
    const rendered = await waitFor(async () => {
      try {
        return await page.evaluate(`(() => {
          const text = document.body.innerText || ''
          return text.includes('新建 Pipeline') && text.includes('Agent Pipeline')
        })()`)
      } catch {
        return null
      }
    }, 15_000)
    check(
      'panel renders after click',
      rendered === true,
      rendered === true ? 'list header + 新建 Pipeline visible' : 'panel copy never appeared',
    )
    const panelBytes = await page.screenshot(join(OUT_DIR, 'verify-panel.png'))
    console.log(`      wrote ${join(OUT_DIR, 'verify-panel.png')} (${panelBytes} bytes)`)

    // A second sanity check: the page really is our mounted React tree, not a
    // text match on a transcript.
    const hasRoot = await page.evaluate(`document.querySelectorAll('.lm-root .lm-shell .lm-app').length`)
    check('loop-manager markup mounted', Number(hasRoot) >= 1, `.lm-root workbench nodes: ${String(hasRoot)}`)

    // ---- v9 Loop tab (CONTRACT.md §13.7) ---------------------------------
    const navOrder = await page.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('.lm-nav [data-nav]'));
      const index = (name) => buttons.findIndex((button) => button.getAttribute('data-nav') === name);
      return { agent: index('all'), loops: index('loops'), recent: index('recent'), labels: buttons.map((button) => button.getAttribute('data-nav')) };
    })()`)
    check(
      'Loop tab sits after Agent Pipeline',
      navOrder !== null &&
        navOrder.agent >= 0 &&
        navOrder.loops === navOrder.agent + 1 &&
        navOrder.recent > navOrder.loops,
      `tabs: ${JSON.stringify(navOrder?.labels ?? [])}`,
    )

    const clickedLoopTab = await page.evaluate(`(() => {
      const button = document.querySelector('.lm-nav [data-nav="loops"]');
      if (!button) return false;
      button.click();
      return true;
    })()`)
    const loopView =
      clickedLoopTab === true
        ? await waitFor(async () => {
            try {
              return await page.evaluate(`(() => {
              const crumb = document.querySelector('.lm-crumb');
              const heading = document.querySelector('.lm-root h1');
              const body = document.body.innerText || '';
              if (!crumb || crumb.textContent.trim() !== 'Loop') return null;
              if (!heading || heading.textContent.trim() !== 'Loop') return null;
              if (!body.includes('新建 Loop')) return null;
              return {
                eyebrow: (document.querySelector('.lm-root .eyebrow') || { textContent: '' }).textContent.trim(),
                empty: body.includes('还没有 Loop'),
              };
            })()`)
            } catch {
              return null
            }
          }, 15_000)
        : null
    check(
      'Loop list renders after clicking Loop',
      loopView !== null,
      loopView === null
        ? 'Loop tab never rendered the list'
        : `eyebrow="${loopView.eyebrow}", emptyState=${loopView.empty}`,
    )

    let countSync = null
    try {
      countSync = await page.evaluate(`fetch('/loop-manager/api/state', { headers: { accept: 'application/json' } })
        .then((response) => response.json())
        .then((state) => {
          const badge = document.querySelector('.lm-loop-count');
          return { badge: badge ? String(badge.textContent).trim() : null, loops: Array.isArray(state.loops) ? state.loops.length : -1 };
        })`)
    } catch {
      countSync = null
    }
    check(
      'Loop count matches state',
      countSync !== null && countSync.loops >= 0 && String(countSync.badge) === String(countSync.loops),
      countSync === null ? 'state fetch failed' : `badge=${String(countSync.badge)} loops=${String(countSync.loops)}`,
    )

    const loopBytes = await page.screenshot(join(OUT_DIR, 'verify-loop-tab.png'))
    console.log(`      wrote ${join(OUT_DIR, 'verify-loop-tab.png')} (${loopBytes} bytes)`)

    // ---- new-Loop editor: steps can be added and removed (§13.8.4) --------
    const editor = await page.evaluate(`(async () => {
      const create = document.querySelector('[data-action="create-loop"]')
      if (!create) return null
      create.click()
      await new Promise((resolve) => setTimeout(resolve, 120))
      // Every add/remove re-renders the modal, so always re-query it.
      const modal = () => document.querySelector('.modal.lm-loop-form')
      const count = () => (modal() === null ? -1 : modal().querySelectorAll('.lm-loop-step').length)
      if (modal() === null) return null
      const before = count()
      const add = modal().querySelector('[data-action="add-step"]')
      if (add) add.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      const added = count()
      const removes = modal() === null ? [] : modal().querySelectorAll('[data-loop-step-action="remove"]')
      if (removes.length > 1) removes[removes.length - 1].click()
      await new Promise((resolve) => setTimeout(resolve, 150))
      const removed = count()
      const form = modal()
      return {
        before,
        added,
        removed,
        hasName: Boolean(form && form.querySelector('.lm-field-loop-name')),
        hasPipelineSelect: Boolean(form && form.querySelector('.lm-field-pipeline')),
        hasGateName: Boolean(form && form.querySelector('.lm-field-gate-name')),
        hasAuto: Boolean(form && form.querySelector('.lm-field-gate-auto')),
        hasMax: Boolean(form && form.querySelector('.lm-field-gate-max')),
      }
    })()`)
    check(
      'new-Loop editor adds/removes steps',
      editor !== null &&
        editor.hasName &&
        editor.hasPipelineSelect &&
        editor.hasGateName &&
        editor.hasAuto &&
        editor.hasMax &&
        editor.added === editor.before + 1 &&
        editor.removed === editor.before,
      editor === null
        ? 'editor modal never opened'
        : `steps ${editor.before} -> ${editor.added} -> ${editor.removed}, name=${editor.hasName} pipeline=${editor.hasPipelineSelect} gateName=${editor.hasGateName} auto=${editor.hasAuto} max=${editor.hasMax}`,
    )
    const editorBytes = await page.screenshot(join(OUT_DIR, 'verify-loop-editor.png'))
    console.log(`      wrote ${join(OUT_DIR, 'verify-loop-editor.png')} (${editorBytes} bytes)`)
    await page.evaluate(`(() => {
      const close = document.querySelector('.modal.lm-loop-form [data-action="close"]')
      if (close) close.click()
    })()`)

    // ---- list row + detail flow render for a real saved loop -------------
    const createdLoop = await page.evaluate(`(async () => {
      const state = await (await fetch('/loop-manager/api/state', { headers: { accept: 'application/json' } })).json()
      const pipeline = Array.isArray(state.pipelines) ? state.pipelines[0] : undefined
      if (!pipeline) return null
      const response = await fetch('/loop-manager/api/loops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'browser-verify-loop',
          desc: 'scripts/browser-verify.mjs',
          steps: [{ pipelineId: pipeline.id, gate: { name: '门禁', type: 'agent', command: '输出里是否有 DONE', autoLoop: false, maxIterations: 3 } }],
        }),
      })
      const body = await response.json()
      return body && body.ok === true && body.loop && typeof body.loop.id === 'string' ? body.loop : null
    })()`)
    let loopRowOk = false
    let loopDetailOk = false
    try {
      if (createdLoop !== null) {
        const row = await waitFor(async () => {
          try {
            return await page.evaluate(`Boolean(document.querySelector('[data-open-loop="${createdLoop.id}"]'))`)
          } catch {
            return null
          }
        }, 15_000)
        loopRowOk = row === true
        check(
          'Loop row renders in the list',
          loopRowOk,
          loopRowOk ? `loop ${createdLoop.id} has a row` : 'row never appeared after the poll',
        )
        if (loopRowOk) {
          await page.evaluate(`document.querySelector('[data-open-loop="${createdLoop.id}"]').click()`)
          loopDetailOk =
            (await waitFor(async () => {
              try {
                return await page.evaluate(`(() => {
                const flow = document.querySelector('.lm-loop-flow')
                const stage = document.querySelector('.lm-loop-stage')
                const gateCard = document.querySelector('.lm-loop-gate')
                const text = document.body.innerText || ''
                return Boolean(flow && stage && gateCard && (text.includes('手动循环') || text.includes('自动循环')))
              })()`)
              } catch {
                return null
              }
            }, 15_000)) === true
          check(
            'Loop detail flow renders',
            loopDetailOk,
            loopDetailOk ? 'pipeline card + gate card + loop policy visible' : 'flow never rendered',
          )
          const detailBytes = await page.screenshot(join(OUT_DIR, 'verify-loop-detail.png'))
          console.log(`      wrote ${join(OUT_DIR, 'verify-loop-detail.png')} (${detailBytes} bytes)`)
        }
      } else {
        check('Loop row renders in the list', false, 'could not create a probe loop through the API')
      }
    } finally {
      if (createdLoop !== null) {
        try {
          await page.evaluate(
            `fetch('/loop-manager/api/loops/${createdLoop.id}', { method: 'DELETE' }).then((response) => response.json())`,
          )
        } catch {
          // best-effort cleanup; the verification profile is disposable
        }
      }
    }
  }

  // Uncaught page errors / console errors recorded during the run.
  const problems = page.events
    .filter(
      (event) =>
        event.method === 'Runtime.exceptionThrown' ||
        (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'),
    )
    .map((event) => {
      if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params?.exceptionDetails
        return details?.exception?.description ?? details?.text ?? 'uncaught exception'
      }
      return event.params?.entry?.text ?? 'console error'
    })
  const relevant = problems.filter((text) =>
    /loop-manager|lm-|Loop Manager|Cannot read|not a function|undefined is not/i.test(String(text)),
  )
  check(
    'no uncaught page errors',
    relevant.length === 0,
    relevant.length === 0 ? `${problems.length} unrelated console errors` : relevant.slice(0, 3).join(' | '),
  )

  const failed = results.filter((entry) => !entry.ok)
  console.log(
    `\nBROWSER ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length} checks`,
  )
  process.exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  console.error(`browser-verify: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 2
} finally {
  page?.close()
  if (chrome !== null && !KEEP_CHROME) {
    chrome.kill('SIGTERM')
    await delay(500)
    if (chrome.exitCode === null) chrome.kill('SIGKILL')
  }
  if (profileDir !== null && !KEEP_CHROME) {
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}
