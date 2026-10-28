import type { Run, LoopRun } from '../lib/types.js'
/**
 * Unit tests for lib/store.js: atomic JSON persistence, last-run bookkeeping,
 * run retention and crash recovery. CONTRACT.md §6.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createStore, MAX_FINISHED_RUNS_PER_PIPELINE } from '../lib/store.js'

/** Create a throwaway directory and its state.json path. */
async function tempStoreFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'loop-manager-store-'))
  return { directory, file: path.join(directory, 'nested', 'state.json') }
}

/** Simple pipeline record. */
function pipeline(id = 'p1', extra: any = {}) {
  return {
    id,
    name: `pipeline-${id}`,
    nodes: [{ id: 'a', title: 'A', prompt: 'hello' }],
    edges: [] as any[],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

/** Simple run record. */
function run(id: string, pipelineId = 'p1', status: Run['status'] = 'completed', startedAt = 1): Run {
  return {
    id,
    pipelineId,
    status,
    startedAt,
    ...(status === 'running' ? {} : { finishedAt: startedAt + 1 }),
    order: ['a'],
    nodeStates: { a: { status: 'completed' } },
  }
}

/** Simple Loop record (v9, CONTRACT.md §13.1). */
function loop(id = 'loop-1', extra: any = {}) {
  return {
    id,
    name: `loop-${id}`,
    desc: '',
    icon: '⟳',
    color: '',
    star: false,
    steps: [
      {
        id: 's1',
        pipelineId: 'p1',
        gate: { id: 's1-gate', name: '门禁', type: 'agent', command: '是否完成', autoLoop: false, maxIterations: 3 },
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

/** Simple LoopRun record (v9, CONTRACT.md §13.3). */
function loopRun(id: string, loopId = 'loop-1', status: LoopRun['status'] = 'completed', startedAt = 1): LoopRun {
  return {
    id,
    loopId,
    loopName: `loop-${loopId}`,
    status,
    startedAt,
    ...(status === 'running' || status === 'awaiting' ? {} : { finishedAt: startedAt + 1 }),
    order: ['s1'],
    stepStates: {
      s1: { status: status === 'completed' ? 'completed' : 'awaiting', iteration: 1, gateStatus: 'passed' },
    },
  }
}

test('load on a missing file yields an empty library', async () => {
  const { file } = await tempStoreFile()
  const store = createStore({ file })
  await store.load()
  assert.deepEqual(store.listPipelines(), [])
  assert.deepEqual(store.listRuns(), [])
  assert.deepEqual(store.listLoops(), [])
  assert.deepEqual(store.listLoopRuns(), [])
  assert.equal(store.getPipeline('nope'), undefined)
  assert.equal(store.getLoop('nope'), undefined)
  assert.equal(store.getLoopRun('nope'), undefined)
})

test('upsertPipeline writes an atomic state file that a new store loads', async () => {
  const { directory, file } = await tempStoreFile()
  const store = createStore({ file })
  await store.load()
  await store.upsertPipeline(pipeline())
  await store.saveLastRun('p1', run('r1'))

  const text = await readFile(file, 'utf8')
  const parsed = JSON.parse(text)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.pipelines.length, 1)
  assert.equal(parsed.lastRuns.p1.id, 'r1')

  // No temp files may survive a successful write.
  const entries = await readdir(path.join(directory, 'nested'))
  assert.deepEqual(entries, ['state.json'])

  const reloaded = createStore({ file })
  await reloaded.load()
  assert.equal(reloaded.listPipelines().length, 1)
  assert.equal(reloaded.listPipelines()[0].name, 'pipeline-p1')
  assert.equal(reloaded.listRuns().length, 1)
  assert.equal(reloaded.listRuns()[0].id, 'r1')
  await rm(directory, { recursive: true, force: true })
})

test('corrupt JSON is reported and replaced by the next write', async () => {
  const { directory, file } = await tempStoreFile()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '{not json', 'utf8')
  const warnings: any[] = []
  const store = createStore({ file, logger: { warn: (message) => warnings.push(message) } })
  await store.load()
  assert.deepEqual(store.listPipelines(), [])
  assert.ok(warnings.some((message) => /not valid JSON/.test(message)))

  await store.upsertPipeline(pipeline())
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(parsed.pipelines.length, 1)
  assert.equal(parsed.pipelines[0].id, 'p1')
  await rm(directory, { recursive: true, force: true })
})

test('an unsupported state version starts empty instead of guessing', async () => {
  const { directory, file } = await tempStoreFile()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 99, pipelines: [pipeline()], lastRuns: {} }), 'utf8')
  const store = createStore({ file, logger: { warn: () => undefined } })
  await store.load()
  assert.deepEqual(store.listPipelines(), [])
  await rm(directory, { recursive: true, force: true })
})

test('a run still marked running after a restart is demoted to failed', async () => {
  const { directory, file } = await tempStoreFile()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(
    file,
    JSON.stringify({ version: 1, pipelines: [] as any[], lastRuns: { p1: run('r-running', 'p1', 'running') } }),
    'utf8',
  )
  const store = createStore({ file, logger: { warn: () => undefined } })
  await store.load()
  const [loaded] = store.listRuns()
  assert.equal(loaded.status, 'failed')
  assert.match(loaded.error as any, /restarted/)
  await rm(directory, { recursive: true, force: true })
})

test('setRun prunes old finished runs but keeps running ones', async () => {
  const { directory, file } = await tempStoreFile()
  const store = createStore({ file })
  await store.load()

  store.setRun(run('running', 'p1', 'running', 0))
  for (let index = 0; index < MAX_FINISHED_RUNS_PER_PIPELINE + 2; index += 1) {
    store.setRun(run(`r${index}`, 'p1', 'completed', index + 1))
  }
  const runs = store.listRuns()
  assert.equal(runs.filter((candidate) => candidate.status === 'running').length, 1)
  assert.equal(runs.filter((candidate) => candidate.status !== 'running').length, MAX_FINISHED_RUNS_PER_PIPELINE)
  // Newest finished runs survive.
  assert.ok(runs.some((candidate) => candidate.id === 'r6'))
  assert.ok(!runs.some((candidate) => candidate.id === 'r0'))

  // Other pipelines are unaffected by this pipeline's pruning.
  store.setRun(run('other', 'p2', 'completed', 100))
  assert.ok(store.listRuns().some((candidate) => candidate.id === 'other'))
  await rm(directory, { recursive: true, force: true })
})

test('removeRun clears the durable last-run pointer', async () => {
  const { directory, file } = await tempStoreFile()
  const store = createStore({ file })
  await store.load()
  await store.upsertPipeline(pipeline())
  store.setRun(run('r1'))
  await store.saveLastRun('p1', run('r1'))
  assert.equal(await store.removeRun('r1'), true)
  assert.equal(store.listRuns().length, 0)
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(parsed.lastRuns, {})
  assert.equal(await store.removeRun('r1'), false)
  await rm(directory, { recursive: true, force: true })
})

test('removePipeline drops its runs and last-run pointer', async () => {
  const { directory, file } = await tempStoreFile()
  const store = createStore({ file })
  await store.load()
  await store.upsertPipeline(pipeline('p1'))
  await store.upsertPipeline(pipeline('p2'))
  store.setRun(run('r1', 'p1'))
  store.setRun(run('r2', 'p2'))
  await store.saveLastRun('p1', run('r1', 'p1'))

  assert.equal(await store.removePipeline('p1'), true)
  assert.equal(await store.removePipeline('p1'), false)
  assert.deepEqual(
    store.listPipelines().map((candidate) => candidate.id),
    ['p2'],
  )
  assert.deepEqual(
    store.listRuns().map((candidate) => candidate.id),
    ['r2'],
  )
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(Object.keys(parsed.lastRuns), [])
  await rm(directory, { recursive: true, force: true })
})

test('a write failure rejects CRUD mutations but saveLastRun only logs', async () => {
  const { directory, file } = await tempStoreFile()
  // Make the target path a directory so the rename cannot succeed.
  await mkdir(file, { recursive: true })
  const warnings: any[] = []
  const store = createStore({ file, logger: { warn: (message) => warnings.push(message) } })
  await store.load()

  await assert.rejects(store.upsertPipeline(pipeline()))
  await store.saveLastRun('p1', run('r1'))
  assert.ok(warnings.some((message) => /could not persist the last run/.test(message)))
  await rm(directory, { recursive: true, force: true })
})

test('local mutations are forwarded to the PostgreSQL mirror hooks', async () => {
  const calls: any[] = []
  const mirror = {
    upsertPipeline: (value: any) => {
      calls.push(['upsertPipeline', value.id])
    },
    removePipeline: (id: any) => {
      calls.push(['removePipeline', id])
    },
    setRun: (value: any) => {
      calls.push(['setRun', value.id])
    },
    removeRun: (id: any) => {
      calls.push(['removeRun', id])
    },
  }
  const store = createStore({ mirror })
  await store.load()
  await store.upsertPipeline(pipeline('p1'))
  store.setRun(run('r1', 'p1'))
  assert.equal(await store.removeRun('r1'), true)
  await store.removePipeline('p1')
  assert.deepEqual(calls, [
    ['upsertPipeline', 'p1'],
    ['setRun', 'r1'],
    ['removeRun', 'r1'],
    ['removePipeline', 'p1'],
  ])
})

// ---------------------------------------------------------------------------
// v9 loops and LoopRuns (CONTRACT.md §13.4)
// ---------------------------------------------------------------------------

test('upsertLoop persists loops to state.json and a fresh store loads them', async () => {
  const { directory, file } = await tempStoreFile()
  const store = createStore({ file })
  await store.load()
  await store.upsertLoop(loop())

  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(parsed.version, 1)
  assert.equal(parsed.loops.length, 1)
  assert.equal(parsed.loops[0].id, 'loop-1')
  assert.equal(parsed.loops[0].steps[0].pipelineId, 'p1')
  assert.deepEqual(parsed.loopRuns, [])
  assert.deepEqual(parsed.lastLoopRuns, {})

  const reloaded = createStore({ file })
  await reloaded.load()
  assert.equal(reloaded.listLoops().length, 1)
  assert.equal(reloaded!.getLoop('loop-1')!.name, 'loop-loop-1')
  assert.deepEqual(reloaded.listLoopRuns(), [])
  await rm(directory, { recursive: true, force: true })
})

test('a state file without loops fields still loads (old format compatibility)', async () => {
  const { directory, file } = await tempStoreFile()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, pipelines: [pipeline()], lastRuns: {} }), 'utf8')
  const store = createStore({ file, logger: { warn: () => undefined } })
  await store.load()
  assert.equal(store.listPipelines().length, 1)
  assert.deepEqual(store.listLoops(), [])
  assert.deepEqual(store.listLoopRuns(), [])
  await rm(directory, { recursive: true, force: true })
})

test('saveLoopRun persists the run and the per-loop lastLoopRun pointer', async () => {
  const { directory, file } = await tempStoreFile()
  const store = createStore({ file })
  await store.load()
  await store.upsertLoop(loop())
  store.setLoopRun(loopRun('lr1'))
  await store.saveLoopRun('loop-1', loopRun('lr1'))

  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(parsed.loopRuns.length, 1)
  assert.equal(parsed.loopRuns[0].id, 'lr1')
  assert.equal(parsed.lastLoopRuns['loop-1'].id, 'lr1')

  const reloaded = createStore({ file })
  await reloaded.load()
  assert.equal(reloaded.listLoopRuns().length, 1)
  assert.equal(reloaded.listLoopRuns()[0].id, 'lr1')
  assert.equal(reloaded.listLoopRuns()[0].status, 'completed')
  assert.equal(reloaded!.getLoopRun('lr1')!.loopId, 'loop-1')
  assert.equal(reloaded!.getLoop('loop-1')!.steps[0].gate.type, 'agent')
  await rm(directory, { recursive: true, force: true })
})

test('removeLoop deletes the loop with its runs and lastLoopRun entry', async () => {
  const { directory, file } = await tempStoreFile()
  const store = createStore({ file })
  await store.load()
  await store.upsertLoop(loop('loop-1'))
  await store.upsertLoop(loop('loop-2'))
  store.setLoopRun(loopRun('lr1', 'loop-1'))
  await store.saveLoopRun('loop-1', loopRun('lr1', 'loop-1'))
  store.setLoopRun(loopRun('lr2', 'loop-2'))
  await store.saveLoopRun('loop-2', loopRun('lr2', 'loop-2'))

  assert.equal(await store.removeLoop('loop-1'), true)
  assert.equal(store.getLoop('loop-1'), undefined)
  assert.deepEqual(
    store.listLoopRuns().map((candidate) => candidate.id),
    ['lr2'],
  )
  assert.equal(store.getLoopRun('lr1'), undefined)
  assert.equal(await store.removeLoop('loop-1'), false)

  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(
    parsed.loops.map((candidate: any) => candidate.id),
    ['loop-2'],
  )
  assert.deepEqual(Object.keys(parsed.lastLoopRuns), ['loop-2'])
  await rm(directory, { recursive: true, force: true })
})

test('removeLoopRun deletes one loop run and reports whether it existed', async () => {
  const { directory, file } = await tempStoreFile()
  const store = createStore({ file })
  await store.load()
  store.setLoopRun(loopRun('lr1'))
  assert.equal(await store.removeLoopRun('lr1'), true)
  assert.deepEqual(store.listLoopRuns(), [])
  assert.equal(await store.removeLoopRun('lr1'), false)
  await rm(directory, { recursive: true, force: true })
})

test('setLoopRun keeps the newest 5 finished runs per loop but never prunes active ones', async () => {
  const store = createStore({})
  await store.load()
  store.setLoopRun(loopRun('lr-running', 'loop-1', 'running', 0))
  store.setLoopRun(loopRun('lr-awaiting', 'loop-1', 'awaiting', 0))
  for (let index = 0; index < 7; index += 1) {
    store.setLoopRun(loopRun(`lr${index}`, 'loop-1', 'completed', index + 1))
  }
  // Another loop's history is unaffected by loop-1's pruning.
  store.setLoopRun(loopRun('other', 'loop-2', 'completed', 100))

  const runs = store.listLoopRuns()
  const loopOneFinished = runs.filter((candidate) => candidate.loopId === 'loop-1' && candidate.status === 'completed')
  assert.equal(loopOneFinished.length, 5)
  assert.ok(
    runs.some((candidate) => candidate.id === 'lr-running'),
    'running runs are never pruned',
  )
  assert.ok(
    runs.some((candidate) => candidate.id === 'lr-awaiting'),
    'awaiting runs are never pruned',
  )
  assert.ok(
    runs.some((candidate) => candidate.id === 'lr6'),
    'the newest finished run survives',
  )
  assert.ok(!runs.some((candidate) => candidate.id === 'lr0'), 'the oldest finished run was pruned')
  assert.ok(runs.some((candidate) => candidate.id === 'other'))
})

test('listLoopRuns returns at most 50 runs newest first', async () => {
  const store = createStore({})
  await store.load()
  for (let index = 0; index < 55; index += 1) {
    store.setLoopRun(loopRun(`lr${index}`, `loop-${Math.floor(index / 5)}`, 'completed', index + 1))
  }
  const runs = store.listLoopRuns()
  assert.equal(runs.length, 50)
  assert.equal(runs[0].id, 'lr54')
  assert.equal(runs[49].id, 'lr5')
  assert.ok(runs.every((candidate, index) => index === 0 || runs[index - 1].startedAt >= candidate.startedAt))
})

test('replaceAll replaces loops and loopRuns with the database snapshot', async () => {
  const store = createStore({})
  await store.load()
  await store.upsertLoop(loop('old'))
  store.setLoopRun(loopRun('lr-old', 'old'))

  store.replaceAll({
    pipelines: [] as any[],
    runs: [] as any[],
    loops: [loop('new')],
    loopRuns: [loopRun('lr-new', 'new')],
  })
  assert.deepEqual(
    store.listLoops().map((candidate) => candidate.id),
    ['new'],
  )
  assert.deepEqual(
    store.listLoopRuns().map((candidate) => candidate.id),
    ['lr-new'],
  )
  assert.equal(store.getLoop('old'), undefined)
  assert.equal(store.getLoopRun('lr-old'), undefined)

  // A snapshot without loop fields clears the loop tables too.
  store.replaceAll({ pipelines: [] as any[], runs: [] })
  assert.deepEqual(store.listLoops(), [])
  assert.deepEqual(store.listLoopRuns(), [])
})

test('loop mutations are forwarded to the PostgreSQL mirror hooks', async () => {
  const calls: any[] = []
  const mirror = {
    upsertLoop: (value: any) => {
      calls.push(['upsertLoop', value.id])
    },
    removeLoop: (id: any) => {
      calls.push(['removeLoop', id])
    },
    setLoopRun: (value: any) => {
      calls.push(['setLoopRun', value.id])
    },
    removeLoopRun: (id: any) => {
      calls.push(['removeLoopRun', id])
    },
  }
  const store = createStore({ mirror })
  await store.load()
  await store.upsertLoop(loop('loop-1'))
  store.setLoopRun(loopRun('lr1'))
  await store.removeLoopRun('lr1')
  await store.removeLoop('loop-1')
  assert.deepEqual(calls, [
    ['upsertLoop', 'loop-1'],
    ['setLoopRun', 'lr1'],
    ['removeLoopRun', 'lr1'],
    ['removeLoop', 'loop-1'],
  ])
})

test('saveLoopRun only logs when the state file cannot be written', async () => {
  const { directory, file } = await tempStoreFile()
  // Make the target path a directory so the rename cannot succeed.
  await mkdir(file, { recursive: true })
  const warnings: any[] = []
  const store = createStore({ file, logger: { warn: (message) => warnings.push(message) } })
  await store.load()
  store.setLoopRun(loopRun('lr1'))
  await store.saveLoopRun('loop-1', loopRun('lr1'))
  assert.ok(warnings.some((message) => /could not persist .*loop run/.test(message)))
  await rm(directory, { recursive: true, force: true })
})
