/** Browser-only host and workbench contracts. No runtime module is emitted. */
type ClientDisposer = () => void
interface ClientReactElement {
  readonly type: unknown
  readonly props: unknown
  readonly key: string | null
}
interface ClientReactHost {
  createElement(
    type: string,
    props?: Record<string, unknown> | null,
    ...children: ClientReactElement[]
  ): ClientReactElement
  createElement<P>(
    type: (props: P) => ClientReactElement,
    props?: P | null,
    ...children: ClientReactElement[]
  ): ClientReactElement
  useRef<T>(initial: T): { current: T }
  useEffect(effect: () => void | ClientDisposer, dependencies: readonly unknown[]): void
}
interface ClientSlotOwner {
  size?: number
  active?: boolean
}
interface ClientHostContext {
  effect?(effect: () => ClientDisposer, label: string): void
  slots: {
    inject(name: string, setup: () => unknown): void
    register(
      options: { name: string; id?: string; key?: string; order?: number; label?: () => string },
      render: (owner?: ClientSlotOwner) => ClientReactElement,
    ): unknown
  }
}
interface Window {
  __ModuleLoader__: {
    load(module: {
      id: string
      factory: (require: (id: 'react') => ClientReactHost) => {
        name: string
        inject: string[]
        apply(ctx: ClientHostContext): void
      }
    }): void
  }
}
/** Only unnormalised external JSON records use dynamic property values. */
type ClientWireRecord = Record<string, any>
interface ClientModel {
  provider: string
  model: string
}
interface ClientNode {
  id: string
  name: string
  type: string
  command: string
  skill?: string
  model?: ClientModel | null
}
interface ClientGate extends ClientNode {
  skill: string
  model: ClientModel | null
  autoLoop: boolean
  maxIterations: number
}
interface ClientPipeline {
  id: string
  name: string
  desc: string
  icon: string
  color: string
  star: boolean
  nodes: ClientNode[]
  edges: [string, string][]
  createdAt: number
  updatedAt: number
}
interface ClientStep {
  id: string
  pipelineId: string
  gate: ClientGate
}
interface ClientLoop {
  id: string
  name: string
  desc: string
  icon: string
  color: string
  star: boolean
  steps: ClientStep[]
  createdAt: number
  updatedAt: number
}
interface ClientLoopDraft extends Omit<ClientLoop, 'id' | 'createdAt' | 'updatedAt'> {
  loopId: string | null
}
interface ClientNodeDraft {
  type: string
  name: string
  command: string
  skill: string
  model: ClientModel | null
}
interface ClientNodeState {
  status?: string
  startedAt?: number
  finishedAt?: number
  thinking?: string
  output?: string
  error?: string
}
interface ClientRun {
  id: string
  pipelineId: string
  pipelineName?: string
  status: string
  startedAt: number
  finishedAt?: number
  order: string[]
  nodeStates: Record<string, ClientNodeState>
  error?: string
  loopRunId?: string
}
interface ClientStepState {
  status?: string
  iteration?: number
  pipelineStatus?: string
  pipelineRunId?: string
  pipelineRunIds?: string[]
  gateStatus?: string
  decision?: string
  gateError?: string
  gateThinking?: string
  gateOutput?: string
  error?: string
}
interface ClientLoopRun {
  id: string
  loopId: string
  loopName?: string
  status: string
  startedAt: number
  finishedAt?: number
  order: string[]
  stepStates: Record<string, ClientStepState>
  error?: string
}
interface ClientSkill {
  name: string
  description?: string
}
interface ClientProvider {
  id: string
  name: string
  models: { id: string; name: string }[]
}
interface ClientDbValues {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
  readFromDb: boolean
}
interface ClientDbStatus {
  config?: Partial<ClientDbValues> & { hasPassword?: boolean }
  readFromDb?: boolean
  connected?: boolean
  configured?: boolean
  error?: string
}
interface ClientApiEnvelope {
  ok: boolean
  error?: string
  code?: string
  pipelines: ClientWireRecord[]
  runs: ClientRun[]
  loops: ClientWireRecord[]
  loopRuns: ClientLoopRun[]
  skills: ClientSkill[]
  providers: ClientProvider[]
  default: ClientModel | null
  failures?: { id?: string; name?: string }[]
  unavailable?: boolean
  pipeline: ClientPipeline
  loop: ClientLoop
  run: ClientRun
  loopRun: ClientLoopRun
  db?: ClientDbStatus
  imported?: {
    importedPipelines: number
    importedRuns: number
    importedLoops?: number
    importedLoopRuns?: number
  }
}
interface ClientApiError extends Error {
  code?: string
  status?: number
  cause?: unknown
}
interface ClientCanvas {
  position: Record<string, { x: number; y: number }>
  width: number
  height: number
}
interface ClientState {
  pipelines: ClientPipeline[]
  runs: ClientRun[]
  loops: ClientLoop[]
  loopRuns: ClientLoopRun[]
  selectedLoop: string | null
  loopDraft: ClientLoopDraft | null
  loading: boolean
  error: string | null
  nav: 'all' | 'loops' | 'recent' | 'star'
  filter: 'all' | 'draft' | 'running' | 'success' | 'error'
  query: string
  sort: 'recent' | 'name'
  selected: string | null
  editingNodeId: string | null
  skills: ClientSkill[]
  skillsLoading: boolean
  skillsError: string | null
  skillsAt: number
  models: ClientProvider[]
  modelsLoading: boolean
  modelsError: string | null
  modelsAt: number
  modelsDefault: ClientModel | null
  busy: string | null
  openThinking: Set<string>
  scrollTop: number
  toastTimer: number | null
}
