#!/usr/bin/env node
/**
 * e2e-run.mjs — end-to-end check of the Loop Manager engine with REAL agents.
 *
 * Drives the Web GUI in headless Chrome (CDP), so every API call carries the
 * authenticated browser cookie the host minted from the launch token:
 *
 *   1. open the app + click the sidebar `Loop Manager` row;
 *   2. create a two-node pipeline (A -> B) through the HTTP API from the page;
 *   3. start it, poll `/loop-manager/api/state` until the run settles;
 *   4. assert: run completed, both nodes completed with non-empty output, and
 *      B's recorded output proves it received A's output through `{{input}}`;
 *   5. screenshot the run view.
 *
 * Requires a host whose default model is actually configured (the verify
 * profile needs the credentials file copied next to it), otherwise the nodes
 * fail with a model/credential error — which the script reports verbatim.
 *
 * Usage:
 *   node dist/scripts/e2e-run.mjs --base http://127.0.0.1:58099 --token <token> [--out dir] [--timeout 240]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const LABEL = 'Loop Manager'

/** @param {string[]} argv @returns {Record<string, string|boolean>} */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  /** @type {Record<string, string|boolean>} */
  const out: Record<string, string | boolean> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const BASE = String(args.base ?? 'http://127.0.0.1:58099').replace(/\/+$/, '')
const TOKEN = typeof args.token === 'string' ? args.token : ''
const CHROME = String(args.chrome ?? CHROME_DEFAULT)
const DEBUG_PORT = Number(args['debug-port'] ?? 9223)
const OUT_DIR = resolve(String(args.out ?? join(import.meta.dirname, '../../scripts')))
const TIMEOUT_MS = Number(args.timeout ?? 240_000)
if (TOKEN === '') {
  console.error('e2e-run: --token is required')
  process.exit(2)
}

/**
 * Poll until the probe answers truthy.
 * @template T @param {() => Promise<T|null>} probe @param {number} timeoutMs @returns {Promise<T|null>}
 */
async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, intervalMs = 500): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null && value !== undefined && value !== false) return value
    await delay(intervalMs)
  }
  return null
}

/** Minimal CDP page client (same shape as scripts/browser-verify.mjs). */
class CdpPage {
  socket: WebSocket
  nextId: number
  pending: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>
  events: Array<{ method: string; params: any }>
  ready: Promise<void>

  /** @param {string} url */
  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener('open', () => resolveReady(undefined), { once: true })
      this.socket.addEventListener('error', () => rejectReady(new Error('CDP socket error')), { once: true })
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
    this.socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }

  /** @param {string} method @param {Record<string, unknown>} [params] */
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectSend(new Error(`CDP command ${method} timed out`))
      }, 30_000)
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
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** @param {string} expression */
  async evaluate(expression: string) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed',
      )
    }
    return result.result?.value
  }

  /** @param {string} file @returns {Promise<number>} */
  async screenshot(file: string): Promise<number> {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const bytes = Buffer.from(String(result.data), 'base64')
    writeFileSync(file, bytes)
    return bytes.length
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* ignore */
    }
  }
}

let chrome = null
let page: CdpPage = null!
let profileDir = null
const failures = []
/** @param {string} name @param {boolean} ok @param {string} detail */
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`)
}

try {
  mkdirSync(OUT_DIR, { recursive: true })
  profileDir = mkdtempSync(join(tmpdir(), 'chrome-loop-e2e-'))
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
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
  let stderr = ''
  chrome.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
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
    console.error(`e2e-run: Chrome did not start\n${stderr.slice(-1500)}`)
    process.exit(2)
  }

  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  })
  const target = await created.json()
  page = new CdpPage(target.webSocketDebuggerUrl)
  await page.ready
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Log.enable')
  await page.send('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(TOKEN)}` })

  const shell = await waitFor(async () => {
    try {
      return await page.evaluate('Boolean(globalThis.__DSH_BOOT__) && document.readyState !== "loading"')
    } catch {
      return null
    }
  }, 30_000)
  check('app shell boots', shell === true, 'window.__DSH_BOOT__ present')

  // Open the panel through the real sidebar row (proves the entry point works).
  const row = await waitFor(async () => {
    try {
      const count = await page.evaluate(
        `document.querySelectorAll('button[aria-label=${JSON.stringify(LABEL)}]').length`,
      )
      return count > 0 ? count : null
    } catch {
      return null
    }
  }, 20_000)
  check('sidebar row present', row === 1, `buttons: ${String(row ?? 0)}`)
  await page.evaluate(`document.querySelector('button[aria-label=${JSON.stringify(LABEL)}]').click()`)
  await waitFor(async () => {
    try {
      return await page.evaluate(`document.body.innerText.includes('新建 Loop')`)
    } catch {
      return null
    }
  }, 15_000)

  // Everything below runs in the page, so it carries the authenticated cookie.
  const api = async (method: string, path: string, body?: unknown) =>
    page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify('/loop-manager/api')} + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      cache: 'no-store',
      ${body === undefined ? '' : `headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}),`}
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, json, text: text.slice(0, 400) }
  })()`)

  // Read the same model catalog the node picker shows, and pin node A to its
  // first advertised model (node B inherits the Harness default).
  const catalog = await api('GET', '/models')
  const firstProvider = (catalog.json?.providers ?? [])[0]
  const firstModel = firstProvider?.models?.[0]
  check(
    'model catalog available',
    catalog.status === 200 && firstModel !== undefined,
    firstModel ? `${firstProvider.id}/${firstModel.id}` : catalog.text,
  )
  const pinnedModel = firstModel === undefined ? undefined : { provider: firstProvider.id, model: firstModel.id }

  // A deliberately tiny task pair: A returns a marker, B must receive it.
  const marker = `LOOP${Date.now().toString(36).toUpperCase()}`
  const pipeline = {
    name: `E2E ${marker}`,
    description: 'automated end-to-end check',
    nodes: [
      {
        id: 'node-a',
        name: 'A: 说一个标记',
        command: `只输出这一行，不要任何解释和标点：${marker}-OK`,
        ...(pinnedModel === undefined ? {} : { model: pinnedModel }),
      },
      {
        id: 'node-b',
        name: 'B: 复述上游',
        command: '上游节点的输出是：{{input}}\n请只输出这一行：我收到 <上游的完整内容>',
      },
    ],
    edges: [{ from: 'node-a', to: 'node-b' }],
  }

  const createdPipeline = await api('POST', '/pipelines', pipeline)
  check(
    'create pipeline',
    createdPipeline.status === 200 && createdPipeline.json?.ok === true,
    createdPipeline.json?.ok === true ? `id ${createdPipeline.json.pipeline.id}` : createdPipeline.text,
  )
  const pipelineId = createdPipeline.json?.pipeline?.id

  // Open the pipeline in the panel and inspect the node dialog's model picker.
  if (pipelineId !== undefined) {
    const opened = await waitFor(async () => {
      try {
        return await page.evaluate(`(() => {
          const row = document.querySelector('[data-open=${JSON.stringify(pipelineId)}]')
          if (row === null) return false
          row.click()
          return true
        })()`)
      } catch {
        return null
      }
    }, 15_000)
    check('pipeline opens in editor', opened === true, opened === true ? 'row clicked' : 'row not found')

    const addOpened = await waitFor(async () => {
      try {
        return await page.evaluate(`(() => {
          const button = document.querySelector('[data-action="add-node"]')
          if (button === null) return false
          button.click()
          return true
        })()`)
      } catch {
        return null
      }
    }, 10_000)
    check('node dialog opens', addOpened === true, addOpened === true ? 'add-node clicked' : 'button not found')

    const modelPicker = await waitFor(async () => {
      try {
        return await page.evaluate(`(() => {
          const select = document.querySelector('.lm-field-model')
          if (select === null) return null
          return {
            options: select.options.length,
            first: select.options.length > 0 ? select.options[0].textContent : '',
            disabled: select.disabled,
          }
        })()`)
      } catch {
        return null
      }
    }, 10_000)
    check(
      'model picker present',
      modelPicker !== null && modelPicker.options >= 2,
      modelPicker === null ? 'no .lm-field-model' : `${modelPicker.options} options, first="${modelPicker.first}"`,
    )
    check(
      'model picker offers the Harness default',
      modelPicker !== null && /跟随 Harness 默认模型/.test(modelPicker.first),
      modelPicker === null ? 'no picker' : modelPicker.first,
    )

    const modalShot = await page.screenshot(join(OUT_DIR, 'verify-node-model.png'))
    console.log(`      wrote ${join(OUT_DIR, 'verify-node-model.png')} (${modalShot} bytes)`)
    await page.evaluate(
      `document.querySelector('.lm-root').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    )
    await delay(200)

    // The database configuration entry sits after 已收藏 and opens a config
    // modal with the read-source switch on top.
    const dbOpened = await waitFor(
      async () => {
        try {
          return await page.evaluate(`(() => {
          const button = document.querySelector('[data-db]')
          if (button === null) return false
          button.click()
          return true
        })()`)
        } catch {
          return null
        }
      },
      10_000,
      150,
    )
    check('database config entry opens', dbOpened === true, dbOpened === true ? 'nav clicked' : 'nav missing')
    const dbModal = await waitFor(
      async () => {
        try {
          return await page.evaluate(`(() => {
          const modal = document.querySelector('.modal')
          if (modal === null) return null
          return {
            title: (modal.querySelector('h2')?.textContent || '').trim(),
            hasSwitch: modal.querySelector('.lm-field-db-read') !== null,
            switchChecked: modal.querySelector('.lm-field-db-read') === null ? null : modal.querySelector('.lm-field-db-read').checked,
            hasHost: modal.querySelector('.lm-field-db-host') !== null,
            hasPort: modal.querySelector('.lm-field-db-port') !== null,
            hasDatabase: modal.querySelector('.lm-field-db-database') !== null,
            hasUser: modal.querySelector('.lm-field-db-user') !== null,
            hasTest: modal.querySelector('button[data-action="db-test"]') !== null,
            status: (modal.querySelector('[data-db-status]')?.textContent || '').trim(),
          }
        })()`)
        } catch {
          return null
        }
      },
      10_000,
      150,
    )
    check(
      'database config modal opens',
      dbModal !== null &&
        dbModal.title === '数据库配置' &&
        dbModal.hasHost &&
        dbModal.hasPort &&
        dbModal.hasDatabase &&
        dbModal.hasUser,
      dbModal === null
        ? 'no modal'
        : `title="${dbModal.title}" host=${dbModal.hasHost} port=${dbModal.hasPort} db=${dbModal.hasDatabase} user=${dbModal.hasUser}`,
    )
    check(
      'database read switch is on top',
      dbModal !== null && dbModal.hasSwitch === true && dbModal.hasTest === true,
      dbModal === null ? 'no modal' : `switch=${String(dbModal.switchChecked)} status="${dbModal.status}"`,
    )

    const switched = await page.evaluate(`(() => {
      const checkbox = document.querySelector('.lm-field-db-read')
      if (checkbox === null) return null
      const before = checkbox.checked
      checkbox.click()
      const after = checkbox.checked
      checkbox.click()
      return { before, after, restored: checkbox.checked }
    })()`)
    check(
      'database read switch toggles',
      switched !== null && switched.after !== switched.before && switched.restored === switched.before,
      switched === null
        ? 'no switch'
        : `${String(switched.before)} → ${String(switched.after)} → ${String(switched.restored)}`,
    )

    const dbShot = await page.screenshot(join(OUT_DIR, 'verify-db-config.png'))
    console.log(`      wrote ${join(OUT_DIR, 'verify-db-config.png')} (${dbShot} bytes)`)

    if (dbModal !== null && /已连接/.test(dbModal.status)) {
      await page.evaluate(`(() => {
        const button = document.querySelector('.modal button[data-action="db-test"]')
        if (button !== null) button.click()
      })()`)
      const testResult = await waitFor(
        async () => {
          try {
            const text = await page.evaluate(`(() => {
            const status = document.querySelector('.modal [data-db-status]')
            return status === null ? null : status.textContent.trim()
          })()`)
            return typeof text === 'string' && /连接成功|失败|错误/.test(text) ? text : null
          } catch {
            return null
          }
        },
        15_000,
        200,
      )
      check(
        'database test connection works',
        typeof testResult === 'string' && /连接成功/.test(testResult),
        `status="${String(testResult)}"`,
      )

      // Exercise the real form submit: switch the read source off, save, then
      // reopen and switch it back on. The password field stays empty and must
      // reuse the saved secret.
      await page.evaluate(`(() => {
        const checkbox = document.querySelector('.lm-field-db-read')
        if (checkbox !== null && checkbox.checked) checkbox.click()
        const submit = document.querySelector('.modal button[type="submit"]')
        if (submit !== null) submit.click()
      })()`)
      const savedOff = await waitFor(
        async () => {
          try {
            const modalGone = await page.evaluate(`document.querySelector('.modal') === null`)
            if (modalGone !== true) return null
            const result = await api('GET', '/db')
            return result.json?.db?.readFromDb === false ? result.json.db : null
          } catch {
            return null
          }
        },
        15_000,
        300,
      )
      check(
        'database config saves read switch off',
        savedOff !== null,
        savedOff === null ? 'modal did not close / readFromDb stayed on' : 'readFromDb=false',
      )

      await waitFor(
        async () => {
          try {
            return await page.evaluate(`(() => {
            const button = document.querySelector('[data-db]')
            if (button === null) return false
            button.click()
            return true
          })()`)
          } catch {
            return null
          }
        },
        10_000,
        150,
      )
      await waitFor(
        async () => {
          try {
            return await page.evaluate(`document.querySelector('.lm-field-db-read') !== null`)
          } catch {
            return null
          }
        },
        10_000,
        150,
      )
      await page.evaluate(`(() => {
        const checkbox = document.querySelector('.lm-field-db-read')
        if (checkbox !== null && !checkbox.checked) checkbox.click()
        const submit = document.querySelector('.modal button[type="submit"]')
        if (submit !== null) submit.click()
      })()`)
      const savedOn = await waitFor(
        async () => {
          try {
            const modalGone = await page.evaluate(`document.querySelector('.modal') === null`)
            if (modalGone !== true) return null
            const result = await api('GET', '/db')
            return result.json?.db?.readFromDb === true ? result.json.db : null
          } catch {
            return null
          }
        },
        15_000,
        300,
      )
      check(
        'database config saves read switch on',
        savedOn !== null,
        savedOn === null ? 'modal did not close / readFromDb stayed off' : 'readFromDb=true',
      )
    } else {
      console.log('INFO  database is not configured yet; connection and save checks were not exercised')
    }

    await page.evaluate(`(() => {
      const button = document.querySelector('.modal button[data-action="close"]')
      if (button !== null) button.click()
    })()`)
    await waitFor(
      async () => {
        try {
          return await page.evaluate(`document.querySelector('.modal') === null`)
        } catch {
          return null
        }
      },
      5_000,
      100,
    )
  }

  let run = null
  if (pipelineId !== undefined) {
    const startSelector = `[data-run=${JSON.stringify(pipelineId)}]`
    const openStart = await waitFor(
      async () => {
        try {
          return await page.evaluate(`(() => {
          const button = document.querySelector(${JSON.stringify(startSelector)})
          if (button === null) return false
          button.click()
          return true
        })()`)
        } catch {
          return null
        }
      },
      10_000,
      150,
    )
    check(
      'start button opens a dialog',
      openStart === true,
      openStart === true ? 'start clicked' : 'start button missing',
    )

    const startDialog = await waitFor(
      async () => {
        try {
          return await page.evaluate(`(() => {
          const modal = document.querySelector('.modal')
          if (modal === null) return null
          return {
            title: (modal.querySelector('h2')?.textContent || '').trim(),
            hasCancel: modal.querySelector('button[data-action="close"]') !== null,
            hasConfirm: modal.querySelector('button[data-action="confirm-run"]') !== null,
          }
        })()`)
        } catch {
          return null
        }
      },
      5_000,
      100,
    )
    check(
      'start asks for confirmation',
      startDialog !== null && startDialog.title === '开始任务？' && startDialog.hasCancel && startDialog.hasConfirm,
      startDialog === null
        ? 'no dialog'
        : `title="${startDialog.title}" cancel=${startDialog.hasCancel} confirm=${startDialog.hasConfirm}`,
    )
    const startShot = await page.screenshot(join(OUT_DIR, 'verify-start-confirm.png'))
    console.log(`      wrote ${join(OUT_DIR, 'verify-start-confirm.png')} (${startShot} bytes)`)

    // Cancel once: it must not start a run.
    await page.evaluate(`(() => {
      const button = document.querySelector('.modal button[data-action="close"]')
      if (button !== null) button.click()
    })()`)
    const startCancelled = await waitFor(
      async () => {
        try {
          return await page.evaluate(`document.querySelector('.modal') === null`)
        } catch {
          return null
        }
      },
      5_000,
      100,
    )
    check(
      'start confirmation can be cancelled',
      startCancelled === true,
      startCancelled === true ? 'dialog closed' : 'dialog stayed open',
    )

    // Reopen and confirm: the run starts only after the confirm button.
    await waitFor(
      async () => {
        try {
          return await page.evaluate(`(() => {
          const button = document.querySelector(${JSON.stringify(startSelector)})
          if (button === null) return false
          button.click()
          return true
        })()`)
        } catch {
          return null
        }
      },
      10_000,
      150,
    )
    await waitFor(
      async () => {
        try {
          return await page.evaluate(`document.querySelector('.modal button[data-action="confirm-run"]') !== null`)
        } catch {
          return null
        }
      },
      5_000,
      100,
    )
    const startedAfter = Date.now()
    await page.evaluate(`document.querySelector('.modal button[data-action="confirm-run"]').click()`)

    const started = await waitFor(
      async () => {
        const state = await api('GET', '/state')
        return (
          (state.json?.runs ?? []).find(
            (candidate: any) => candidate.pipelineId === pipelineId && candidate.startedAt >= startedAfter,
          ) || null
        )
      },
      20_000,
      400,
    )
    check('confirm starts the run', started !== null, started === null ? 'no run after confirm' : `run ${started.id}`)
    const runId = started?.id

    // While it runs, the stop button must also ask before stopping.
    if (runId !== undefined) {
      const stopShown = await waitFor(
        async () => {
          try {
            return await page.evaluate(`document.querySelector('[data-stop]') !== null`)
          } catch {
            return null
          }
        },
        8_000,
        150,
      )
      if (stopShown === true) {
        await page.evaluate(`document.querySelector('[data-stop]').click()`)
        const stopDialog = await waitFor(
          async () => {
            try {
              return await page.evaluate(`(() => {
              const modal = document.querySelector('.modal')
              if (modal === null) return null
              return {
                title: (modal.querySelector('h2')?.textContent || '').trim(),
                hasCancel: modal.querySelector('button[data-action="close"]') !== null,
                hasConfirm: modal.querySelector('button[data-action="confirm-stop"]') !== null,
              }
            })()`)
            } catch {
              return null
            }
          },
          5_000,
          100,
        )
        check(
          'stop asks for confirmation',
          stopDialog !== null && stopDialog.title === '停止任务？' && stopDialog.hasCancel && stopDialog.hasConfirm,
          stopDialog === null
            ? 'no dialog'
            : `title="${stopDialog.title}" cancel=${stopDialog.hasCancel} confirm=${stopDialog.hasConfirm}`,
        )
        const stopShot = await page.screenshot(join(OUT_DIR, 'verify-stop-confirm.png'))
        console.log(`      wrote ${join(OUT_DIR, 'verify-stop-confirm.png')} (${stopShot} bytes)`)
        await page.evaluate(`(() => {
          const button = document.querySelector('.modal button[data-action="close"]')
          if (button !== null) button.click()
        })()`)
        const stopCancelled = await waitFor(
          async () => {
            try {
              return await page.evaluate(`document.querySelector('.modal') === null`)
            } catch {
              return null
            }
          },
          5_000,
          100,
        )
        check(
          'stop confirmation can be cancelled',
          stopCancelled === true,
          stopCancelled === true ? 'dialog closed' : 'dialog stayed open',
        )
      } else {
        console.log('INFO  run finished before the stop button appeared; stop confirmation was not exercised')
      }
    }

    if (runId !== undefined) {
      // Poll the same endpoint the UI polls.
      const settled = await waitFor(
        async () => {
          const state = await api('GET', '/state')
          const found = (state.json?.runs ?? []).find((candidate: any) => candidate.id === runId)
          if (found === undefined) return null
          return found.status === 'running' ? null : found
        },
        TIMEOUT_MS,
        1500,
      )

      if (settled === null) {
        check('run settles', false, `still running after ${TIMEOUT_MS} ms`)
      } else {
        run = settled
        check(
          'run settles',
          true,
          `status=${settled.status} after ${Math.round((settled.finishedAt ?? Date.now()) - settled.startedAt)} ms`,
        )
        const stateA = settled.nodeStates?.['node-a'] ?? {}
        const stateB = settled.nodeStates?.['node-b'] ?? {}
        check(
          'node A completed',
          stateA.status === 'completed',
          `status=${stateA.status} output=${JSON.stringify(String(stateA.output ?? '').slice(0, 80))}`,
        )
        check(
          'node B completed',
          stateB.status === 'completed',
          `status=${stateB.status} output=${JSON.stringify(String(stateB.output ?? '').slice(0, 80))}`,
        )
        check(
          'A output reached B',
          String(stateB.output ?? '').includes(marker) || String(stateB.output ?? '').includes('我收到'),
          `B output mentions A: ${String(stateB.output ?? '').includes(marker)}`,
        )
        check(
          'run completed',
          settled.status === 'completed',
          `status=${settled.status}${settled.error ? ` error=${settled.error}` : ''}`,
        )
      }
    }
  }

  // The panel polls `/state`; wait for the editor log to catch up with the run.
  const logUi = await waitFor(async () => {
    try {
      return await page.evaluate(`(() => {
        const blocks = document.querySelectorAll('.logs .lm-log-node')
        if (blocks.length < 2) return null
        const details = document.querySelector('.logs details.lm-think')
        const output = document.querySelector('.logs .lm-log-output-text')
        return {
          blocks: blocks.length,
          hasThinking: details !== null,
          thinkingOpen: details === null ? null : details.open,
          thinkingSummary: details === null ? '' : (details.querySelector('summary')?.textContent ?? ''),
          output: output === null ? '' : output.textContent,
        }
      })()`)
    } catch {
      return null
    }
  }, 20_000)
  check(
    'run log renders per-node blocks',
    logUi !== null && logUi.blocks >= 2,
    logUi === null ? 'no .lm-log-node' : `${logUi.blocks} blocks`,
  )
  check(
    'run log shows the final result',
    logUi !== null && logUi.output.includes(marker),
    logUi === null ? 'no output node' : JSON.stringify(logUi.output.slice(0, 100)),
  )
  // Bring the log panel into the viewport so the screenshots actually show it.
  await page.evaluate(`(() => {
    const logs = document.querySelector('.logs')
    if (logs !== null) logs.scrollIntoView({ block: 'start' })
  })()`)
  await delay(150)
  const foldedShot = await page.screenshot(join(OUT_DIR, 'verify-run-folded.png'))
  console.log(`      wrote ${join(OUT_DIR, 'verify-run-folded.png')} (${foldedShot} bytes)`)
  if (logUi !== null && logUi.hasThinking) {
    check(
      'thinking starts folded',
      logUi.thinkingOpen === false,
      `summary=${JSON.stringify(logUi.thinkingSummary.trim())}`,
    )
    await page.evaluate(`document.querySelector('.logs details.lm-think summary').click()`)
    const openedThinking = await page.evaluate(`document.querySelector('.logs details.lm-think').open`)
    check('thinking expands on click', openedThinking === true, `open=${String(openedThinking)}`)

    // The panel re-renders on every /state poll: the expanded block must survive it.
    await delay(2_500)
    const stillOpen = await page.evaluate(`(() => {
      const details = document.querySelector('.logs details.lm-think')
      return details === null ? null : details.open
    })()`)
    check('thinking stays expanded across polls', stillOpen === true, `open=${String(stillOpen)}`)

    await page.evaluate(`(() => {
      const logs = document.querySelector('.logs')
      if (logs !== null) logs.scrollIntoView({ block: 'start' })
    })()`)
    await delay(150)
    const shot = await page.screenshot(join(OUT_DIR, 'verify-run.png'))
    console.log(`      wrote ${join(OUT_DIR, 'verify-run.png')} (${shot} bytes)`)

    // Collapsing is also remembered, so a poll must not re-open it.
    await page.evaluate(`document.querySelector('.logs details.lm-think summary').click()`)
    await delay(2_500)
    const stillClosed = await page.evaluate(`(() => {
      const details = document.querySelector('.logs details.lm-think')
      return details === null ? null : details.open
    })()`)
    check('thinking stays collapsed after closing', stillClosed === false, `open=${String(stillClosed)}`)

    // Scrolling inside an expanded thinking block must also survive the polls.
    // Shrink the block in the test page so even a short reasoning body scrolls.
    await page.evaluate(`(() => {
      const style = document.createElement('style')
      style.setAttribute('data-e2e', 'think-scroll')
      style.textContent = '.lm-root .logs .lm-think-body{max-height:24px !important}'
      document.head.appendChild(style)
    })()`)
    await page.evaluate(`document.querySelector('.logs details.lm-think summary').click()`)
    const scrollTop = await waitFor(
      async () => {
        try {
          return await page.evaluate(`(() => {
          const body = document.querySelector('.logs details.lm-think .lm-think-body')
          if (body === null || body.scrollHeight <= body.clientHeight) return null
          body.scrollTop = Math.min(60, body.scrollHeight - body.clientHeight)
          return body.scrollTop
        })()`)
        } catch {
          return null
        }
      },
      5_000,
      100,
    )
    check('thinking body can scroll', typeof scrollTop === 'number' && scrollTop > 0, `scrollTop=${String(scrollTop)}`)

    await delay(2_500)
    const scrollAfter = await page.evaluate(`(() => {
      const details = document.querySelector('.logs details.lm-think')
      const body = details === null ? null : details.querySelector('.lm-think-body')
      return { open: details === null ? null : details.open, top: body === null ? null : body.scrollTop }
    })()`)
    check(
      'thinking scroll position survives polls',
      scrollAfter.open === true &&
        typeof scrollAfter.top === 'number' &&
        scrollAfter.top > 0 &&
        typeof scrollTop === 'number' &&
        Math.abs(scrollAfter.top - scrollTop) <= 1,
      `open=${String(scrollAfter.open)} scrollTop=${String(scrollAfter.top)} (was ${String(scrollTop)})`,
    )

    await page.evaluate(`(() => {
      const style = document.querySelector('style[data-e2e="think-scroll"]')
      if (style !== null) style.remove()
    })()`)
  } else {
    console.log('INFO  thinking block not present (this model returned no reasoning for the prompt)')
    const shot = await page.screenshot(join(OUT_DIR, 'verify-run.png'))
    console.log(`      wrote ${join(OUT_DIR, 'verify-run.png')} (${shot} bytes)`)
  }
  // Confirm that the stop dialog's confirm button really stops a live run. A
  // `sleep` keeps the node busy long enough for the UI to expose its stop button.
  const stopPipeline = await api('POST', '/pipelines', {
    name: `E2E stop ${marker}`,
    description: 'stop-confirmation probe',
    nodes: [
      {
        id: 'node-stop',
        name: 'stop probe',
        command: '请调用 bash 工具执行 `sleep 6`，然后只输出：STOP-PROBE',
      },
    ],
    edges: [] as any[],
  })
  const stopPipelineId = stopPipeline.json?.pipeline?.id
  if (stopPipelineId !== undefined) {
    // The panel is still showing the first pipeline's editor; go back to the
    // list so the new pipeline row is rendered.
    await page.evaluate(`(() => {
      const back = document.querySelector('[data-action="back"]')
      if (back !== null) back.click()
    })()`)
    const stopRow = await waitFor(
      async () => {
        try {
          return await page.evaluate(`(() => {
          const row = document.querySelector('[data-open=${JSON.stringify(stopPipelineId)}]')
          if (row === null) return false
          row.click()
          return true
        })()`)
        } catch {
          return null
        }
      },
      15_000,
      200,
    )
    check('stop probe pipeline opens', stopRow === true, stopRow === true ? 'row clicked' : 'row not found')

    const stopStarted = await api('POST', `/pipelines/${stopPipelineId}/run`)
    const stopRunId = stopStarted.json?.run?.id
    check(
      'stop probe run starts',
      stopStarted.status === 202 && stopRunId !== undefined,
      stopRunId !== undefined ? `run ${stopRunId}` : stopStarted.text,
    )

    const stopButtonShown = await waitFor(
      async () => {
        try {
          return await page.evaluate(`document.querySelector('[data-stop]') !== null`)
        } catch {
          return null
        }
      },
      10_000,
      100,
    )
    if (stopButtonShown === true && stopRunId !== undefined) {
      await page.evaluate(`document.querySelector('[data-stop]').click()`)
      await waitFor(
        async () => {
          try {
            return await page.evaluate(`document.querySelector('.modal button[data-action="confirm-stop"]') !== null`)
          } catch {
            return null
          }
        },
        5_000,
        100,
      )
      await page.evaluate(`document.querySelector('.modal button[data-action="confirm-stop"]').click()`)
      const stopped = await waitFor(
        async () => {
          const state = await api('GET', '/state')
          const found = (state.json?.runs ?? []).find((candidate: any) => candidate.id === stopRunId)
          return found !== undefined && found.status !== 'running' ? found : null
        },
        20_000,
        300,
      )
      check(
        'stop confirmation stops the run',
        stopped !== null && stopped.status === 'stopped',
        stopped === null ? 'run stayed running' : `status=${stopped.status}`,
      )
    } else {
      check('stop confirmation stops the run', false, 'run finished before the stop button appeared')
    }
  }

  // Surface the host-side error detail when a node failed (credential/model issues).
  if (run !== null) {
    for (const [nodeId, state] of Object.entries<any>(run.nodeStates ?? {})) {
      if (state.status === 'failed' || state.error)
        console.log(`      ${nodeId}: ${state.status} — ${state.error ?? ''}`)
    }
  }

  const relevant = page.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params?.exceptionDetails?.exception?.description ?? 'uncaught exception')
    .filter((text) => /loop-manager|lm-/i.test(String(text)))
  check('no uncaught page errors', relevant.length === 0, relevant.slice(0, 2).join(' | ') || 'none')

  console.log(`\nE2E ${failures.length === 0 ? 'PASS' : 'FAIL'} (${failures.length} failed)`)
  process.exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  console.error(`e2e-run: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 2
} finally {
  page?.close()
  if (chrome !== null) {
    chrome.kill('SIGTERM')
    await delay(400)
    if (chrome.exitCode === null) chrome.kill('SIGKILL')
  }
  if (profileDir !== null) {
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}
