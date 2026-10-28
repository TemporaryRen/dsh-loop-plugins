import type { Pipeline, Run, Loop, LoopRun, Logger, StoreMirror, StateSnapshot } from './types.js'

export interface DbConfig {
  version: number
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
  readFromDb: boolean
  updatedAt: number
}
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>
}
export interface DatabaseClient extends Queryable {
  release?(): void
}
export interface DatabasePool extends Queryable {
  connect(): Promise<DatabaseClient>
  end?(): Promise<void>
  on?(event: 'error', listener: (error: unknown) => void): unknown
}
export interface DatabaseDriver {
  Pool: new (options: {
    host: string
    port: number
    database: string
    user: string
    password: string
    ssl?: { rejectUnauthorized: boolean }
    max: number
    connectionTimeoutMillis: number
    idleTimeoutMillis: number
    application_name: string
  }) => DatabasePool
}
export interface DatabaseManagerOptions {
  file?: string
  logger?: Logger
  loadDriver?: () => Promise<DatabaseDriver>
}

/**
 * PostgreSQL persistence for dsh-loop-manager.
 *
 * Local `state.json` stays authoritative for the plugin's own operations. This
 * module mirrors pipelines and runs into PostgreSQL and can serve `/api/state`
 * from the database when the "从数据库读取" switch is on.
 *
 * The `pg` driver is loaded lazily so a deployment without the dependency still
 * mounts the plugin and can use local persistence; database routes then report
 * a clear error instead of crashing the host half.
 *
 * Tables (fixed names, initialized on first successful connection):
 *   loop_manager_meta        key/value metadata incl. schema version
 *   loop_manager_pipelines   one row per pipeline; nodes/edges as JSONB
 *   loop_manager_runs        one row per run; order/nodeStates as JSONB
 *   loop_manager_loops       one row per loop; steps as JSONB
 *   loop_manager_loop_runs   one row per loop run; order/stepStates as JSONB
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Version of the local db-config.json shape. */
export const DB_CONFIG_VERSION = 1

/** Version written into `loop_manager_meta`. */
export const DB_SCHEMA_VERSION = 2

/** Default PostgreSQL port. */
export const DEFAULT_DB_PORT = 5432

/** Every table this plugin owns. */
export const DB_TABLES = [
  'loop_manager_meta',
  'loop_manager_pipelines',
  'loop_manager_runs',
  'loop_manager_loops',
  'loop_manager_loop_runs',
]

/** Default connection budget; the plugin is low-traffic. */
const POOL_MAX = 4

/** Connect timeout for one pool. */
const CONNECT_TIMEOUT_MS = 8_000

/** `pg` is optional at module load; loaded on first use. */
let cachedDriver: DatabaseDriver | undefined

/**
 * Load the `pg` driver through a narrow, testable seam.
 */
async function defaultLoadDriver(): Promise<DatabaseDriver> {
  if (cachedDriver !== undefined) return cachedDriver
  let module
  try {
    module = await import('pg')
  } catch {
    throw new Error('PostgreSQL 驱动 pg 未安装；请在插件目录执行 npm install')
  }
  const driver = module?.default ?? module
  if (driver === null || typeof driver !== 'object' || typeof driver.Pool !== 'function') {
    throw new Error('PostgreSQL 驱动 pg 加载失败（缺少 Pool）')
  }
  cachedDriver = driver as DatabaseDriver
  return driver as DatabaseDriver
}

/**
 * Format an error as a short single-line message.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) as string
  } catch {
    return String(error)
  }
}

/**
 * Validate and normalize one database config.
 *
 * `previous` supplies the saved password when the submitted password is blank,
 * so editing host/port does not require re-typing the secret.
 *
 */
export function normalizeDbConfig(
  input: unknown,
  previous: { password?: string } | null = null,
): {
  version: number
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
  readFromDb: boolean
  updatedAt: number
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('数据库配置必须是一个 JSON 对象')
  }
  const record = input as Record<string, unknown>
  const host = typeof record.host === 'string' ? record.host.trim() : ''
  if (host === '') throw new Error('主机不能为空')
  if (host.length > 255) throw new Error('主机名过长')

  const rawPort =
    record.port === undefined || record.port === null || record.port === '' ? DEFAULT_DB_PORT : Number(record.port)
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    throw new Error('端口必须是 1–65535 的整数')
  }

  const database = typeof record.database === 'string' ? record.database.trim() : ''
  if (database === '') throw new Error('数据库名不能为空')
  if (database.length > 63) throw new Error('数据库名过长')

  const user = typeof record.user === 'string' ? record.user.trim() : ''
  if (user === '') throw new Error('用户名不能为空')
  if (user.length > 63) throw new Error('用户名过长')

  const submittedPassword = typeof record.password === 'string' ? record.password : ''
  const previousPassword =
    previous !== null && typeof previous === 'object' && typeof previous.password === 'string' ? previous.password : ''
  const password = submittedPassword === '' ? previousPassword : submittedPassword
  if (password.length > 2048) throw new Error('密码过长')

  return {
    version: DB_CONFIG_VERSION,
    host,
    port: rawPort,
    database,
    user,
    password,
    ssl: record.ssl === true,
    readFromDb: record.readFromDb === true,
    updatedAt: Date.now(),
  }
}

/**
 * Strip the secret from one config before it crosses the HTTP boundary.
 */
export function publicDbConfig(config: {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
  readFromDb: boolean
}): {
  host: string
  port: number
  database: string
  user: string
  ssl: boolean
  readFromDb: boolean
  hasPassword: boolean
} {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ssl: config.ssl === true,
    readFromDb: config.readFromDb === true,
    hasPassword: typeof config.password === 'string' && config.password !== '',
  }
}

/**
 * Map one `loop_manager_pipelines` row to the local Pipeline shape.
 */
export function rowToPipeline(row: Record<string, unknown>): Pipeline {
  return {
    id: String(row.id),
    name: typeof row.name === 'string' ? row.name : '',
    desc: typeof row.description === 'string' ? row.description : '',
    icon: typeof row.icon === 'string' && row.icon !== '' ? row.icon : '◈',
    color: typeof row.color === 'string' ? row.color : '',
    star: row.star === true,
    ...(typeof row.cwd === 'string' && row.cwd !== '' ? { cwd: row.cwd } : {}),
    nodes: Array.isArray(row.nodes) ? (row.nodes as Pipeline['nodes']) : [],
    edges: Array.isArray(row.edges) ? (row.edges as Pipeline['edges']) : [],
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  }
}

/**
 * Map one local Pipeline to the ordered parameter list of its upsert.
 */
export function pipelineParams(pipeline: Pipeline): unknown[] {
  return [
    String(pipeline.id),
    typeof pipeline.name === 'string' ? pipeline.name : '',
    typeof pipeline.desc === 'string' ? pipeline.desc : '',
    typeof pipeline.icon === 'string' && pipeline.icon !== '' ? pipeline.icon : '◈',
    typeof pipeline.color === 'string' ? pipeline.color : '',
    pipeline.star === true,
    typeof pipeline.cwd === 'string' && pipeline.cwd !== '' ? pipeline.cwd : null,
    JSON.stringify(Array.isArray(pipeline.nodes) ? pipeline.nodes : []),
    JSON.stringify(Array.isArray(pipeline.edges) ? pipeline.edges : []),
    Number(pipeline.createdAt) || 0,
    Number(pipeline.updatedAt) || 0,
  ]
}

/**
 * Map one `loop_manager_runs` row to the local Run shape.
 */
export function rowToRun(row: Record<string, unknown>): Run {
  return {
    id: String(row.id),
    pipelineId: String(row.pipeline_id),
    pipelineName: typeof row.pipeline_name === 'string' ? row.pipeline_name : '',
    status: typeof row.status === 'string' ? (row.status as Run['status']) : 'failed',
    startedAt: Number(row.started_at) || 0,
    ...(row.finished_at === null || row.finished_at === undefined ? {} : { finishedAt: Number(row.finished_at) }),
    order: Array.isArray(row.order_ids) ? row.order_ids.map(String) : [],
    nodeStates:
      row.node_states !== null && typeof row.node_states === 'object' && !Array.isArray(row.node_states)
        ? (row.node_states as Run['nodeStates'])
        : {},
    ...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
  }
}

/**
 * Map one local Run to the ordered parameter list of its upsert.
 */
export function runParams(run: Run): unknown[] {
  return [
    String(run.id),
    String(run.pipelineId),
    typeof run.pipelineName === 'string' ? run.pipelineName : '',
    typeof run.status === 'string' ? run.status : 'failed',
    Number(run.startedAt) || 0,
    run.finishedAt === undefined || run.finishedAt === null ? null : Number(run.finishedAt),
    JSON.stringify(Array.isArray(run.order) ? run.order : []),
    JSON.stringify(run.nodeStates !== null && typeof run.nodeStates === 'object' ? run.nodeStates : {}),
    typeof run.error === 'string' && run.error !== '' ? run.error : null,
    Date.now(),
  ]
}

/**
 * Map one `loop_manager_loops` row to the local Loop shape.
 */
export function rowToLoop(row: Record<string, unknown>): Loop {
  return {
    id: String(row.id),
    name: typeof row.name === 'string' ? row.name : '',
    desc: typeof row.description === 'string' ? row.description : '',
    icon: typeof row.icon === 'string' && row.icon !== '' ? row.icon : '⟳',
    color: typeof row.color === 'string' ? row.color : '',
    star: row.star === true,
    steps: Array.isArray(row.steps) ? (row.steps as Loop['steps']) : [],
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  }
}

/**
 * Map one local Loop to the ordered parameter list of its upsert.
 */
export function loopParams(loop: Loop): unknown[] {
  return [
    String(loop.id),
    typeof loop.name === 'string' ? loop.name : '',
    typeof loop.desc === 'string' ? loop.desc : '',
    typeof loop.icon === 'string' && loop.icon !== '' ? loop.icon : '⟳',
    typeof loop.color === 'string' ? loop.color : '',
    loop.star === true,
    JSON.stringify(Array.isArray(loop.steps) ? loop.steps : []),
    Number(loop.createdAt) || 0,
    Number(loop.updatedAt) || 0,
  ]
}

/**
 * Map one `loop_manager_loop_runs` row to the local LoopRun shape.
 */
export function rowToLoopRun(row: Record<string, unknown>): LoopRun {
  return {
    id: String(row.id),
    loopId: String(row.loop_id),
    loopName: typeof row.loop_name === 'string' ? row.loop_name : '',
    status: typeof row.status === 'string' ? (row.status as LoopRun['status']) : 'failed',
    startedAt: Number(row.started_at) || 0,
    ...(row.finished_at === null || row.finished_at === undefined ? {} : { finishedAt: Number(row.finished_at) }),
    order: Array.isArray(row.order_ids) ? row.order_ids.map(String) : [],
    stepStates:
      row.step_states !== null && typeof row.step_states === 'object' && !Array.isArray(row.step_states)
        ? (row.step_states as LoopRun['stepStates'])
        : {},
    ...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
  }
}

/**
 * Map one local LoopRun to the ordered parameter list of its upsert.
 */
export function loopRunParams(run: LoopRun): unknown[] {
  return [
    String(run.id),
    String(run.loopId),
    typeof run.loopName === 'string' ? run.loopName : '',
    typeof run.status === 'string' ? run.status : 'failed',
    Number(run.startedAt) || 0,
    run.finishedAt === undefined || run.finishedAt === null ? null : Number(run.finishedAt),
    JSON.stringify(Array.isArray(run.order) ? run.order : []),
    JSON.stringify(run.stepStates !== null && typeof run.stepStates === 'object' ? run.stepStates : {}),
    typeof run.error === 'string' && run.error !== '' ? run.error : null,
    Date.now(),
  ]
}

/** DDL executed on every connect; all statements are idempotent. */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS loop_manager_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS loop_manager_pipelines (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     icon TEXT NOT NULL DEFAULT '◈',
     color TEXT NOT NULL DEFAULT '',
     star BOOLEAN NOT NULL DEFAULT FALSE,
     cwd TEXT,
     nodes JSONB NOT NULL,
     edges JSONB NOT NULL,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS loop_manager_runs (
     id TEXT PRIMARY KEY,
     pipeline_id TEXT NOT NULL,
     pipeline_name TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,
     started_at BIGINT NOT NULL,
     finished_at BIGINT,
     order_ids JSONB NOT NULL,
     node_states JSONB NOT NULL,
     error TEXT,
     updated_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS loop_manager_loops (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     icon TEXT NOT NULL DEFAULT '⟳',
     color TEXT NOT NULL DEFAULT '',
     star BOOLEAN NOT NULL DEFAULT FALSE,
     steps JSONB NOT NULL,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS loop_manager_loop_runs (
     id TEXT PRIMARY KEY,
     loop_id TEXT NOT NULL,
     loop_name TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,
     started_at BIGINT NOT NULL,
     finished_at BIGINT,
     order_ids JSONB NOT NULL,
     step_states JSONB NOT NULL,
     error TEXT,
     updated_at BIGINT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS loop_manager_runs_pipeline_idx ON loop_manager_runs (pipeline_id)',
  'CREATE INDEX IF NOT EXISTS loop_manager_runs_started_idx ON loop_manager_runs (started_at DESC)',
  'CREATE INDEX IF NOT EXISTS loop_manager_loop_runs_loop_idx ON loop_manager_loop_runs (loop_id)',
  'CREATE INDEX IF NOT EXISTS loop_manager_loop_runs_started_idx ON loop_manager_loop_runs (started_at DESC)',
]

/** Upsert one pipeline row. */
const UPSERT_PIPELINE = `INSERT INTO loop_manager_pipelines
  (id, name, description, icon, color, star, cwd, nodes, edges, created_at, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    icon = EXCLUDED.icon,
    color = EXCLUDED.color,
    star = EXCLUDED.star,
    cwd = EXCLUDED.cwd,
    nodes = EXCLUDED.nodes,
    edges = EXCLUDED.edges,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at`

/** Upsert one run row. */
const UPSERT_RUN = `INSERT INTO loop_manager_runs
  (id, pipeline_id, pipeline_name, status, started_at, finished_at, order_ids, node_states, error, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)
  ON CONFLICT (id) DO UPDATE SET
    pipeline_id = EXCLUDED.pipeline_id,
    pipeline_name = EXCLUDED.pipeline_name,
    status = EXCLUDED.status,
    started_at = EXCLUDED.started_at,
    finished_at = EXCLUDED.finished_at,
    order_ids = EXCLUDED.order_ids,
    node_states = EXCLUDED.node_states,
    error = EXCLUDED.error,
    updated_at = EXCLUDED.updated_at`

/** Upsert one loop row. */
const UPSERT_LOOP = `INSERT INTO loop_manager_loops
  (id, name, description, icon, color, star, steps, created_at, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    icon = EXCLUDED.icon,
    color = EXCLUDED.color,
    star = EXCLUDED.star,
    steps = EXCLUDED.steps,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at`

/** Upsert one loop run row. */
const UPSERT_LOOP_RUN = `INSERT INTO loop_manager_loop_runs
  (id, loop_id, loop_name, status, started_at, finished_at, order_ids, step_states, error, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)
  ON CONFLICT (id) DO UPDATE SET
    loop_id = EXCLUDED.loop_id,
    loop_name = EXCLUDED.loop_name,
    status = EXCLUDED.status,
    started_at = EXCLUDED.started_at,
    finished_at = EXCLUDED.finished_at,
    order_ids = EXCLUDED.order_ids,
    step_states = EXCLUDED.step_states,
    error = EXCLUDED.error,
    updated_at = EXCLUDED.updated_at`

/**
 * Ensure every table/index exists and the schema version is recorded.
 */
export async function initializeSchema(queryable: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await queryable.query(statement)
  }
  await queryable.query(
    'INSERT INTO loop_manager_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    ['schema_version', String(DB_SCHEMA_VERSION)],
  )
}

/**
 * Insert or update one pipeline through a pool/client.
 */
async function writePipeline(queryable: Queryable, pipeline: Pipeline): Promise<void> {
  await queryable.query(UPSERT_PIPELINE, pipelineParams(pipeline))
}

/**
 * Insert or update one run through a pool/client.
 */
async function writeRun(queryable: Queryable, run: Run): Promise<void> {
  await queryable.query(UPSERT_RUN, runParams(run))
}

/**
 * Insert or update one loop through a pool/client.
 */
async function writeLoop(queryable: Queryable, loop: Loop): Promise<void> {
  await queryable.query(UPSERT_LOOP, loopParams(loop))
}

/**
 * Insert or update one loop run through a pool/client.
 */
async function writeLoopRun(queryable: Queryable, run: LoopRun): Promise<void> {
  await queryable.query(UPSERT_LOOP_RUN, loopRunParams(run))
}

/**
 * Create the PostgreSQL persistence manager.
 *
 */
export function createDatabaseManager({
  file = undefined,
  logger = undefined,
  loadDriver = undefined,
}: DatabaseManagerOptions = {}) {
  const warn = (message: string) => {
    try {
      logger?.warn?.(`loop-manager db: ${message}`)
    } catch {
      // ignore logger failures
    }
  }

  let config: DbConfig | null = null
  let pool: DatabasePool | null = null
  let driver: DatabaseDriver | null = null
  const status = {
    connected: false,
    initialized: false,
    error: null as string | null,
    lastCheckedAt: null as number | null,
  }

  /** Serialized mirror queue; errors never poison later writes. */
  let mirrorChain = Promise.resolve()
  let mirrorPending = 0

  function recordError(error: unknown) {
    status.connected = false
    status.error = messageOf(error)
    status.lastCheckedAt = Date.now()
    warn(status.error)
  }

  async function getDriver() {
    if (driver !== null) return driver as DatabaseDriver
    driver = await (typeof loadDriver === 'function' ? loadDriver() : defaultLoadDriver())
    return driver as DatabaseDriver
  }

  /**
   * Build a pool for one config and wait for a connection.
   */
  async function createPool(candidate: DbConfig) {
    const loaded = await getDriver()
    if (loaded === null || typeof loaded !== 'object' || typeof loaded.Pool !== 'function') {
      throw new Error('PostgreSQL 驱动不可用')
    }
    const next = new loaded.Pool({
      host: candidate.host,
      port: candidate.port,
      database: candidate.database,
      user: candidate.user,
      password: candidate.password,
      ssl: candidate.ssl === true ? { rejectUnauthorized: false } : undefined,
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      application_name: 'dsh-loop-manager',
    })
    // Idle pool clients emit `error` when the server drops the socket; without
    // a listener node crashes the whole host process. Record it and let the
    // next explicit operation decide whether to reconnect.
    next.on?.('error', (error: unknown) => {
      recordError(error)
    })
    try {
      await next.query('SELECT 1')
      return next
    } catch (error) {
      await next.end?.().catch?.(() => undefined)
      throw error
    }
  }

  /**
   * Replace the live pool, closing the previous one asynchronously.
   */
  function installPool(next: DatabasePool): void {
    const previous = pool
    pool = next
    status.connected = true
    status.initialized = true
    status.error = null
    status.lastCheckedAt = Date.now()
    if (previous !== null && previous !== next) {
      Promise.resolve(previous.end?.()).catch((error) => warn(`close previous pool: ${messageOf(error)}`))
    }
  }

  /**
   * Persist config with owner-only permissions.
   */
  async function persistConfig(next: DbConfig): Promise<void> {
    if (typeof file !== 'string' || file === '') return
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(file, 0o600).catch(() => undefined)
  }

  /**
   * Run one mirror operation on the queue.
   */
  function enqueue(label: string, operation: (queryable: Queryable) => Promise<unknown>): Promise<void> {
    if (config === null || pool === null) return Promise.resolve()
    const target = pool
    mirrorPending += 1
    const task = mirrorChain
      .then(() => operation(target))
      .then(() => {
        status.connected = true
        status.error = null
        status.lastCheckedAt = Date.now()
      })
      .catch((error) => {
        recordError(error)
      })
      .finally(() => {
        mirrorPending -= 1
      })
    mirrorChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  const ready: Promise<void> = (async () => {
    if (typeof file !== 'string' || file === '') return
    let raw
    try {
      raw = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') {
        warn(`could not read ${file}: ${messageOf(error)}`)
        status.error = messageOf(error)
      }
      return
    }
    try {
      config = normalizeDbConfig(raw, null)
    } catch (error) {
      warn(`invalid ${file}: ${messageOf(error)}`)
      status.error = messageOf(error)
      return
    }
    try {
      const next = await createPool(config)
      await initializeSchema(next)
      installPool(next)
    } catch (error) {
      recordError(error)
    }
  })()

  /**
   * Wait for queued mirror writes. Returns false when the timeout fires.
   */
  async function flushMirror(timeoutMs: number = 2_500): Promise<boolean> {
    if (mirrorPending === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
    })
    const result = await Promise.race([mirrorChain.then(() => true), timeout])
    clearTimeout(timer)
    return result === true
  }

  function buildPublicStatus() {
    return {
      configured: config !== null,
      readFromDb: config !== null && config.readFromDb === true,
      connected: status.connected,
      initialized: status.initialized,
      error: status.error,
      lastCheckedAt: status.lastCheckedAt,
      config: config === null ? null : publicDbConfig(config),
    }
  }

  const mirror: StoreMirror = {
    upsertPipeline(pipeline: Pipeline) {
      return enqueue('upsert pipeline', (queryable) => writePipeline(queryable, pipeline))
    },

    removePipeline(id: string) {
      return enqueue('remove pipeline', async (queryable) => {
        await queryable.query('DELETE FROM loop_manager_runs WHERE pipeline_id = $1', [String(id)])
        await queryable.query('DELETE FROM loop_manager_pipelines WHERE id = $1', [String(id)])
      })
    },

    setRun(run: Run) {
      return enqueue('upsert run', (queryable) => writeRun(queryable, run))
    },

    removeRun(runId: string) {
      return enqueue('remove run', (queryable) =>
        queryable.query('DELETE FROM loop_manager_runs WHERE id = $1', [String(runId)]),
      )
    },

    upsertLoop(loop: Loop) {
      return enqueue('upsert loop', (queryable) => writeLoop(queryable, loop))
    },

    removeLoop(id: string) {
      return enqueue('remove loop', async (queryable) => {
        await queryable.query('DELETE FROM loop_manager_loop_runs WHERE loop_id = $1', [String(id)])
        await queryable.query('DELETE FROM loop_manager_loops WHERE id = $1', [String(id)])
      })
    },

    setLoopRun(run: LoopRun) {
      return enqueue('upsert loop run', (queryable) => writeLoopRun(queryable, run))
    },

    removeLoopRun(runId: string) {
      return enqueue('remove loop run', (queryable) =>
        queryable.query('DELETE FROM loop_manager_loop_runs WHERE id = $1', [String(runId)]),
      )
    },
  }

  return {
    /** Resolves once the startup config load/connect attempt settles. */
    ready,

    /**
     * Persist and connect a new configuration, initializing the schema.
     * On failure neither the file nor the live pool is changed.
     */
    async configure(input: unknown) {
      const next = normalizeDbConfig(input, config)
      await flushMirror()
      const nextPool = await createPool(next)
      try {
        await initializeSchema(nextPool)
      } catch (error) {
        await nextPool.end?.().catch?.(() => undefined)
        throw error
      }
      try {
        await persistConfig(next)
      } catch (error) {
        await nextPool.end?.().catch?.(() => undefined)
        throw error
      }
      config = next
      installPool(nextPool)
      return buildPublicStatus()
    },

    /**
     * Test one connection and initialize its schema without saving it.
     */
    async test(input: unknown): Promise<{ connected: true; initialized: true }> {
      const next = normalizeDbConfig(input, config)
      const nextPool = await createPool(next)
      try {
        await initializeSchema(nextPool)
      } finally {
        await nextPool.end?.().catch?.(() => undefined)
      }
      return { connected: true, initialized: true }
    },

    readFromDb(): boolean {
      return config !== null && config.readFromDb === true
    },

    connected(): boolean {
      return config !== null && pool !== null && status.connected
    },

    publicStatus() {
      return buildPublicStatus()
    },

    async loadState(): Promise<StateSnapshot> {
      if (pool === null) throw new Error('数据库未连接')
      // Sequential reads: PGlite-style single-connection servers reset the
      // socket when a second connection arrives concurrently.
      const pipelines = await pool.query('SELECT * FROM loop_manager_pipelines ORDER BY created_at ASC')
      const runs = await pool.query('SELECT * FROM loop_manager_runs ORDER BY started_at DESC LIMIT 50')
      const loops = await pool.query('SELECT * FROM loop_manager_loops ORDER BY created_at ASC')
      const loopRuns = await pool.query('SELECT * FROM loop_manager_loop_runs ORDER BY started_at DESC LIMIT 50')
      status.connected = true
      status.error = null
      status.lastCheckedAt = Date.now()
      return {
        pipelines: (pipelines.rows ?? []).map(rowToPipeline),
        runs: (runs.rows ?? []).map(rowToRun),
        loops: (loops.rows ?? []).map(rowToLoop),
        loopRuns: (loopRuns.rows ?? []).map(rowToLoopRun),
      }
    },

    /**
     * Import local data when the database has no pipelines yet (first init).
     * Loops and loop runs are imported in the same transaction (§13.4).
     */
    async backfillIfEmpty(
      pipelines?: Pipeline[],
      runs?: Run[],
      loops?: Loop[],
      loopRuns?: LoopRun[],
    ): Promise<{ importedPipelines: number; importedRuns: number; importedLoops: number; importedLoopRuns: number }> {
      const imported = { importedPipelines: 0, importedRuns: 0, importedLoops: 0, importedLoopRuns: 0 }
      if (pool === null) return imported
      const pipelineList = Array.isArray(pipelines) ? pipelines : []
      const runList = Array.isArray(runs) ? runs : []
      const loopList = Array.isArray(loops) ? loops : []
      const loopRunList = Array.isArray(loopRuns) ? loopRuns : []
      if (pipelineList.length === 0 && loopList.length === 0) return imported
      const counted = await pool.query('SELECT COUNT(*)::int AS count FROM loop_manager_pipelines')
      const count = Number(counted.rows?.[0]?.count) || 0
      if (count > 0) return imported
      const client = await pool.connect()
      let pipelineCount = 0
      let runCount = 0
      let loopCount = 0
      let loopRunCount = 0
      try {
        await client.query('BEGIN')
        for (const pipeline of pipelineList) {
          await writePipeline(client, pipeline)
          pipelineCount += 1
        }
        for (const run of runList) {
          await writeRun(client, run)
          runCount += 1
        }
        for (const loop of loopList) {
          await writeLoop(client, loop)
          loopCount += 1
        }
        for (const loopRun of loopRunList) {
          await writeLoopRun(client, loopRun)
          loopRunCount += 1
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release?.()
      }
      status.connected = true
      status.error = null
      imported.importedPipelines = pipelineCount
      imported.importedRuns = runCount
      imported.importedLoops = loopCount
      imported.importedLoopRuns = loopRunCount
      return imported
    },

    /**
     * Wait for queued mirror writes. Returns false when the timeout fires.
     */
    async flush(timeoutMs: number = 2_500): Promise<boolean> {
      return flushMirror(timeoutMs)
    },

    /** Mirror hooks consumed by `createStore`. */
    mirror,

    /**
     * Close the live pool after pending mirror writes settle.
     */
    async close(): Promise<void> {
      await flushMirror()
      const previous = pool
      pool = null
      status.connected = false
      if (previous !== null) await previous.end?.().catch?.((error) => warn(`close pool: ${messageOf(error)}`))
    },
  }
}
