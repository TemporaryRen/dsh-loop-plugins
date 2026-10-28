/**
 * Run orchestration for dsh-loop-manager.
 *
 * The engine executes a pipeline's DAG serially in topological order. Each node
 * is one real DSH agent turn; the turn runner is injectable so unit tests never
 * touch a real agent:
 *
 * ```js
 * const engine = createEngine({ store, runNode: fakeRunner })
 * engine.start(pipeline)   // -> { ok: true, run }
 * ```
 *
 * The default runner ({@link createAgentNodeRunner}) implements the recipe the
 * contract pins down: create a Session, resolve its Agent, deliver one user
 * message with `followup`, flush, then poll session events until the matching
 * `turn/end`.
 */
import { randomUUID } from 'node:crypto'
import type { NodeState, Pipeline, PipelineNode, Run, RunStatus } from './types.js'
import type {
  CreateUserMessage,
  DefaultModelService,
  HostSession,
  Logger,
  ModelSelection,
  ResolveService,
  SessionController,
  SessionEvent,
  SessionsService,
  TurnReason,
} from './host-types.js'

export interface RunnerProgress {
  output: string
  thinking: string
}
export interface NodeRunnerContext {
  node: PipelineNode
  prompt: string
  pipeline: Pick<Pipeline, 'cwd'>
  signal: AbortSignal
  defaultModel?: ModelSelection
  onSession?: (sessionId: string) => void
  onProgress?: (progress: RunnerProgress) => void
}
export interface NodeRunnerResult {
  output: string
  thinking?: string
  sessionId?: string
}
export type NodeRunner = (context: NodeRunnerContext) => Promise<NodeRunnerResult | string>
export interface AgentNodeRunnerOptions {
  resolveService?: ResolveService
  createUserMessage?: CreateUserMessage
  logger?: Logger
  pollIntervalMs?: number
}
export interface EngineStore {
  getRun?: (runId: string) => Run | undefined
  listRuns(): Run[]
  setRun(run: Run): unknown
  saveLastRun(pipelineId: string, run: Run): void | Promise<unknown>
  removeRun(runId: string): Promise<boolean>
}
export interface EngineOptions extends AgentNodeRunnerOptions {
  store?: EngineStore
  runNode?: NodeRunner
  nodeTimeoutMs?: number
  now?: () => number
}
export type EngineFailure = { ok: false; code: string; message: string; run?: Run }
export type EngineRunResult = { ok: true; run: Run } | EngineFailure
export type DeleteRunResult = { ok: true } | { ok: false; code: string; message: string }
interface RunHandle {
  run: Run
  pipeline: Pipeline
  controller: AbortController
  stopRequested: boolean
  abortNode?: (reason: Error) => void
  defaultModel?: ModelSelection
  done: Promise<void>
}

import { renderNodePrompt, topologicalOrder } from './dag.js'

/** Poll interval while waiting for a node's agent turn to finish. */
export const DEFAULT_POLL_INTERVAL_MS = 400

/** Default per-node timeout: 30 minutes. */
export const DEFAULT_NODE_TIMEOUT_MS = 30 * 60 * 1000

/** Node output is truncated to this many characters before recording. */
export const MAX_OUTPUT_CHARS = 20000

/** How many consecutive snapshot reads may fail before the node fails. */
export const MAX_CONSECUTIVE_POLL_ERRORS = 3

/** Raised when a run was stopped by the user (or by plugin teardown). */
export class RunStoppedError extends Error {
  declare code: string
  constructor(message = 'the run was stopped') {
    super(message)
    this.name = 'RunStoppedError'
    this.code = 'run-stopped'
  }
}

/** Raised when a node exceeded {@link DEFAULT_NODE_TIMEOUT_MS}. */
export class NodeTimeoutError extends Error {
  declare code: string
  declare timeoutMs: number
  constructor(timeoutMs: number) {
    super(`node timed out after ${timeoutMs} ms`)
    this.name = 'NodeTimeoutError'
    this.code = 'node-timeout'
    this.timeoutMs = timeoutMs
  }
}

/**
 * Format any thrown value as a single-line message.
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
 * Turn an upstream error value into an Error instance.
 */
function asError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(messageOf(error))
}

/**
 * Truncate a node output to the contract limit.
 */
function truncateOutput(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}` : text
}

/**
 * Truncate the folded thinking process kept on a run's node state.
 */
function truncateThinking(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return text.length > MAX_THINKING_CHARS ? `${text.slice(0, MAX_THINKING_CHARS)}` : text
}

/**
 * Read the deployment's current default model selection.
 *
 * One run snapshots this once at start (CONTRACT.md §5 / §11.3); the loop
 * engine reuses the same helper so a gate turn without its own model follows
 * the same deployment default. Never throws: a missing service or malformed
 * selection simply means "no default".
 *
 */
export function readDefaultModel(resolveService?: ResolveService): ModelSelection | undefined {
  if (typeof resolveService !== 'function') return undefined
  let selection
  try {
    const service = resolveService('agentDefaultModel') as DefaultModelService | null | undefined
    selection = typeof service?.currentSelection === 'function' ? service.currentSelection() : undefined
  } catch {
    return undefined
  }
  if (selection === null || typeof selection !== 'object') return undefined
  const model = selection as Partial<ModelSelection>
  if (typeof model.provider !== 'string' || model.provider === '') return undefined
  if (typeof model.model !== 'string' || model.model === '') return undefined
  return {
    provider: model.provider,
    model: model.model,
    ...(typeof model.reasoningEffort === 'string' && model.reasoningEffort !== ''
      ? { reasoningEffort: model.reasoningEffort }
      : {}),
  }
}

/**
 * Read the next event sequence number of a session.
 * `session.seq` is the next seq (= log length); older/modified hosts may expose
 * only `snapshotEvents()`, so both shapes are supported.
 */
function sessionStartSeq(session: HostSession): number {
  if (session !== null && typeof session === 'object' && typeof session.seq === 'number') return session.seq
  if (session !== null && typeof session === 'object' && typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    if (Array.isArray(events)) return events.length
  }
  return 0
}

/**
 * Abort-aware sleep. Rejects with the signal reason as soon as it fires.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Read the abort reason as an Error.
 */
function abortReason(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new RunStoppedError('the run was stopped')
}

/**
 * Render a `turn/end.reason` as a user-facing failure message.
 */
function describeTurnReason(reason: TurnReason | undefined): string {
  if (reason === null || typeof reason !== 'object') return 'the agent turn ended without a result'
  const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
  if (kind === 'error') {
    const error = reason.error
    if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
    return 'the agent turn failed'
  }
  if (kind === 'aborted') {
    const cause = reason.reason
    const causeKind =
      cause !== null && typeof cause === 'object' && typeof cause.kind === 'string' ? cause.kind : undefined
    return causeKind === undefined ? 'the agent turn was aborted' : `the agent turn was aborted (${causeKind})`
  }
  if (kind === 'blocked') return 'the agent turn was blocked before it started'
  if (kind === 'max-tokens') return 'the agent turn stopped at the max token limit'
  return `the agent turn did not complete (${kind})`
}

/**
 * How much folded "thinking" one node keeps (reasoning + intermediate text).
 */
export const MAX_THINKING_CHARS = 12000

/**
 * Collect the finished turn's final answer plus the folded thinking process.
 *
 * The chat transcript folds reasoning and intermediate steps and shows only the
 * final answer; a run log should match that: `output` is the last assistant
 * text of the turn (shown in full), `thinking` carries the reasoning blocks,
 * tool calls and earlier assistant text (folded by default in the UI).
 *
 * While running, yields the latest readable progress instead.
 */
function collectTurnResult(events: SessionEvent[], endEvent?: SessionEvent): RunnerProgress {
  const endSeq = typeof endEvent?.seq === 'number' ? endEvent.seq : Number.POSITIVE_INFINITY
  const turn = endEvent?.data?.turn
  const pieces: Array<{ seq: number; kind: 'text' | 'thought'; text: string }> = []
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    if (typeof event.seq === 'number' && event.seq >= endSeq) continue
    const eventTurn = event.data?.turn
    if (turn !== undefined && eventTurn !== undefined && eventTurn !== turn) continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const seq = typeof event.seq === 'number' ? event.seq : pieces.length
    const texts = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        texts.push(block.text)
      } else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
        pieces.push({ seq, kind: 'thought', text: block.text })
      } else if (block.type === 'tool-call' && typeof block.name === 'string' && block.name !== '') {
        pieces.push({ seq, kind: 'thought', text: `· 调用工具 ${block.name}` })
      }
    }
    if (texts.length > 0) pieces.push({ seq, kind: 'text', text: texts.join('\n\n') })
  }
  pieces.sort((left, right) => left.seq - right.seq)
  const textPieces = pieces.filter((piece) => piece.kind === 'text')
  const output = textPieces.length > 0 ? textPieces[textPieces.length - 1].text : ''
  const thoughts = pieces
    .filter((piece) => piece !== (textPieces.length > 0 ? textPieces[textPieces.length - 1] : null))
    .map((piece) => piece.text)
  let thinking = thoughts.join('\n\n')
  if (thinking.length > MAX_THINKING_CHARS) thinking = thinking.slice(0, MAX_THINKING_CHARS)
  return { output, thinking }
}

/**
 * Create the real node runner: one fresh DSH Session + Agent turn per node.
 *
 * The runner is registered as the engine default and receives the abort signal
 * from the engine. Aborting the signal (user stop, plugin teardown or node
 * timeout) cancels the agent turn with `agent.cancel({ kind: 'user' })`, so a
 * stopped node releases the session promptly.
 *
 */
export function createAgentNodeRunner({
  resolveService = undefined,
  createUserMessage = undefined,
  logger = undefined,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: AgentNodeRunnerOptions = {}) {
  const warn = (message: string) => {
    try {
      logger?.warn?.(`loop-manager: ${message}`)
    } catch {
      // ignore logger failures
    }
  }

  return async function runAgentNode({
    node,
    prompt,
    pipeline,
    signal,
    defaultModel,
    onSession,
    onProgress,
  }: NodeRunnerContext): Promise<NodeRunnerResult & { thinking: string; sessionId: string }> {
    if (signal?.aborted === true) throw abortReason(signal)
    if (typeof createUserMessage !== 'function') {
      throw new Error('the LLM message factory is not available in this deployment')
    }
    const sessionController = resolveService?.('sessionController') as SessionController | null | undefined
    const sessions = resolveService?.('sessions') as SessionsService | null | undefined
    if (sessionController === undefined || sessionController === null) {
      throw new Error('the session controller service is not mounted in this deployment')
    }
    if (sessions === undefined || sessions === null) {
      throw new Error('the session store service is not mounted in this deployment')
    }

    // 1. Fresh Session. Only pass `cwd` when the pipeline names one; never pass
    //    both workspaceId and cwd (sessionController.create rejects that).
    const cwd = typeof pipeline?.cwd === 'string' && pipeline.cwd.trim() !== '' ? pipeline.cwd.trim() : undefined
    // Every node runs in the harness' `standard` preset, so the tool surface and
    // prompting match a normal chat session; an older host without that preset
    // falls back to the deployment default.
    let created
    try {
      created = await sessionController.create({
        ...(cwd === undefined ? {} : { cwd }),
        agentPreset: 'standard',
      })
    } catch (error) {
      warn(
        `could not create the node session with the "standard" preset, retrying with the default: ${messageOf(error)}`,
      )
      created = await sessionController.create(cwd === undefined ? {} : { cwd })
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('the session controller did not return a session id')
    }

    // 2. Resolve the live Agent that owns the Session.
    const resolved = await sessionController.resolveAgent(sessionId)
    if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) throw asError(resolved.error)
    const agent = resolved?.agent
    if (agent === undefined || agent === null) {
      throw new Error(`the session controller could not resolve an agent for session "${sessionId}"`)
    }
    onSession?.(sessionId)

    // 2b. Pin the node's model (the chat composer's own selection seam). A node
    //     may specify its own selection; a node without one is pinned to the
    //     deployment default captured when the run started, so a sibling node's
    //     model choice can never leak into it through the mutated default. A
    //     failed explicit selection is a real node failure: silently running
    //     another model would hide a misconfiguration.
    const explicit = node?.model
    const hasExplicit =
      explicit !== undefined &&
      explicit !== null &&
      typeof explicit.provider === 'string' &&
      typeof explicit.model === 'string' &&
      explicit.provider !== '' &&
      explicit.model !== ''
    const inherited =
      defaultModel !== undefined &&
      defaultModel !== null &&
      typeof defaultModel.provider === 'string' &&
      typeof defaultModel.model === 'string' &&
      defaultModel.provider !== '' &&
      defaultModel.model !== ''
        ? defaultModel
        : undefined
    const pinned = hasExplicit ? explicit : inherited
    if (pinned !== undefined) {
      if (typeof sessionController.selectModel !== 'function') {
        if (hasExplicit) throw new Error('this deployment cannot select a model per session')
        warn(`this deployment cannot pin the default model for session "${sessionId}"`)
      } else {
        await sessionController.selectModel({
          sessionId,
          provider: pinned.provider,
          model: pinned.model,
          ...(typeof pinned.reasoningEffort === 'string' && pinned.reasoningEffort !== ''
            ? { reasoningEffort: pinned.reasoningEffort }
            : {}),
        })
      }
    }

    // 3. Capture the next event seq BEFORE delivering the message, so the turn
    //    search can never match an earlier turn.
    const startSeq = sessionStartSeq(agent.session)

    const cancelAgent = () => {
      try {
        agent.cancel({ kind: 'user' })
      } catch (error) {
        warn(`could not cancel the agent of session "${sessionId}": ${messageOf(error)}`)
      }
    }

    try {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'loop-manager' },
        }),
      )

      // Flush is a durability checkpoint, not part of the turn. A host without
      // a persistence listener can return false (or throw); that must not fail
      // the node — the turn is already running.
      try {
        const acknowledged = await sessions.flush(agent.session)
        if (acknowledged === false) warn(`session persistence did not acknowledge node "${node?.id}"`)
      } catch (error) {
        warn(`session flush failed for node "${node?.id}": ${messageOf(error)}`)
      }

      // 4. Poll until the turn that started after `startSeq` ends.
      let consecutiveErrors = 0
      let lastProgressOutput = ''
      let lastProgressThinking = ''
      while (true) {
        if ((signal as AbortSignal | undefined)?.aborted === true) throw abortReason(signal)

        let events
        try {
          events = agent.session.snapshotEvents(startSeq)
          consecutiveErrors = 0
        } catch (error) {
          consecutiveErrors += 1
          if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) throw asError(error)
          await sleep(pollIntervalMs, signal)
          continue
        }

        const endEvent = Array.isArray(events)
          ? events.find(
              (event) => event?.type === 'turn/end' && (typeof event.seq !== 'number' || event.seq >= startSeq),
            )
          : undefined
        if (endEvent !== undefined) {
          const result = collectTurnResult(events, endEvent)
          const reason = endEvent.data?.reason
          if (reason?.kind !== 'completed') throw new Error(describeTurnReason(reason))
          return { output: result.output, thinking: result.thinking, sessionId }
        }

        // Live progress for the run log: report the latest committed assistant
        // text and reasoning while the turn is still running, so the browser
        // shows output as the agent works instead of only at turn end.
        if (typeof onProgress === 'function' && Array.isArray(events)) {
          const progress = collectTurnResult(events, undefined)
          if (
            (progress.output !== lastProgressOutput || progress.thinking !== lastProgressThinking) &&
            (progress.output !== '' || progress.thinking !== '')
          ) {
            lastProgressOutput = progress.output
            lastProgressThinking = progress.thinking
            try {
              onProgress(progress)
            } catch (error) {
              warn(`node progress listener failed: ${messageOf(error)}`)
            }
          }
        }

        await sleep(pollIntervalMs, signal)
      }
    } catch (error) {
      // Any abnormal exit (stop, timeout, turn error, poll failure) must cancel
      // the still-running turn so the session is not left thinking.
      cancelAgent()
      throw error instanceof Error ? error : asError(error)
    }
  }
}

/**
 * Create a run engine.
 *
 */
export function createEngine({
  store: providedStore,
  logger = undefined,
  runNode = undefined,
  resolveService = undefined,
  createUserMessage = undefined,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  nodeTimeoutMs = DEFAULT_NODE_TIMEOUT_MS,
  now = Date.now,
}: EngineOptions = {}) {
  if (providedStore === undefined || providedStore === null) throw new Error('createEngine requires a store')
  const store = providedStore

  const warn = (message: string) => {
    try {
      logger?.warn?.(`loop-manager: ${message}`)
    } catch {
      // ignore logger failures
    }
  }

  const usesRealRunner = typeof runNode !== 'function'
  const nodeRunner: NodeRunner = usesRealRunner
    ? createAgentNodeRunner({ resolveService, createUserMessage, logger, pollIntervalMs })
    : runNode!

  const activeRuns = new Map<string, RunHandle>()

  /**
   * Read one run from the store, tolerating a store without `getRun`.
   */
  function readRun(runId: string): Run | undefined {
    if (typeof store.getRun === 'function') return store.getRun(runId)
    return store.listRuns().find((run) => run.id === runId)
  }

  /**
   * Find the running run of a pipeline (at most one by contract).
   */
  function findRunningRun(pipelineId: string): Run | undefined {
    return store.listRuns().find((run) => run.pipelineId === pipelineId && run.status === 'running')
  }

  /**
   * Record the run in memory and persist it as the pipeline's last run.
   * Failures are logged only: bookkeeping must never break execution.
   */
  function persistRun(handle: Pick<RunHandle, 'run' | 'pipeline'>): void {
    try {
      store.setRun(handle.run)
    } catch (error) {
      warn(`could not record the run: ${messageOf(error)}`)
      return
    }
    try {
      const task = store.saveLastRun(handle.pipeline.id, handle.run)
      if (task !== null && typeof task === 'object' && typeof task.catch === 'function') {
        task.catch((error) => warn(`could not persist the run: ${messageOf(error)}`))
      }
    } catch (error) {
      warn(`could not persist the run: ${messageOf(error)}`)
    }
  }

  /**
   * Capture the deployment's current default model so every node without its
   * own model runs with the same selection for the whole run.
   */
  function currentDefaultModel() {
    return readDefaultModel(resolveService)
  }

  /**
   * Verify the services the default runner depends on are mounted.
   */
  function missingServiceMessage() {
    if (typeof resolveService !== 'function') {
      return 'the session controller service is not mounted in this deployment'
    }
    let sessionController
    let sessions
    try {
      sessionController = resolveService('sessionController')
      sessions = resolveService('sessions')
    } catch {
      sessionController = undefined
      sessions = undefined
    }
    if (sessionController === undefined || sessionController === null) {
      return 'the session controller service is not mounted in this deployment'
    }
    if (sessions === undefined || sessions === null) {
      return 'the session store service is not mounted in this deployment'
    }
    return undefined
  }

  /**
   * Mark every still-pending node as skipped and stamp the run's finish time.
   */
  function settlePendingNodes(run: Run, error?: string): void {
    const finishedAt = now()
    for (const nodeId of run.order) {
      const state = run.nodeStates?.[nodeId]
      if (state === undefined || state.status !== 'pending') continue
      state.status = 'skipped'
      state.finishedAt = finishedAt
      if (error !== undefined) state.error = error
    }
  }

  /**
   * Execute the pipeline's nodes serially. Never rejects: failures are recorded
   * on the run, and the run is always persisted by the finally block.
   */
  async function runLoop(handle: RunHandle): Promise<void> {
    const { run, pipeline } = handle
    const outputs: Record<string, string> = Object.create(null)
    const nodeById = new Map<string, PipelineNode>()
    for (const node of Array.isArray(pipeline.nodes) ? pipeline.nodes : []) {
      if (node !== null && typeof node === 'object' && typeof node.id === 'string') nodeById.set(node.id, node)
    }

    let finishedStatus: RunStatus = 'completed'

    try {
      for (const nodeId of run.order) {
        if (handle.stopRequested) {
          finishedStatus = 'stopped'
          break
        }
        const node = nodeById.get(nodeId)
        const state = run.nodeStates[nodeId]
        if (node === undefined || state === undefined) continue

        const prompt = renderNodePrompt(node, pipeline.nodes, pipeline.edges, outputs)
        state.status = 'running'
        state.startedAt = now()
        persistRun(handle)

        const nodeController = new AbortController()
        let timedOut = false
        const timeoutTimer = setTimeout(() => {
          timedOut = true
          nodeController.abort(new NodeTimeoutError(nodeTimeoutMs))
        }, nodeTimeoutMs)
        timeoutTimer.unref?.()

        const forwardAbort = () => nodeController.abort(abortReason(handle.controller.signal))
        if (handle.controller.signal.aborted) forwardAbort()
        else handle.controller.signal.addEventListener('abort', forwardAbort, { once: true })
        handle.abortNode = (reason) => nodeController.abort(reason)

        let nodeFailed = false
        try {
          const result = await nodeRunner({
            node,
            prompt,
            pipeline,
            signal: nodeController.signal,
            defaultModel: handle.defaultModel,
            onSession: (sessionId) => {
              if (typeof sessionId !== 'string' || sessionId === '') return
              if (state.sessionId === sessionId) return
              state.sessionId = sessionId
              persistRun(handle)
            },
            onProgress: (progress) => {
              if (state.status !== 'running') return
              state.output = truncateOutput(progress?.output)
              state.thinking = truncateThinking(progress?.thinking)
            },
          })
          if (nodeController.signal.aborted) throw abortReason(nodeController.signal)
          const output = typeof result === 'string' ? result : result?.output
          state.output = truncateOutput(output)
          if (
            typeof result === 'object' &&
            result !== null &&
            typeof result.thinking === 'string' &&
            result.thinking !== ''
          ) {
            state.thinking = truncateThinking(result.thinking)
          }
          state.status = 'completed'
          state.finishedAt = now()
          outputs[nodeId] = state.output
        } catch (error) {
          nodeFailed = true
          state.finishedAt = now()
          if (timedOut) {
            state.status = 'failed'
            state.error = `node timed out after ${nodeTimeoutMs} ms`
            finishedStatus = 'failed'
            run.error = `node "${node.title ?? nodeId}" failed: ${state.error}`
          } else if (handle.stopRequested || handle.controller.signal.aborted) {
            state.status = 'skipped'
            state.error = 'the run was stopped'
            finishedStatus = 'stopped'
          } else {
            state.status = 'failed'
            state.error = messageOf(error)
            finishedStatus = 'failed'
            run.error = `node "${node.title ?? nodeId}" failed: ${state.error}`
          }
        } finally {
          clearTimeout(timeoutTimer)
          handle.controller.signal.removeEventListener('abort', forwardAbort)
          handle.abortNode = undefined
          persistRun(handle)
        }
        if (nodeFailed) break
      }
    } catch (error) {
      // Defensive: a runner/store bug must end the run, not leak a rejection.
      finishedStatus = 'failed'
      if (run.error === undefined) run.error = messageOf(error)
      warn(`run "${run.id}" failed unexpectedly: ${messageOf(error)}`)
    } finally {
      run.status = finishedStatus
      run.finishedAt = now()
      settlePendingNodes(run, finishedStatus === 'stopped' ? 'the run was stopped' : undefined)
      persistRun(handle)
    }
  }

  return {
    /**
     * Create a run and start executing the pipeline in the background.
     *
     * Returns immediately with the running run (the API answers 202). A
     * pipeline may only have one running run at a time.
     *
     */
    start(pipeline: Pipeline): EngineRunResult {
      if (pipeline === null || typeof pipeline !== 'object') {
        return { ok: false, code: 'bad-request', message: 'a pipeline is required' }
      }
      const running = findRunningRun(pipeline.id)
      if (running !== undefined) {
        return {
          ok: false,
          code: 'run-in-progress',
          message: `pipeline "${pipeline.name ?? pipeline.id}" already has a running run`,
        }
      }

      const topology = topologicalOrder(pipeline.nodes, pipeline.edges)
      if (!topology.ok) return { ok: false, code: topology.code, message: topology.message }

      const nodeStates: Record<string, NodeState> = {}
      for (const node of Array.isArray(pipeline.nodes) ? pipeline.nodes : []) {
        if (node !== null && typeof node === 'object' && typeof node.id === 'string')
          nodeStates[node.id] = { status: 'pending' }
      }
      const run: Run = {
        id: randomUUID(),
        pipelineId: pipeline.id,
        pipelineName: typeof pipeline.name === 'string' ? pipeline.name : '',
        status: 'running',
        startedAt: now(),
        order: topology.order,
        nodeStates,
      }

      if (usesRealRunner) {
        const missing = missingServiceMessage()
        if (missing !== undefined) {
          run.status = 'failed'
          run.error = missing
          run.finishedAt = now()
          for (const nodeId of run.order)
            run.nodeStates[nodeId] = { status: 'skipped', finishedAt: run.finishedAt, error: missing }
          const failedHandle = { run, pipeline }
          persistRun(failedHandle)
          return { ok: false, code: 'internal', message: missing, run }
        }
      }

      const handle: RunHandle = {
        run,
        pipeline,
        defaultModel: currentDefaultModel(),
        controller: new AbortController(),
        stopRequested: false,
        abortNode: undefined,
        done: Promise.resolve(),
      }
      persistRun(handle)
      activeRuns.set(run.id, handle)
      handle.done = runLoop(handle)
        .catch((error) => {
          warn(`run "${run.id}" error: ${messageOf(error)}`)
        })
        .finally(() => {
          activeRuns.delete(run.id)
        })
      return { ok: true, run }
    },

    /**
     * Stop one run: cancel the active agent turn, mark the current node and all
     * remaining nodes skipped, and resolve once the run reached its final state.
     *
     * Stopping an already-finished run is a no-op returning that run.
     *
     */
    async stop(runId: string): Promise<EngineRunResult> {
      const run = readRun(runId)
      if (run === undefined) return { ok: false, code: 'run-not-found', message: `run "${runId}" not found` }
      if (run.status !== 'running') return { ok: true, run }

      const handle = activeRuns.get(runId)
      if (handle === undefined) {
        // A run restored from a crashed host has no owner: settle it directly.
        run.status = 'stopped'
        run.finishedAt = now()
        run.error = run.error ?? 'the run was stopped'
        settlePendingNodes(run, 'the run was stopped')
        try {
          store.setRun(run)
        } catch (error) {
          warn(`could not record the stopped run: ${messageOf(error)}`)
        }
        try {
          await store.saveLastRun(run.pipelineId, run)
        } catch (error) {
          warn(`could not persist the stopped run: ${messageOf(error)}`)
        }
        return { ok: true, run }
      }

      handle.stopRequested = true
      handle.controller.abort(new RunStoppedError('the run was stopped'))
      if (typeof handle.abortNode === 'function') handle.abortNode(new RunStoppedError('the run was stopped'))
      await handle.done
      return { ok: true, run }
    },

    /**
     * Delete one finished run from the in-memory table (and from disk when it
     * was the pipeline's persisted last run).
     */
    async deleteRun(runId: string): Promise<DeleteRunResult> {
      const run = readRun(runId)
      if (run === undefined) return { ok: false, code: 'run-not-found', message: `run "${runId}" not found` }
      if (run.status === 'running') {
        return { ok: false, code: 'run-in-progress', message: 'stop the run before deleting it' }
      }
      const removed = await store.removeRun(runId)
      if (!removed) return { ok: false, code: 'run-not-found', message: `run "${runId}" not found` }
      return { ok: true }
    },

    /**
     * List runs (newest first) from the store.
     */
    listRuns() {
      return store.listRuns()
    },

    /**
     * Stop every active run and wait for their final state to be persisted.
     * Called by the plugin's effect disposer so plugin unload leaves no agent
     * turns running.
     */
    async dispose() {
      const handles = [...activeRuns.values()]
      for (const handle of handles) {
        handle.stopRequested = true
        handle.controller.abort(new RunStoppedError('the plugin was unloaded'))
        if (typeof handle.abortNode === 'function') handle.abortNode(new RunStoppedError('the plugin was unloaded'))
      }
      await Promise.allSettled(handles.map((handle) => handle.done))
    },
  }
}
