/**
 * Unit tests for lib/engine.js — run orchestration with an injected fake node
 * runner, so no DSH agent is ever created. Covered: serial topological
 * execution, output propagation, failure/skip semantics, stop, per-node
 * timeout, single-running-run enforcement and last-run persistence.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createEngine, MAX_OUTPUT_CHARS, MAX_THINKING_CHARS } from '../lib/engine.js'
import { createStore } from '../lib/store.js'

/** Poll `predicate` until true (5ms ticks) or fail. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Reject as soon as the abort signal fires (a well-behaved fake runner). */
function abortableWait(signal: AbortSignal | undefined) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
  })
}

/** Pipeline fixture. */
function makePipeline(): any {
  return {
    id: 'p1',
    name: 'Pipeline one',
    nodes: [
      { id: 'a', title: 'A', prompt: 'Start here' },
      { id: 'b', title: 'B', prompt: 'Previous: {{input}}' },
      { id: 'c', title: 'C', prompt: 'Reuse {{node:a}}' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
    createdAt: 1,
    updatedAt: 1,
  }
}

test('runs nodes serially in topological order and propagates outputs', async () => {
  const store = createStore({})
  await store.load()
  /** @type {Array<{ id: string, prompt: string }>} */
  const calls: Array<{ id: string; prompt: string }> = []
  const engine = createEngine({
    store,
    runNode: async ({ node, prompt, onSession }) => {
      calls.push({ id: node.id, prompt })
      onSession?.(`session-${node.id}`)
      return { output: `out-${node.id}` }
    },
  })

  const started = engine.start(makePipeline())
  assert.equal(started.ok, true)
  const run = started.run
  assert.equal(run.status, 'running')
  await waitFor(() => run.status !== 'running')

  assert.equal(run.status, 'completed')
  assert.deepEqual(run.order, ['a', 'b', 'c'])
  assert.deepEqual(
    calls.map((call) => call.id),
    ['a', 'b', 'c'],
  )
  assert.equal(calls[0].prompt, 'Start here')
  // {{input}} resolved from the direct predecessor A.
  assert.equal(calls[1].prompt, 'Previous: [A]\nout-a')
  // {{node:a}} resolves any known node.
  assert.equal(calls[2].prompt, 'Reuse out-a')

  for (const nodeId of ['a', 'b', 'c']) {
    const state = run.nodeStates[nodeId]
    assert.equal(state.status, 'completed')
    assert.equal(state.output, `out-${nodeId}`)
    assert.equal(state.sessionId, `session-${nodeId}`)
    assert.equal(typeof state.startedAt, 'number')
    assert.equal(typeof state.finishedAt, 'number')
  }
  assert.equal(typeof run.finishedAt, 'number')
  assert.equal(typeof run.error, 'undefined')

  // The run table is updated in place.
  assert.equal(store.listRuns().length, 1)
  assert.equal(store.listRuns()[0].status, 'completed')
})

test('a failing node fails the run and skips the remaining nodes', async () => {
  const store = createStore({})
  await store.load()
  const calls: any[] = []
  const engine = createEngine({
    store,
    runNode: async ({ node }) => {
      calls.push(node.id)
      if (node.id === 'b') throw new Error('boom')
      return { output: `out-${node.id}` }
    },
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => run!.status !== 'running')

  assert.equal(run!.status, 'failed')
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(run!.nodeStates.a.status, 'completed')
  assert.equal(run!.nodeStates.b.status, 'failed')
  assert.equal(run!.nodeStates.b.error, 'boom')
  assert.equal(run!.nodeStates.c.status, 'skipped')
  assert.match(run!.error as any, /node "B" failed: boom/)
})

test('a second run of the same pipeline is refused while one is active', async () => {
  const store = createStore({})
  await store.load()
  const engine = createEngine({
    store,
    runNode: async ({ signal }) => {
      await abortableWait(signal)
      return { output: 'late' }
    },
  })

  const first = engine.start(makePipeline())
  assert.equal(first.ok, true)
  await waitFor(() => first.run.nodeStates.a.status === 'running')

  const second = engine.start(makePipeline())
  assert.equal(second.ok, false)
  assert.equal(second.code, 'run-in-progress')

  const stopped = await engine.stop(first.run.id)
  assert.equal(stopped.ok, true)
  assert.equal(stopped.run.status, 'stopped')
})

test('stop cancels the running node and skips the rest', async () => {
  const store = createStore({})
  await store.load()
  const called: any[] = []
  const engine = createEngine({
    store,
    runNode: async ({ node, signal }) => {
      called.push(node.id)
      await abortableWait(signal)
      return { output: node.id }
    },
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => called.length === 1 && run!.nodeStates.a.status === 'running')

  const result = await engine.stop(run!.id)
  assert.equal(result.ok, true)
  assert.equal(run!.status, 'stopped')
  assert.equal(run!.nodeStates.a.status, 'skipped')
  assert.equal(run!.nodeStates.a.error, 'the run was stopped')
  assert.equal(run!.nodeStates.b.status, 'skipped')
  assert.equal(run!.nodeStates.c.status, 'skipped')
  assert.equal(typeof run!.finishedAt, 'number')
  assert.deepEqual(called, ['a'])

  // Stopping a finished run is a no-op that returns the same run.
  const again = await engine.stop(run!.id)
  assert.equal(again.ok, true)
  assert.equal(again.run.status, 'stopped')
})

test('a node that exceeds its timeout fails the run', async () => {
  const store = createStore({})
  await store.load()
  const engine = createEngine({
    store,
    nodeTimeoutMs: 25,
    runNode: async ({ signal }) => {
      await abortableWait(signal)
      return { output: 'never' }
    },
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => run!.status !== 'running')

  assert.equal(run!.status, 'failed')
  assert.equal(run!.nodeStates.a.status, 'failed')
  assert.match(run!.nodeStates.a.error as any, /timed out after 25 ms/)
  assert.equal(run!.nodeStates.b.status, 'skipped')
  assert.match(run!.error as any, /node "A" failed/)
})

test('the run captures the deployment default model once and passes it to every node', async () => {
  const store = createStore({})
  await store.load()
  const seen: any[] = []
  const engine = createEngine({
    store,
    resolveService: (name) =>
      name === 'agentDefaultModel'
        ? {
            currentSelection: () => ({
              provider: 'deepseek-official',
              model: 'deepseek-flash',
              reasoningEffort: 'high',
            }),
          }
        : undefined,
    runNode: async ({ defaultModel }) => {
      seen.push(defaultModel)
      return { output: 'ok' }
    },
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => run!.status !== 'running')
  assert.equal(seen.length, 3)
  for (const entry of seen) {
    assert.deepEqual(entry, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
  }
})

test('start reports internal when the session services are absent', async () => {
  const store = createStore({})
  await store.load()
  // No runNode -> the real runner is used, and no services resolve.
  const engine = createEngine({ store, resolveService: () => undefined })

  const started = engine.start(makePipeline())
  assert.equal(started.ok, false)
  assert.equal(started.code, 'internal')
  assert.match(started.message, /is not mounted in this deployment/)

  const persisted = store.listRuns()[0]
  assert.equal(persisted.status, 'failed')
  assert.match(persisted.error as any, /the session controller service is not mounted in this deployment/)
  assert.equal(persisted.nodeStates.a.status, 'skipped')
})

test('a node keeps its folded thinking process on the run state', async () => {
  const store = createStore({})
  await store.load()
  const engine = createEngine({
    store,
    runNode: async ({ node }) => ({ output: `out-${node.id}`, thinking: `thought-${node.id}` }),
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => run!.status !== 'running')

  assert.equal(run!.nodeStates.a.output, 'out-a')
  assert.equal(run!.nodeStates.a.thinking, 'thought-a')
})

test('live progress updates the running node state before completion', async () => {
  const store = createStore({})
  await store.load()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const engine = createEngine({
    store,
    runNode: async ({ onProgress }) => {
      onProgress!({ output: 'partial', thinking: 'thinking…' })
      await gate
      return { output: 'final', thinking: 'finished thinking' }
    },
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => run!.nodeStates.a.output === 'partial')
  assert.equal(run!.nodeStates.a.status, 'running')
  assert.equal(run!.nodeStates.a.thinking, 'thinking…')

  release()
  await waitFor(() => run!.status !== 'running')
  assert.equal(run!.nodeStates.a.output, 'final')
  assert.equal(run!.nodeStates.a.thinking, 'finished thinking')
})

test('the folded thinking process is truncated to the contract limit', async () => {
  const store = createStore({})
  await store.load()
  const engine = createEngine({
    store,
    runNode: async () => ({ output: 'answer', thinking: 'y'.repeat(MAX_THINKING_CHARS + 500) }),
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => run!.status !== 'running')
  assert.equal(run!.nodeStates.a.thinking!.length, MAX_THINKING_CHARS)
})

test('outputs are truncated to the contract limit', async () => {
  const store = createStore({})
  await store.load()
  const engine = createEngine({
    store,
    runNode: async () => ({ output: 'x'.repeat(MAX_OUTPUT_CHARS + 500) }),
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => run!.status !== 'running')
  assert.equal(run!.nodeStates.a.output!.length, MAX_OUTPUT_CHARS)
})

test('dispose stops every active run', async () => {
  const store = createStore({})
  await store.load()
  const engine = createEngine({
    store,
    runNode: async ({ signal }) => {
      await abortableWait(signal)
      return { output: 'late' }
    },
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => run!.nodeStates.a.status === 'running')
  await engine.dispose()

  assert.equal(run!.status, 'stopped')
  assert.equal(run!.nodeStates.a.status, 'skipped')
  assert.equal(run!.nodeStates.c.status, 'skipped')
})

test('the last run of every pipeline is persisted to disk', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'loop-manager-engine-'))
  const file = path.join(directory, 'state.json')
  const store = createStore({ file })
  await store.load()
  await store.upsertPipeline(makePipeline())
  const engine = createEngine({
    store,
    runNode: async ({ node }) => ({ output: `out-${node.id}` }),
  })

  const run = engine.start(makePipeline()).run
  await waitFor(() => run!.status !== 'running')
  // saveLastRun is fire-and-forget from the engine; wait for the file to land.
  await waitFor(() => store.listRuns().length > 0)
  await new Promise((resolve) => setTimeout(resolve, 50))

  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(parsed.lastRuns.p1.id, run!.id)
  assert.equal(parsed.lastRuns.p1.status, 'completed')
  assert.equal(parsed.lastRuns.p1.nodeStates.a.output, 'out-a')

  // A fresh store restores the run table from the durable last run.
  const reloaded = createStore({ file })
  await reloaded.load()
  assert.equal(reloaded.listRuns().length, 1)
  assert.equal(reloaded.listRuns()[0].status, 'completed')
  await rm(directory, { recursive: true, force: true })
})

test('deleteRun refuses running runs and removes finished ones', async () => {
  const store = createStore({})
  await store.load()
  const engine = createEngine({
    store,
    runNode: async ({ signal }) => {
      await abortableWait(signal)
      return { output: 'late' }
    },
  })

  // Running run cannot be deleted.
  const runningRun = engine.start(makePipeline()).run
  await waitFor(() => runningRun!.nodeStates.a.status === 'running')
  const refused = await engine.deleteRun(runningRun!.id)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'run-in-progress')
  await engine.stop(runningRun!.id)

  assert.deepEqual(await engine.deleteRun(runningRun!.id), { ok: true })
  const missing = await engine.deleteRun(runningRun!.id)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'run-not-found')

  // Unknown run ids surface as run-not-found for stop too.
  const stopped = await engine.stop('does-not-exist')
  assert.equal(stopped.ok, false)
  assert.equal(stopped.code, 'run-not-found')
})
