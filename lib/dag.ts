/**
 * Pure DAG algorithms for dsh-loop-manager pipelines.
 *
 * A pipeline is a directed acyclic graph: `nodes` are agent tasks, `edges` are
 * `{ from, to }` dependencies meaning "from runs before to". This module is
 * dependency-free (plain ESM, no imports) so both the host half and unit tests
 * can use it, and so the client half can port the same ~60 lines if it wants a
 * local cycle preview.
 *
 * Every function is pure: it never mutates its arguments and never throws for
 * malformed input — malformed graphs come back as `{ ok: false, code, message }`.
 *
 */

/** Error code shared by every graph-level failure (mapped to HTTP 400 in the API). */
export const GRAPH_ERROR_CODE = 'invalid-graph'

/**
 * Build a graph failure result.
 */
import type { PipelineNode, PipelineEdge } from './types.js'

function graphError(message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: GRAPH_ERROR_CODE, message }
}

/**
 * Return the display name of a node, falling back to its id. `title` is the v1
 * field name and stays readable so an old state file renders without migration.
 */
function nodeTitle(node: PipelineNode | undefined, fallback: string): string {
  if (node !== null && typeof node === 'object') {
    if (typeof node.name === 'string' && node.name.trim() !== '') return node.name
    if (typeof node.title === 'string' && node.title.trim() !== '') return node.title
  }
  return fallback
}

/**
 * Structural pass over the graph followed by a stable Kahn topological sort.
 *
 */
function buildOrder(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
): { ok: true; order: string[] } | { ok: false; code: string; message: string } {
  if (!Array.isArray(nodes)) return graphError('nodes must be an array')
  if (!Array.isArray(edges)) return graphError('edges must be an array')

  const position: Map<string, number> = new Map()
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node === null || typeof node !== 'object') return graphError(`nodes[${index}] must be an object`)
    if (typeof node.id !== 'string' || node.id === '') {
      return graphError(`nodes[${index}] must carry a non-empty string id`)
    }
    if (position.has(node.id)) return graphError(`duplicate node id "${node.id}"`)
    position.set(node.id, index)
  }

  const outgoing: Map<string, string[]> = new Map()
  const inDegree: Map<string, number> = new Map()
  for (const id of position.keys()) {
    outgoing.set(id, [])
    inDegree.set(id, 0)
  }

  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]
    if (edge === null || typeof edge !== 'object') return graphError(`edges[${index}] must be an object`)
    const { from, to } = edge
    if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') {
      return graphError(`edges[${index}] must carry non-empty string "from" and "to" ids`)
    }
    if (!position.has(from)) return graphError(`edge ${index} references unknown node "${from}"`)
    if (!position.has(to)) return graphError(`edge ${index} references unknown node "${to}"`)
    if (from === to) {
      const node = nodes[position.get(from)!]
      return graphError(`node "${nodeTitle(node, from)}" cannot depend on itself (self-loop)`)
    }
    outgoing.get(from)!.push(to)
    inDegree.set(to, inDegree.get(to)! + 1)
  }

  // Stable Kahn: repeatedly pick the earliest node in the declared array order
  // whose in-degree reached zero. That keeps sibling branches in author order.
  const order: string[] = []
  const emitted = new Set()
  while (order.length < position.size) {
    let picked
    for (const id of position.keys()) {
      if (emitted.has(id)) continue
      if (inDegree.get(id) !== 0) continue
      // Iteration order follows the nodes array, so the first ready hit is the
      // earliest-declared one — the stability guarantee.
      picked = id
      break
    }
    if (picked === undefined) {
      const cycleNodes = [...position.keys()].filter((id) => !emitted.has(id))
      const titles = cycleNodes.map((id) => nodeTitle(nodes[position.get(id)!], id))
      return graphError(`cycle detected among nodes: ${titles.join(', ')}`)
    }
    emitted.add(picked)
    order.push(picked)
    for (const next of outgoing.get(picked)!) {
      inDegree.set(next, inDegree.get(next)! - 1)
    }
  }

  return { ok: true, order }
}

/**
 * Validate a pipeline graph.
 *
 * Checks node identity (non-empty unique ids), edge endpoints, self-loops and
 * cycles. Node titles/prompt lengths are request-shape concerns validated by
 * the HTTP layer, not graph semantics.
 *
 */
export function validateGraph(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
): { ok: true } | { ok: false; code: string; message: string } {
  const result = buildOrder(nodes, edges)
  return result.ok ? { ok: true } : result
}

/**
 * Compute the execution order of a pipeline.
 *
 * Multiple ready nodes are ordered by their position in `nodes` (stable Kahn),
 * so an author can predict the order of independent branches.
 *
 */
export function topologicalOrder(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
): { ok: true; order: string[] } | { ok: false; code: string; message: string } {
  return buildOrder(nodes, edges)
}

/**
 * List the direct predecessors of one node.
 */
export function predecessors(edges: PipelineEdge[], nodeId: string): string[] {
  const result: string[] = []
  const seen = new Set()
  if (!Array.isArray(edges)) return result
  for (const edge of edges) {
    if (edge === null || typeof edge !== 'object') continue
    if (edge.to !== nodeId) continue
    if (typeof edge.from !== 'string' || edge.from === '') continue
    if (seen.has(edge.from)) continue
    seen.add(edge.from)
    result.push(edge.from)
  }
  return result
}

/**
 * Render one node's prompt with upstream outputs substituted in.
 *
 * Rules (CONTRACT.md section 3):
 *  1. `{{node:<id>}}` becomes that node's output (any known node), or `''`.
 *  2. `{{input}}` becomes every direct predecessor's output, in predecessor
 *     order, each segment `[<title>]\\n<output>`, segments joined by `\\n\\n`.
 *  3. When the prompt contains neither token and predecessor outputs exist, an
 *     `--- 上游节点输出 ---` block with the same segments is appended.
 *
 * All substitutions happen in one pass, so text inserted from an upstream
 * output is never scanned again for tokens (no recursive expansion).
 *
 */
export function renderNodePrompt(
  node: PipelineNode,
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  outputs: Record<string, string | undefined>,
): string {
  const isSkillNode = node !== null && typeof node === 'object' && node.type === 'skill'
  const skillName = node !== null && typeof node === 'object' && typeof node.skill === 'string' ? node.skill.trim() : ''
  const source =
    node !== null && typeof node === 'object'
      ? typeof node.command === 'string'
        ? node.command
        : typeof node.prompt === 'string'
          ? node.prompt
          : ''
      : ''
  const outputOf = (id: string) => {
    const value = outputs === null || typeof outputs !== 'object' ? undefined : outputs[id]
    return typeof value === 'string' ? value : ''
  }

  const byId = new Map<string, PipelineNode>()
  if (Array.isArray(nodes)) {
    for (const candidate of nodes) {
      if (candidate !== null && typeof candidate === 'object' && typeof candidate.id === 'string') {
        byId.set(candidate.id, candidate)
      }
    }
  }

  const nodeId = node !== null && typeof node === 'object' && typeof node.id === 'string' ? node.id : ''
  const segments = []
  for (const predecessorId of predecessors(edges, nodeId)) {
    const output = outputOf(predecessorId)
    if (output === '') continue
    segments.push({ title: nodeTitle(byId.get(predecessorId), predecessorId), output })
  }
  const joined = segments.map((segment) => `[${segment.title}]\n${segment.output}`).join('\n\n')

  const hasInputToken = source.includes('{{input}}')
  const hasNodeToken = /\{\{node:[^}]+\}\}/.test(source)

  const rendered = source.replace(/\{\{(input|node:[^}]+)\}\}/g, (match: string, token: string) => {
    if (token === 'input') return joined
    const targetId = token.slice('node:'.length).trim()
    return outputOf(targetId)
  })

  // CONTRACT.md §10: an AGENT node's command IS the task description; a SKILL
  // node's prompt instead pins one installed skill and wraps the author's
  // supplementary text in that skill's execution.
  const upstream = !hasInputToken && !hasNodeToken && segments.length > 0 ? `\n\n--- 上游节点输出 ---\n${joined}` : ''
  if (isSkillNode && skillName !== '') {
    const body = rendered.trim()
    return (
      `请使用 skill \`${skillName}\` 完成本节点任务：先调用 skill 工具加载它，然后严格按该 skill 的说明执行。` +
      (body === '' ? '' : `\n\n任务补充信息：\n${body}`) +
      upstream
    )
  }
  return `${rendered}${upstream}`
}
