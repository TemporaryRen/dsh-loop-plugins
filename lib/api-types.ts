import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createDatabaseManager } from './db.js'
import type { createEngine } from './engine.js'
import type { createLoopEngine } from './loopengine.js'
import type { createStore } from './store.js'

/** Structural Cordis surface used by the plugin entry. */
export interface ApiHostContext {
  logger?: { warn?: (message: string) => void }
  connection: { requestRejection(request: IncomingMessage): unknown }
  // Host service names and implementations are supplied by the active composition.
  get(serviceName: 'sessionController'): { modelCatalog?: () => Promise<HostModelCatalog> } | undefined
  get(serviceName: 'llm'):
    | {
        listProviders?: () => Array<{ id?: unknown; name?: unknown } | null>
        listModels?: (provider: string) => Promise<unknown[]>
      }
    | undefined
  get(serviceName: string): any
  effect(setup: () => unknown, description: string): unknown
  webServer: {
    register(route: {
      kind: 'prefix'
      path: string
      handler(request: IncomingMessage, response: ServerResponse): void
    }): unknown
  }
}

export interface RequestHandlerOptions {
  ctx: ApiHostContext
  store: ReturnType<typeof createStore>
  engine: ReturnType<typeof createEngine>
  loopEngine: ReturnType<typeof createLoopEngine>
  db: ReturnType<typeof createDatabaseManager>
  dbReady: Promise<void>
  requireAuth: boolean
  ready: Promise<void>
}

export interface HostModelCatalog {
  groups?: Array<{ id?: unknown; name?: unknown; models?: unknown[] } | null>
  default?: { provider?: unknown; model?: unknown } | null
  failures?: Array<{ id?: unknown; name?: unknown; message?: unknown } | null>
}

export interface ModelEntry {
  id: string
  name: string
  description?: string
}
export interface ModelProvider {
  id: string
  name: string
  models: ModelEntry[]
}
export interface ModelsResponse {
  ok: true
  providers: ModelProvider[]
  default?: { provider: string; model: string }
  failures?: { id: string; name: string; message: string }[]
  unavailable?: boolean
  error?: string
}
export interface SkillsResponse {
  ok: true
  skills: Awaited<ReturnType<typeof import('./skills.js').discoverSkills>>
  unavailable?: boolean
  error?: string
}
