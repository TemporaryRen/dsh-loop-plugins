import type {} from '@deepseek-ai/dsh-llm'

/** Register the plugin's existing message provenance with the host's extension seam. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'loop-manager': { kind: 'loop-manager' }
  }
}

/** Structural interfaces for the DSH services consumed by the engines. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface Logger {
  warn?: (message: string) => void
  info?: (message: string) => void
}

/** The service container may contain arbitrary services; consumers narrow them. */
export type ResolveService = (name: string) => unknown

export interface TurnReason {
  kind?: string
  error?: { message?: unknown } | null
  reason?: { kind?: unknown } | null
}

export interface SessionEvent {
  type?: string
  seq?: number
  data?: {
    turn?: unknown
    reason?: TurnReason
    message?: { content?: Array<{ type?: string; text?: unknown; name?: unknown } | null> }
  }
}

export interface HostSession {
  seq?: number
  snapshotEvents(startSeq?: number): SessionEvent[]
}

export interface HostAgent {
  session: HostSession
  cancel(reason: { kind: 'user' }): unknown
  followup(message: unknown): unknown
}

export interface SessionController {
  create(options: { cwd?: string; agentPreset?: string }): Promise<{ sessionId?: string } | undefined>
  resolveAgent(sessionId: string): Promise<{ agent?: HostAgent; error?: unknown } | undefined>
  selectModel?: (selection: ModelSelection & { sessionId: string }) => Promise<unknown>
}

export interface SessionsService {
  flush(session: HostSession): unknown | Promise<unknown>
}

export interface DefaultModelService {
  currentSelection?: () => unknown
}

export interface UserMessageInput {
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'loop-manager' }
}

export type CreateUserMessage = (input: UserMessageInput) => unknown
