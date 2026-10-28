/**
 * Loop orchestration for dsh-loop-manager (CONTRACT.md §13.3 / §13.5).
 *
 * A Loop is a list of `pipeline + gate` pairs executed in order. Each pipeline
 * is a normal pipeline run started through {@link createEngine}, whose progress
 * is polled from the store until it settles; each gate is one real agent/skill
 * turn executed through the injected `runGate` runner. The state machine lives
 * on the {@link LoopRun} record (`stepStates`), so `/api/state` polling shows
 * everything the browser needs.
 *
 * ```js
 * const loopEngine = createLoopEngine({ store, engine, runGate })
 * loopEngine.start(loop)             // -> { ok: true, run }
 * await loopEngine.retry(run.id)      // -> resume an awaiting run
 * ```
 *
 * The gate runner is injectable so unit tests never touch a real agent; the
 * plugin entry builds the default one from `createAgentNodeRunner` with a
 * synthetic gate node and `pipeline = {}` (the gate session uses the host's
 * default working directory).
 */
import { randomUUID } from 'node:crypto'
import type { Loop, LoopGate, LoopRun, LoopStep, LoopStepState, Pipeline, PipelineNode, Run } from './types.js'
import type { Logger, ModelSelection, ResolveService } from './host-types.js'
import type { DeleteRunResult, EngineRunResult, NodeRunner } from './engine.js'

export interface LoopEngineStore {
  listPipelines(): Pipeline[]
  getPipeline?: (pipelineId: string) => Pipeline | undefined
  getRun?: (runId: string) => Run | undefined
  listLoopRuns(): LoopRun[]
  getLoopRun(runId: string): LoopRun | undefined
  getLoop(loopId: string): Loop | undefined
  setLoopRun(run: LoopRun): unknown
  saveLoopRun(loopId: string, run: LoopRun): void | Promise<unknown>
  removeLoopRun(runId: string): Promise<boolean>
}
export interface PipelineEngine {
  start(pipeline: Pipeline): EngineRunResult
  stop?: (runId: string) => Promise<EngineRunResult>
}
export interface LoopEngineOptions {
  store?: LoopEngineStore
  engine?: PipelineEngine
  runGate?: NodeRunner
  resolveService?: ResolveService
  logger?: Logger
  now?: () => number
  pollIntervalMs?: number
  gateTimeoutMs?: number
}
export type LoopEngineRunResult =
  { ok: true; run: LoopRun } | { ok: false; code: string; message: string; run?: LoopRun }
interface LoopHandle {
  run: LoopRun
  loop: Loop
  controller: AbortController
  stopRequested: boolean
  abortGate?: (reason: Error) => void
  currentPipelineRunId?: string
  currentStepIndex: number
  defaultModel?: ModelSelection
  done: Promise<void>
}

import {
  DEFAULT_NODE_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_THINKING_CHARS,
  RunStoppedError,
  readDefaultModel,
} from './engine.js'
import {
  MAX_GATE_OUTPUT_CHARS,
  aggregatePipelineOutput,
  parseGateDecision,
  renderGatePrompt,
  validateLoop,
} from './loop.js'

/** Message used when a gate has no usable TRUE/FALSE verdict (CONTRACT.md §13.2). */
const UNKNOWN_GATE_ERROR = '门禁没有给出 TRUE/FALSE 结论'

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
 * Read an abort reason as an Error.
 */
function abortReason(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new RunStoppedError('the loop run was stopped')
}

/**
 * Abort-aware sleep: resolves when the delay elapsed or the signal fired.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Truncate the aggregated pipeline output handed to the gate.
 */
function truncateGateOutput(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return text.length > MAX_GATE_OUTPUT_CHARS ? text.slice(0, MAX_GATE_OUTPUT_CHARS) : text
}

/**
 * Truncate the folded gate thinking process (same cap as node thinking).
 */
function truncateThinking(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return text.length > MAX_THINKING_CHARS ? text.slice(0, MAX_THINKING_CHARS) : text
}

/**
 * Create the loop engine.
 *
 */
export function createLoopEngine({
  store: providedStore,
  engine: providedEngine,
  runGate = undefined,
  resolveService = undefined,
  logger = undefined,
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  gateTimeoutMs = DEFAULT_NODE_TIMEOUT_MS,
}: LoopEngineOptions = {}) {
  if (providedStore === undefined || providedStore === null) throw new Error('createLoopEngine requires a store')
  if (providedEngine === undefined || providedEngine === null) throw new Error('createLoopEngine requires a run engine')
  const store = providedStore
  const engine = providedEngine

  const warn = (message: string) => {
    try {
      logger?.warn?.(`loop-manager: ${message}`)
    } catch {
      // ignore logger failures
    }
  }

  const gateRunner: NodeRunner =
    typeof runGate === 'function'
      ? runGate
      : async () => {
          throw new Error('the gate runner is not available in this deployment')
        }

  const activeRuns = new Map<string, LoopHandle>()

  /**
   * Verify the services the real gate runner depends on are mounted.
   */
  function missingServiceMessage() {
    if (typeof resolveService !== 'function') return undefined
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
   * Known pipeline ids for loop validation.
   */
  function currentPipelineIds() {
    const ids = new Set<string>()
    for (const pipeline of store.listPipelines()) {
      if (pipeline !== null && typeof pipeline === 'object' && typeof pipeline.id === 'string' && pipeline.id !== '') {
        ids.add(pipeline.id)
      }
    }
    return ids
  }

  /**
   * Find the running loop run of one loop (at most one by contract).
   */
  function findRunningLoopRun(loopId: string): LoopRun | undefined {
    return store.listLoopRuns().find((run) => run.loopId === loopId && run.status === 'running')
  }

  /**
   * Record one loop run in memory (and optionally on disk).
   * Failures are logged only: bookkeeping must never break execution.
   */
  function persistRun(run: LoopRun, disk: boolean): void {
    try {
      store.setLoopRun(run)
    } catch (error) {
      warn(`could not record the loop run: ${messageOf(error)}`)
      return
    }
    if (!disk) return
    try {
      const task = store.saveLoopRun(run.loopId, run)
      if (task !== null && typeof task === 'object' && typeof task.catch === 'function') {
        task.catch((error) => warn(`could not persist the loop run: ${messageOf(error)}`))
      }
    } catch (error) {
      warn(`could not persist the loop run: ${messageOf(error)}`)
    }
  }

  /**
   * Mark the current and every later unfinished step as skipped.
   */
  function settleSkipped(run: LoopRun, fromIndex: number): void {
    const order = Array.isArray(run.order) ? run.order : []
    const stateMap = run.stepStates !== null && typeof run.stepStates === 'object' ? run.stepStates : {}
    const finishedAt = now()
    for (let index = fromIndex; index < order.length; index += 1) {
      const state = stateMap[order[index]]
      if (state === undefined || state === null || typeof state !== 'object') continue
      if (state.status === 'completed') continue
      state.status = 'skipped'
      if (state.gateStatus !== 'passed') state.gateStatus = 'skipped'
      state.finishedAt = finishedAt
    }
  }

  /**
   * Stop the pipeline run currently owned by one loop handle.
   */
  async function stopPipelineRun(pipelineRunId?: string): Promise<void> {
    if (typeof pipelineRunId !== 'string' || pipelineRunId === '') return
    if (typeof engine.stop !== 'function') return
    try {
      await engine.stop(pipelineRunId)
    } catch (error) {
      warn(`could not stop pipeline run "${pipelineRunId}": ${messageOf(error)}`)
    }
  }

  /**
   * Poll an ordinary run until it left the `running` state.
   */
  async function waitForPipeline(handle: LoopHandle, pipelineRunId?: string): Promise<Run | undefined> {
    if (typeof pipelineRunId !== 'string' || pipelineRunId === '') return undefined
    while (true) {
      if (handle.stopRequested) return undefined
      const run = typeof store.getRun === 'function' ? store.getRun(pipelineRunId) : undefined
      if (run === undefined || run.status !== 'running') return run
      await sleep(pollIntervalMs, handle.controller.signal)
    }
  }

  /**
   * Run one gate turn and translate its output into a decision.
   *
   * Returns `'TRUE'` / `'FALSE'` on a successful decision, or `'awaiting'` /
   * `'stopped'` when the step should settle instead of continuing.
   *
   */
  async function runGateTurn(
    handle: LoopHandle,
    step: LoopStep,
    state: LoopStepState,
    pipeline: Pipeline,
    pipelineRun: Run,
    index: number,
  ): Promise<'TRUE' | 'FALSE' | 'awaiting' | 'stopped'> {
    const gate: Partial<LoopGate> = step.gate !== null && typeof step.gate === 'object' ? step.gate : {}
    state.gateStatus = 'running'
    if (typeof state.startedAt !== 'number') state.startedAt = now()
    persistRun(handle.run, false)

    const gateId = typeof gate.id === 'string' && gate.id.trim() !== '' ? gate.id.trim() : `${step.id}-gate`
    const gateName = typeof gate.name === 'string' && gate.name.trim() !== '' ? gate.name.trim() : '门禁'
    const gateType = gate.type === 'skill' ? 'skill' : 'agent'
    const node: PipelineNode = {
      id: gateId,
      name: gateName,
      type: gateType,
      ...(gateType === 'skill' ? { skill: typeof gate.skill === 'string' ? gate.skill : '' } : {}),
      ...(gate.model !== null && typeof gate.model === 'object' ? { model: gate.model } : {}),
    }
    const prompt = renderGatePrompt({
      gate: { ...gate, id: gateId, name: gateName, type: gateType },
      pipeline,
      pipelineRun,
      pipelineOutput: state.pipelineOutput,
      stepIndex: index,
      iteration: state.iteration,
    })

    const gateController = new AbortController()
    handle.abortGate = (reason) => gateController.abort(reason)
    const forwardAbort = () => gateController.abort(abortReason(handle.controller.signal))
    if (handle.controller.signal.aborted) forwardAbort()
    else handle.controller.signal.addEventListener('abort', forwardAbort, { once: true })

    let timedOut = false
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      gateController.abort(new Error(`门禁节点执行超时（${gateTimeoutMs} ms）`))
    }, gateTimeoutMs)
    timeoutTimer.unref?.()

    try {
      const result = await gateRunner({
        node,
        prompt,
        pipeline: {},
        signal: gateController.signal,
        defaultModel: handle.defaultModel,
        onSession: (sessionId) => {
          if (typeof sessionId !== 'string' || sessionId === '') return
          if (state.gateSessionId === sessionId) return
          state.gateSessionId = sessionId
          persistRun(handle.run, false)
        },
        onProgress: (progress) => {
          if (state.gateStatus !== 'running') return
          state.gateOutput = truncateGateOutput(progress?.output)
          state.gateThinking = truncateThinking(progress?.thinking)
        },
      })
      if (gateController.signal.aborted) throw abortReason(gateController.signal)
      const output = typeof result === 'string' ? result : result?.output
      state.gateOutput = truncateGateOutput(output)
      const thinking = typeof result === 'object' && result !== null ? result.thinking : undefined
      if (typeof thinking === 'string' && thinking !== '') state.gateThinking = truncateThinking(thinking)
      // A runner may report its session only through its return value (the real
      // agent runner also calls onSession; accepting both keeps alternative
      // runners working without losing the session link, CONTRACT.md §13.5).
      const resultSession = typeof result === 'object' && result !== null ? result.sessionId : undefined
      if (state.gateSessionId === undefined && typeof resultSession === 'string' && resultSession !== '') {
        state.gateSessionId = resultSession
      }

      const decision = parseGateDecision(state.gateOutput)
      if (decision === 'UNKNOWN') {
        state.decision = 'UNKNOWN'
        state.gateStatus = 'failed'
        state.gateError = UNKNOWN_GATE_ERROR
        state.status = 'awaiting'
        state.finishedAt = now()
        return 'awaiting'
      }
      return decision
    } catch (error) {
      if (handle.stopRequested) return 'stopped'
      state.gateStatus = 'failed'
      state.gateError = timedOut ? `门禁节点执行超时（${gateTimeoutMs} ms）` : messageOf(error)
      state.status = 'awaiting'
      state.finishedAt = now()
      return 'awaiting'
    } finally {
      clearTimeout(timeoutTimer)
      handle.controller.signal.removeEventListener('abort', forwardAbort)
      handle.abortGate = undefined
    }
  }

  /**
   * Execute one loop step: pipeline first, then its gate; repeats the pair when
   * the gate says FALSE and automatic looping has budget left.
   *
   */
  async function runStep(handle: LoopHandle, index: number): Promise<'completed' | 'awaiting' | 'stopped'> {
    const { run, loop } = handle
    const step = loop.steps[index]
    const state = run.stepStates[step.id]
    const gate: Partial<LoopGate> = step.gate !== null && typeof step.gate === 'object' ? step.gate : {}
    const maxIterations = Number.isInteger(gate.maxIterations) ? gate.maxIterations! : 3

    while (true) {
      if (handle.stopRequested) return 'stopped'

      // 1. Start one attempt of this group's pipeline run.
      state.iteration = (Number.isInteger(state.iteration) ? state.iteration : 0) + 1
      state.status = 'running'
      state.gateStatus = 'pending'
      if (typeof state.startedAt !== 'number') state.startedAt = now()
      delete state.error
      delete state.gateError
      delete state.decision
      delete state.gateOutput
      delete state.gateThinking
      delete state.gateSessionId
      delete state.pipelineOutput
      delete state.finishedAt
      persistRun(run, false)

      const pipeline = typeof store.getPipeline === 'function' ? store.getPipeline(step.pipelineId) : undefined
      if (pipeline === undefined) {
        state.status = 'failed'
        state.gateStatus = 'awaiting'
        state.error = `第 ${index + 1} 组引用的 Pipeline 不存在`
        state.finishedAt = now()
        return 'awaiting'
      }

      const started = engine.start(pipeline)
      if (started === null || typeof started !== 'object' || started.ok !== true) {
        state.status = 'failed'
        state.gateStatus = 'awaiting'
        state.error =
          typeof started?.message === 'string' && started.message !== ''
            ? started.message
            : '该 Agent Pipeline 无法开始运行'
        const refusedRun = started?.run
        if (refusedRun !== null && typeof refusedRun === 'object' && typeof refusedRun.id === 'string') {
          state.pipelineRunId = refusedRun.id
          state.pipelineStatus = refusedRun.status === 'completed' ? 'completed' : 'failed'
        }
        state.finishedAt = now()
        return 'awaiting'
      }

      const pipelineRun = started.run
      if (pipelineRun !== null && typeof pipelineRun === 'object' && typeof pipelineRun.id === 'string') {
        state.pipelineRunId = pipelineRun.id
        state.pipelineStatus = 'running'
        handle.currentPipelineRunId = pipelineRun.id
      }
      persistRun(run, false)

      const finished = await waitForPipeline(handle, state.pipelineRunId)
      handle.currentPipelineRunId = undefined
      if (handle.stopRequested) return 'stopped'

      if (finished === undefined) {
        state.pipelineStatus = 'failed'
        state.status = 'failed'
        state.gateStatus = 'awaiting'
        state.error = 'Agent Pipeline 的运行记录丢失'
        state.finishedAt = now()
        return 'awaiting'
      }
      state.pipelineStatus =
        finished.status === 'completed' ? 'completed' : finished.status === 'stopped' ? 'stopped' : 'failed'
      if (finished.status !== 'completed') {
        state.status = 'failed'
        state.gateStatus = 'awaiting'
        state.error =
          typeof finished.error === 'string' && finished.error !== ''
            ? finished.error
            : `Agent Pipeline「${pipeline.name ?? pipeline.id}」运行未完成（${finished.status}）`
        state.finishedAt = now()
        return 'awaiting'
      }

      // 2. Judge the aggregated output with the gate turn.
      state.pipelineOutput = aggregatePipelineOutput(pipeline, finished)
      persistRun(run, false)
      const outcome = await runGateTurn(handle, step, state, pipeline, finished, index)
      if (outcome === 'stopped') return 'stopped'
      if (outcome === 'awaiting') return 'awaiting'
      if (outcome === 'TRUE') {
        state.gateStatus = 'passed'
        state.decision = 'TRUE'
        state.status = 'completed'
        state.finishedAt = now()
        persistRun(run, true)
        return 'completed'
      }

      // 3. FALSE: automatic looping while the iteration budget lasts, else wait
      //    for the manual "↻ 重新循环" retry.
      state.decision = 'FALSE'
      if (gate.autoLoop === true && state.iteration < maxIterations) {
        state.gateStatus = 'pending'
        persistRun(run, true)
        continue
      }
      state.gateStatus = 'awaiting'
      state.status = 'awaiting'
      if (gate.autoLoop === true) state.gateError = `自动循环已达上限 ${maxIterations} 次`
      state.finishedAt = now()
      return 'awaiting'
    }
  }

  /**
   * Mark a run stopped after its executor stopped.
   */
  function finalizeStop(handle: LoopHandle): void {
    settleSkipped(handle.run, handle.currentStepIndex)
    handle.run.status = 'stopped'
    handle.run.finishedAt = now()
    persistRun(handle.run, true)
  }

  /**
   * Mark a run awaiting a manual retry after its executor paused.
   */
  function finalizeAwaiting(handle: LoopHandle): void {
    delete handle.run.finishedAt
    handle.run.status = 'awaiting'
    persistRun(handle.run, true)
  }

  /**
   * Drive one loop run from `startIndex` until it completes, awaits or stops.
   * Never rejects: unexpected failures settle the run as failed.
   */
  async function execute(handle: LoopHandle, startIndex: number): Promise<void> {
    const { run, loop } = handle
    const steps = Array.isArray(loop.steps) ? loop.steps : []
    try {
      for (let index = startIndex; index < steps.length; index += 1) {
        if (handle.stopRequested) {
          finalizeStop(handle)
          return
        }
        handle.currentStepIndex = index
        const outcome = await runStep(handle, index)
        if (outcome === 'stopped') {
          finalizeStop(handle)
          return
        }
        if (outcome === 'awaiting') {
          finalizeAwaiting(handle)
          return
        }
      }
      run.status = 'completed'
      run.finishedAt = now()
      persistRun(run, true)
    } catch (error) {
      // Defensive: a runner/store bug must end the run, not leak a rejection.
      warn(`loop run "${run.id}" failed unexpectedly: ${messageOf(error)}`)
      settleSkipped(run, handle.currentStepIndex)
      run.status = 'failed'
      run.error = messageOf(error)
      run.finishedAt = now()
      persistRun(run, true)
    } finally {
      activeRuns.delete(run.id)
    }
  }

  /**
   * Build the background handle for one loop run and start executing it.
   */
  function launch(run: LoopRun, loop: Loop, startIndex: number): void {
    const handle: LoopHandle = {
      run,
      loop,
      controller: new AbortController(),
      stopRequested: false,
      abortGate: undefined,
      currentPipelineRunId: undefined,
      currentStepIndex: startIndex,
      defaultModel: readDefaultModel(resolveService),
      done: Promise.resolve(),
    }
    activeRuns.set(run.id, handle)
    handle.done = execute(handle, startIndex)
      .catch((error) => {
        warn(`loop run "${run.id}" error: ${messageOf(error)}`)
      })
      .finally(() => {
        activeRuns.delete(run.id)
      })
  }

  return {
    /**
     * Validate one loop, create its LoopRun and execute it in the background.
     *
     * A loop may only have one running LoopRun at a time. A refused start never
     * leaves a run behind, except for a deployment whose session services are
     * missing: that run is recorded as `failed` so the reason is visible.
     *
     */
    start(loop: Loop): LoopEngineRunResult {
      if (loop === null || typeof loop !== 'object' || Array.isArray(loop)) {
        return { ok: false, code: 'bad-request', message: 'a loop is required' }
      }
      const validation = validateLoop(loop, { pipelineIds: currentPipelineIds() })
      if (!validation.ok) return validation
      if (typeof loop.id !== 'string' || loop.id.trim() === '') {
        return { ok: false, code: 'invalid-loop', message: 'Loop 缺少 id' }
      }

      const running = findRunningLoopRun(loop.id)
      if (running !== undefined) {
        return {
          ok: false,
          code: 'run-in-progress',
          message: `loop "${loop.name ?? loop.id}" already has a running run`,
        }
      }

      const steps = loop.steps
      const run: LoopRun = {
        id: randomUUID(),
        loopId: loop.id,
        loopName: typeof loop.name === 'string' ? loop.name : '',
        status: 'running',
        startedAt: now(),
        order: steps.map((step) => step.id),
        stepStates: {},
      }
      const stepStates: Record<string, LoopStepState> = {}
      for (const step of steps) {
        stepStates[step.id] = { status: 'pending', iteration: 0, gateStatus: 'pending' }
      }
      run.stepStates = stepStates

      const missing = missingServiceMessage()
      if (missing !== undefined) {
        run.status = 'failed'
        run.error = missing
        run.finishedAt = now()
        for (const step of steps) {
          run.stepStates[step.id] = {
            status: 'skipped',
            iteration: 0,
            gateStatus: 'skipped',
            error: missing,
            finishedAt: run.finishedAt,
          }
        }
        persistRun(run, true)
        return { ok: false, code: 'internal', message: missing, run }
      }

      persistRun(run, true)
      launch(run, loop, 0)
      return { ok: true, run }
    },

    /**
     * Stop one LoopRun: cancel the current gate turn, stop the current pipeline
     * run, mark the current and later steps skipped, and settle as `stopped`.
     * Stopping a finished run is a no-op returning that run.
     *
     */
    async stop(runId: string): Promise<LoopEngineRunResult> {
      const run = store.getLoopRun(runId)
      if (run === undefined) return { ok: false, code: 'loop-run-not-found', message: `loop run "${runId}" not found` }
      if (run.status !== 'running' && run.status !== 'awaiting') return { ok: true, run }

      const handle = activeRuns.get(runId)
      if (handle === undefined) {
        // An awaiting run has no executor to cancel: settle it directly.
        settleSkipped(run, 0)
        run.status = 'stopped'
        run.finishedAt = now()
        persistRun(run, true)
        return { ok: true, run }
      }

      handle.stopRequested = true
      handle.controller.abort(new RunStoppedError('the loop run was stopped'))
      if (typeof handle.abortGate === 'function') handle.abortGate(new RunStoppedError('the loop run was stopped'))
      await stopPipelineRun(handle.currentPipelineRunId)
      await handle.done
      // A run that settled as awaiting just before the stop request still owes
      // the user the stopped state.
      if (run.status === 'running' || run.status === 'awaiting') {
        settleSkipped(run, handle.currentStepIndex)
        run.status = 'stopped'
        run.finishedAt = now()
        persistRun(run, true)
      }
      return { ok: true, run }
    },

    /**
     * Resume an awaiting/failed LoopRun from one step (default: the first
     * awaiting/failed step). Manual retries are not limited by `maxIterations`;
     * `iteration` keeps counting for display.
     *
     */
    async retry(runId: string, stepId: string | undefined = undefined): Promise<LoopEngineRunResult> {
      const run = store.getLoopRun(runId)
      if (run === undefined) return { ok: false, code: 'loop-run-not-found', message: `loop run "${runId}" not found` }
      if (run.status !== 'awaiting' && run.status !== 'failed') {
        return { ok: false, code: 'not-awaiting', message: 'this loop run is not waiting for a manual retry' }
      }
      if (activeRuns.has(run.id)) {
        return { ok: false, code: 'not-awaiting', message: 'this loop run is still executing' }
      }

      const order = Array.isArray(run.order) ? run.order : []
      const stateMap = run.stepStates !== null && typeof run.stepStates === 'object' ? run.stepStates : {}
      let targetIndex
      if (typeof stepId === 'string' && stepId !== '') {
        targetIndex = order.indexOf(stepId)
        if (targetIndex < 0) return { ok: false, code: 'step-not-found', message: `step "${stepId}" not found` }
      } else {
        targetIndex = order.findIndex((id) => {
          const state = stateMap[id]
          return state !== undefined && state !== null && (state.status === 'awaiting' || state.status === 'failed')
        })
        if (targetIndex < 0) targetIndex = order.findIndex((id) => stateMap[id]?.status !== 'completed')
      }
      if (targetIndex < 0) {
        return { ok: false, code: 'not-awaiting', message: 'this loop run has nothing left to retry' }
      }

      const loop = store.getLoop(run.loopId)
      if (loop === undefined) return { ok: false, code: 'loop-not-found', message: `loop "${run.loopId}" not found` }
      const validation = validateLoop(loop, { pipelineIds: currentPipelineIds() })
      if (!validation.ok) return validation

      // Reset the target step and every later one; the target keeps its
      // iteration counter so the UI can show "第 N 次执行".
      for (let index = targetIndex; index < order.length; index += 1) {
        const id = order[index]
        const previous = stateMap[id]
        const iteration = index === targetIndex && Number.isInteger(previous?.iteration) ? previous.iteration : 0
        stateMap[id] = { status: 'pending', iteration, gateStatus: 'pending' }
      }
      run.stepStates = stateMap
      run.status = 'running'
      delete run.finishedAt
      delete run.error
      persistRun(run, true)
      launch(run, loop, targetIndex)
      return { ok: true, run }
    },

    /**
     * Delete one finished loop run. Running loop runs must be stopped first.
     */
    async deleteRun(runId: string): Promise<DeleteRunResult> {
      const run = store.getLoopRun(runId)
      if (run === undefined) return { ok: false, code: 'loop-run-not-found', message: `loop run "${runId}" not found` }
      if (run.status === 'running' || activeRuns.has(runId)) {
        return { ok: false, code: 'run-in-progress', message: 'stop the loop run before deleting it' }
      }
      const removed = await store.removeLoopRun(runId)
      if (!removed) return { ok: false, code: 'loop-run-not-found', message: `loop run "${runId}" not found` }
      return { ok: true }
    },

    /**
     * List loop runs (newest first) from the store.
     */
    listRuns() {
      return store.listLoopRuns()
    },

    /**
     * Stop every active or awaiting LoopRun. Called by the plugin's effect
     * disposer so plugin unload leaves no agent turn or pipeline run running.
     */
    async dispose() {
      const handles = [...activeRuns.values()]
      for (const handle of handles) {
        handle.stopRequested = true
        handle.controller.abort(new RunStoppedError('the plugin was unloaded'))
        if (typeof handle.abortGate === 'function') handle.abortGate(new RunStoppedError('the plugin was unloaded'))
        await stopPipelineRun(handle.currentPipelineRunId)
      }
      await Promise.allSettled(handles.map((handle) => handle.done))
      // Idle awaiting runs have no background executor left to notice the
      // unload; settle them too so nothing is left half-open on disk.
      for (const run of store.listLoopRuns()) {
        if (run.status !== 'running' && run.status !== 'awaiting') continue
        if (activeRuns.has(run.id)) continue
        settleSkipped(run, 0)
        run.status = 'stopped'
        run.finishedAt = now()
        persistRun(run, true)
      }
    },
  }
}
