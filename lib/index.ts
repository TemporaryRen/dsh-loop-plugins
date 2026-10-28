/**
 * dsh-loop-manager — host half.
 *
 * A Cordis plugin that exposes the Loop Manager JSON API under the
 * `/loop-manager` prefix and runs DAG pipelines of agent tasks through the
 * session controller. The browser half (`lib/client.ts`) compiles to a
 * module-loader bundle served by the plugin platform, not by this route.
 *
 * Wire contract: spec/CONTRACT.md. Every response is JSON with the
 * `{ ok: true, ...payload }` / `{ ok: false, code, error }` envelope.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

// The one DSH host package this plugin depends on (declared in package.json
// peerDependencies so a `link:`-installed profile package resolves it).
// Imported here, in the plugin entry, and injected into the run engine — that
// keeps lib/engine.ts independent of the host package at runtime for unit tests.
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { createDatabaseManager } from './db.js'
import { validateGraph } from './dag.js'
import { createAgentNodeRunner, createEngine } from './engine.js'
import { validateLoop } from './loop.js'
import { createLoopEngine } from './loopengine.js'
import { discoverSkills } from './skills.js'
import { createStore } from './store.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PipelineNode, PipelineEdge, Pipeline, Run, LoopGate, LoopStep, Loop, LoopRun } from './types.js'
import type {
  ApiHostContext,
  RequestHandlerOptions,
  ModelEntry,
  ModelProvider,
  ModelsResponse,
  SkillsResponse,
} from './api-types.js'

export type {
  PipelineNode,
  PipelineEdge,
  Pipeline,
  NodeState,
  Run,
  LoopGate,
  LoopStep,
  Loop,
  LoopStepState,
  LoopRun,
  ModelSelection,
  GateDecision,
} from './types.js'
export type { ApiHostContext } from './api-types.js'

type PipelineInput = Omit<Pipeline, 'id' | 'createdAt' | 'updatedAt'>
type LoopInput = Omit<Loop, 'id' | 'createdAt' | 'updatedAt'>

/** Plugin name; also the client bundle id. */
export const name = 'dsh-loop-manager'

/** Services this host half needs; Cordis mounts the plugin only when all exist. */
export const inject = ['webServer', 'connection', 'sessions', 'sessionController', 'agents']

/** Version reported by the unauthenticated health route. */
export const PLUGIN_VERSION = '0.3.0'

/** URL prefix of every host route. */
export const ROUTE_PREFIX = '/loop-manager'

/** Unauthenticated health route (the only route outside the auth fence). */
const PING_PATH = `${ROUTE_PREFIX}/api/ping`

/** How long the installed-skill catalog is reused before discovery runs again. */
const SKILLS_CACHE_MS = 15_000

/** How long the model catalog is reused before it is rebuilt. */
const MODELS_CACHE_MS = 30_000

/** Bound on request bodies (the DAG editor never sends more than this). */
const MAX_BODY_BYTES = 1 << 20

/** Longest accepted pipeline name (design spec: 50). */
const MAX_PIPELINE_NAME_LENGTH = 50

/** Longest accepted node name (design spec: 40). */
const MAX_NODE_NAME_LENGTH = 40

/** Longest accepted pipeline description (design spec: 160). */
const MAX_DESC_LENGTH = 160

/** Allowed pipeline icon tints (the design's `.pipeline-icon` variants). */
const ALLOWED_COLORS = new Set(['', 'blue', 'peach', 'purple'])

/** Longest accepted loop name (design spec: 50). */
const MAX_LOOP_NAME_LENGTH = 50

/** Longest accepted gate name (design spec: 40). */
const MAX_GATE_NAME_LENGTH = 40

/** Gate iteration cap used when a create/update payload omits it (§13.1). */
const DEFAULT_GATE_MAX_ITERATIONS = 3

/** Accepted gate iteration range (CONTRACT.md §13.1). */
const MIN_GATE_MAX_ITERATIONS = 1
const MAX_GATE_MAX_ITERATIONS = 20

/** Loop icon used when the author leaves it blank. */
const LOOP_ICON_DEFAULT = '⟳'

/**
 * One API failure carrying the exact HTTP status and wire code from the
 * contract's error table.
 */
class ApiError extends Error {
  declare code: string
  declare status: number
  /**
   * @param {string} code - wire code (`bad-request`, `invalid-graph`, ...).
   * @param {string} message - human readable reason.
   * @param {number} [status] - HTTP status.
   */
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/**
 * Resolve the on-disk state file: `<DSH_HOME or ~/.dsh>/loop-manager/state.json`.
 * @returns {string}
 */
function resolveStateFile() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = configured !== '' ? configured : path.join(os.homedir(), '.dsh')
  return path.join(home, 'loop-manager', 'state.json')
}

/**
 * Resolve the PostgreSQL config file next to the local state file.
 * @returns {string}
 */
function resolveDbConfigFile() {
  return path.join(path.dirname(resolveStateFile()), 'db-config.json')
}

/**
 * Bundled skill directories of the running installation: the desktop runtime
 * ships `office-*` skills under `Resources/runtime/office-skills`, while a CLI
 * installation carries the same assets inside `@deepseek-ai/dsh-skill-office`.
 * @returns {string[]} existing directories (empty when neither is present).
 */
function resolveBundledSkillRoots() {
  const roots = []
  try {
    const resources = path.join(path.dirname(path.dirname(process.execPath)), 'Resources')
    const desktopRoot = path.join(resources, 'runtime', 'office-skills')
    if (existsSync(desktopRoot)) roots.push(desktopRoot)
  } catch {
    // ignore: not the desktop runtime
  }
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve('@deepseek-ai/dsh-skill-office/package.json')
    const assets = path.join(path.dirname(manifest), 'assets')
    if (existsSync(assets)) roots.push(assets)
  } catch {
    // ignore: the office skill package is not installed in this composition
  }
  return roots
}

/**
 * Home directories the skill providers use (`~/.dsh`, `~/.agents`).
 * @returns {{ dshHome: string, agentsHome: string }}
 */
function resolveSkillHomes() {
  const dshHome =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : path.join(os.homedir(), '.dsh')
  const agentsHome =
    typeof process.env.DSH_AGENTS_HOME === 'string' && process.env.DSH_AGENTS_HOME.trim() !== ''
      ? process.env.DSH_AGENTS_HOME.trim()
      : path.join(os.homedir(), '.agents')
  return { dshHome, agentsHome }
}

/**
 * Format any thrown value as a log/response message.
 * @param {unknown} error - thrown value.
 * @returns {string}
 */
function messageOf(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Write one JSON response. Tolerates an already-committed response (a client
 * that vanished mid-body) by destroying the socket instead of throwing.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable envelope.
 * @returns {void}
 */
function writeJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent === true) {
    res.destroy?.()
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/**
 * Read and parse a bounded JSON request body. Empty body reads as `{}`.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<unknown>}
 * @throws {ApiError} `bad-request` for oversized or malformed bodies.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
}

/**
 * Validate and trim a required display name.
 * @param {unknown} value - raw value.
 * @param {string} field - field name for the error message.
 * @returns {string}
 */
function requireName(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string') throw new ApiError('bad-request', `"${field}" must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new ApiError('bad-request', `"${field}" must not be empty`)
  if (trimmed.length > maxLength) {
    throw new ApiError('bad-request', `"${field}" must be at most ${maxLength} characters`)
  }
  return trimmed
}

/**
 * Validate an optional short text field (desc / icon / color).
 * @param {unknown} value - raw value.
 * @param {string} field - field name for the error message.
 * @param {number} maxLength - length cap.
 * @returns {string} trimmed text, '' when absent.
 */
function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new ApiError('bad-request', `"${field}" must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new ApiError('bad-request', `"${field}" must be at most ${maxLength} characters`)
  }
  return trimmed
}

/**
 * Validate an optional string field; absent/blank values become `undefined`.
 * @param {unknown} value - raw value.
 * @param {string} field - field name for the error message.
 * @returns {string | undefined}
 */
function optionalString(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ApiError('bad-request', `"${field}" must be a string`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Normalize a node's optional pinned model (`{ provider, model }`). An absent or
 * blank value means "inherit the host default", so it is omitted entirely.
 * @param {unknown} value - raw `model` payload.
 * @param {number} index - node position, for error messages.
 * @returns {{ model?: { provider: string, model: string } }}
 */
function normalizeNodeModel(value: unknown, index: number): Pick<PipelineNode, 'model'> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('bad-request', `nodes[${index}].model must be an object`)
  }
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (provider === '' && model === '') return {}
  if (provider === '' || model === '') {
    throw new ApiError('bad-request', `nodes[${index}].model needs both "provider" and "model"`)
  }
  if (provider.length > 64 || model.length > 128) {
    throw new ApiError('bad-request', `nodes[${index}].model is too long`)
  }
  return { model: { provider, model } }
}

/**
 * Normalize one client-supplied node. Missing ids are generated so a POST can
 * create isolated nodes without pre-assigning identities.
 * @param {unknown} candidate - raw node payload.
 * @param {number} index - position, for error messages.
 * @returns {{ id: string, title: string, prompt: string }}
 */
function normalizeNode(candidate: unknown, index: number): PipelineNode {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ApiError('bad-request', `nodes[${index}] must be an object`)
  }
  const record = candidate as Record<string, unknown>
  const rawId = typeof record.id === 'string' ? record.id.trim() : ''
  const id = rawId !== '' ? rawId : randomUUID()
  // `title`/`prompt` are the v1 field names and stay accepted for older clients.
  const name = requireName(record.name ?? record.title, `nodes[${index}].name`, MAX_NODE_NAME_LENGTH)
  const type = record.type === undefined || record.type === null ? 'agent' : record.type
  if (type !== 'agent' && type !== 'skill') {
    throw new ApiError('bad-request', `nodes[${index}].type must be "agent" or "skill"`)
  }
  const commandRaw = typeof record.command === 'string' ? record.command : record.prompt
  if (commandRaw !== undefined && typeof commandRaw !== 'string') {
    throw new ApiError('bad-request', `nodes[${index}].command must be a string`)
  }
  const command = typeof commandRaw === 'string' ? commandRaw : ''

  if (type === 'skill') {
    const skill = typeof record.skill === 'string' ? record.skill.trim() : ''
    if (skill === '') throw new ApiError('bad-request', `nodes[${index}].skill must name an installed skill`)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) {
      throw new ApiError('bad-request', `nodes[${index}].skill must be a kebab-case skill name`)
    }
    // `command` carries the optional supplementary instruction for a skill node.
    return { id, name, type, skill, command: command.trim(), ...normalizeNodeModel(record.model, index) }
  }

  if (command.trim() === '') {
    throw new ApiError('bad-request', `nodes[${index}].command must not be empty`)
  }
  return { id, name, type: 'agent', command, ...normalizeNodeModel(record.model, index) }
}

/**
 * Normalize one client-supplied edge.
 * @param {unknown} candidate - raw edge payload.
 * @param {number} index - position, for error messages.
 * @returns {{ from: string, to: string }}
 */
function normalizeEdge(candidate: unknown, index: number): PipelineEdge {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ApiError('bad-request', `edges[${index}] must be an object`)
  }
  const record = candidate as Record<string, unknown>
  if (typeof record.from !== 'string' || record.from.trim() === '') {
    throw new ApiError('bad-request', `edges[${index}].from must be a non-empty string`)
  }
  if (typeof record.to !== 'string' || record.to.trim() === '') {
    throw new ApiError('bad-request', `edges[${index}].to must be a non-empty string`)
  }
  return { from: record.from.trim(), to: record.to.trim() }
}

/**
 * Validate a create/update payload and shape it into the persisted fields
 * (`id`, `createdAt`, `updatedAt` are owned by the server).
 * @param {unknown} payload - parsed JSON body.
 */
function normalizePipelineInput(payload: unknown): PipelineInput {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError('bad-request', 'request body must be a JSON object')
  }
  const record = payload as Record<string, unknown>
  const name = requireName(record.name, 'name', MAX_PIPELINE_NAME_LENGTH)
  const desc = optionalText(record.desc ?? record.description, 'desc', MAX_DESC_LENGTH)
  const cwd = optionalString(record.cwd, 'cwd')
  const icon = record.icon === undefined ? undefined : optionalText(record.icon, 'icon', 4)
  const color = record.color === undefined ? undefined : optionalText(record.color, 'color', 12)
  if (color !== undefined && !ALLOWED_COLORS.has(color)) {
    throw new ApiError('bad-request', `"color" must be one of ${[...ALLOWED_COLORS].filter(Boolean).join(', ')}`)
  }
  if (!Array.isArray(record.nodes)) throw new ApiError('bad-request', '"nodes" must be an array')
  if (!Array.isArray(record.edges)) throw new ApiError('bad-request', '"edges" must be an array')
  const nodes = record.nodes.map((candidate, index) => normalizeNode(candidate, index))
  const edges = record.edges.map((candidate, index) => normalizeEdge(candidate, index))

  const graph = validateGraph(nodes, edges)
  if (!graph.ok) throw new ApiError('invalid-graph', graph.message, 400)

  return {
    name,
    desc,
    cwd,
    icon,
    color,
    star: typeof record.star === 'boolean' ? record.star : undefined,
    nodes,
    edges,
  }
}

/**
 * Normalize the optional pinned model of one gate (same rules as §11.2).
 * @param {unknown} value - raw `model` payload.
 * @param {string} field - field path for error messages.
 * @returns {{ model?: { provider: string, model: string } }}
 */
function normalizeGateModel(value: unknown, field: string): Pick<LoopGate, 'model'> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('bad-request', `"${field}" must be an object`)
  }
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (provider === '' && model === '') return {}
  if (provider === '' || model === '') {
    throw new ApiError('bad-request', `"${field}" needs both "provider" and "model"`)
  }
  if (provider.length > 64 || model.length > 128) {
    throw new ApiError('bad-request', `"${field}" is too long`)
  }
  return { model: { provider, model } }
}

/**
 * Normalize one client-supplied gate (门禁节点). The gate always belongs to the
 * step that carries it, which is how "gate comes after its pipeline" is
 * enforced structurally (CONTRACT.md §13.1).
 * @param {unknown} candidate - raw gate payload.
 * @param {number} index - step position, for error messages.
 * @param {string} stepId - owning step id (the default gate id suffix).
 */
function normalizeLoopGate(candidate: unknown, index: number, stepId: string): LoopGate {
  const field = `steps[${index}].gate`
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ApiError('bad-request', `"${field}" must be an object`)
  }
  const record = candidate as Record<string, unknown>
  const rawId = typeof record.id === 'string' ? record.id.trim() : ''
  const id = rawId !== '' ? rawId : `${stepId}-gate`
  const type = record.type === undefined || record.type === null ? 'agent' : record.type
  if (type !== 'agent' && type !== 'skill') {
    throw new ApiError('bad-request', `"${field}.type" must be "agent" or "skill"`)
  }
  const rawName = typeof record.name === 'string' ? record.name.trim() : ''
  const name = rawName !== '' ? rawName : '门禁'
  if (name.length > MAX_GATE_NAME_LENGTH) {
    throw new ApiError('bad-request', `"${field}.name" must be at most ${MAX_GATE_NAME_LENGTH} characters`)
  }
  if (record.autoLoop !== undefined && record.autoLoop !== null && typeof record.autoLoop !== 'boolean') {
    throw new ApiError('bad-request', `"${field}.autoLoop" must be a boolean`)
  }
  const rawMax =
    record.maxIterations === undefined || record.maxIterations === null
      ? DEFAULT_GATE_MAX_ITERATIONS
      : Number(record.maxIterations)
  if (!Number.isInteger(rawMax) || rawMax < MIN_GATE_MAX_ITERATIONS || rawMax > MAX_GATE_MAX_ITERATIONS) {
    throw new ApiError(
      'bad-request',
      `"${field}.maxIterations" must be an integer between ${MIN_GATE_MAX_ITERATIONS} and ${MAX_GATE_MAX_ITERATIONS}`,
    )
  }
  if (record.command !== undefined && record.command !== null && typeof record.command !== 'string') {
    throw new ApiError('bad-request', `"${field}.command" must be a string`)
  }
  const command = typeof record.command === 'string' ? record.command : ''

  const gate: LoopGate = {
    id,
    name,
    type,
    command,
    autoLoop: record.autoLoop === true,
    maxIterations: rawMax,
    ...normalizeGateModel(record.model, `${field}.model`),
  }
  if (type === 'skill') {
    const skill = typeof record.skill === 'string' ? record.skill.trim() : ''
    if (skill === '') throw new ApiError('invalid-loop', `"${field}.skill" must name an installed skill`)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) {
      throw new ApiError('invalid-loop', `"${field}.skill" must be a kebab-case skill name`)
    }
    gate.skill = skill
  }
  return gate
}

/**
 * Normalize one client-supplied loop step (a pipeline and its gate).
 * @param {unknown} candidate - raw step payload.
 * @param {number} index - position, for error messages.
 */
function normalizeLoopStep(candidate: unknown, index: number): LoopStep {
  const field = `steps[${index}]`
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ApiError('bad-request', `"${field}" must be an object`)
  }
  const record = candidate as Record<string, unknown>
  const rawId = typeof record.id === 'string' ? record.id.trim() : ''
  const id = rawId !== '' ? rawId : randomUUID()
  const pipelineId = typeof record.pipelineId === 'string' ? record.pipelineId.trim() : ''
  if (pipelineId === '') throw new ApiError('invalid-loop', `第 ${index + 1} 组缺少 Pipeline`)
  return { id, pipelineId, gate: normalizeLoopGate(record.gate, index, id) }
}

/**
 * Validate a loop create/update payload and shape it into its persisted fields.
 * The unknown-pipeline check is done by {@link validateLoop}, so a loop can only
 * reference pipelines that exist right now (CONTRACT.md §13.2).
 * @param {unknown} payload - parsed JSON body.
 * @param {string[]} pipelineIds - ids of the pipelines currently saved.
 */
function normalizeLoopInput(payload: unknown, pipelineIds: string[]): LoopInput {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError('bad-request', 'request body must be a JSON object')
  }
  const record = payload as Record<string, unknown>
  const name = requireName(record.name, 'name', MAX_LOOP_NAME_LENGTH)
  const desc = optionalText(record.desc ?? record.description, 'desc', MAX_DESC_LENGTH)
  const icon = record.icon === undefined || record.icon === null ? undefined : optionalText(record.icon, 'icon', 4)
  const color =
    record.color === undefined || record.color === null ? undefined : optionalText(record.color, 'color', 12)
  if (color !== undefined && !ALLOWED_COLORS.has(color)) {
    throw new ApiError('bad-request', `"color" must be one of ${[...ALLOWED_COLORS].filter(Boolean).join(', ')}`)
  }
  if (record.star !== undefined && typeof record.star !== 'boolean') {
    throw new ApiError('bad-request', '"star" must be a boolean')
  }
  if (!Array.isArray(record.steps)) throw new ApiError('bad-request', '"steps" must be an array')
  const steps = record.steps.map((candidate, index) => normalizeLoopStep(candidate, index))
  const loop = {
    name,
    desc,
    ...(icon === undefined ? {} : { icon }),
    color: color ?? '',
    star: typeof record.star === 'boolean' ? record.star : undefined,
    steps,
  }
  const validation = validateLoop(loop, { pipelineIds })
  if (!validation.ok) throw new ApiError(validation.code, validation.message, 400)
  return loop
}

/**
 * Extract the pathname of a request without trusting its URL.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {string}
 */
function requestPathname(req: IncomingMessage) {
  try {
    return new URL(req.url ?? '/', 'http://dsh.internal').pathname
  } catch {
    return ''
  }
}

/**
 * Decode one path parameter.
 * @param {string} raw - raw path segment.
 * @returns {string}
 */
function decodeParam(raw: string) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Merge local in-flight runs into a database snapshot. Local objects win for
 * the same id, so live node progress is visible while the mirror catches up.
 */
function mergeRuns(remoteRuns: Run[], localRuns: Run[]): Run[] {
  const byId = new Map<string, Run>()
  for (const run of Array.isArray(remoteRuns) ? remoteRuns : []) {
    if (run !== null && typeof run === 'object' && typeof run.id === 'string') byId.set(run.id, run)
  }
  for (const run of Array.isArray(localRuns) ? localRuns : []) {
    if (run !== null && typeof run === 'object' && typeof run.id === 'string') byId.set(run.id, run)
  }
  return [...byId.values()].sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0)).slice(0, 50)
}

/**
 * Merge local in-flight loop runs into a database snapshot (same rule as
 * {@link mergeRuns}: local objects win for the same id, so live step progress
 * stays visible while the PostgreSQL mirror catches up).
 */
function mergeLoopRuns(remoteRuns: LoopRun[], localRuns: LoopRun[]): LoopRun[] {
  const byId = new Map<string, LoopRun>()
  for (const run of Array.isArray(remoteRuns) ? remoteRuns : []) {
    if (run !== null && typeof run === 'object' && typeof run.id === 'string') byId.set(run.id, run)
  }
  for (const run of Array.isArray(localRuns) ? localRuns : []) {
    if (run !== null && typeof run === 'object' && typeof run.id === 'string') byId.set(run.id, run)
  }
  return [...byId.values()].sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0)).slice(0, 50)
}

/**
 * Build the prefix route handler.
 *
 * The handler never rejects: every failure becomes the JSON error envelope.
 * `ping` is answered before the auth fence; every other route is fenced when
 * `requireAuth` is enabled (default), because these routes can start agents.
 *
 * @param {object} options - handler dependencies.
 * @param {boolean} options.requireAuth - whether the connection fence applies.
 * @param {Promise<void>} options.ready - resolves once the store is loaded.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function createRequestHandler({
  ctx,
  store,
  engine,
  loopEngine,
  db,
  dbReady,
  requireAuth,
  ready,
}: RequestHandlerOptions) {
  /** @param {string} message - log line */
  const warn = (message: string) => {
    try {
      ctx.logger?.warn?.(`loop-manager: ${message}`)
    } catch {
      // ignore logger failures
    }
  }

  /**
   * Apply the connection fence. Fail closed when the connection service itself
   * misbehaves.
   * @param {import('node:http').IncomingMessage} req - request.
   * @returns {boolean} true when the request must be rejected with 401.
   */
  function isRejected(req: IncomingMessage) {
    if (!requireAuth) return false
    try {
      return ctx.connection.requestRejection(req) !== undefined
    } catch (error) {
      warn(`connection fence threw, rejecting the request: ${messageOf(error)}`)
      return true
    }
  }

  /** Installed-skill catalog cache: skill discovery walks the filesystem. */
  let skillsCache: { at: number; key: string; value: SkillsResponse | null } = { at: 0, key: '', value: null }

  /**
   * List the skills installed in this deployment (the Skill node's dropdown).
   * Uses `ctx.skills` when mounted, caches for {@link SKILLS_CACHE_MS}, and
   * degrades to an empty catalog instead of failing the editor.
   * @param {string} cwd - working directory whose project skill roots apply.
   */
  async function listSkills(cwd: string): Promise<SkillsResponse> {
    const cacheKey = cwd
    const now = Date.now()
    if (skillsCache.value !== null && skillsCache.key === cacheKey && now - skillsCache.at < SKILLS_CACHE_MS) {
      return skillsCache.value
    }
    // 1. Registry entries, when the composition mounts skill providers at this
    //    plugin's scope (CLI/headless). The Web composition mounts them inside
    //    agent presets, so this is usually empty there.
    let registryEntries: NonNullable<Parameters<typeof discoverSkills>[0]['registryEntries']> = []
    const registry = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
      try {
        const entries = await registry.list({
          ...(cwd === '' ? {} : { cwd }),
          signal: AbortSignal.timeout(8000),
        })
        registryEntries = Array.isArray(entries) ? entries : []
      } catch (error) {
        warn(`skill registry listing failed, falling back to the filesystem: ${messageOf(error)}`)
      }
    }

    // 2. The same roots the shipped filesystem provider uses, plus bundled
    //    office skills of this installation.
    const { dshHome, agentsHome } = resolveSkillHomes()
    let skills
    try {
      skills = await discoverSkills({
        cwd,
        dshHome,
        agentsHome,
        extraRoots: resolveBundledSkillRoots(),
        registryEntries,
      })
    } catch (error) {
      warn(`could not scan installed skills: ${messageOf(error)}`)
      return { ok: true, skills: [], error: messageOf(error) }
    }
    const value: SkillsResponse = { ok: true, skills }
    skillsCache = { at: now, key: cacheKey, value }
    return value
  }

  /** Model catalog cache: the catalog is the chat composer's own model source. */
  let modelsCache: { at: number; value: ModelsResponse | null } = { at: 0, value: null }

  /**
   * Shape one model list entry for the browser model picker.
   * @returns {{ id: string, name: string, description?: string } | undefined}
   */
  function modelEntry(model: unknown): ModelEntry | undefined {
    if (model === null || typeof model !== 'object') return undefined
    const record = model as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (id === '') return undefined
    const name = typeof record.name === 'string' && record.name !== '' ? record.name : id
    const description =
      typeof record.description === 'string' && record.description !== '' ? record.description : undefined
    return { id, name, ...(description === undefined ? {} : { description }) }
  }

  /**
   * Read the deployment's model catalog. The chat composer's model picker uses
   * `sessionController.modelCatalog()`, so the Loop Manager node picker offers
   * exactly the same providers, models and labels. Older hosts without that
   * method fall back to the raw `llm` registry.
   */
  async function listModels(): Promise<ModelsResponse> {
    const now = Date.now()
    if (modelsCache.value !== null && now - modelsCache.at < MODELS_CACHE_MS) return modelsCache.value

    const sessionController = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    if (
      sessionController !== undefined &&
      sessionController !== null &&
      typeof sessionController.modelCatalog === 'function'
    ) {
      try {
        const catalog = await sessionController.modelCatalog()

        const providers: ModelProvider[] = []
        for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
          if (group === null || typeof group !== 'object' || typeof group.id !== 'string' || group.id === '') continue
          const models = (Array.isArray(group.models) ? group.models : [])
            .map(modelEntry)
            .filter((entry) => entry !== undefined)
          if (models.length === 0) continue
          providers.push({
            id: group.id,
            name: typeof group.name === 'string' && group.name !== '' ? group.name : group.id,
            models,
          })
        }
        const selection = catalog?.default
        const fallback =
          selection !== null &&
          typeof selection === 'object' &&
          typeof selection.provider === 'string' &&
          typeof selection.model === 'string' &&
          selection.provider !== '' &&
          selection.model !== ''
            ? { provider: selection.provider, model: selection.model }
            : undefined
        const failures = (Array.isArray(catalog?.failures) ? catalog.failures : [])
          .filter(
            (failure): failure is { id: string; name?: unknown; message?: unknown } =>
              failure !== null && typeof failure === 'object' && typeof failure.id === 'string',
          )
          .map((failure) => ({
            id: failure.id,
            name: typeof failure.name === 'string' ? failure.name : failure.id,
            message: typeof failure.message === 'string' ? failure.message : '',
          }))
        const value: ModelsResponse = {
          ok: true,
          providers,
          ...(fallback === undefined ? {} : { default: fallback }),
          ...(failures.length === 0 ? {} : { failures }),
        }
        modelsCache = { at: now, value }
        return value
      } catch (error) {
        warn(`the session model catalog could not be read, falling back to the llm registry: ${messageOf(error)}`)
      }
    }

    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (
      llm === undefined ||
      llm === null ||
      typeof llm.listProviders !== 'function' ||
      typeof llm.listModels !== 'function'
    ) {
      const value: ModelsResponse = {
        ok: true,
        providers: [],
        unavailable: true,
        error: 'the llm service is not mounted in this deployment',
      }
      modelsCache = { at: now, value }
      return value
    }

    const providers: ModelProvider[] = []
    let providerList
    try {
      providerList = llm.listProviders()
    } catch (error) {
      warn(`could not list model providers: ${messageOf(error)}`)
      return { ok: true, providers: [], error: messageOf(error) }
    }
    for (const provider of Array.isArray(providerList) ? providerList : []) {
      if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string') continue
      let models
      try {
        models = await llm.listModels(provider.id)
      } catch (error) {
        warn(`provider "${provider.id}" did not list models: ${messageOf(error)}`)
        continue
      }
      const entries = (Array.isArray(models) ? models : []).map(modelEntry).filter((entry) => entry !== undefined)
      if (entries.length === 0) continue
      providers.push({
        id: provider.id,
        name: typeof provider.name === 'string' ? provider.name : provider.id,
        models: entries,
      })
    }
    let fallback
    try {
      const defaultModel = ctx.get('agentDefaultModel')
      const selection =
        typeof defaultModel?.currentSelection === 'function' ? defaultModel.currentSelection() : undefined
      if (selection !== undefined && selection !== null)
        fallback = { provider: selection.provider, model: selection.model }
    } catch {
      // A missing default-model service just means no default is reported.
    }
    const value: ModelsResponse = { ok: true, providers, ...(fallback === undefined ? {} : { default: fallback }) }
    modelsCache = { at: now, value }
    return value
  }

  /**
   * Dispatch one API request.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>}
   */
  async function dispatch(req: IncomingMessage, res: ServerResponse) {
    const pathname = requestPathname(req)
    const method = (req.method ?? 'GET').toUpperCase()

    // Health route: open on purpose (no cookie needed), reads nothing.
    if (pathname === PING_PATH) {
      if (method !== 'GET') {
        writeJson(res, 405, { ok: false, code: 'bad-request', error: 'method not allowed' })
        return
      }
      writeJson(res, 200, { ok: true, name, version: PLUGIN_VERSION })
      return
    }

    if (isRejected(req)) {
      writeJson(res, 401, { ok: false, code: 'unauthorized', error: 'authentication required' })
      return
    }

    await ready

    const pipelineMatch = new RegExp(`^${ROUTE_PREFIX}/api/pipelines/([^/]+)$`).exec(pathname)
    const pipelineRunMatch = new RegExp(`^${ROUTE_PREFIX}/api/pipelines/([^/]+)/run$`).exec(pathname)
    const runStopMatch = new RegExp(`^${ROUTE_PREFIX}/api/runs/([^/]+)/stop$`).exec(pathname)
    const runMatch = new RegExp(`^${ROUTE_PREFIX}/api/runs/([^/]+)$`).exec(pathname)
    const loopMatch = new RegExp(`^${ROUTE_PREFIX}/api/loops/([^/]+)$`).exec(pathname)
    const loopStartMatch = new RegExp(`^${ROUTE_PREFIX}/api/loops/([^/]+)/run$`).exec(pathname)
    const loopRunStopMatch = new RegExp(`^${ROUTE_PREFIX}/api/loop-runs/([^/]+)/stop$`).exec(pathname)
    const loopRunRetryMatch = new RegExp(`^${ROUTE_PREFIX}/api/loop-runs/([^/]+)/retry$`).exec(pathname)
    const loopRunMatch = new RegExp(`^${ROUTE_PREFIX}/api/loop-runs/([^/]+)$`).exec(pathname)

    try {
      if (pathname === `${ROUTE_PREFIX}/api/state`) {
        if (method !== 'GET') throw methodNotAllowed()
        let dbError
        if (db !== undefined && db !== null && db.readFromDb()) {
          try {
            if (db.connected()) await dbReady
            await db.flush()
            const remote = await db.loadState()
            const localRunning = store.listRuns().filter((run) => run.status === 'running')
            const localRunningLoopRuns = store.listLoopRuns().filter((run) => run.status === 'running')
            if (localRunning.length === 0 && localRunningLoopRuns.length === 0) {
              store.replaceAll(remote)
              writeJson(res, 200, {
                ok: true,
                pipelines: store.listPipelines(),
                runs: store.listRuns(),
                loops: store.listLoops(),
                loopRuns: store.listLoopRuns(),
                source: 'db',
              })
            } else {
              writeJson(res, 200, {
                ok: true,
                pipelines: remote.pipelines,
                runs: mergeRuns(remote.runs, localRunning),
                loops: Array.isArray(remote.loops) ? remote.loops : [],
                loopRuns: mergeLoopRuns(remote.loopRuns, localRunningLoopRuns),
                source: 'db',
              })
            }
            return
          } catch (error) {
            dbError = messageOf(error)
            warn(`could not read state from PostgreSQL, falling back to local: ${dbError}`)
          }
        }
        writeJson(res, 200, {
          ok: true,
          pipelines: store.listPipelines(),
          runs: store.listRuns(),
          loops: store.listLoops(),
          loopRuns: store.listLoopRuns(),
          source: 'local',
          ...(dbError === undefined ? {} : { dbError }),
        })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/api/db`) {
        if (method === 'GET') {
          if (db === undefined || db === null)
            throw new ApiError('internal', 'the database manager is not mounted', 500)
          await db.ready
          writeJson(res, 200, { ok: true, db: db.publicStatus() })
          return
        }
        if (method === 'PUT') {
          if (db === undefined || db === null)
            throw new ApiError('internal', 'the database manager is not mounted', 500)
          const payload = await readJsonBody(req)
          await db.ready
          let configured
          try {
            configured = await db.configure(payload)
          } catch (error) {
            throw new ApiError('db-error', messageOf(error), 400)
          }
          let imported = { importedPipelines: 0, importedRuns: 0, importedLoops: 0, importedLoopRuns: 0 }
          try {
            imported = await db.backfillIfEmpty(
              store.listPipelines(),
              store.listRuns(),
              store.listLoops(),
              store.listLoopRuns(),
            )
          } catch (error) {
            warn(`could not backfill PostgreSQL with the local library: ${messageOf(error)}`)
          }
          if (db.readFromDb() && !store.listRuns().some((run) => run.status === 'running')) {
            try {
              await db.flush()
              store.replaceAll(await db.loadState())
            } catch (error) {
              warn(`could not hydrate the local store from PostgreSQL: ${messageOf(error)}`)
            }
          }
          writeJson(res, 200, { ok: true, db: configured, imported })
          return
        }
        throw methodNotAllowed()
      }

      if (pathname === `${ROUTE_PREFIX}/api/db/test`) {
        if (method !== 'POST') throw methodNotAllowed()
        if (db === undefined || db === null) throw new ApiError('internal', 'the database manager is not mounted', 500)
        const payload = await readJsonBody(req)
        await db.ready
        let tested
        try {
          tested = await db.test(payload)
        } catch (error) {
          throw new ApiError('db-error', messageOf(error), 400)
        }
        writeJson(res, 200, { ok: true, db: { ...tested } })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/api/models`) {
        if (method !== 'GET') throw methodNotAllowed()
        writeJson(res, 200, await listModels())
        return
      }

      if (pathname === `${ROUTE_PREFIX}/api/skills`) {
        if (method !== 'GET') throw methodNotAllowed()
        const requestUrl = new URL(req.url ?? '/', 'http://dsh.internal')
        const cwd = (requestUrl.searchParams.get('cwd') ?? '').trim()
        writeJson(res, 200, await listSkills(cwd))
        return
      }

      if (pathname === `${ROUTE_PREFIX}/api/pipelines`) {
        if (method !== 'POST') throw methodNotAllowed()
        const payload = await readJsonBody(req)
        const normalized = normalizePipelineInput(payload)
        const timestamp = Date.now()
        const pipeline = {
          id: randomUUID(),
          name: normalized.name,
          desc: normalized.desc ?? '',
          icon: normalized.icon === undefined || normalized.icon === '' ? '◈' : normalized.icon,
          color: normalized.color ?? '',
          star: normalized.star === true,
          ...(normalized.cwd === undefined ? {} : { cwd: normalized.cwd }),
          nodes: normalized.nodes,
          edges: normalized.edges,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        try {
          await store.upsertPipeline(pipeline)
        } catch (error) {
          throw new ApiError('internal', `could not persist the pipeline: ${messageOf(error)}`, 500)
        }
        writeJson(res, 200, { ok: true, pipeline })
        return
      }

      if (pipelineMatch !== null) {
        const pipelineId = decodeParam(pipelineMatch[1])
        if (method === 'PUT') {
          const existing = store.getPipeline(pipelineId)
          if (existing === undefined) throw pipelineNotFound(pipelineId)
          const payload = await readJsonBody(req)
          const normalized = normalizePipelineInput(payload)
          const pipeline = {
            id: existing.id,
            name: normalized.name,
            desc: normalized.desc ?? '',
            icon: normalized.icon === undefined || normalized.icon === '' ? (existing.icon ?? '◈') : normalized.icon,
            color: normalized.color ?? '',
            star: normalized.star === undefined ? existing.star === true : normalized.star,
            ...(normalized.cwd === undefined ? {} : { cwd: normalized.cwd }),
            nodes: normalized.nodes,
            edges: normalized.edges,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
          }
          try {
            await store.upsertPipeline(pipeline)
          } catch (error) {
            throw new ApiError('internal', `could not persist the pipeline: ${messageOf(error)}`, 500)
          }
          writeJson(res, 200, { ok: true, pipeline })
          return
        }
        if (method === 'PATCH') {
          const existing = store.getPipeline(pipelineId)
          if (existing === undefined) throw pipelineNotFound(pipelineId)
          const payload = await readJsonBody(req)
          if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new ApiError('bad-request', 'request body must be a JSON object')
          }
          const patch = payload as Record<string, unknown>
          const pipeline = { ...existing }
          if (patch.name !== undefined) pipeline.name = requireName(patch.name, 'name', MAX_PIPELINE_NAME_LENGTH)
          if (patch.desc !== undefined || patch.description !== undefined) {
            pipeline.desc = optionalText(patch.desc ?? patch.description, 'desc', MAX_DESC_LENGTH)
          }
          if (patch.icon !== undefined) pipeline.icon = optionalText(patch.icon, 'icon', 4) || '◈'
          if (patch.color !== undefined) {
            const color = optionalText(patch.color, 'color', 12)
            if (!ALLOWED_COLORS.has(color)) {
              throw new ApiError(
                'bad-request',
                `"color" must be one of ${[...ALLOWED_COLORS].filter(Boolean).join(', ')}`,
              )
            }
            pipeline.color = color
          }
          if (patch.star !== undefined) {
            if (typeof patch.star !== 'boolean') throw new ApiError('bad-request', '"star" must be a boolean')
            pipeline.star = patch.star
          }
          pipeline.updatedAt = Date.now()
          try {
            await store.upsertPipeline(pipeline)
          } catch (error) {
            throw new ApiError('internal', `could not persist the pipeline: ${messageOf(error)}`, 500)
          }
          writeJson(res, 200, { ok: true, pipeline })
          return
        }

        if (method === 'DELETE') {
          const existing = store.getPipeline(pipelineId)
          if (existing === undefined) throw pipelineNotFound(pipelineId)
          try {
            await store.removePipeline(pipelineId)
          } catch (error) {
            throw new ApiError('internal', `could not delete the pipeline: ${messageOf(error)}`, 500)
          }
          writeJson(res, 200, { ok: true })
          return
        }
        throw methodNotAllowed()
      }

      if (pathname === `${ROUTE_PREFIX}/api/loops`) {
        if (method !== 'POST') throw methodNotAllowed()
        const payload = await readJsonBody(req)
        const normalized = normalizeLoopInput(
          payload,
          store.listPipelines().map((pipeline) => pipeline.id),
        )
        const timestamp = Date.now()
        const loop = {
          id: randomUUID(),
          name: normalized.name,
          desc: normalized.desc ?? '',
          icon: normalized.icon === undefined || normalized.icon === '' ? LOOP_ICON_DEFAULT : normalized.icon,
          color: normalized.color ?? '',
          star: normalized.star === true,
          steps: normalized.steps,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        try {
          await store.upsertLoop(loop)
        } catch (error) {
          throw new ApiError('internal', `could not persist the loop: ${messageOf(error)}`, 500)
        }
        writeJson(res, 200, { ok: true, loop })
        return
      }

      if (loopMatch !== null) {
        const loopId = decodeParam(loopMatch[1])
        if (method === 'PUT') {
          const existing = store.getLoop(loopId)
          if (existing === undefined) throw loopNotFound(loopId)
          const payload = await readJsonBody(req)
          const normalized = normalizeLoopInput(
            payload,
            store.listPipelines().map((pipeline) => pipeline.id),
          )
          const loop = {
            id: existing.id,
            name: normalized.name,
            desc: normalized.desc ?? '',
            icon:
              normalized.icon === undefined || normalized.icon === ''
                ? (existing.icon ?? LOOP_ICON_DEFAULT)
                : normalized.icon,
            color: normalized.color ?? '',
            star: normalized.star === undefined ? existing.star === true : normalized.star,
            steps: normalized.steps,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
          }
          try {
            await store.upsertLoop(loop)
          } catch (error) {
            throw new ApiError('internal', `could not persist the loop: ${messageOf(error)}`, 500)
          }
          writeJson(res, 200, { ok: true, loop })
          return
        }
        if (method === 'PATCH') {
          const existing = store.getLoop(loopId)
          if (existing === undefined) throw loopNotFound(loopId)
          const payload = await readJsonBody(req)
          if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new ApiError('bad-request', 'request body must be a JSON object')
          }
          const patch = payload as Record<string, unknown>
          const loop = { ...existing }
          if (patch.name !== undefined) loop.name = requireName(patch.name, 'name', MAX_LOOP_NAME_LENGTH)
          if (patch.desc !== undefined || patch.description !== undefined) {
            loop.desc = optionalText(patch.desc ?? patch.description, 'desc', MAX_DESC_LENGTH)
          }
          if (patch.icon !== undefined) loop.icon = optionalText(patch.icon, 'icon', 4) || LOOP_ICON_DEFAULT
          if (patch.color !== undefined) {
            const color = optionalText(patch.color, 'color', 12)
            if (!ALLOWED_COLORS.has(color)) {
              throw new ApiError(
                'bad-request',
                `"color" must be one of ${[...ALLOWED_COLORS].filter(Boolean).join(', ')}`,
              )
            }
            loop.color = color
          }
          if (patch.star !== undefined) {
            if (typeof patch.star !== 'boolean') throw new ApiError('bad-request', '"star" must be a boolean')
            loop.star = patch.star
          }
          loop.updatedAt = Date.now()
          try {
            await store.upsertLoop(loop)
          } catch (error) {
            throw new ApiError('internal', `could not persist the loop: ${messageOf(error)}`, 500)
          }
          writeJson(res, 200, { ok: true, loop })
          return
        }
        if (method === 'DELETE') {
          const existing = store.getLoop(loopId)
          if (existing === undefined) throw loopNotFound(loopId)
          const runningLoopRun = store.listLoopRuns().find((run) => run.loopId === loopId && run.status === 'running')
          if (runningLoopRun !== undefined) {
            throw new ApiError('run-in-progress', 'stop the loop run before deleting it', 409)
          }
          try {
            await store.removeLoop(loopId)
          } catch (error) {
            throw new ApiError('internal', `could not delete the loop: ${messageOf(error)}`, 500)
          }
          writeJson(res, 200, { ok: true })
          return
        }
        throw methodNotAllowed()
      }

      if (loopStartMatch !== null) {
        if (method !== 'POST') throw methodNotAllowed()
        const loopId = decodeParam(loopStartMatch[1])
        const loop = store.getLoop(loopId)
        if (loop === undefined) throw loopNotFound(loopId)
        const started = loopEngine.start(loop)
        if (!started.ok) {
          if (started.code === 'run-in-progress') throw new ApiError('run-in-progress', started.message, 409)
          if (started.code === 'invalid-loop') throw new ApiError('invalid-loop', started.message, 400)
          if (started.code === 'bad-request') throw new ApiError('bad-request', started.message, 400)
          throw new ApiError('internal', started.message, 500)
        }
        writeJson(res, 202, { ok: true, run: started.run })
        return
      }

      if (loopRunStopMatch !== null) {
        if (method !== 'POST') throw methodNotAllowed()
        const stopped = await loopEngine.stop(decodeParam(loopRunStopMatch[1]))
        if (!stopped.ok) {
          if (stopped.code === 'loop-run-not-found') throw new ApiError('loop-run-not-found', stopped.message, 404)
          throw new ApiError('internal', stopped.message, 500)
        }
        writeJson(res, 200, { ok: true, run: stopped.run })
        return
      }

      if (loopRunRetryMatch !== null) {
        if (method !== 'POST') throw methodNotAllowed()
        const runId = decodeParam(loopRunRetryMatch[1])
        const payload = await readJsonBody(req)
        const rawStepId =
          payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>).stepId : undefined
        const stepId = typeof rawStepId === 'string' && rawStepId.trim() !== '' ? rawStepId.trim() : undefined
        const resumed = await loopEngine.retry(runId, stepId)
        if (!resumed.ok) {
          if (resumed.code === 'loop-run-not-found') throw new ApiError('loop-run-not-found', resumed.message, 404)
          if (resumed.code === 'loop-not-found') throw new ApiError('loop-not-found', resumed.message, 404)
          if (resumed.code === 'not-awaiting') throw new ApiError('not-awaiting', resumed.message, 409)
          if (resumed.code === 'step-not-found') throw new ApiError('step-not-found', resumed.message, 400)
          if (resumed.code === 'invalid-loop') throw new ApiError('invalid-loop', resumed.message, 400)
          if (resumed.code === 'bad-request') throw new ApiError('bad-request', resumed.message, 400)
          throw new ApiError('internal', resumed.message, 500)
        }
        writeJson(res, 202, { ok: true, run: resumed.run })
        return
      }

      if (loopRunMatch !== null) {
        if (method !== 'DELETE') throw methodNotAllowed()
        const deleted = await loopEngine.deleteRun(decodeParam(loopRunMatch[1]))
        if (!deleted.ok) {
          if (deleted.code === 'run-in-progress') throw new ApiError('run-in-progress', deleted.message, 409)
          throw new ApiError('loop-run-not-found', deleted.message, 404)
        }
        writeJson(res, 200, { ok: true })
        return
      }

      if (pipelineRunMatch !== null) {
        if (method !== 'POST') throw methodNotAllowed()
        const pipelineId = decodeParam(pipelineRunMatch[1])
        const pipeline = store.getPipeline(pipelineId)
        if (pipeline === undefined) throw pipelineNotFound(pipelineId)
        const started = engine.start(pipeline)
        if (!started.ok) {
          if (started.code === 'run-in-progress') throw new ApiError('run-in-progress', started.message, 409)
          if (started.code === 'invalid-graph') throw new ApiError('invalid-graph', started.message, 400)
          if (started.code === 'bad-request') throw new ApiError('bad-request', started.message, 400)
          throw new ApiError('internal', started.message, 500)
        }
        writeJson(res, 202, { ok: true, run: started.run })
        return
      }

      if (runStopMatch !== null) {
        if (method !== 'POST') throw methodNotAllowed()
        const stopped = await engine.stop(decodeParam(runStopMatch[1]))
        if (!stopped.ok) throw new ApiError('run-not-found', stopped.message, 404)
        writeJson(res, 200, { ok: true, run: stopped.run })
        return
      }

      if (runMatch !== null) {
        if (method !== 'DELETE') throw methodNotAllowed()
        const deleted = await engine.deleteRun(decodeParam(runMatch[1]))
        if (!deleted.ok) {
          if (deleted.code === 'run-in-progress') throw new ApiError('run-in-progress', deleted.message, 409)
          throw new ApiError('run-not-found', deleted.message, 404)
        }
        writeJson(res, 200, { ok: true })
        return
      }

      writeJson(res, 404, { ok: false, code: 'bad-request', error: `unknown route: ${method} ${pathname}` })
    } catch (error) {
      if (error instanceof ApiError) {
        writeJson(res, error.status, { ok: false, code: error.code, error: error.message })
        return
      }
      warn(`unexpected failure on ${method} ${pathname}: ${messageOf(error)}`)
      writeJson(res, 500, { ok: false, code: 'internal', error: messageOf(error) })
    }
  }

  return dispatch
}

/**
 * @returns {ApiError} 405 envelope for a known path with the wrong method.
 */
function methodNotAllowed() {
  return new ApiError('bad-request', 'method not allowed', 405)
}

/**
 * @param {string} pipelineId - requested id.
 * @returns {ApiError} 404 `pipeline-not-found` envelope.
 */
function pipelineNotFound(pipelineId: string) {
  return new ApiError('pipeline-not-found', `pipeline "${pipelineId}" not found`, 404)
}

/**
 * @param {string} loopId - requested id.
 * @returns {ApiError} 404 `loop-not-found` envelope.
 */
function loopNotFound(loopId: string) {
  return new ApiError('loop-not-found', `loop "${loopId}" not found`, 404)
}

/**
 * Mount the host half.
 *
 * @param {{ requireAuth?: boolean }} [config] - loader-provided plugin config;
 *   `requireAuth: false` disables the connection fence (isolated verification
 *   profile only). It defaults to `true`: these routes can start agent turns.
 * @returns {void}
 */
export function apply(ctx: ApiHostContext, config: { requireAuth?: boolean } = {}) {
  const logger = ctx.logger
  const requireAuth = config?.requireAuth !== false

  const db = createDatabaseManager({ file: resolveDbConfigFile(), logger })
  const store = createStore({ file: resolveStateFile(), logger, mirror: db.mirror })
  const resolveService = (serviceName: string) => {
    try {
      return ctx.get(serviceName)
    } catch (error) {
      logger?.warn?.(`loop-manager: could not resolve service "${serviceName}": ${messageOf(error)}`)
      return undefined
    }
  }
  const engine = createEngine({
    store,
    logger,
    createUserMessage,
    resolveService,
  })
  // Gate turns reuse the same real agent-turn runner as pipeline nodes, so a
  // gate is one normal session in the harness (CONTRACT.md §13.5).
  const loopEngine = createLoopEngine({
    store,
    engine,
    logger,
    resolveService,
    runGate: createAgentNodeRunner({ resolveService, createUserMessage, logger }),
  })

  // Store loading is async and never rejects; requests wait for it (it settles
  // within one file read, long before the first HTTP request arrives).
  const ready = store.load().catch((error) => {
    logger?.warn?.(`loop-manager: could not load the state file: ${messageOf(error)}`)
  })

  // Once the local file is loaded and PostgreSQL is reachable: initialise an
  // empty database from the local library, then hydrate the in-memory store
  // when the read-source switch is on. Never blocks local fallback on failure.
  const dbReady = ready
    .then(() => db.ready)
    .then(async () => {
      if (!db.connected()) return
      try {
        await db.backfillIfEmpty(store.listPipelines(), store.listRuns(), store.listLoops(), store.listLoopRuns())
      } catch (error) {
        logger?.warn?.(`loop-manager: initial PostgreSQL backfill failed: ${messageOf(error)}`)
      }
      if (db.readFromDb() && !store.listRuns().some((run) => run.status === 'running')) {
        try {
          await db.flush()
          store.replaceAll(await db.loadState())
        } catch (error) {
          logger?.warn?.(`loop-manager: could not hydrate from PostgreSQL: ${messageOf(error)}`)
        }
      }
    })
    .catch((error) => {
      logger?.warn?.(`loop-manager: PostgreSQL startup failed: ${messageOf(error)}`)
    })

  const handler = createRequestHandler({ ctx, store, engine, loopEngine, db, dbReady, requireAuth, ready })

  // The route lives inside an effect so plugin unload disposes it.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          void handler(req, res).catch((error) => {
            logger?.warn?.(`loop-manager: request handler crashed: ${messageOf(error)}`)
            writeJson(res, 500, { ok: false, code: 'internal', error: messageOf(error) })
          })
        },
      }),
    'dsh-loop-manager: /loop-manager routes',
  )

  // Unload must stop every scheduled run (and cancel its agent turn).
  ctx.effect(() => () => loopEngine.dispose(), 'dsh-loop-manager: stop running loops')

  ctx.effect(() => () => engine.dispose(), 'dsh-loop-manager: stop running pipelines')

  // Close the PostgreSQL pool (after pending mirror writes settle).
  ctx.effect(() => () => db.close(), 'dsh-loop-manager: close the PostgreSQL pool')
}
