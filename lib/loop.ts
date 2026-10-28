/**
 * Pure Loop helpers for dsh-loop-manager (CONTRACT.md §13.2).
 *
 * A Loop pairs one Agent Pipeline with one gate node per step and repeats the
 * pair until the gate decides `TRUE`. This module holds the dependency-free
 * half of that feature: input validation, the aggregated pipeline output the
 * gate judges, the gate prompt template and the decision protocol parser.
 *
 * Like `lib/dag.js` every function is pure: it never mutates its arguments and
 * never throws for malformed input — malformed loops come back as
 * `{ ok: false, code: 'invalid-loop', message }`, malformed decisions parse as
 * `UNKNOWN`.
 *
 */
export interface GatePromptInput {
  gate?: Partial<LoopGate>
  pipeline?: Partial<Pipeline>
  pipelineRun?: Partial<Run>
  pipelineOutput?: string
  stepIndex?: number
  iteration?: number
}

/** Error code shared by every loop-level failure (mapped to HTTP 400 in the API). */
export const LOOP_ERROR_CODE = 'invalid-loop'

/** Hard cap on the number of pipeline + gate pairs in one loop (§13.1). */
export const MAX_LOOP_STEPS = 20

/** Gate output (and the pipeline output it judges) is truncated to this size. */
export const MAX_GATE_OUTPUT_CHARS = 20000

/** Tints the loop icon may use (the design's `.pipeline-icon` variants). */
const ALLOWED_COLORS = new Set(['', 'blue', 'peach', 'purple'])

/** Gate node types (§10). */
const ALLOWED_GATE_TYPES = new Set(['agent', 'skill'])

/** Installed skill names are kebab-case (§10.2). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Placeholder used when a pipeline produced no text at all. */
const EMPTY_PIPELINE_OUTPUT = '（Pipeline 没有产出文本输出）'

/** Message values that may follow `结论:`/`verdict:` (English first, then Chinese). */
const LABELLED_DECISION =
  /(?:结论|结果|判定|verdict|decision)[^\S\r\n]*[:：][^\S\r\n]*[*_`"'「『]*[^\S\r\n]*(TRUE|FALSE|不通过|通过)/i

/** Markdown/quote decorations around a standalone decision line. */
const LINE_PREFIX = /^[\s>*_`~#\-–—•+]+/
const LINE_SUFFIX = /[\s*_`~'"「」『』[\]()（）.。,，!！;；:：、?？]+$/

/**
 * Build a loop validation failure result.
 */
import type { PipelineNode, Pipeline, Run, LoopGate } from './types.js'

function loopError(message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: LOOP_ERROR_CODE, message }
}

/**
 * Normalize the `pipelineIds` option into a membership test.
 * Accepts the documented `Set`, a plain array, or any object with `has`.
 */
function pipelineMatcher(pipelineIds: unknown): ((id: string) => boolean) | undefined {
  if (pipelineIds instanceof Set) return (id) => pipelineIds.has(id)
  if (Array.isArray(pipelineIds)) return (id) => pipelineIds.includes(id)
  if (
    pipelineIds !== null &&
    typeof pipelineIds === 'object' &&
    typeof (pipelineIds as { has(id: string): boolean }).has === 'function'
  ) {
    return (id) => (pipelineIds as { has(id: string): boolean }).has(id)
  }
  return undefined
}

/**
 * Validate one optional/required text field.
 */
function checkText(
  value: unknown,
  { field, max, required = false }: { field: string; max: number; required?: boolean },
): string | undefined {
  if (value === undefined || value === null) {
    return required ? `${field}不能为空` : undefined
  }
  if (typeof value !== 'string') return `${field}必须是字符串`
  const trimmed = value.trim()
  if (required && trimmed === '') return `${field}不能为空`
  if (trimmed.length > max) return `${field}不能超过 ${max} 个字符`
  return undefined
}

/**
 * Validate one gate node of a loop step.
 */
function checkGate(gate: unknown, label: string): string | undefined {
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) return `${label}缺少门禁节点`
  const record = gate as Record<string, unknown>

  if (record.id !== undefined && record.id !== null && (typeof record.id !== 'string' || record.id.trim() === '')) {
    return `${label}门禁 id 必须是非空字符串`
  }
  // Absent name defaults to '门禁'; a submitted empty name is a real mistake.
  if (record.name !== undefined && record.name !== null) {
    const nameError = checkText(record.name, { field: `${label}门禁名称`, max: 40, required: true })
    if (nameError !== undefined) return nameError
  }

  const type = record.type === undefined || record.type === null ? 'agent' : record.type
  if (typeof type !== 'string' || !ALLOWED_GATE_TYPES.has(type)) {
    return `${label}门禁类型必须是 agent 或 skill`
  }
  if (record.autoLoop !== undefined && record.autoLoop !== null && typeof record.autoLoop !== 'boolean') {
    return `${label}门禁的自动循环必须是布尔值`
  }
  if (record.maxIterations !== undefined && record.maxIterations !== null) {
    const maxIterations = record.maxIterations
    if (!Number.isInteger(maxIterations) || (maxIterations as number) < 1 || (maxIterations as number) > 20) {
      return `${label}门禁的自动循环上限必须是 1–20 的整数`
    }
  }
  if (record.model !== undefined && record.model !== null) {
    const model = record.model
    if (model === null || typeof model !== 'object' || Array.isArray(model)) {
      return `${label}门禁的模型格式不正确`
    }
    const modelRecord = model as Record<string, unknown>
    const provider = typeof modelRecord.provider === 'string' ? modelRecord.provider.trim() : ''
    const modelId = typeof modelRecord.model === 'string' ? modelRecord.model.trim() : ''
    if (provider === '' || modelId === '') return `${label}门禁的模型必须同时提供 provider 与 model`
    if (provider.length > 64 || modelId.length > 128) return `${label}门禁的模型参数过长`
  }

  if (type === 'skill') {
    const skill = typeof record.skill === 'string' ? record.skill.trim() : ''
    if (skill === '') return `${label}门禁必须选择一个已安装 Skill`
    if (!KEBAB_CASE.test(skill)) return `${label}门禁的 Skill 名称必须是 kebab-case`
    if (record.command !== undefined && record.command !== null && typeof record.command !== 'string') {
      return `${label}门禁的补充信息必须是字符串`
    }
    return undefined
  }

  if (typeof record.command !== 'string' || record.command.trim() === '') {
    return `${label}门禁的判断要求不能为空`
  }
  return undefined
}

/**
 * Validate a complete loop against the rules in CONTRACT.md §13.2.
 *
 * Callers normalize missing ids/defaults first (the HTTP layer does); every
 * field marked optional by §13.1 may therefore still be absent here and is
 * accepted as its documented default. Step ids are required and globally
 * unique because the run state machine keys `stepStates` by them.
 *
 */
export function validateLoop(
  loop: unknown,
  options: { pipelineIds?: Iterable<string> | { has(id: string): boolean } } = {},
): { ok: true } | { ok: false; code: string; message: string } {
  if (loop === null || typeof loop !== 'object' || Array.isArray(loop)) return loopError('Loop 必须是一个对象')
  const record = loop as Record<string, unknown>

  const nameError = checkText(record.name, { field: 'Loop 名称', max: 50, required: true })
  if (nameError !== undefined) return loopError(nameError)
  const descError = checkText(record.desc ?? record.description, { field: 'Loop 描述', max: 160 })
  if (descError !== undefined) return loopError(descError)
  if (record.icon !== undefined && record.icon !== null) {
    const iconError = checkText(record.icon, { field: 'Loop 图标', max: 4 })
    if (iconError !== undefined) return loopError(iconError)
  }
  if (record.color !== undefined && record.color !== null) {
    if (typeof record.color !== 'string') return loopError('Loop 颜色必须是字符串')
    if (!ALLOWED_COLORS.has(record.color.trim())) {
      return loopError('Loop 颜色必须是 blue / peach / purple 之一（或留空）')
    }
  }
  if (record.star !== undefined && record.star !== null && typeof record.star !== 'boolean') {
    return loopError('Loop 收藏状态必须是布尔值')
  }

  const steps = record.steps
  if (!Array.isArray(steps)) return loopError('Loop 必须包含 steps 数组')
  if (steps.length === 0) return loopError('Loop 至少需要一组 Pipeline + 门禁')
  if (steps.length > MAX_LOOP_STEPS) return loopError(`Loop 最多允许 ${MAX_LOOP_STEPS} 组 Pipeline + 门禁`)

  const knownPipeline = pipelineMatcher(options?.pipelineIds)
  const seenStepIds = new Set()
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const label = `第 ${index + 1} 组`
    if (step === null || typeof step !== 'object' || Array.isArray(step)) return loopError(`${label}必须是一个对象`)
    const stepRecord = step as Record<string, unknown>
    if (typeof stepRecord.id !== 'string' || stepRecord.id.trim() === '') return loopError(`${label}缺少 step id`)
    if (seenStepIds.has(stepRecord.id)) return loopError(`${label}的 step id "${stepRecord.id}" 重复`)
    seenStepIds.add(stepRecord.id)

    if (typeof stepRecord.pipelineId !== 'string' || stepRecord.pipelineId.trim() === '') {
      return loopError(`${label}缺少 Pipeline`)
    }
    if (knownPipeline !== undefined && !knownPipeline(stepRecord.pipelineId)) {
      return loopError(`${label}引用的 Pipeline 不存在`)
    }

    const gateError = checkGate(stepRecord.gate, label)
    if (gateError !== undefined) return loopError(gateError)
  }

  return { ok: true }
}

/**
 * Truncate one gate-facing text to {@link MAX_GATE_OUTPUT_CHARS}.
 */
function truncate(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return text.length > MAX_GATE_OUTPUT_CHARS ? text.slice(0, MAX_GATE_OUTPUT_CHARS) : text
}

/**
 * Read the display name of a node, falling back to its id/legacy `title`.
 */
function nodeName(node: Partial<PipelineNode> | undefined, fallback: string): string {
  if (node !== null && typeof node === 'object') {
    if (typeof node.name === 'string' && node.name.trim() !== '') return node.name.trim()
    if (typeof node.title === 'string' && node.title.trim() !== '') return node.title.trim()
  }
  return fallback
}

/**
 * Aggregate a finished pipeline run into the text the gate judges (§13.2).
 *
 * Segments follow `run.order`, each one `【<node name>】\n<node output>`; empty
 * outputs are skipped and the whole text is truncated to
 * {@link MAX_GATE_OUTPUT_CHARS}. A run without any text yields the documented
 * placeholder so the gate still receives a readable body.
 *
 */
export function aggregatePipelineOutput(
  pipeline: Partial<Pipeline> | undefined,
  run: Partial<Run> | undefined,
): string {
  const order = Array.isArray(run?.order) ? run.order : []
  const nodeStates = run?.nodeStates !== null && typeof run?.nodeStates === 'object' ? run.nodeStates : {}
  const byId = new Map<string, PipelineNode>()
  for (const node of Array.isArray(pipeline?.nodes) ? pipeline.nodes : []) {
    if (node !== null && typeof node === 'object' && typeof node.id === 'string') byId.set(node.id, node)
  }

  const segments: string[] = []
  for (const nodeId of order) {
    if (typeof nodeId !== 'string') continue
    const state = nodeStates[nodeId]
    if (state === null || typeof state !== 'object') continue
    const output = typeof state.output === 'string' ? state.output : ''
    if (output.trim() === '') continue
    segments.push(`【${nodeName(byId.get(nodeId), nodeId)}】\n${output}`)
  }

  if (segments.length === 0) return EMPTY_PIPELINE_OUTPUT
  return truncate(segments.join('\n\n'))
}

/**
 * Render the requirement text of a gate: a plain agent command, or the §10.1
 * skill wrapper plus the author's supplementary instruction for a skill gate.
 */
function gateRequirement(gate: Partial<LoopGate> | undefined): string {
  const command = typeof gate?.command === 'string' ? gate.command.trim() : ''
  if (gate?.type !== 'skill') return command
  const skill = typeof gate.skill === 'string' ? gate.skill.trim() : ''
  const header =
    skill === ''
      ? '请完成本节点的门禁判断任务。'
      : `请使用 skill \`${skill}\` 完成本节点任务：先调用 skill 工具加载它，然后严格按该 skill 的说明执行。`
  return command === '' ? header : `${header}\n\n任务补充信息：\n${command}`
}

/**
 * Render the full gate prompt (§13.2). The gate agent's first line must be
 * `TRUE` or `FALSE`; everything after it is a one-line explanation.
 *
 * `stepIndex` is 0-based and rendered 1-based (`第 1 组`); `iteration` is the
 * 1-based attempt counter of that step.
 *
 */
export function renderGatePrompt({
  gate,
  pipeline,
  pipelineRun,
  pipelineOutput,
  stepIndex = 0,
  iteration = 1,
}: GatePromptInput = {}) {
  const output =
    typeof pipelineOutput === 'string' && pipelineOutput !== ''
      ? pipelineOutput
      : aggregatePipelineOutput(pipeline, pipelineRun)
  const pipelineName =
    typeof pipeline?.name === 'string' && pipeline.name.trim() !== ''
      ? pipeline.name.trim()
      : typeof pipeline?.id === 'string' && pipeline.id !== ''
        ? pipeline.id
        : 'Pipeline'
  const group = Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex + 1 : 1
  const attempt = Number.isInteger(iteration) && iteration > 0 ? iteration : 1

  return [
    `你是 Loop Manager 的「门禁节点」（第 ${group} 组 / 第 ${attempt} 次尝试）。`,
    '请判断上一段 Agent Pipeline 是否得出了符合要求的结果。',
    '',
    '判断要求：',
    gateRequirement(gate),
    '',
    `Agent Pipeline「${pipelineName}」本次运行结果：`,
    output,
    '',
    '结论规则：',
    '- 第一行只输出 TRUE 或 FALSE：',
    '  TRUE = 满足判断要求，可以进入下一组 Pipeline；',
    '  FALSE = 不满足判断要求，需要重新运行本组 Pipeline；',
    '- 第一行之后可以用一句话说明理由。',
  ].join('\n')
}

/**
 * Read a decision out of a JSON value (`true`, `"TRUE"`, ...).
 */
function decisionOfValue(value: unknown): 'TRUE' | 'FALSE' | undefined {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value !== 'string') return undefined
  const text = value.trim().toUpperCase()
  if (text === 'TRUE') return 'TRUE'
  if (text === 'FALSE') return 'FALSE'
  return undefined
}

/**
 * Read the decision out of one parsed JSON object, checking the documented
 * field names in order.
 */
function decisionOfJson(parsed: unknown): 'TRUE' | 'FALSE' | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  for (const key of ['pass', 'ok', 'decision', 'verdict']) {
    if (!Object.hasOwn(record, key)) continue
    const decision = decisionOfValue(record[key])
    if (decision !== undefined) return decision
  }
  return undefined
}

/**
 * Yield candidate JSON payloads from a model answer, in priority order.
 */
function* jsonCandidates(text: string): Generator<string> {
  yield text
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence !== null) yield fence[1].trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) yield text.slice(first, last + 1)
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      yield trimmed
      break
    }
  }
}

/**
 * Strip markdown decorations around a standalone line and return the decision
 * when the line is exactly TRUE/FALSE.
 */
function standaloneDecision(line: string): 'TRUE' | 'FALSE' | undefined {
  let text = typeof line === 'string' ? line.trim() : ''
  if (text === '') return undefined
  text = text.replace(LINE_PREFIX, '')
  text = text.replace(LINE_SUFFIX, '')
  const upper = text.toUpperCase()
  return upper === 'TRUE' || upper === 'FALSE' ? upper : undefined
}

/**
 * Parse the gate decision protocol (§13.2).
 *
 * Priority: JSON field → tagged value (`<verdict>TRUE</verdict>`) → standalone
 * line → explicit conclusion line (`结论：FALSE`, Chinese 通过/不通过 included)
 * → first standalone TRUE/FALSE word → `UNKNOWN`.
 *
 */
export function parseGateDecision(text: unknown): 'TRUE' | 'FALSE' | 'UNKNOWN' {
  if (typeof text !== 'string') return 'UNKNOWN'
  const raw = text.trim()
  if (raw === '') return 'UNKNOWN'

  // 1. JSON object (`{"pass": true}`, fenced or embedded).
  for (const candidate of jsonCandidates(raw)) {
    if (candidate === '') continue
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const decision = decisionOfJson(parsed)
    if (decision !== undefined) return decision
  }

  // 2. Tagged value: <verdict>TRUE</verdict>.
  const tagged = /<([A-Za-z][\w-]*)\s*>\s*(TRUE|FALSE)\s*<\/\1\s*>/i.exec(raw)
  if (tagged !== null) return tagged[2].toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE'

  // 3. Standalone line, markdown/quote decorations stripped.
  for (const line of raw.split(/\r?\n/)) {
    const decision = standaloneDecision(line)
    if (decision !== undefined) return decision
  }

  // 4. Explicit conclusion line (`结论：TRUE`, `verdict: FALSE`, `判定：不通过`).
  const labelled = LABELLED_DECISION.exec(raw)
  if (labelled !== null) {
    const value = labelled[1].toUpperCase()
    if (value === 'TRUE' || value === '通过') return 'TRUE'
    return 'FALSE'
  }

  // 5. First standalone TRUE/FALSE word anywhere.
  const word = /\b(TRUE|FALSE)\b/i.exec(raw)
  if (word !== null) return word[1].toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE'

  return 'UNKNOWN'
}
