/**
 * Unit tests for lib/loopengine.js — the v9 Loop state machine (CONTRACT.md
 * §13.3). The pipeline engine is faked: it registers a normal Run in the store
 * and completes it on the next tick, so the loop engine's polling path is
 * exercised for real. The gate turn is an injected `runGate` whose decisions
 * are scripted per call, so no agent/session is ever created.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createLoopEngine } from '../lib/loopengine.js'
import { createStore } from '../lib/store.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Poll `predicate` every 2 ms until true or the budget expires. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await delay(2)
  }
}

/** Reject as soon as the injected abort signal fires (never settles without one). */
function abortableWait(signal: AbortSignal | undefined) {
  return new Promise((resolve, reject) => {
    if (signal === undefined) return // keep the gate "running" forever
    if (signal.aborted === true) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
  })
}

/** Pipeline fixture (two nodes, names carry through to the aggregated output). */
function makePipeline(id: string, name: string) {
  return {
    id,
    name,
    nodes: [
      { id: 'a', name: 'A', command: `${name} node A` },
      { id: 'b', name: 'B', command: `${name} node B` },
    ],
    edges: [] as any[],
    createdAt: 1,
    updatedAt: 1,
  }
}

/** Two-group loop fixture: step 1 -> p1, step 2 -> p2. */
function makeLoop({ id = 'loop-1', autoLoop = false, maxIterations = 3 }: any = {}) {
  return {
    id,
    name: 'Loop one',
    steps: [
      {
        id: 's1',
        pipelineId: 'p1',
        gate: {
          id: 's1-gate',
          name: '门禁一',
          type: 'agent' as const,
          command: '第一组是否完成',
          autoLoop,
          maxIterations,
        },
      },
      {
        id: 's2',
        pipelineId: 'p2',
        gate: {
          id: 's2-gate',
          name: '门禁二',
          type: 'agent' as const,
          command: '第二组是否完成',
          autoLoop,
          maxIterations,
        },
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  }
}

/**
 * Fake pipeline engine: `start()` registers a running Run in the store and
 * settles it on the next timer tick with the next scripted result.
 * Script entry shapes: { status: 'completed'|'failed'|'stopped', error? } or
 * { startError: { code, message } } to simulate engine.start refusing.
 * @param {any} store - loop-manager store.
 * @param {Array<any>} [script] - per-start outcomes.
 */
function createFakeEngine(store: any, script: Array<any> = []): any {
  const calls = { start: [] as any[], stop: [] as string[] }
  const runs: any[] = []
  let sequence = 0
  return {
    calls,
    runs,
    start(pipeline: any) {
      const planned = script.length > 0 ? script.shift() : { status: 'completed' }
      if (planned.startError !== undefined) {
        calls.start.push({ pipelineId: pipeline.id, refused: true } as any)
        return { ok: false, ...planned.startError }
      }
      calls.start.push({ pipelineId: pipeline.id, refused: false } as any)
      const run: any = {
        id: `prun-${++sequence}`,
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        status: 'running',
        startedAt: sequence,
        order: pipeline.nodes.map((node: any) => node.id),
        nodeStates: Object.fromEntries(pipeline.nodes.map((node: any) => [node.id, { status: 'running' }])),
      }
      store.setRun(run)
      runs.push(run)
      const settle = () => {
        // The loop engine may have stopped this run already; never resurrect it.
        if (run.status !== 'running') return
        const status = planned.status ?? 'completed'
        run.status = status
        run.finishedAt = Date.now()
        for (const node of pipeline.nodes) {
          const state = run.nodeStates[node.id]
          if (state === undefined) continue
          if (status === 'completed') {
            state.status = 'completed'
            state.output = `${pipeline.id}:${node.id}:out`
            state.finishedAt = Date.now()
          } else {
            state.status = status === 'stopped' ? 'skipped' : 'failed'
            state.error = planned.error ?? `pipeline ${pipeline.id} ${status}`
            state.finishedAt = Date.now()
          }
        }
        if (status !== 'completed') run.error = planned.error ?? `pipeline "${pipeline.name}" ${status}`
      }
      const timer = setTimeout(settle, 1)
      timer.unref?.()
      return { ok: true, run }
    },
    async stop(runId: any) {
      calls.stop.push(runId as any)
      const run = store.getRun(runId)
      if (run === undefined) return { ok: false, code: 'run-not-found', message: `run "${runId}" not found` }
      if (run.status === 'running') {
        run.status = 'stopped'
        run.finishedAt = Date.now()
      }
      return { ok: true, run }
    },
  }
}

/**
 * Fake gate turn. Each script entry is `{ output, thinking?, sessionId? }`,
 * `{ error }` (throw), or `{ waitForAbort: true }` (keep running until the
 * loop engine aborts it → throw, like a well-behaved runner).
 */
function createGateRunner(script: any = []) {
  const calls: any[] = []
  let index = 0
  async function runGate(args: any) {
    calls.push(args)
    const planned = script.length > 0 ? script[Math.min(index, script.length - 1)] : { output: 'TRUE' }
    index += 1
    if (planned.waitForAbort === true) {
      await abortableWait(args.signal)
      throw new Error('gate aborted')
    }
    if (planned.error !== undefined) throw new Error(planned.error)
    // Real runners announce the gate session through onSession; the loop engine
    // stores it on the step state (it does not consume a returned sessionId).
    if (planned.sessionId !== undefined && typeof args.onSession === 'function') args.onSession(planned.sessionId)
    return {
      output: planned.output ?? '',
      ...(planned.thinking === undefined ? {} : { thinking: planned.thinking }),
      ...(planned.sessionId === undefined ? {} : { sessionId: planned.sessionId }),
    }
  }
  return { runGate, calls }
}

/**
 * Build a store with the two referenced pipelines, a fake engine and the loop
 * engine under test. `now` is deterministic and monotonic.
 */
async function createHarness({ gateScript = [], pipelineScript = [] }: any = {}) {
  const store = createStore({})
  await store.load()
  await store.upsertPipeline(makePipeline('p1', 'Pipeline one'))
  await store.upsertPipeline(makePipeline('p2', 'Pipeline two'))
  const engine = createFakeEngine(store, pipelineScript)
  const gate = createGateRunner(gateScript)
  let clock = 1000
  const loopEngine = createLoopEngine({
    store,
    engine,
    runGate: gate.runGate,
    pollIntervalMs: 2,
    now: () => {
      clock += 1
      return clock
    },
  } as any)
  return { store, engine, gate, loopEngine }
}

/**
 * Save the loop in the store (the real HTTP flow persists before running) and
 * start it. retry() resolves the loop via store.getLoop, so persisting is part
 * of the contract, not test scaffolding.
 */
async function startLoop(h: any, loop: any) {
  await h.store.upsertLoop(loop)
  return h.loopEngine.start(loop)
}

/** Assert a `{ ok: false }` result from the loop engine. */
function assertRefused(result: any, code: any) {
  assert.equal(result.ok, false)
  assert.equal(result.code, code)
  assert.equal(typeof result.message, 'string')
  assert.ok(result.message.trim() !== '')
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test('both gates TRUE: each group advances and the LoopRun completes', async () => {
  const h = await createHarness({
    gateScript: [
      { output: 'TRUE\n输出包含所需内容', thinking: 'gate one thinking', sessionId: 'gate-session-1' },
      { output: '**TRUE**', sessionId: 'gate-session-2' },
    ],
  })
  try {
    const started = await startLoop(h, makeLoop())
    assert.equal(started.ok, true)
    assert.equal(started.run.status, 'running')
    const run = started.run
    await waitFor(() => run.status === 'completed', 'LoopRun completed')

    assert.equal(run.loopId, 'loop-1')
    assert.equal(run.loopName, 'Loop one')
    assert.deepEqual(run.order, ['s1', 's2'])
    assert.equal(typeof run.finishedAt, 'number')

    const first = run.stepStates.s1
    assert.equal(first.status, 'completed')
    assert.equal(first.iteration, 1)
    assert.equal(first.pipelineStatus, 'completed')
    assert.equal(typeof first.pipelineRunId, 'string')
    assert.ok(first.pipelineOutput.includes('p1:a:out'), 'aggregated pipeline output reached the step state')
    assert.equal(first.gateStatus, 'passed')
    assert.equal(first.decision, 'TRUE')
    assert.equal(first.gateOutput, 'TRUE\n输出包含所需内容')
    assert.equal(first.gateThinking, 'gate one thinking')
    assert.equal(first.gateSessionId, 'gate-session-1')

    const second = run.stepStates.s2
    assert.equal(second.status, 'completed')
    assert.equal(second.iteration, 1)
    assert.equal(second.gateStatus, 'passed')
    assert.equal(second.decision, 'TRUE')
    assert.equal(second.gateSessionId, 'gate-session-2')

    // One pipeline run per group, and each is a normal run visible in the store.
    assert.deepEqual(
      h.engine.calls.start.map((call: any) => call.pipelineId),
      ['p1', 'p2'],
    )
    assert.equal(h.store.getRun(first.pipelineRunId)?.status, 'completed')
    assert.equal(h.store.getRun(second.pipelineRunId)?.status, 'completed')

    // The gate prompt is rendered from the contract template and carries the
    // page of pipeline output plus the agent judgement requirement.
    const prompt = h.gate.calls[0].prompt
    assert.match(prompt, /门禁节点/)
    assert.match(prompt, /第一组是否完成/)
    assert.ok(prompt.includes('【A】'), 'gate prompt embeds the aggregated pipeline output')
    assert.equal(h.gate.calls[0].node.id, 's1-gate')
    assert.equal(h.gate.calls[0].node.name, '门禁一')
    assert.equal(h.gate.calls[0].node.type, 'agent')
    assert.deepEqual(h.gate.calls[0].pipeline, {}, 'gate sessions use the host default working directory')

    // The in-memory store sees the run (and it is the newest loop run).
    assert.equal(h.store.getLoopRun(run.id), run)
    assert.equal(h.store.listLoopRuns()[0].id, run.id)
  } finally {
    await h.loopEngine.dispose()
  }
})

// ---------------------------------------------------------------------------
// FALSE handling
// ---------------------------------------------------------------------------

test('FALSE + autoLoop: the group re-runs until maxIterations, then awaits manually', async () => {
  const h = await createHarness({
    gateScript: [{ output: 'FALSE\n缺少 DONE' }, { output: 'FALSE\n仍然缺少 DONE' }],
  })
  try {
    const run = (await startLoop(h, makeLoop({ autoLoop: true, maxIterations: 2 }))).run
    await waitFor(() => run.status === 'awaiting', 'LoopRun awaiting at the iteration cap')

    assert.equal(h.engine.calls.start.length, 2, 'the pipeline ran maxIterations times')
    const first = run.stepStates.s1
    assert.equal(first.status, 'awaiting')
    assert.equal(first.iteration, 2)
    assert.equal(first.gateStatus, 'awaiting')
    assert.equal(first.decision, 'FALSE')
    assert.match(first.gateError, /自动循环已达上限 2 次/)
    assert.equal(first.gateOutput, 'FALSE\n仍然缺少 DONE')

    const second = run.stepStates.s2
    assert.equal(second.status, 'pending')
    assert.equal(second.iteration, 0)
    assert.equal(second.gateStatus, 'pending')
  } finally {
    await h.loopEngine.dispose()
  }
})

test('FALSE + autoLoop: a later TRUE advances to the next group', async () => {
  const h = await createHarness({
    gateScript: [{ output: 'FALSE' }, { output: 'TRUE' }, { output: 'TRUE' }],
  })
  try {
    const run = (await startLoop(h, makeLoop({ autoLoop: true, maxIterations: 3 }))).run
    await waitFor(() => run.status === 'completed', 'LoopRun completed after the retry')

    assert.equal(h.engine.calls.start.length, 3)
    assert.equal(run.stepStates.s1.iteration, 2)
    assert.equal(run.stepStates.s1.gateStatus, 'passed')
    assert.equal(run.stepStates.s1.decision, 'TRUE')
    assert.equal(run.stepStates.s2.status, 'completed')
  } finally {
    await h.loopEngine.dispose()
  }
})

test('FALSE + manual loop: the run awaits, retry resumes the same group', async () => {
  const h = await createHarness({
    gateScript: [{ output: 'FALSE\n不满足' }, { output: 'TRUE' }, { output: 'TRUE' }],
  })
  try {
    const run = (await startLoop(h, makeLoop({ autoLoop: false }))).run
    await waitFor(() => run.status === 'awaiting', 'LoopRun awaiting after a manual-loop FALSE')

    const first = run.stepStates.s1
    assert.equal(first.status, 'awaiting')
    assert.equal(first.iteration, 1)
    assert.equal(first.gateStatus, 'awaiting')
    assert.equal(first.decision, 'FALSE')
    assert.equal(h.engine.calls.start.length, 1, 'manual mode never auto-reruns')

    const retried = await h.loopEngine.retry(run.id)
    assert.equal(retried.ok, true)
    assert.equal(retried.run.id, run.id)
    assert.equal(retried.run.status, 'running')
    await waitFor(() => run.status === 'completed', 'LoopRun completed after retry')

    assert.equal(run.stepStates.s1.iteration, 2, 'iteration keeps counting for display')
    assert.equal(run.stepStates.s1.gateStatus, 'passed')
    assert.equal(run.stepStates.s1.decision, 'TRUE')
    assert.equal(run.stepStates.s2.status, 'completed')
    assert.equal(h.engine.calls.start.length, 3, 'p1 re-ran, then p2 ran once')
  } finally {
    await h.loopEngine.dispose()
  }
})

test('UNKNOWN gate output awaits with the contract gateError and preserves the output', async () => {
  const h = await createHarness({
    gateScript: [{ output: '我无法判断这一点。' }, { output: 'TRUE' }, { output: 'TRUE' }],
  })
  try {
    const run = (await startLoop(h, makeLoop({ autoLoop: true }))).run
    await waitFor(() => run.status === 'awaiting', 'LoopRun awaiting on an UNKNOWN decision')

    const first = run.stepStates.s1
    assert.equal(first.status, 'awaiting')
    assert.equal(first.decision, 'UNKNOWN')
    assert.equal(first.gateStatus, 'failed')
    assert.equal(first.gateError, '门禁没有给出 TRUE/FALSE 结论')
    assert.equal(first.gateOutput, '我无法判断这一点。')

    // UNKNOWN is retryable by hand even with autoLoop on.
    assert.equal((await h.loopEngine.retry(run.id)).ok, true)
    await waitFor(() => run.status === 'completed', 'LoopRun completed after retrying UNKNOWN')
    assert.equal(run.stepStates.s1.decision, 'TRUE')
  } finally {
    await h.loopEngine.dispose()
  }
})

test('a gate turn that throws awaits with a readable gateError', async () => {
  const h = await createHarness({
    gateScript: [{ error: 'gate turn exploded' }, { output: 'TRUE' }, { output: 'TRUE' }],
  })
  try {
    const run = (await startLoop(h, makeLoop())).run
    await waitFor(() => run.status === 'awaiting', 'LoopRun awaiting after a gate throw')

    const first = run.stepStates.s1
    assert.equal(first.status, 'awaiting')
    assert.equal(first.gateStatus, 'failed')
    assert.ok(first.decision === undefined || first.decision === 'UNKNOWN', 'a thrown gate has no TRUE/FALSE verdict')
    assert.match(first.gateError, /gate turn exploded/)
  } finally {
    await h.loopEngine.dispose()
  }
})

// ---------------------------------------------------------------------------
// pipeline failures
// ---------------------------------------------------------------------------

test('a failed pipeline marks the step failed and awaits a manual retry', async () => {
  const h = await createHarness({
    gateScript: [{ output: 'TRUE' }, { output: 'TRUE' }],
    pipelineScript: [{ status: 'failed', error: 'node A exploded' }, { status: 'completed' }, { status: 'completed' }],
  })
  try {
    const run = (await startLoop(h, makeLoop())).run
    await waitFor(() => run.status === 'awaiting', 'LoopRun awaiting after a pipeline failure')

    const first = run.stepStates.s1
    assert.equal(first.status, 'failed')
    assert.equal(first.gateStatus, 'awaiting')
    assert.equal(first.pipelineStatus, 'failed')
    assert.match(first.error, /node A exploded/)
    assert.equal(h.gate.calls.length, 0, 'a failed pipeline never reaches its gate')
    assert.equal(run.stepStates.s2.status, 'pending')

    assert.equal((await h.loopEngine.retry(run.id)).ok, true)
    await waitFor(() => run.status === 'completed', 'LoopRun completed after the pipeline retry')
    assert.equal(run.stepStates.s1.iteration, 2)
    assert.equal(run.stepStates.s1.pipelineStatus, 'completed')
    assert.equal(run.stepStates.s2.status, 'completed')
  } finally {
    await h.loopEngine.dispose()
  }
})

test('engine.start run-in-progress fails that group and stays retryable', async () => {
  const h = await createHarness({
    gateScript: [{ output: 'TRUE' }, { output: 'TRUE' }],
    pipelineScript: [
      { startError: { code: 'run-in-progress', message: 'pipeline "Pipeline one" is already running' } },
      { status: 'completed' },
      { status: 'completed' },
    ],
  })
  try {
    const run = (await startLoop(h, makeLoop())).run
    await waitFor(() => run.status === 'awaiting', 'LoopRun awaiting after run-in-progress')

    const first = run.stepStates.s1
    assert.equal(first.status, 'failed')
    assert.equal(first.gateStatus, 'awaiting')
    assert.match(first.error, /already running/)

    assert.equal((await h.loopEngine.retry(run.id)).ok, true)
    await waitFor(() => run.status === 'completed', 'LoopRun completed after retrying run-in-progress')
  } finally {
    await h.loopEngine.dispose()
  }
})

test('a stopped pipeline run is treated like a failure and awaits', async () => {
  const h = await createHarness({
    gateScript: [{ output: 'TRUE' }, { output: 'TRUE' }],
    pipelineScript: [{ status: 'stopped' }, { status: 'completed' }, { status: 'completed' }],
  })
  try {
    const run = (await startLoop(h, makeLoop())).run
    await waitFor(() => run.status === 'awaiting', 'LoopRun awaiting after its pipeline was stopped')
    assert.equal(run.stepStates.s1.pipelineStatus, 'stopped')
    assert.equal(run.stepStates.s1.gateStatus, 'awaiting')
  } finally {
    await h.loopEngine.dispose()
  }
})

// ---------------------------------------------------------------------------
// stop / dispose
// ---------------------------------------------------------------------------

test('stop skips the current and later groups and marks the LoopRun stopped', async () => {
  const h = await createHarness({ gateScript: [{ waitForAbort: true }] })
  try {
    const run = (await startLoop(h, makeLoop())).run
    await waitFor(() => run.stepStates.s1.gateStatus === 'running', 'the gate turn to start')

    const stopped = await h.loopEngine.stop(run.id)
    assert.equal(stopped.ok, true)
    assert.equal(run.status, 'stopped')
    assert.equal(typeof run.finishedAt, 'number')
    assert.equal(run.stepStates.s1.status, 'skipped')
    assert.notEqual(run.stepStates.s1.gateStatus, 'passed')
    assert.equal(run.stepStates.s2.status, 'skipped')
  } finally {
    await h.loopEngine.dispose()
  }
})

test('dispose stops every active LoopRun', async () => {
  const h = await createHarness({ gateScript: [{ waitForAbort: true }] })
  const run = (await startLoop(h, makeLoop())).run
  await waitFor(() => run.stepStates.s1.gateStatus === 'running', 'the gate turn to start')
  await h.loopEngine.dispose()
  assert.equal(run.status, 'stopped')
  assert.equal(run.stepStates.s1.status, 'skipped')
})

// ---------------------------------------------------------------------------
// errors and guards
// ---------------------------------------------------------------------------

test('a second start of the same loop is refused with run-in-progress', async () => {
  const h = await createHarness({ gateScript: [{ waitForAbort: true }] })
  try {
    const first = await startLoop(h, makeLoop())
    assert.equal(first.ok, true)
    await waitFor(() => first.run.stepStates.s1.gateStatus === 'running', 'the first run to reach its gate')

    const second = h.loopEngine.start(makeLoop())
    assertRefused(second, 'run-in-progress')

    assert.equal((await h.loopEngine.stop(first.run.id)).ok, true)
  } finally {
    await h.loopEngine.dispose()
  }
})

test('start refuses an invalid loop', async () => {
  const h = await createHarness()
  try {
    assertRefused(h.loopEngine.start(makeLoop({ id: '', name: '' })), 'invalid-loop')
    const broken = makeLoop()
    broken.steps[0].pipelineId = 'ghost'
    assertRefused(h.loopEngine.start(broken as any), 'invalid-loop')
    assert.equal(h.store.listLoopRuns().length, 0, 'a refused start creates no run')
  } finally {
    await h.loopEngine.dispose()
  }
})

test('retry reports loop-run-not-found / not-awaiting / step-not-found', async () => {
  const h = await createHarness({ gateScript: [{ output: 'FALSE' }, { output: 'TRUE' }, { output: 'TRUE' }] })
  try {
    assertRefused(await h.loopEngine.retry('does-not-exist'), 'loop-run-not-found')

    const run = (await startLoop(h, makeLoop())).run
    await waitFor(() => run.status === 'awaiting', 'LoopRun awaiting')
    assertRefused(await h.loopEngine.retry(run.id, 'no-such-step'), 'step-not-found')

    assert.equal((await h.loopEngine.retry(run.id)).ok, true)
    await waitFor(() => run.status === 'completed', 'LoopRun completed')
    assertRefused(await h.loopEngine.retry(run.id), 'not-awaiting')
  } finally {
    await h.loopEngine.dispose()
  }
})

test('retry is refused while the LoopRun is running', async () => {
  const h = await createHarness({ gateScript: [{ waitForAbort: true }] })
  try {
    const run = (await startLoop(h, makeLoop())).run
    await waitFor(() => run.stepStates.s1.gateStatus === 'running', 'the gate turn to start')
    assertRefused(await h.loopEngine.retry(run.id), 'not-awaiting')
    await h.loopEngine.stop(run.id)
  } finally {
    await h.loopEngine.dispose()
  }
})

test('listRuns exposes loop run history newest first', async () => {
  const h = await createHarness({ gateScript: [{ output: 'TRUE' }, { output: 'TRUE' }] })
  try {
    const run = (await startLoop(h, makeLoop())).run
    await waitFor(() => run.status === 'completed', 'LoopRun completed')
    const runs = h.loopEngine.listRuns()
    assert.equal(runs.length, 1)
    assert.equal(runs[0].id, run.id)
    assert.equal(runs[0].status, 'completed')
  } finally {
    await h.loopEngine.dispose()
  }
})
