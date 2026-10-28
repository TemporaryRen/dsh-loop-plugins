/**
 * JSON persistence for dsh-loop-manager.
 *
 * State lives in `<DSH_HOME or ~/.dsh>/loop-manager/state.json`:
 *
 * ```json
 * { "version": 1, "pipelines": [Pipeline...], "lastRuns": { "<pipelineId>": Run },
 *   "loops": [Loop...], "loopRuns": [LoopRun...], "lastLoopRuns": { "<loopId>": LoopRun } }
 * ```
 *
 * Pipelines and the latest run per pipeline are durable. Older runs are
 * memory-only, capped at {@link MAX_FINISHED_RUNS_PER_PIPELINE} per pipeline.
 * Loop records are durable; loop runs follow the same rule with a cap of
 * {@link MAX_FINISHED_LOOP_RUNS_PER_LOOP} finished runs per loop. A state file
 * written before v9 has no loop fields and simply loads them as empty.
 *
 * Writes are atomic (temp file + rename) and serialized through one promise
 * chain, so concurrent HTTP mutations can never interleave two partial files.
 */
import type { Pipeline, Run, Loop, LoopRun, LoopGate, LoopStep, Logger, StoreMirror, StateSnapshot } from './types.js'

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** On-disk format version written into every state file. */
export const STATE_VERSION = 1

/** How many finished runs are kept in memory per pipeline. */
export const MAX_FINISHED_RUNS_PER_PIPELINE = 5

/** How many finished loop runs are kept in memory per loop. */
export const MAX_FINISHED_LOOP_RUNS_PER_LOOP = 5

/** How many run rows `listRuns()` hands out (the 运行记录 view). */
export const MAX_RUN_HISTORY = 50

/** How many loop run rows `listLoopRuns()` hands out. */
export const MAX_LOOP_RUN_HISTORY = 50

/**
 * Format a log line, folding an optional error into a single string so any
 * logger implementation (cordis' logger included) can print it.
 */
function formatLog(message: string, error?: unknown): string {
  if (error === undefined) return `loop-manager: ${message}`
  const detail = error instanceof Error ? error.message : String(error)
  return `loop-manager: ${message}: ${detail}`
}

/**
 * Create the plugin store. Call {@link Store.load} once before serving reads.
 *
 * All methods are backed by in-memory maps; the mutating methods persist the
 * whole state atomically. `file` may be omitted for tests: writes become no-ops
 * while the in-memory table keeps working.
 *
 */
export function createStore({
  file = undefined,
  logger = undefined,
  mirror = undefined,
}: { file?: string; logger?: Logger; mirror?: StoreMirror } = {}) {
  const pipelines: Map<string, Pipeline> = new Map()
  const runs: Map<string, Run> = new Map()
  const lastRuns: Map<string, Run> = new Map()
  const loops: Map<string, Loop> = new Map()
  const loopRuns: Map<string, LoopRun> = new Map()
  const lastLoopRuns: Map<string, LoopRun> = new Map()

  /** Serialized write chain: every persist waits for the previous one. */
  let writeChain = Promise.resolve()

  /**
   * Forward one mutation to the optional PostgreSQL mirror. Mirror failures are
   * recorded by the database manager and must never affect local persistence.
   */
  function mirrorCall<K extends keyof StoreMirror>(method: K, ...args: Parameters<NonNullable<StoreMirror[K]>>): void {
    if (mirror === null || typeof mirror !== 'object') return
    const handler = mirror[method]
    if (typeof handler !== 'function') return
    try {
      const task = (handler as (...values: Parameters<NonNullable<StoreMirror[K]>>) => unknown)(...args)
      if (task !== null && typeof task === 'object' && typeof (task as { catch?: unknown }).catch === 'function') {
        ;(task as { catch(handler: (error: unknown) => void): unknown }).catch((error: unknown) =>
          warn(`PostgreSQL mirror ${method} failed`, error),
        )
      }
    } catch (error) {
      warn(`PostgreSQL mirror ${method} failed`, error)
    }
  }

  /**
   * Log without ever letting the logger break persistence.
   */
  function warn(message: string, error?: unknown) {
    try {
      logger?.warn?.(formatLog(message, error))
    } catch {
      // A broken logger must not break the store.
    }
  }

  /**
   * Validate a run loaded from disk. Runs written by older/failed processes
   * may still say `running`; nobody owns them after a restart, so they are
   * demoted to `failed` instead of blocking the pipeline forever.
   */
  function normalizeLoadedRun(candidate: unknown): Run | undefined {
    if (candidate === null || typeof candidate !== 'object') return undefined
    const run = candidate as Run
    if (typeof run.id !== 'string' || run.id === '') return undefined
    if (typeof run.pipelineId !== 'string' || run.pipelineId === '') return undefined
    if (!Array.isArray(run.order)) return undefined
    if (run.nodeStates === null || typeof run.nodeStates !== 'object') run.nodeStates = {}
    if (run.status === 'running') {
      run.status = 'failed'
      run.error = 'the host restarted before this run finished'
      if (typeof run.finishedAt !== 'number') run.finishedAt = Date.now()
      warn(`run "${run.id}" was still marked running on load; marked it failed`)
    }
    return run
  }

  /**
   * Validate a pipeline loaded from disk.
   */
  function normalizeLoadedPipeline(candidate: unknown): Pipeline | undefined {
    if (candidate === null || typeof candidate !== 'object') return undefined
    const pipeline = candidate as Pipeline
    if (typeof pipeline.id !== 'string' || pipeline.id === '') return undefined
    if (typeof pipeline.name !== 'string') return undefined
    if (!Array.isArray(pipeline.nodes)) return undefined
    if (!Array.isArray(pipeline.edges)) return undefined

    // v1 -> v2 field migration (CONTRACT.md §9.2).
    if (pipeline.desc === undefined && typeof pipeline.description === 'string') pipeline.desc = pipeline.description
    delete pipeline.description
    if (typeof pipeline.icon !== 'string' || pipeline.icon === '') pipeline.icon = '◈'
    if (typeof pipeline.color !== 'string') pipeline.color = ''
    if (typeof pipeline.star !== 'boolean') pipeline.star = false
    for (const node of pipeline.nodes) {
      if (node === null || typeof node !== 'object') continue
      if (typeof node.name !== 'string' && typeof node.title === 'string') node.name = node.title
      delete node.title
      if (typeof node.command !== 'string' && typeof node.prompt === 'string') node.command = node.prompt
      delete node.prompt
      if (typeof node.name !== 'string') node.name = ''
      if (typeof node.command !== 'string') node.command = ''
      if (node.type !== 'skill') node.type = 'agent'
      if (node.type === 'skill') {
        if (typeof node.skill !== 'string') node.skill = ''
      } else {
        delete node.skill
      }
      // v2 declared Skills/MCP on the node; the model is now "the command text
      // is the whole instruction", so fold a legacy declaration into it once
      // instead of dropping information the author wrote.
      const legacySkills = typeof node.skills === 'string' ? node.skills.trim() : ''
      const legacyMcp = typeof node.mcp === 'string' ? node.mcp.trim() : ''
      if (legacySkills !== '') node.command += `\n\n（可用 Skills：${legacySkills}）`
      if (legacyMcp !== '') node.command += `\n\n（可用 MCP 工具：${legacyMcp}）`
      delete node.skills
      delete node.mcp
    }
    return pipeline
  }

  /**
   * Fill the documented defaults of one loaded gate node (§13.1).
   */
  function normalizeLoadedGate(candidate: unknown, stepId: string): LoopGate {
    const record =
      candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : {}
    const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : `${stepId}-gate`
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : '门禁'
    const type = record.type === 'skill' ? 'skill' : 'agent'
    const model =
      record.model !== null &&
      typeof record.model === 'object' &&
      !Array.isArray(record.model) &&
      typeof (record.model as Record<string, unknown>).provider === 'string' &&
      typeof (record.model as Record<string, unknown>).model === 'string'
        ? {
            provider: (record.model as { provider: string }).provider,
            model: (record.model as { model: string }).model,
          }
        : undefined
    return {
      id,
      name,
      type,
      command: typeof record.command === 'string' ? record.command : '',
      ...(type === 'skill' ? { skill: typeof record.skill === 'string' ? record.skill.trim() : '' } : {}),
      ...(model === undefined ? {} : { model }),
      autoLoop: record.autoLoop === true,
      maxIterations: Number.isInteger(record.maxIterations) ? (record.maxIterations as number) : 3,
    }
  }

  /**
   * Validate a loop step loaded from disk; unreadable steps are dropped so one
   * broken row cannot take the whole loop down.
   */
  function normalizeLoadedStep(candidate: unknown): LoopStep | undefined {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const record = candidate as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const pipelineId = typeof record.pipelineId === 'string' ? record.pipelineId.trim() : ''
    if (id === '' || pipelineId === '') return undefined
    return { id, pipelineId, gate: normalizeLoadedGate(record.gate, id) }
  }

  /**
   * Validate a loop loaded from disk and fill the v9 defaults. A loop written
   * before v9 has no `steps`; it loads as an empty (non-runnable) loop.
   */
  function normalizeLoadedLoop(candidate: unknown): Loop | undefined {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const loop = candidate as Loop
    if (typeof loop.id !== 'string' || loop.id === '') return undefined
    if (typeof loop.name !== 'string') return undefined
    if (loop.desc === undefined && typeof loop.description === 'string') loop.desc = loop.description
    delete loop.description
    if (typeof loop.desc !== 'string') loop.desc = ''
    if (typeof loop.icon !== 'string' || loop.icon === '') loop.icon = '⟳'
    if (typeof loop.color !== 'string') loop.color = ''
    if (typeof loop.star !== 'boolean') loop.star = false
    if (!Array.isArray(loop.steps)) loop.steps = []
    const steps: LoopStep[] = []
    for (const candidateStep of loop.steps) {
      const step = normalizeLoadedStep(candidateStep)
      if (step === undefined) {
        warn('skipped an unreadable loop step in the state file')
        continue
      }
      steps.push(step)
    }
    loop.steps = steps
    if (typeof loop.createdAt !== 'number') loop.createdAt = 0
    if (typeof loop.updatedAt !== 'number') loop.updatedAt = loop.createdAt
    return loop
  }

  /**
   * Validate a loop run loaded from disk. A run that was still running (or
   * waiting for a manual retry) has no owner after a host restart, so it is
   * demoted to `failed` and can be retried from the UI (§13.3).
   */
  function normalizeLoadedLoopRun(candidate: unknown): LoopRun | undefined {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const run = candidate as LoopRun
    if (typeof run.id !== 'string' || run.id === '') return undefined
    if (typeof run.loopId !== 'string' || run.loopId === '') return undefined
    if (typeof run.loopName !== 'string') run.loopName = ''
    if (typeof run.startedAt !== 'number') run.startedAt = 0
    if (!Array.isArray(run.order)) run.order = []
    if (run.stepStates === null || typeof run.stepStates !== 'object' || Array.isArray(run.stepStates))
      run.stepStates = {}
    if (run.status === 'running' || run.status === 'awaiting') {
      run.status = 'failed'
      run.error = '宿主已重启，本次 Loop 未完成'
      if (typeof run.finishedAt !== 'number') run.finishedAt = Date.now()
      warn(`loop run "${run.id}" was still unfinished on load; marked it failed`)
    }
    return run
  }

  /**
   * Read and parse the state file. Never throws: a missing or corrupt file
   * yields an empty library (and the next write overwrites it).
   */
  async function load(): Promise<void> {
    pipelines.clear()
    runs.clear()
    lastRuns.clear()
    loops.clear()
    loopRuns.clear()
    lastLoopRuns.clear()
    if (typeof file !== 'string' || file === '') return

    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') {
        warn(`could not read ${file}; starting with an empty library`, error)
      }
      return
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      warn(`${file} is not valid JSON; starting with an empty library (it will be overwritten)`, error)
      return
    }

    if (parsed === null || typeof parsed !== 'object') {
      warn(`${file} does not contain an object; starting with an empty library`)
      return
    }
    const version = (parsed as { version?: unknown }).version
    if (typeof version === 'number' && version !== STATE_VERSION) {
      warn(`${file} has unsupported version ${version}; starting with an empty library`)
      return
    }

    const storedPipelines = (parsed as { pipelines?: unknown }).pipelines
    if (Array.isArray(storedPipelines)) {
      for (const candidate of storedPipelines) {
        const pipeline = normalizeLoadedPipeline(candidate)
        if (pipeline === undefined) {
          warn('skipped an unreadable pipeline entry in the state file')
          continue
        }
        pipelines.set(pipeline.id, pipeline)
      }
    }

    const storedRuns = (parsed as { lastRuns?: unknown }).lastRuns
    if (storedRuns !== null && typeof storedRuns === 'object' && !Array.isArray(storedRuns)) {
      for (const [pipelineId, candidate] of Object.entries(storedRuns)) {
        const run = normalizeLoadedRun(candidate)
        if (run === undefined) continue
        if (typeof run.pipelineId !== 'string') run.pipelineId = pipelineId
        lastRuns.set(run.pipelineId, run)
        runs.set(run.id, run)
      }
    }

    // v9 loop records. Files from before v9 have none of these fields, which
    // simply means an empty loop library.
    const storedLoops = (parsed as { loops?: unknown }).loops
    if (Array.isArray(storedLoops)) {
      for (const candidate of storedLoops) {
        const loop = normalizeLoadedLoop(candidate)
        if (loop === undefined) {
          warn('skipped an unreadable loop entry in the state file')
          continue
        }
        loops.set(loop.id, loop)
      }
    }

    const storedLoopRuns = (parsed as { loopRuns?: unknown }).loopRuns
    if (Array.isArray(storedLoopRuns)) {
      for (const candidate of storedLoopRuns) {
        const run = normalizeLoadedLoopRun(candidate)
        if (run === undefined) {
          warn('skipped an unreadable loop run entry in the state file')
          continue
        }
        loopRuns.set(run.id, run)
      }
    }

    const storedLastLoopRuns = (parsed as { lastLoopRuns?: unknown }).lastLoopRuns
    if (storedLastLoopRuns !== null && typeof storedLastLoopRuns === 'object' && !Array.isArray(storedLastLoopRuns)) {
      for (const [loopId, candidate] of Object.entries(storedLastLoopRuns)) {
        const run = normalizeLoadedLoopRun(candidate)
        if (run === undefined) continue
        if (typeof run.loopId !== 'string' || run.loopId === '') run.loopId = loopId
        lastLoopRuns.set(run.loopId, run)
        loopRuns.set(run.id, run)
      }
    }

    // Enforce the in-memory retention caps after a load that may predate them.
    const loopIds: Set<string> = new Set(loops.keys())
    for (const run of loopRuns.values()) loopIds.add(run.loopId)
    for (const loopId of loopIds) pruneFinishedLoopRuns(loopId)
  }

  /**
   * Serialize the current state into the on-disk shape.
   */
  function serialize(): string {
    return JSON.stringify({
      version: STATE_VERSION,
      pipelines: [...pipelines.values()],
      lastRuns: Object.fromEntries(lastRuns),
      loops: [...loops.values()],
      loopRuns: [...loopRuns.values()],
      lastLoopRuns: Object.fromEntries(lastLoopRuns),
    })
  }

  /**
   * Atomically replace the state file: write a temp sibling, then rename.
   */
  async function writeState(): Promise<void> {
    if (typeof file !== 'string' || file === '') return
    const payload = serialize()
    const directory = path.dirname(file)
    await mkdir(directory, { recursive: true })
    const tempFile = `${file}.tmp-${randomUUID()}`
    try {
      await writeFile(tempFile, payload, 'utf8')
      await rename(tempFile, file)
    } catch (error) {
      await unlink(tempFile).catch(() => undefined)
      throw error
    }
  }

  /**
   * Enqueue one write behind the previous ones. The returned promise resolves
   * once this write landed; callers that must surface failures await it.
   */
  function persist(): Promise<void> {
    const task = writeChain.then(() => writeState())
    // The chain itself never rejects, otherwise one failed write would poison
    // every later write.
    writeChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  /**
   * Drop the oldest finished runs beyond the retention cap for one pipeline.
   * Running runs are always kept; the map keeps at most
   * {@link MAX_FINISHED_RUNS_PER_PIPELINE} finished runs.
   */
  function pruneFinishedRuns(pipelineId: string) {
    const finished: Run[] = []
    for (const run of runs.values()) {
      if (run.pipelineId === pipelineId && run.status !== 'running') finished.push(run)
    }
    finished.sort(
      (left, right) => (right.finishedAt ?? right.startedAt ?? 0) - (left.finishedAt ?? left.startedAt ?? 0),
    )
    for (const stale of finished.slice(MAX_FINISHED_RUNS_PER_PIPELINE)) {
      runs.delete(stale.id)
    }
  }

  /**
   * Drop the oldest finished loop runs beyond the retention cap for one loop.
   * Unfinished runs (running / awaiting) are always kept; the map keeps at most
   * {@link MAX_FINISHED_LOOP_RUNS_PER_LOOP} finished runs per loop.
   */
  function pruneFinishedLoopRuns(loopId: string) {
    const finished: LoopRun[] = []
    for (const run of loopRuns.values()) {
      if (run.loopId !== loopId) continue
      if (run.status === 'running' || run.status === 'awaiting') continue
      finished.push(run)
    }
    finished.sort(
      (left, right) => (right.finishedAt ?? right.startedAt ?? 0) - (left.finishedAt ?? left.startedAt ?? 0),
    )
    for (const stale of finished.slice(MAX_FINISHED_LOOP_RUNS_PER_LOOP)) {
      loopRuns.delete(stale.id)
      const last = lastLoopRuns.get(loopId)
      if (last !== undefined && last.id === stale.id) lastLoopRuns.delete(loopId)
    }
  }

  return {
    /**
     * Load the state file into memory. Safe to call once at plugin start.
     */
    load,

    /**
     * Replace the in-memory library with a database snapshot. Used when
     * `/api/state` is served from PostgreSQL and no local run is active.
     * This deliberately does not rewrite the local state file.
     */
    replaceAll(next: Partial<StateSnapshot>): void {
      const pipelinesNext =
        next !== null && typeof next === 'object' && Array.isArray(next.pipelines) ? next.pipelines : []
      const runsNext = next !== null && typeof next === 'object' && Array.isArray(next.runs) ? next.runs : []
      const loopsNext = next !== null && typeof next === 'object' && Array.isArray(next.loops) ? next.loops : []
      const loopRunsNext =
        next !== null && typeof next === 'object' && Array.isArray(next.loopRuns) ? next.loopRuns : []
      pipelines.clear()
      runs.clear()
      lastRuns.clear()
      loops.clear()
      loopRuns.clear()
      lastLoopRuns.clear()
      for (const pipeline of pipelinesNext) {
        if (
          pipeline !== null &&
          typeof pipeline === 'object' &&
          typeof pipeline.id === 'string' &&
          pipeline.id !== ''
        ) {
          pipelines.set(pipeline.id, pipeline)
        }
      }
      for (const run of runsNext) {
        if (run === null || typeof run !== 'object' || typeof run.id !== 'string' || run.id === '') continue
        runs.set(run.id, run)
        const previous = lastRuns.get(run.pipelineId)
        if (previous === undefined || (run.startedAt ?? 0) >= (previous.startedAt ?? 0))
          lastRuns.set(run.pipelineId, run)
      }
      for (const loop of loopsNext) {
        if (loop !== null && typeof loop === 'object' && typeof loop.id === 'string' && loop.id !== '') {
          loops.set(loop.id, loop)
        }
      }
      for (const run of loopRunsNext) {
        if (run === null || typeof run !== 'object' || typeof run.id !== 'string' || run.id === '') continue
        if (typeof run.loopId !== 'string' || run.loopId === '') continue
        if (!Array.isArray(run.order)) run.order = []
        if (run.stepStates === null || typeof run.stepStates !== 'object') run.stepStates = {}
        loopRuns.set(run.id, run)
        const previous = lastLoopRuns.get(run.loopId)
        if (previous === undefined || (run.startedAt ?? 0) >= (previous.startedAt ?? 0))
          lastLoopRuns.set(run.loopId, run)
      }
    },

    /**
     * List every pipeline.
     */
    listPipelines(): Pipeline[] {
      return [...pipelines.values()]
    },

    /**
     * Read one pipeline.
     */
    getPipeline(id: string): Pipeline | undefined {
      return pipelines.get(id)
    },

    /**
     * Insert or replace one pipeline and persist the library.
     */
    async upsertPipeline(pipeline: Pipeline): Promise<void> {
      if (pipeline === null || typeof pipeline !== 'object' || typeof pipeline.id !== 'string' || pipeline.id === '') {
        throw new Error('a pipeline must carry a non-empty string id')
      }
      pipelines.set(pipeline.id, pipeline)
      await persist()
      mirrorCall('upsertPipeline', pipeline)
    },

    /**
     * Remove a pipeline together with its in-memory runs and durable last-run
     * pointer.
     */
    async removePipeline(id: string): Promise<boolean> {
      const removed = pipelines.delete(id)
      lastRuns.delete(id)
      for (const [runId, run] of runs) {
        if (run.pipelineId === id) runs.delete(runId)
      }
      if (removed) {
        await persist()
        mirrorCall('removePipeline', id)
      }
      return removed
    },

    /**
     * List every loop, in insertion order.
     */
    listLoops(): Loop[] {
      return [...loops.values()]
    },

    /**
     * Read one loop.
     */
    getLoop(id: string): Loop | undefined {
      return loops.get(id)
    },

    /**
     * Insert or replace one loop and persist the library.
     */
    async upsertLoop(loop: Loop): Promise<void> {
      if (loop === null || typeof loop !== 'object' || typeof loop.id !== 'string' || loop.id === '') {
        throw new Error('a loop must carry a non-empty string id')
      }
      loops.set(loop.id, loop)
      await persist()
      mirrorCall('upsertLoop', loop)
    },

    /**
     * Remove a loop together with its loop runs and durable last-run pointer.
     */
    async removeLoop(id: string): Promise<boolean> {
      const removed = loops.delete(id)
      lastLoopRuns.delete(id)
      for (const [runId, run] of loopRuns) {
        if (run.loopId === id) loopRuns.delete(runId)
      }
      if (removed) {
        await persist()
        mirrorCall('removeLoop', id)
      }
      return removed
    },

    /**
     * List runs, newest first. Includes running runs, the recent finished runs
     * and the durable last run of each pipeline (restored on load).
     */
    listRuns(): Run[] {
      return [...runs.values()]
        .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
        .slice(0, MAX_RUN_HISTORY)
    },

    /**
     * Read one run from the in-memory table.
     */
    getRun(runId: string): Run | undefined {
      return runs.get(runId)
    },

    /**
     * Insert or update one in-memory run and prune old finished runs.
     * This does not write the state file; use {@link saveLastRun} for that.
     */
    setRun(run: Run): void {
      if (run === null || typeof run !== 'object' || typeof run.id !== 'string' || run.id === '') {
        throw new Error('a run must carry a non-empty string id')
      }
      runs.set(run.id, run)
      pruneFinishedRuns(run.pipelineId)
      mirrorCall('setRun', run)
    },

    /**
     * Remove one in-memory run. When it was the durable last run of its
     * pipeline, the pointer is cleared and the state file rewritten.
     */
    async removeRun(runId: string): Promise<boolean> {
      const run = runs.get(runId)
      if (run === undefined) return false
      runs.delete(runId)
      const last = lastRuns.get(run.pipelineId)
      if (last !== undefined && last.id === runId) {
        lastRuns.delete(run.pipelineId)
        try {
          await persist()
        } catch (error) {
          warn('could not persist the removal of the last run', error)
        }
      }
      mirrorCall('removeRun', runId)
      return true
    },

    /**
     * Remember the most recent run of a pipeline and persist it.
     * Write failures are logged, never thrown: run bookkeeping must not turn
     * an execution into an HTTP 500.
     */
    async saveLastRun(pipelineId: string, run: Run): Promise<void> {
      if (typeof pipelineId !== 'string' || pipelineId === '') return
      if (run === null || typeof run !== 'object' || typeof run.id !== 'string') return
      lastRuns.set(pipelineId, run)
      try {
        await persist()
      } catch (error) {
        warn('could not persist the last run', error)
      }
    },

    /**
     * List loop runs, newest first; at most {@link MAX_LOOP_RUN_HISTORY} rows.
     */
    listLoopRuns(): LoopRun[] {
      return [...loopRuns.values()]
        .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
        .slice(0, MAX_LOOP_RUN_HISTORY)
    },

    /**
     * Read one loop run from the in-memory table.
     */
    getLoopRun(runId: string): LoopRun | undefined {
      return loopRuns.get(runId)
    },

    /**
     * Insert or update one in-memory loop run and prune old finished runs.
     * This does not write the state file; use {@link saveLoopRun} for that.
     */
    setLoopRun(run: LoopRun): void {
      if (run === null || typeof run !== 'object' || typeof run.id !== 'string' || run.id === '') {
        throw new Error('a loop run must carry a non-empty string id')
      }
      loopRuns.set(run.id, run)
      pruneFinishedLoopRuns(run.loopId)
      mirrorCall('setLoopRun', run)
    },

    /**
     * Remember the most recent loop run of a loop and persist it.
     * Write failures are logged, never thrown: loop bookkeeping must not turn
     * an execution into an HTTP 500.
     */
    async saveLoopRun(loopId: string, run: LoopRun): Promise<void> {
      if (typeof loopId !== 'string' || loopId === '') return
      if (run === null || typeof run !== 'object' || typeof run.id !== 'string') return
      lastLoopRuns.set(loopId, run)
      try {
        await persist()
      } catch (error) {
        warn('could not persist the last loop run', error)
      }
    },

    /**
     * Remove one in-memory loop run. When it was the durable last run of its
     * loop, the pointer is cleared and the state file rewritten.
     */
    async removeLoopRun(runId: string): Promise<boolean> {
      const run = loopRuns.get(runId)
      if (run === undefined) return false
      loopRuns.delete(runId)
      const last = lastLoopRuns.get(run.loopId)
      if (last !== undefined && last.id === runId) {
        lastLoopRuns.delete(run.loopId)
        try {
          await persist()
        } catch (error) {
          warn('could not persist the removal of the last loop run', error)
        }
      }
      mirrorCall('removeLoopRun', runId)
      return true
    },
  }
}

export type Store = ReturnType<typeof createStore>
