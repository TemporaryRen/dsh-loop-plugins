/** Shared domain contracts for host persistence and execution. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}
export interface PipelineNode {
  id: string
  name: string
  type?: 'agent' | 'skill'
  command?: string
  skill?: string
  model?: ModelSelection
  /** Legacy persisted fields, normalized when loading state. */
  title?: string
  prompt?: string
  skills?: string
  mcp?: string
}
export interface PipelineEdge {
  from: string
  to: string
}
export interface Pipeline {
  id: string
  name: string
  desc?: string
  description?: string
  icon?: string
  color?: string
  star?: boolean
  cwd?: string
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  createdAt: number
  updatedAt: number
}
export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped'
export interface NodeState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  sessionId?: string
  output?: string
  thinking?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}
export interface Run {
  id: string
  pipelineId: string
  pipelineName?: string
  status: RunStatus
  startedAt: number
  finishedAt?: number
  order: string[]
  nodeStates: Record<string, NodeState>
  error?: string
}
export interface LoopGate {
  id?: string
  name: string
  type: 'agent' | 'skill'
  command?: string
  skill?: string
  model?: ModelSelection
  autoLoop: boolean
  maxIterations: number
}
export interface LoopStep {
  id: string
  pipelineId: string
  gate: LoopGate
}
export interface Loop {
  id: string
  name: string
  desc?: string
  description?: string
  icon?: string
  color?: string
  star?: boolean
  steps: LoopStep[]
  createdAt: number
  updatedAt: number
}
export type GateDecision = 'TRUE' | 'FALSE' | 'UNKNOWN'
export interface LoopStepState {
  status: NodeState['status'] | 'awaiting'
  iteration: number
  pipelineRunId?: string
  pipelineStatus?: RunStatus
  pipelineOutput?: string
  gateStatus: 'pending' | 'running' | 'passed' | 'failed' | 'awaiting' | 'skipped'
  decision?: GateDecision
  gateOutput?: string
  gateThinking?: string
  gateSessionId?: string
  gateError?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}
export interface LoopRun {
  id: string
  loopId: string
  loopName: string
  status: RunStatus | 'awaiting'
  startedAt: number
  finishedAt?: number
  order: string[]
  stepStates: Record<string, LoopStepState>
  error?: string
}
export interface Logger {
  warn?: (message: string) => void
  info?: (message: string) => void
}
export interface StateSnapshot {
  pipelines: Pipeline[]
  runs: Run[]
  loops: Loop[]
  loopRuns: LoopRun[]
}
export interface StoreMirror {
  upsertPipeline?: (pipeline: Pipeline) => unknown
  removePipeline?: (id: string) => unknown
  setRun?: (run: Run) => unknown
  removeRun?: (id: string) => unknown
  upsertLoop?: (loop: Loop) => unknown
  removeLoop?: (id: string) => unknown
  setLoopRun?: (run: LoopRun) => unknown
  removeLoopRun?: (id: string) => unknown
}
