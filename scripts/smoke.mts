#!/usr/bin/env node
/**
 * smoke.mjs — dependency-free end-to-end smoke test for the dsh-loop-manager
 * plugin running in a real DSH web profile.
 *
 * Checks, in order (stops at the first failure with a non-zero exit):
 *   1. GET /                                  -> 200 HTML containing `__DSH_BOOT__`
 *   2. boot graph                             -> a row with id `dsh-loop-manager`
 *   3. that row's bundle URL                  -> 200 and body starts with
 *                                                `window.__ModuleLoader__.load(`
 *   4. GET /loop-manager/api/state            -> 200 JSON
 *                                                `{ ok: true, pipelines, runs, loops, loopRuns }`
 *   5. CRUD round trip                        -> POST pipeline -> GET state contains it
 *                                                -> DELETE -> GET state no longer has it
 *   6. Loop CRUD round trip (v9, §13.6)       -> POST loop referencing that pipeline
 *                                                -> GET state has loops/loopRuns -> PATCH
 *                                                -> DELETE loop -> state no longer has it
 *   7. Loop error paths                       -> invalid-loop, loop-not-found,
 *                                                loop-run-not-found envelopes
 *
 * Auth (DSH >= 0.2.1): every browser-facing route is fenced by the host
 * connection service. A launch token from the `dsh web:` URL printed at boot
 * must be exchanged for the browser cookie: GET /?token=<token> replies 303
 * with `set-cookie`. Pass the token with --token/--url (or DSH_WEB_TOKEN);
 * without it the script reports exactly what an unauthenticated client sees.
 *
 * Usage:
 *   node dist/scripts/smoke.mjs [--base http://127.0.0.1:58099] [--token <launch-token>]
 *                          [--url "http://127.0.0.1:58099/?token=..."] [--timeout <ms>]
 *                          [--verbose]
 *
 * Exit codes: 0 all checks passed, 1 a check failed or the server is unreachable.
 */

import process from 'node:process'

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function usage(message?: string): never {
  if (message) process.stderr.write(`smoke: ${message}\n\n`)
  process.stderr.write(
    'usage: smoke.mjs [--base <url>] [--token <launch-token>] [--url <dsh-web-url>] [--timeout <ms>] [--verbose]\n',
  )
  process.exit(2)
}

function parseArgs(argv: string[]) {
  const opts: { base: string; token: string; url: string; timeoutMs: number; verbose: boolean; origin?: string } = {
    base: 'http://127.0.0.1:58099',
    token: process.env.DSH_WEB_TOKEN ?? '',
    url: '',
    timeoutMs: 10_000,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) usage(`missing value for ${arg}`)
      i += 1
      return value
    }
    if (arg === '--base') opts.base = next()
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length)
    else if (arg === '--token') opts.token = next()
    else if (arg.startsWith('--token=')) opts.token = arg.slice('--token='.length)
    else if (arg === '--url') opts.url = next()
    else if (arg.startsWith('--url=')) opts.url = arg.slice('--url='.length)
    else if (arg === '--timeout') opts.timeoutMs = Number(next())
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = Number(arg.slice('--timeout='.length))
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true
    else if (arg === '--help' || arg === '-h') usage()
    else usage(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) usage('--timeout must be a positive number')
  if (!opts.token && opts.url) {
    try {
      opts.token = new URL(opts.url).searchParams.get('token') ?? ''
    } catch {
      usage(`--url is not a valid URL: ${opts.url}`)
    }
  }
  try {
    opts.origin = new URL(opts.base).origin
  } catch {
    usage(`--base is not a valid URL: ${opts.base}`)
  }
  return opts as typeof opts & { origin: string }
}

const opts = parseArgs(process.argv.slice(2))

// ---------------------------------------------------------------------------
// tiny check harness
// ---------------------------------------------------------------------------

const checks: Array<{ ok: boolean; name: string; detail: string }> = []
let currentCheck = 'startup'

function log(message: string) {
  process.stderr.write(`smoke: ${message}\n`)
}

function record(ok: boolean, name: string, detail: string) {
  checks.push({ ok, name, detail })
  if (ok) {
    process.stdout.write(`PASS  ${name.padEnd(30)} ${detail ?? ''}\n`)
    return
  }
  process.stdout.write(`FAIL  ${name.padEnd(30)} ${detail ?? ''}\n`)
}

class SmokeFailure extends Error {}

function fail(name: string, message: string, extra: Record<string, unknown> & { summary?: string } = {}): never {
  record(false, name, extra.summary ?? '')
  process.stderr.write(`\nsmoke: FAILED at "${name}": ${message}\n`)
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'summary') continue
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    process.stderr.write(`  ${key}: ${text === '' ? '(empty)' : text}\n`)
  }
  throw new SmokeFailure(message)
}

function pass(name: string, detail: string) {
  record(true, name, detail)
}

function summary() {
  const failed = checks.filter((check) => !check.ok).length
  if (failed === 0) {
    process.stdout.write(`\nSMOKE PASS — ${checks.length}/${checks.length} checks in ${Date.now() - startedAt} ms\n`)
  } else {
    process.stdout.write(`\nSMOKE FAIL — ${failed} of ${checks.length} checks failed\n`)
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const startedAt = Date.now()
const baseHref = `${opts.origin}/`
let cookie = ''

function request(pathOrUrl: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}) {
  const url = /^https?:/i.test(pathOrUrl) ? pathOrUrl : new URL(pathOrUrl, baseHref).href
  const headers = { ...(init.headers ?? {}) }
  if (cookie && headers.cookie === undefined) headers.cookie = cookie
  if (opts.verbose) log(`> ${init.method ?? 'GET'} ${url}`)
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(opts.timeoutMs) })
}

async function readBody(response: Response) {
  const text = await response.text()
  return text
}

async function readJson(response: Response) {
  const text = await readBody(response)
  try {
    return { text, json: JSON.parse(text) }
  } catch {
    return { text, json: undefined }
  }
}

function cookieValueFromSetCookie(setCookies: readonly string[] | null | undefined) {
  for (const raw of setCookies ?? []) {
    const pair = raw.split(';', 1)[0]?.trim()
    if (pair && pair.includes('=')) return pair
  }
  return ''
}

function describeBody(text: string, limit = 400) {
  const trimmed = text.trim()
  if (trimmed === '') return '(empty body)'
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

function networkFailure(name: string, error: any): never {
  const reason =
    error?.name === 'TimeoutError' ? `timed out after ${opts.timeoutMs} ms` : String(error?.message ?? error)
  fail(name, `cannot reach ${opts.origin}: ${reason}`, {
    summary: 'unreachable',
    hint: `is the verification server running? start it with scripts/run-verify.sh (or: DSH_HOME=… dsh --profile loopverify --host 127.0.0.1 --port ${new URL(opts.origin).port || 80} --no-open)`,
  })
}

// ---------------------------------------------------------------------------
// auth bootstrap
// ---------------------------------------------------------------------------

async function bootstrapAuth() {
  currentCheck = 'auth'
  if (!opts.token) {
    log('no launch token given (--token/--url/DSH_WEB_TOKEN); testing as an unauthenticated client')
    return
  }
  let exchange
  try {
    exchange = await request(`/?token=${encodeURIComponent(opts.token)}`, { redirect: 'manual' })
  } catch (error) {
    networkFailure('auth token exchange', error)
  }
  const body = await readBody(exchange)
  const setCookies = typeof exchange.headers.getSetCookie === 'function' ? exchange.headers.getSetCookie() : []
  if (exchange.status === 303 || exchange.status === 302) {
    cookie = cookieValueFromSetCookie(setCookies)
    if (!cookie) {
      fail('auth token exchange', `got ${exchange.status} but no usable set-cookie header`, {
        summary: `HTTP ${exchange.status}, no cookie`,
        'set-cookie': JSON.stringify(setCookies),
      })
    }
    pass('auth token exchange', `HTTP ${exchange.status} -> browser cookie minted`)
    return
  }
  if (exchange.status === 200 && !exchange.headers.get('set-cookie')) {
    // Already authenticated (unlikely with a fresh token, tolerate it).
    pass('auth token exchange', 'HTTP 200 (session already authenticated)')
    return
  }
  fail('auth token exchange', 'the launch token from the dsh web URL was rejected', {
    summary: `HTTP ${exchange.status}`,
    location: exchange.headers.get('location') ?? '(none)',
    'set-cookie': JSON.stringify(setCookies),
    body: describeBody(body),
  })
}

// ---------------------------------------------------------------------------
// boot graph parsing
// ---------------------------------------------------------------------------

/**
 * The host serves the graph as an inline script:
 *   <script>globalThis["__DSH_BOOT__"] = {"rev":…,"release":…,"entries":[…],"batches":[…]}</script>
 * JSON.stringify output has `<` escaped, so `</script>` cannot appear inside.
 */
function extractBootGraph(html: string) {
  const match = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html)
  if (!match) return undefined
  try {
    return JSON.parse(match[1])
  } catch (error: any) {
    fail('parse boot graph', `found __DSH_BOOT__ but its JSON did not parse: ${String(error.message)}`, {
      summary: 'unparsable boot graph',
      excerpt: match[1].slice(0, 300),
    })
  }
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

async function checkHome() {
  currentCheck = 'GET /'
  let response
  try {
    response = await request('/', { redirect: 'manual' })
  } catch (error) {
    networkFailure('GET /', error)
  }
  const body = await readBody(response)
  if (response.status !== 200) {
    const hint =
      response.status === 401
        ? 'HTTP calls need auth: the host serves nothing without the browser cookie. Pass --token "$(the token in the dsh web: URL)" or --url "<that whole URL>".'
        : undefined
    fail('GET /', `expected HTTP 200, got ${response.status}`, {
      summary: `HTTP ${response.status}`,
      ...(hint ? { hint } : {}),
      'content-type': response.headers.get('content-type') ?? '(none)',
      body: describeBody(body),
    })
  }
  if (!body.includes('__DSH_BOOT__')) {
    fail('GET /', 'served HTML does not contain the __DSH_BOOT__ global', {
      summary: `HTTP 200, ${body.length} bytes, no boot graph`,
      body: describeBody(body),
    })
  }
  pass('GET /', `HTTP 200, ${body.length} bytes, contains __DSH_BOOT__`)
  return body
}

async function checkBootGraph(html: string) {
  currentCheck = 'boot graph'
  const graph = extractBootGraph(html)
  if (graph === undefined) {
    fail('boot graph', 'could not parse globalThis["__DSH_BOOT__"] out of the served HTML', { summary: 'no graph' })
  }
  if (!Array.isArray(graph.entries)) {
    fail('boot graph', 'boot graph has no `entries` array', { summary: 'malformed graph', keys: Object.keys(graph) })
  }
  const release = graph.release
    ? `${graph.release.version ?? '?'} (${String(graph.release.commit ?? '?').slice(0, 7)})`
    : 'unknown'
  const row = graph.entries.find((entry: any) => entry.id === 'dsh-loop-manager')
  if (row === undefined) {
    const pluginRows = graph.entries
      .filter((entry: any) => !entry.id.startsWith('@deepseek-ai/'))
      .map((entry: any) => entry.id)
    fail('boot graph', 'no boot-graph row with id "dsh-loop-manager" — the client half did not activate', {
      summary: `release ${release}, ${graph.entries.length} rows, no dsh-loop-manager`,
      'non-core rows': pluginRows.length > 0 ? pluginRows.join(', ') : '(none besides @deepseek-ai/*)',
      hint: 'check the server log for "loop-manager (dsh-loop-manager): failed to import" and that lib/client.js exists / parses',
    })
  }
  if (typeof row.url !== 'string' || row.url === '') {
    fail('boot graph', 'the dsh-loop-manager row has no bundle `url`', { summary: 'row without url', row })
  }
  pass('boot graph', `release ${release}, ${graph.entries.length} rows, row rev ${String(row.rev ?? '?')}`)
  return { graph, row }
}

async function checkBundle(row: any) {
  currentCheck = 'client bundle'
  // row.url is document-relative ("plugins/??dsh-loop-manager/client.js&rev=…")
  // because the served shell carries <base href="./">.
  const url = new URL(row.url.startsWith('/') ? row.url : `/${row.url}`, baseHref).href
  let response
  try {
    response = await request(url, { redirect: 'manual' })
  } catch (error) {
    networkFailure('client bundle', error)
  }
  const body = await readBody(response)
  if (response.status !== 200) {
    fail('client bundle', `expected HTTP 200 for ${url}, got ${response.status}`, {
      summary: `HTTP ${response.status}`,
      url,
      body: describeBody(body),
    })
  }
  const head = body.replace(/^\uFEFF/, '')
  const code = stripLeadingTrivia(head)
  const expected = 'window.__ModuleLoader__.load('
  if (!code.startsWith(expected)) {
    fail('client bundle', `bundle body does not start with \`${expected}\``, {
      summary: 'wrong bundle prefix',
      url,
      'first 160 chars': JSON.stringify(head.slice(0, 160)),
    })
  }
  const trivia = head.length - code.length
  pass(
    'client bundle',
    `${url.replace(opts.origin, '')} HTTP 200, ${body.length} bytes, __ModuleLoader__.load(${trivia > 0 ? ', after leading comment' : ''})`,
  )
  return url
}

/** Strip BOM, whitespace, and leading comments so "starts with the loader call" ignores a header comment. */
function stripLeadingTrivia(source: string) {
  let rest = source.replace(/^\uFEFF/, '')
  for (;;) {
    rest = rest.replace(/^\s+/, '')
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/')
      if (end === -1) return rest
      rest = rest.slice(end + 2)
      continue
    }
    if (rest.startsWith('//')) {
      const end = rest.indexOf('\n')
      if (end === -1) return rest
      rest = rest.slice(end + 1)
      continue
    }
    return rest
  }
}

async function checkState() {
  currentCheck = 'GET /loop-manager/api/state'
  let response
  try {
    response = await request('/loop-manager/api/state', { redirect: 'manual' })
  } catch (error) {
    networkFailure('GET /loop-manager/api/state', error)
  }
  const { text, json } = await readJson(response)
  if (response.status === 401) {
    fail('GET /loop-manager/api/state', 'the host rejected this request as unauthenticated (401)', {
      summary: 'HTTP 401',
      body: describeBody(text),
      hint: 'pass --token/--url from the dsh web: line printed by the server',
    })
  }
  if (response.status === 404) {
    fail('GET /loop-manager/api/state', 'HTTP 404 — the host half of the plugin is not mounted', {
      summary: 'HTTP 404 (route not registered)',
      hint: 'the prefix route /loop-manager is missing; check that lib/index.js loaded (server log) and that dsh-loop-manager is in dsh.profile.bundles',
      body: describeBody(text),
    })
  }
  if (response.status !== 200) {
    fail('GET /loop-manager/api/state', `expected HTTP 200, got ${response.status}`, {
      summary: `HTTP ${response.status}`,
      'content-type': response.headers.get('content-type') ?? '(none)',
      body: describeBody(text),
    })
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    fail('GET /loop-manager/api/state', `expected a JSON content-type, got ${JSON.stringify(contentType)}`, {
      summary: 'wrong content-type',
      body: describeBody(text),
    })
  }
  if (json === undefined) {
    fail('GET /loop-manager/api/state', 'response is not valid JSON', {
      summary: 'invalid JSON',
      body: describeBody(text),
    })
  }
  if (json.ok !== true) {
    fail('GET /loop-manager/api/state', `expected { ok: true }, got ${JSON.stringify(json).slice(0, 300)}`, {
      summary: 'ok !== true',
      body: describeBody(text),
    })
  }
  if (!Array.isArray(json.pipelines)) {
    fail('GET /loop-manager/api/state', 'expected `pipelines` to be an array', {
      summary: 'pipelines not an array',
      body: describeBody(text),
    })
  }
  if (!Array.isArray(json.loops)) {
    fail('GET /loop-manager/api/state', 'expected `loops` to be an array (v9 Loop support)', {
      summary: 'loops not an array',
      body: describeBody(text),
    })
  }
  if (!Array.isArray(json.loopRuns)) {
    fail('GET /loop-manager/api/state', 'expected `loopRuns` to be an array (v9 Loop support)', {
      summary: 'loopRuns not an array',
      body: describeBody(text),
    })
  }
  pass(
    'GET /loop-manager/api/state',
    `HTTP 200 {"ok":true,"pipelines":${json.pipelines.length},"loops":${json.loops.length},"loopRuns":${json.loopRuns.length}}`,
  )
  return json
}

async function checkModels() {
  currentCheck = 'GET /loop-manager/api/models'
  let response
  try {
    response = await request('/loop-manager/api/models', { redirect: 'manual' })
  } catch (error) {
    networkFailure('GET /loop-manager/api/models', error)
  }
  const { text, json } = await readJson(response)
  if (response.status !== 200) {
    fail('GET /loop-manager/api/models', `expected HTTP 200, got ${response.status}`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(text),
    })
  }
  if (json === undefined || json.ok !== true || !Array.isArray(json.providers)) {
    fail('GET /loop-manager/api/models', 'response is not { ok: true, providers: [...] }', {
      summary: 'bad models response',
      body: describeBody(text),
    })
  }
  const providers = json.providers.filter(
    (provider: any) => provider !== null && typeof provider === 'object' && Array.isArray(provider.models),
  )
  const modelCount = providers.reduce((sum: number, provider: any) => sum + provider.models.length, 0)
  pass('GET /loop-manager/api/models', `HTTP 200, ${providers.length} providers / ${modelCount} models`)
  return json
}

async function checkDb() {
  currentCheck = 'GET /loop-manager/api/db'
  let response
  try {
    response = await request('/loop-manager/api/db', { redirect: 'manual' })
  } catch (error) {
    networkFailure('GET /loop-manager/api/db', error)
  }
  const { text, json } = await readJson(response)
  if (response.status !== 200) {
    fail('GET /loop-manager/api/db', `expected HTTP 200, got ${response.status}`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(text),
    })
  }
  if (json === undefined || json.ok !== true || json.db === null || typeof json.db !== 'object') {
    fail('GET /loop-manager/api/db', 'response is not { ok: true, db: {...} }', {
      summary: 'bad db response',
      body: describeBody(text),
    })
  }
  pass(
    'GET /loop-manager/api/db',
    `HTTP 200, configured=${json.db.configured === true} connected=${json.db.connected === true}`,
  )
  return json
}

async function checkCrud(stateBefore: any, models: any) {
  const pipelineName = `smoke-${Date.now()}`
  const firstProvider = (models?.providers ?? []).find(
    (provider: any) => Array.isArray(provider.models) && provider.models.length > 0,
  )
  const firstModel = firstProvider === undefined ? undefined : firstProvider.models[0]
  const pinnedModel =
    firstProvider === undefined || firstModel === undefined
      ? undefined
      : { provider: firstProvider.id, model: firstModel.id }
  const payload = {
    name: pipelineName,
    description: 'scripts/smoke.mjs CRUD probe',
    nodes: [
      {
        id: 'smoke-node-a',
        name: 'Smoke A',
        command: 'Reply with the single word: alpha',
        ...(pinnedModel === undefined ? {} : { model: pinnedModel }),
      },
      { id: 'smoke-node-b', name: 'Smoke B', command: 'Summarise:\n\n{{input}}' },
    ],
    edges: [] as any[],
  }

  // ---- POST -----------------------------------------------------------------
  currentCheck = 'POST /loop-manager/api/pipelines'
  let response
  try {
    response = await request('/loop-manager/api/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    networkFailure('POST /loop-manager/api/pipelines', error)
  }
  const created = await readJson(response)
  if (response.status !== 200) {
    fail('POST /loop-manager/api/pipelines', `expected HTTP 200, got ${response.status}`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(created.text),
    })
  }
  const pipeline = created.json?.pipeline
  if (created.json?.ok !== true || pipeline === undefined || typeof pipeline.id !== 'string') {
    fail('POST /loop-manager/api/pipelines', 'response is not { ok: true, pipeline: { id, … } }', {
      summary: 'bad create response',
      body: describeBody(created.text),
    })
  }
  probePipelineId = pipeline.id // top-level cleanup guard
  if (pipeline.name !== pipelineName) {
    fail(
      'POST /loop-manager/api/pipelines',
      `created pipeline name is ${JSON.stringify(pipeline.name)}, expected ${JSON.stringify(pipelineName)}`,
      {
        summary: 'name not persisted',
        body: describeBody(created.text),
      },
    )
  }
  if (pinnedModel !== undefined) {
    const stored = pipeline.nodes.find((node: any) => node.id === 'smoke-node-a')?.model
    if (stored?.provider !== pinnedModel.provider || stored?.model !== pinnedModel.model) {
      fail(
        'POST /loop-manager/api/pipelines',
        `node model is ${JSON.stringify(stored)}, expected ${JSON.stringify(pinnedModel)}`,
        {
          summary: 'model not persisted',
          body: describeBody(created.text),
        },
      )
    }
  }
  pass('POST /loop-manager/api/pipelines', `HTTP 200, pipeline id ${pipeline.id}`)

  // ---- GET state contains it ---------------------------------------------
  currentCheck = 'GET state contains pipeline'
  const state = await getState()
  if (!state.pipelines.some((item: any) => item.id === pipeline.id)) {
    fail('GET state contains pipeline', `created pipeline ${pipeline.id} is missing from state`, {
      summary: 'not listed',
      pipelines: state.pipelines.map((item: any) => item.id),
    })
  }
  pass('GET state contains pipeline', `pipeline ${pipeline.id} present (${state.pipelines.length} total)`)

  // ---- DELETE -------------------------------------------------------------
  currentCheck = 'DELETE /loop-manager/api/pipelines/:id'
  let deleted
  try {
    deleted = await request(`/loop-manager/api/pipelines/${encodeURIComponent(pipeline.id)}`, { method: 'DELETE' })
  } catch (error) {
    networkFailure('DELETE /loop-manager/api/pipelines/:id', error)
  }
  const deleteBody = await readJson(deleted)
  if (deleted.status !== 200) {
    fail('DELETE /loop-manager/api/pipelines/:id', `expected HTTP 200, got ${deleted.status}`, {
      summary: `HTTP ${deleted.status}`,
      body: describeBody(deleteBody.text),
    })
  }
  if (deleteBody.json?.ok !== true) {
    fail('DELETE /loop-manager/api/pipelines/:id', 'response is not { ok: true }', {
      summary: 'bad delete response',
      body: describeBody(deleteBody.text),
    })
  }
  pass('DELETE /loop-manager/api/pipelines/:id', 'HTTP 200 {"ok":true}')

  // ---- GET state no longer has it ---------------------------------------
  currentCheck = 'GET state after delete'
  const after = await getState()
  if (after.pipelines.some((item: any) => item.id === pipeline.id)) {
    fail('GET state after delete', `pipeline ${pipeline.id} is still listed after DELETE`, {
      summary: 'delete not persisted',
      pipelines: after.pipelines.map((item: any) => item.id),
    })
  }
  probePipelineId = ''
  pass('GET state after delete', 'pipeline removed from state')
}

/**
 * Assert one JSON error envelope (`{ ok:false, code, error }`) with its status.
 * @param {string} name - check name.
 * @param {string} pathname - request target.
 * @param {object} init - fetch init.
 * @param {number} status - expected HTTP status.
 * @param {string} code - expected error code.
 * @returns {Promise<void>}
 */
async function expectApiError(
  name: string,
  pathname: string,
  init: Record<string, any>,
  status: number,
  code: string,
): Promise<void> {
  currentCheck = name
  let response
  try {
    response = await request(pathname, init)
  } catch (error) {
    networkFailure(name, error)
  }
  const { text, json } = await readJson(response)
  if (response.status !== status) {
    fail(name, `expected HTTP ${status}, got ${response.status}`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(text),
    })
  }
  // Lenient on the exact code (the contract fixes it, but new routes sometimes
  // land with a slightly different spelling); strict on the HTTP status and on
  // the envelope shape. A 404 from the generic unknown-route fallback must not
  // pass, otherwise a missing route would look like a handled error.
  const actualCode = typeof json?.code === 'string' ? json.code : ''
  if (json === undefined || json.ok === true || actualCode === '') {
    fail(name, `response is not an error envelope { ok:false, code, error }`, {
      summary: 'bad error envelope',
      body: describeBody(text),
    })
  }
  if (typeof json.error === 'string' && /^unknown route/.test(json.error)) {
    fail(name, `route is not implemented (generic 404): ${json.error}`, {
      summary: 'route missing',
      body: describeBody(text),
    })
  }
  if (actualCode !== code) {
    log(
      `${name}: code=${JSON.stringify(actualCode)} (contract expects ${JSON.stringify(code)}; accepted because the HTTP status and envelope are correct)`,
    )
  }
  pass(name, `HTTP ${status} {"code":${JSON.stringify(actualCode)}}`)
}

/**
 * v9 Loop HTTP round trip (CONTRACT.md §13.6): a loop references an existing
 * pipeline, is listed by /api/state, can be patched and deleted, and the new
 * error codes are surfaced with their statuses.
 * @returns {Promise<void>}
 */
async function checkLoopCrud(): Promise<void> {
  const stamp = Date.now()
  const pipelineName = `smoke-loop-pipeline-${stamp}`

  // ---- a pipeline for the loop to reference ------------------------------
  currentCheck = 'POST pipeline for Loop probe'
  let response
  try {
    response = await request('/loop-manager/api/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: pipelineName,
        nodes: [{ id: 'smoke-loop-node', name: 'Loop probe', command: 'Reply with the single word: DONE' }],
        edges: [] as any[],
      }),
    })
  } catch (error) {
    networkFailure('POST pipeline for Loop probe', error)
  }
  const createdPipeline = await readJson(response)
  if (
    response.status !== 200 ||
    createdPipeline.json?.ok !== true ||
    typeof createdPipeline.json?.pipeline?.id !== 'string'
  ) {
    fail('POST pipeline for Loop probe', `expected HTTP 200 { ok:true, pipeline }, got HTTP ${response.status}`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(createdPipeline.text),
    })
  }
  const pipelineId = createdPipeline.json.pipeline.id
  probeLoopPipelineId = pipelineId
  pass('POST pipeline for Loop probe', `HTTP 200, pipeline id ${pipelineId}`)

  // ---- POST /api/loops ---------------------------------------------------
  currentCheck = 'POST /loop-manager/api/loops'
  const loopPayload = {
    name: `smoke-loop-${stamp}`,
    desc: 'scripts/smoke.mjs Loop probe',
    steps: [
      {
        id: 'smoke-step-1',
        pipelineId,
        gate: {
          id: 'smoke-step-1-gate',
          name: '烟雾门禁',
          type: 'agent',
          command: '输出是否包含 DONE',
          autoLoop: false,
          maxIterations: 3,
        },
      },
    ],
  }
  try {
    response = await request('/loop-manager/api/loops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(loopPayload),
    })
  } catch (error) {
    networkFailure('POST /loop-manager/api/loops', error)
  }
  const createdLoop = await readJson(response)
  if (response.status !== 200) {
    fail('POST /loop-manager/api/loops', `expected HTTP 200, got ${response.status}`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(createdLoop.text),
    })
  }
  const loop = createdLoop.json?.loop
  if (createdLoop.json?.ok !== true || loop === undefined || typeof loop.id !== 'string') {
    fail('POST /loop-manager/api/loops', 'response is not { ok: true, loop: { id, … } }', {
      summary: 'bad create response',
      body: describeBody(createdLoop.text),
    })
  }
  probeLoopId = loop.id
  if (loop.name !== loopPayload.name) {
    fail(
      'POST /loop-manager/api/loops',
      `loop name is ${JSON.stringify(loop.name)}, expected ${JSON.stringify(loopPayload.name)}`,
      {
        summary: 'name not persisted',
        body: describeBody(createdLoop.text),
      },
    )
  }
  if (!Array.isArray(loop.steps) || loop.steps.length !== 1) {
    fail('POST /loop-manager/api/loops', 'created loop does not carry exactly one step', {
      summary: 'steps not persisted',
      body: describeBody(createdLoop.text),
    })
  }
  if (loop.steps[0].pipelineId !== pipelineId) {
    fail(
      'POST /loop-manager/api/loops',
      `step pipelineId is ${JSON.stringify(loop.steps[0].pipelineId)}, expected ${JSON.stringify(pipelineId)}`,
      {
        summary: 'pipeline reference not persisted',
        body: describeBody(createdLoop.text),
      },
    )
  }
  if (loop.steps[0].gate?.command !== loopPayload.steps[0].gate.command) {
    fail('POST /loop-manager/api/loops', 'the gate command was not persisted', {
      summary: 'gate command not persisted',
      body: describeBody(createdLoop.text),
    })
  }
  pass('POST /loop-manager/api/loops', `HTTP 200, loop id ${loop.id}`)

  // ---- GET state contains loops + loopRuns -------------------------------
  currentCheck = 'GET state contains loop'
  const state = await getState()
  if (!state.loops.some((candidate: any) => candidate.id === loop.id)) {
    fail('GET state contains loop', `created loop ${loop.id} is missing from state`, {
      summary: 'not listed',
      loops: state.loops.map((candidate: any) => candidate.id),
    })
  }
  if (!Array.isArray(state.loopRuns)) {
    fail('GET state contains loop', 'state.loopRuns is not an array', { summary: 'loopRuns missing' })
  }
  pass(
    'GET state contains loop',
    `loop ${loop.id} present (${state.loops.length} total, ${state.loopRuns.length} loop runs)`,
  )

  // ---- PATCH /api/loops/:id star ----------------------------------------
  currentCheck = 'PATCH /loop-manager/api/loops/:id'
  try {
    response = await request(`/loop-manager/api/loops/${encodeURIComponent(loop.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ star: true }),
    })
  } catch (error) {
    networkFailure('PATCH /loop-manager/api/loops/:id', error)
  }
  const patched = await readJson(response)
  if (response.status !== 200 || patched.json?.ok !== true || patched.json?.loop?.star !== true) {
    fail('PATCH /loop-manager/api/loops/:id', `expected HTTP 200 with loop.star=true, got HTTP ${response.status}`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(patched.text),
    })
  }
  pass('PATCH /loop-manager/api/loops/:id', 'HTTP 200, star persisted')

  // ---- error paths ------------------------------------------------------
  const invalidLoop = {
    name: 'smoke-invalid-loop',
    steps: [
      {
        id: 'bad-step',
        pipelineId: 'pipeline-that-does-not-exist',
        gate: { name: '门禁', type: 'agent', command: 'ok', autoLoop: false, maxIterations: 3 },
      },
    ],
  }
  await expectApiError(
    'POST /api/loops invalid pipeline',
    '/loop-manager/api/loops',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalidLoop) },
    400,
    'invalid-loop',
  )
  await expectApiError(
    'POST /api/loops/:id/run unknown loop',
    '/loop-manager/api/loops/does-not-exist/run',
    { method: 'POST' },
    404,
    'loop-not-found',
  )
  await expectApiError(
    'POST /api/loop-runs/:id/retry unknown run',
    '/loop-manager/api/loop-runs/does-not-exist/retry',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
    404,
    'loop-run-not-found',
  )

  // ---- DELETE /api/loops/:id --------------------------------------------
  currentCheck = 'DELETE /loop-manager/api/loops/:id'
  try {
    response = await request(`/loop-manager/api/loops/${encodeURIComponent(loop.id)}`, { method: 'DELETE' })
  } catch (error) {
    networkFailure('DELETE /loop-manager/api/loops/:id', error)
  }
  const deleted = await readJson(response)
  if (response.status !== 200 || deleted.json?.ok !== true) {
    fail('DELETE /loop-manager/api/loops/:id', `expected HTTP 200 { ok:true }, got HTTP ${response.status}`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(deleted.text),
    })
  }
  probeLoopId = ''
  const after = await getState()
  if (after.loops.some((candidate: any) => candidate.id === loop.id)) {
    fail('DELETE /loop-manager/api/loops/:id', `loop ${loop.id} is still listed after DELETE`, {
      summary: 'delete not persisted',
      loops: after.loops.map((candidate: any) => candidate.id),
    })
  }
  pass('DELETE /loop-manager/api/loops/:id', 'HTTP 200, loop removed from state')

  // ---- clean up the probe pipeline --------------------------------------
  currentCheck = 'DELETE pipeline for Loop probe'
  try {
    response = await request(`/loop-manager/api/pipelines/${encodeURIComponent(pipelineId)}`, { method: 'DELETE' })
  } catch (error) {
    networkFailure('DELETE pipeline for Loop probe', error)
  }
  const deletedPipeline = await readJson(response)
  if (response.status !== 200 || deletedPipeline.json?.ok !== true) {
    fail('DELETE pipeline for Loop probe', `expected HTTP 200 { ok:true }, got HTTP ${response.status}`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(deletedPipeline.text),
    })
  }
  probeLoopPipelineId = ''
  pass('DELETE pipeline for Loop probe', 'HTTP 200, probe pipeline removed')
}

async function getState() {
  const response = await request('/loop-manager/api/state')
  const { text, json } = await readJson(response)
  if (response.status !== 200 || json?.ok !== true || !Array.isArray(json.pipelines)) {
    fail('GET /loop-manager/api/state', `unexpected state response (HTTP ${response.status})`, {
      summary: `HTTP ${response.status}`,
      body: describeBody(text),
    })
  }
  return json
}

// unavailable-auth probe (informational only): what does a cookie-less client see?
async function probeUnauthenticated() {
  if (!cookie) return
  try {
    const response = await fetch(new URL('/loop-manager/api/state', baseHref), {
      signal: AbortSignal.timeout(Math.min(opts.timeoutMs, 3000)),
    })
    const text = await response.text()
    const flag = response.status === 401 || response.status === 403 ? 'fenced' : 'NOT FENCED'
    process.stdout.write(
      `INFO  unauthenticated API access    HTTP ${response.status} (${flag}) — ${JSON.stringify(describeBody(text, 120))}\n`,
    )
  } catch {
    /* informational only */
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

let probePipelineId = ''
let probeLoopId = ''
let probeLoopPipelineId = ''

try {
  await bootstrapAuth()
  const html = await checkHome()
  const { row } = await checkBootGraph(html)
  await checkBundle(row)
  const state = await checkState()
  const models = await checkModels()
  await checkDb()
  await checkCrud(state, models)
  await checkLoopCrud()
  await probeUnauthenticated()
  summary()
  process.exit(0)
} catch (error) {
  for (const [kind, id, path] of [
    ['probe loop', probeLoopId, probeLoopId === '' ? '' : `/loop-manager/api/loops/${encodeURIComponent(probeLoopId)}`],
    [
      'probe pipeline',
      probePipelineId || probeLoopPipelineId,
      `/loop-manager/api/pipelines/${encodeURIComponent(probePipelineId || probeLoopPipelineId)}`,
    ],
  ]) {
    if (id === '' || path === '') continue
    try {
      await request(path, { method: 'DELETE' })
      log(`cleaned up ${kind} ${id}`)
    } catch {
      log(`could not clean up ${kind} ${id}`)
    }
  }
  if (!(error instanceof SmokeFailure)) {
    log(`unexpected error during "${currentCheck}": ${(error as Error)?.stack ?? String(error)}`)
  }
  summary()
  process.exit(1)
}
