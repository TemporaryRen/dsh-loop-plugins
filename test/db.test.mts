/**
 * Unit tests for lib/db.js: config normalization, row mapping, schema
 * initialization, backfill and mirroring against an injected fake pg driver.
 * No real PostgreSQL server is needed here; scripts/VERIFY-NOTES.md §15 covers
 * the live wire-protocol path against PGlite.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DB_SCHEMA_VERSION,
  createDatabaseManager,
  initializeSchema,
  loopParams,
  loopRunParams,
  pipelineParams,
  publicDbConfig,
  normalizeDbConfig,
  rowToLoop,
  rowToLoopRun,
  rowToPipeline,
  rowToRun,
  runParams,
} from '../lib/db.js'

/** Build a fake pg pool that records SQL and serves empty result sets. */
function createFakePool({
  connectError = null,
  pipelineCount = 0,
  pipelineRows = [],
  runRows = [],
  loopCount = 0,
  loopRows = [],
  loopRunRows = [],
}: any = {}) {
  const queries: any[] = []
  const pool = {
    queries,
    config: null as any,
    ended: false,
    async query(sql: any, params: any) {
      queries.push({ sql: String(sql), params })
      if (connectError !== null && /SELECT 1/.test(String(sql))) throw connectError
      if (/COUNT\(\*\)::int AS count FROM loop_manager_pipelines/.test(String(sql))) {
        return { rows: [{ count: pipelineCount }] }
      }
      if (/COUNT\(\*\)::int AS count FROM loop_manager_loops/.test(String(sql))) {
        return { rows: [{ count: loopCount }] }
      }
      if (/SELECT \* FROM loop_manager_pipelines/.test(String(sql))) return { rows: pipelineRows }
      if (/SELECT \* FROM loop_manager_runs/.test(String(sql))) return { rows: runRows }
      if (/SELECT \* FROM loop_manager_loop_runs/.test(String(sql))) return { rows: loopRunRows }
      if (/SELECT \* FROM loop_manager_loops/.test(String(sql))) return { rows: loopRows }
      return { rows: [] as any[], rowCount: 1 }
    },
    async connect() {
      if (connectError !== null) throw connectError
      return {
        query: (sql: any, params: any) => pool.query(sql, params),
        release() {},
      }
    },
    async end() {
      pool.ended = true
    },
  }
  return pool
}

/** Build a fake pg module around one pool. */
function createFakeDriver(pool: any): any {
  return {
    Pool: function Pool(config: any) {
      pool.config = config
      return pool
    },
  }
}

/** @returns {Promise<string>} a fresh temp db-config.json path. */
async function tempConfigFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'loop-manager-db-'))
  return path.join(directory, 'db-config.json')
}

test('normalizeDbConfig validates fields, defaults the port and keeps a saved password', () => {
  const config = normalizeDbConfig({
    host: ' 127.0.0.1 ',
    port: '5433',
    database: ' loop ',
    user: ' postgres ',
    password: 'secret',
    ssl: true,
    readFromDb: true,
  })
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 5433)
  assert.equal(config.database, 'loop')
  assert.equal(config.user, 'postgres')
  assert.equal(config.password, 'secret')
  assert.equal(config.ssl, true)
  assert.equal(config.readFromDb, true)

  const defaulted = normalizeDbConfig({ host: 'localhost', database: 'db', user: 'u' })
  assert.equal(defaulted.port, 5432)
  assert.equal(defaulted.password, '')
  assert.equal(defaulted.ssl, false)
  assert.equal(defaulted.readFromDb, false)

  const kept = normalizeDbConfig({ host: 'localhost', database: 'db', user: 'u', password: '' }, { password: 'saved' })
  assert.equal(kept.password, 'saved')
  const replaced = normalizeDbConfig(
    { host: 'localhost', database: 'db', user: 'u', password: 'new' },
    { password: 'saved' },
  )
  assert.equal(replaced.password, 'new')
})

test('normalizeDbConfig rejects invalid required fields', () => {
  assert.throws(() => normalizeDbConfig(null), /JSON 对象/)
  assert.throws(() => normalizeDbConfig({ host: '', database: 'db', user: 'u' }), /主机/)
  assert.throws(() => normalizeDbConfig({ host: 'x', port: 0, database: 'db', user: 'u' }), /端口/)
  assert.throws(() => normalizeDbConfig({ host: 'x', port: 70000, database: 'db', user: 'u' }), /端口/)
  assert.throws(() => normalizeDbConfig({ host: 'x', database: '', user: 'u' }), /数据库名/)
  assert.throws(() => normalizeDbConfig({ host: 'x', database: 'db', user: '' }), /用户名/)
})

test('publicDbConfig redacts the password', () => {
  const publicConfig = publicDbConfig({
    host: 'h',
    port: 5432,
    database: 'd',
    user: 'u',
    password: 'p',
    ssl: false,
    readFromDb: true,
  })
  assert.deepEqual(publicConfig, {
    host: 'h',
    port: 5432,
    database: 'd',
    user: 'u',
    ssl: false,
    readFromDb: true,
    hasPassword: true,
  })
  assert.equal('password' in publicConfig, false)
})

test('row mappers round-trip the JSON columns and numeric timestamps', () => {
  const pipeline = {
    id: 'p1',
    name: 'P',
    desc: 'desc',
    icon: '◈',
    color: 'blue',
    star: true,
    cwd: '/tmp',
    nodes: [{ id: 'n1', name: 'N', command: 'hi' }],
    edges: [{ from: 'n1', to: 'n2' }],
    createdAt: 10,
    updatedAt: 20,
  }
  const params = pipelineParams(pipeline)
  const row = {
    id: params[0],
    name: params[1],
    description: params[2],
    icon: params[3],
    color: params[4],
    star: params[5],
    cwd: params[6],
    nodes: JSON.parse(params[7] as any),
    edges: JSON.parse(params[8] as any),
    created_at: String(params[9]),
    updated_at: String(params[10]),
  }
  assert.deepEqual(rowToPipeline(row), pipeline)

  const run = {
    id: 'r1',
    pipelineId: 'p1',
    pipelineName: 'P',
    status: 'completed',
    startedAt: 100,
    finishedAt: 200,
    order: ['n1'],
    nodeStates: { n1: { status: 'completed', output: 'ok', thinking: 'why' } },
  }
  const runValues = runParams(run as any)
  const runRow = {
    id: runValues[0],
    pipeline_id: runValues[1],
    pipeline_name: runValues[2],
    status: runValues[3],
    started_at: String(runValues[4]),
    finished_at: String(runValues[5]),
    order_ids: JSON.parse(runValues[6] as any),
    node_states: JSON.parse(runValues[7] as any),
    error: runValues[8],
  }
  assert.deepEqual(rowToRun(runRow), run)

  // v9: the Loop and LoopRun row mappers use the same snake_case columns as
  // the DDL in CONTRACT.md §13.4.
  const loop = {
    id: 'l1',
    name: 'L',
    desc: 'loop desc',
    icon: '⟳',
    color: 'peach',
    star: true,
    steps: [
      {
        id: 's1',
        pipelineId: 'p1',
        gate: { id: 's1-gate', name: '门禁', type: 'agent', command: 'ok', autoLoop: false, maxIterations: 3 },
      },
    ],
    createdAt: 10,
    updatedAt: 20,
  }
  assert.ok(Array.isArray(loopParams(loop as any)))
  assert.deepEqual(
    rowToLoop({
      id: loop.id,
      name: loop.name,
      description: loop.desc,
      icon: loop.icon,
      color: loop.color,
      star: loop.star,
      steps: loop.steps,
      created_at: String(loop.createdAt),
      updated_at: String(loop.updatedAt),
    }),
    loop,
  )

  const loopRun = {
    id: 'lrun1',
    loopId: 'l1',
    loopName: 'L',
    status: 'completed',
    startedAt: 100,
    finishedAt: 200,
    order: ['s1'],
    stepStates: { s1: { status: 'completed', iteration: 1, gateStatus: 'passed' } },
  }
  assert.ok(Array.isArray(loopRunParams(loopRun as any)))
  assert.deepEqual(
    rowToLoopRun({
      id: loopRun.id,
      loop_id: loopRun.loopId,
      loop_name: loopRun.loopName,
      status: loopRun.status,
      started_at: String(loopRun.startedAt),
      finished_at: String(loopRun.finishedAt),
      order_ids: loopRun.order,
      step_states: loopRun.stepStates,
      error: null,
    }),
    loopRun,
  )
})

test('initializeSchema issues every idempotent DDL statement and records version 2', async () => {
  assert.equal(DB_SCHEMA_VERSION, 2)
  const pool = createFakePool()
  await initializeSchema(pool)
  const sql = pool.queries.map((entry) => entry.sql)
  assert.ok(sql.some((text) => /CREATE TABLE IF NOT EXISTS loop_manager_meta/.test(text)))
  assert.ok(sql.some((text) => /CREATE TABLE IF NOT EXISTS loop_manager_pipelines/.test(text)))
  assert.ok(sql.some((text) => /CREATE TABLE IF NOT EXISTS loop_manager_runs/.test(text)))
  assert.ok(sql.some((text) => /CREATE TABLE IF NOT EXISTS loop_manager_loops/.test(text)))
  assert.ok(sql.some((text) => /CREATE TABLE IF NOT EXISTS loop_manager_loop_runs/.test(text)))
  assert.ok(sql.some((text) => /CREATE INDEX IF NOT EXISTS/.test(text)))
  const meta = pool.queries.find((entry) => /INSERT INTO loop_manager_meta/.test(entry.sql))
  assert.deepEqual(meta.params, ['schema_version', '2'])
})

test('configure initializes the schema, persists an owner-only config, and rejects bad input', async () => {
  const file = await tempConfigFile()
  const pool = createFakePool()
  const manager = createDatabaseManager({ file, loadDriver: async () => createFakeDriver(pool) } as any)
  await manager.ready

  const status = await manager.configure({
    host: '127.0.0.1',
    port: 5432,
    database: 'loop',
    user: 'postgres',
    password: 'secret',
    readFromDb: true,
  })
  assert.equal(status.connected, true)
  assert.equal(status.initialized, true)
  assert.equal(status.readFromDb, true)
  assert.equal(status.config!.hasPassword, true)
  assert.equal(manager.readFromDb(), true)
  assert.equal(manager.connected(), true)
  assert.ok(pool.queries.some((entry) => /CREATE TABLE IF NOT EXISTS loop_manager_pipelines/.test(entry.sql)))
  assert.equal(pool.config.host, '127.0.0.1')
  assert.equal(pool.config.password, 'secret')

  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.host, '127.0.0.1')
  assert.equal(saved.password, 'secret')
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }

  await assert.rejects(() => manager.configure({ host: '', database: 'loop', user: 'postgres' }), /主机/)
  await manager.close()
  assert.equal(pool.ended, true)
})

test('a failed connection leaves the manager disconnected with a readable error', async () => {
  const file = await tempConfigFile()
  const pool = createFakePool({ connectError: new Error('connection refused') })
  const manager = createDatabaseManager({ file, loadDriver: async () => createFakeDriver(pool) } as any)
  await manager.ready
  await assert.rejects(
    () => manager.configure({ host: '127.0.0.1', database: 'loop', user: 'postgres' }),
    /connection refused/,
  )
  assert.equal(manager.connected(), false)
  assert.equal(manager.publicStatus().configured, false, 'a failed configure does not replace the saved config')
  await manager.close()
})

test('backfillIfEmpty imports pipelines/runs/loops/loopRuns only into an empty database', async () => {
  const file = await tempConfigFile()
  const pool = createFakePool({ pipelineCount: 0, loopCount: 0 })
  const manager = createDatabaseManager({ file, loadDriver: async () => createFakeDriver(pool) } as any)
  await manager.ready
  await manager.configure({ host: 'h', database: 'd', user: 'u' })

  const pipeline = {
    id: 'p1',
    name: 'P',
    desc: '',
    icon: '◈',
    color: '',
    star: false,
    nodes: [] as any[],
    edges: [] as any[],
    createdAt: 1,
    updatedAt: 2,
  }
  const run = { id: 'r1', pipelineId: 'p1', status: 'completed', startedAt: 3, order: [] as any[], nodeStates: {} }
  const loop = {
    id: 'l1',
    name: 'L',
    desc: '',
    icon: '⟳',
    color: '',
    star: false,
    steps: [
      {
        id: 's1',
        pipelineId: 'p1',
        gate: { id: 's1-gate', name: '门禁', type: 'agent', command: 'ok', autoLoop: false, maxIterations: 3 },
      },
    ],
    createdAt: 4,
    updatedAt: 5,
  }
  const loopRun = {
    id: 'lrun1',
    loopId: 'l1',
    loopName: 'L',
    status: 'completed',
    startedAt: 6,
    finishedAt: 7,
    order: ['s1'],
    stepStates: { s1: { status: 'completed', iteration: 1, gateStatus: 'passed' } },
  }
  const imported = await manager.backfillIfEmpty([pipeline], [run] as any, [loop] as any, [loopRun] as any)
  assert.deepEqual(imported, { importedPipelines: 1, importedRuns: 1, importedLoops: 1, importedLoopRuns: 1 })
  const insertedLoops = pool.queries.filter((entry) => /INSERT INTO loop_manager_loops/.test(entry.sql))
  const insertedLoopRuns = pool.queries.filter((entry) => /INSERT INTO loop_manager_loop_runs/.test(entry.sql))
  assert.equal(pool.queries.filter((entry) => /INSERT INTO loop_manager_pipelines/.test(entry.sql)).length, 1)
  assert.equal(pool.queries.filter((entry) => /INSERT INTO loop_manager_runs/.test(entry.sql)).length, 1)
  assert.equal(insertedLoops.length, 1)
  assert.equal(insertedLoopRuns.length, 1)

  // The old two-argument call still works and reports the loop counters.
  const legacyPool = createFakePool({ pipelineCount: 0, loopCount: 0 })
  const legacyManager = createDatabaseManager({
    file: await tempConfigFile(),
    loadDriver: async () => createFakeDriver(legacyPool),
  } as any)
  await legacyManager.ready
  await legacyManager.configure({ host: 'h', database: 'd', user: 'u' })
  assert.deepEqual(await legacyManager.backfillIfEmpty([pipeline], [run] as any), {
    importedPipelines: 1,
    importedRuns: 1,
    importedLoops: 0,
    importedLoopRuns: 0,
  })

  const nonEmptyPool = createFakePool({ pipelineCount: 3 })
  const nonEmptyManager = createDatabaseManager({
    file: await tempConfigFile(),
    loadDriver: async () => createFakeDriver(nonEmptyPool),
  } as any)
  await nonEmptyManager.ready
  await nonEmptyManager.configure({ host: 'h', database: 'd', user: 'u' })
  assert.deepEqual(await nonEmptyManager.backfillIfEmpty([pipeline], [run] as any, [loop] as any, [loopRun] as any), {
    importedPipelines: 0,
    importedRuns: 0,
    importedLoops: 0,
    importedLoopRuns: 0,
  })
  await manager.close()
  await legacyManager.close()
  await nonEmptyManager.close()
})

test('mirror hooks queue parameterized upserts and deletes', async () => {
  const file = await tempConfigFile()
  const pool = createFakePool()
  const manager = createDatabaseManager({ file, loadDriver: async () => createFakeDriver(pool) } as any)
  await manager.ready
  await manager.configure({ host: 'h', database: 'd', user: 'u' })

  const pipeline = {
    id: 'p1',
    name: 'P',
    desc: '',
    icon: '◈',
    color: '',
    star: false,
    nodes: [] as any[],
    edges: [] as any[],
    createdAt: 1,
    updatedAt: 2,
  }
  const run = {
    id: 'r1',
    pipelineId: 'p1',
    status: 'running',
    startedAt: 3,
    order: ['n1'],
    nodeStates: { n1: { status: 'running' } },
  }
  const loop = {
    id: 'l1',
    name: 'L',
    desc: '',
    icon: '⟳',
    color: '',
    star: false,
    steps: [
      {
        id: 's1',
        pipelineId: 'p1',
        gate: { id: 's1-gate', name: '门禁', type: 'agent', command: 'ok', autoLoop: false, maxIterations: 3 },
      },
    ],
    createdAt: 4,
    updatedAt: 5,
  }
  const loopRun = {
    id: 'lrun1',
    loopId: 'l1',
    loopName: 'L',
    status: 'running',
    startedAt: 6,
    order: ['s1'],
    stepStates: { s1: { status: 'running', iteration: 1, gateStatus: 'running' } },
  }
  manager!.mirror.upsertPipeline!(pipeline)
  manager!.mirror.setRun!(run as any)
  manager!.mirror.removeRun!('r-old')
  manager!.mirror.removePipeline!('p-old')
  manager!.mirror.upsertLoop!(loop as any)
  manager!.mirror.setLoopRun!(loopRun as any)
  manager!.mirror.removeLoopRun!('lrun-old')
  manager!.mirror.removeLoop!('l-old')
  assert.equal(await manager.flush(), true)

  const sql = pool.queries.map((entry) => entry.sql)
  assert.ok(sql.some((text) => /INSERT INTO loop_manager_pipelines/.test(text)))
  assert.ok(sql.some((text) => /INSERT INTO loop_manager_runs/.test(text)))
  assert.ok(sql.some((text) => /DELETE FROM loop_manager_runs WHERE id = \$1/.test(text)))
  assert.ok(sql.some((text) => /DELETE FROM loop_manager_runs WHERE pipeline_id = \$1/.test(text)))
  assert.ok(sql.some((text) => /DELETE FROM loop_manager_pipelines WHERE id = \$1/.test(text)))
  assert.ok(sql.some((text) => /INSERT INTO loop_manager_loops/.test(text)))
  assert.ok(sql.some((text) => /INSERT INTO loop_manager_loop_runs/.test(text)))
  assert.ok(sql.some((text) => /DELETE FROM loop_manager_loop_runs WHERE id = \$1/.test(text)))
  assert.ok(sql.some((text) => /DELETE FROM loop_manager_loop_runs WHERE loop_id = \$1/.test(text)))
  assert.ok(sql.some((text) => /DELETE FROM loop_manager_loops WHERE id = \$1/.test(text)))
  assert.equal(manager.publicStatus().error, null)
  await manager.close()
})

test('loadState maps database rows back to local shapes (pipelines, runs, loops, loopRuns)', async () => {
  const file = await tempConfigFile()
  const pipelineRows = [
    {
      id: 'p1',
      name: 'P',
      description: 'd',
      icon: '◈',
      color: '',
      star: false,
      cwd: null,
      nodes: [{ id: 'n1', name: 'N', command: 'hi' }],
      edges: [] as any[],
      created_at: '1',
      updated_at: '2',
    },
  ]
  const runRows = [
    {
      id: 'r1',
      pipeline_id: 'p1',
      pipeline_name: 'P',
      status: 'completed',
      started_at: '3',
      finished_at: '4',
      order_ids: ['n1'],
      node_states: { n1: { status: 'completed' } },
      error: null,
    },
  ]
  const loopRows = [
    {
      id: 'l1',
      name: 'L',
      description: 'loop desc',
      icon: '⟳',
      color: 'blue',
      star: true,
      steps: [
        {
          id: 's1',
          pipelineId: 'p1',
          gate: { id: 's1-gate', name: '门禁', type: 'agent', command: 'ok', autoLoop: false, maxIterations: 3 },
        },
      ],
      created_at: '5',
      updated_at: '6',
    },
  ]
  const loopRunRows = [
    {
      id: 'lrun1',
      loop_id: 'l1',
      loop_name: 'L',
      status: 'awaiting',
      started_at: '7',
      finished_at: null,
      order_ids: ['s1'],
      step_states: { s1: { status: 'awaiting', iteration: 1, gateStatus: 'awaiting' } },
      error: null,
      updated_at: '8',
    },
  ]
  const pool = createFakePool({ pipelineRows, runRows, loopRows, loopRunRows })
  const manager = createDatabaseManager({ file, loadDriver: async () => createFakeDriver(pool) } as any)
  await manager.ready
  await manager.configure({ host: 'h', database: 'd', user: 'u' })
  const state = await manager.loadState()
  assert.equal(state.pipelines.length, 1)
  assert.equal(state.pipelines[0].id, 'p1')
  assert.equal(state.pipelines[0].nodes[0].name, 'N')
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].id, 'r1')
  assert.equal(state.runs[0].pipelineName, 'P')
  assert.equal(state.loops.length, 1)
  assert.equal(state.loops[0].id, 'l1')
  assert.equal(state.loops[0].desc, 'loop desc')
  assert.equal(state.loops[0].steps[0].pipelineId, 'p1')
  assert.equal(state.loopRuns.length, 1)
  assert.equal(state.loopRuns[0].id, 'lrun1')
  assert.equal(state.loopRuns[0].loopName, 'L')
  assert.deepEqual(state.loopRuns[0].order, ['s1'])
  assert.equal(state.loopRuns[0].stepStates.s1.gateStatus, 'awaiting')
  assert.equal('finishedAt' in state.loopRuns[0], false, 'a null finished_at is omitted')
  await manager.close()
})
