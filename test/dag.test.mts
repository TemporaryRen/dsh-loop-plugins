/**
 * Unit tests for the pure DAG helpers in lib/dag.js.
 *
 * Covered (CONTRACT.md §3, §8.1): acyclic graphs, cycles, self-loops, dangling
 * edges, duplicate ids, multiple start nodes, stable topological order, and all
 * three prompt-rendering rules ({{input}}, {{node:<id>}}, appended upstream
 * output block).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { GRAPH_ERROR_CODE, predecessors, renderNodePrompt, topologicalOrder, validateGraph } from '../lib/dag.js'

/** Shorthand node factory. */
function node(id: string, title = id, prompt = ''): any {
  return { id, title, prompt }
}

test('validateGraph accepts a simple chain and isolated nodes', () => {
  const nodes = [node('a', 'A'), node('b', 'B'), node('c', 'C')]
  assert.deepEqual(validateGraph(nodes as any, []), { ok: true })
  assert.deepEqual(
    validateGraph(nodes as any, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]),
    { ok: true },
  )
  assert.deepEqual(validateGraph([], []), { ok: true })
})

test('validateGraph rejects a cycle and lists the cycle node titles', () => {
  const nodes = [node('a', 'Alpha'), node('b', 'Beta'), node('c', 'Gamma'), node('d', 'Delta')]
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'a' },
  ]
  const result = validateGraph(nodes as any, edges)
  assert.equal(result.ok, false)
  assert.equal(result.code, GRAPH_ERROR_CODE)
  assert.match(result.message, /cycle detected/)
  for (const title of ['Alpha', 'Beta', 'Gamma']) assert.match(result.message, new RegExp(title))
  assert.doesNotMatch(result.message, /Delta/)
})

test('validateGraph rejects self-loops', () => {
  const result = validateGraph([node('a', 'Forever')], [{ from: 'a', to: 'a' }])
  assert.equal(result.ok, false)
  assert.equal(result.code, GRAPH_ERROR_CODE)
  assert.match(result.message, /self-loop/)
  assert.match(result.message, /Forever/)
})

test('validateGraph rejects dangling edge endpoints', () => {
  const nodes = [node('a')]
  assert.equal(validateGraph(nodes as any, [{ from: 'a', to: 'ghost' }]).ok, false)
  assert.match(
    (validateGraph(nodes as any, [{ from: 'ghost', to: 'a' }]) as { ok: false; code: string; message: string }).message,
    /unknown node "ghost"/,
  )
})

test('validateGraph rejects duplicate node ids and malformed input', () => {
  assert.equal(validateGraph([node('a'), node('a')], []).ok, false)
  assert.match(
    (validateGraph([node('a'), node('a')], []) as { ok: false; code: string; message: string }).message,
    /duplicate node id/,
  )
  assert.equal(validateGraph(undefined as any, []).ok, false)
  assert.equal(validateGraph([], undefined as any).ok, false)
  assert.equal(validateGraph([{ title: 'no id' }] as any, []).ok, false)
  assert.equal(validateGraph([], [{ from: '', to: 'a' }]).ok, false)
})

test('topologicalOrder handles multiple start nodes in array order', () => {
  // a and b are both roots; c depends on both. Order must be a, b, c.
  const nodes = [node('a'), node('b'), node('c')]
  const edges = [
    { from: 'a', to: 'c' },
    { from: 'b', to: 'c' },
  ]
  assert.deepEqual(topologicalOrder(nodes as any, edges), { ok: true, order: ['a', 'b', 'c'] })
})

test('topologicalOrder is stable: ready nodes keep declared order', () => {
  // Declared x, y, z with z -> x. Initially ready: y (index 1) and z (index 2),
  // so y runs first; then z unblocks x, and x (index 0) precedes z? No: z was
  // already emitted, so the order is y, z, x.
  const nodes = [node('x'), node('y'), node('z')]
  const result = topologicalOrder(nodes as any, [{ from: 'z', to: 'x' }])
  assert.deepEqual(result, { ok: true, order: ['y', 'z', 'x'] })

  // Two independent roots: the earlier-declared root always runs first.
  assert.deepEqual(topologicalOrder([node('late'), node('early')], []), { ok: true, order: ['late', 'early'] })
})

test('topologicalOrder covers isolated nodes and empty graphs', () => {
  assert.deepEqual(topologicalOrder([node('b'), node('a')], []), { ok: true, order: ['b', 'a'] })
  assert.deepEqual(topologicalOrder([], []), { ok: true, order: [] })
})

test('topologicalOrder fails on a cycle with an invalid-graph code', () => {
  const result = topologicalOrder(
    [node('a', 'A'), node('b', 'B')],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, GRAPH_ERROR_CODE)
  assert.match(result.message, /cycle detected among nodes: A, B/)
})

test('predecessors returns direct predecessors in edge order without duplicates', () => {
  const edges = [
    { from: 'a', to: 'c' },
    { from: 'b', to: 'c' },
    { from: 'a', to: 'c' },
    { from: 'c', to: 'd' },
  ]
  assert.deepEqual(predecessors(edges, 'c'), ['a', 'b'])
  assert.deepEqual(predecessors(edges, 'd'), ['c'])
  assert.deepEqual(predecessors(edges, 'a'), [])
  assert.deepEqual(predecessors(undefined as any, 'a'), [])
})

test('renderNodePrompt expands {{input}} with predecessor outputs', () => {
  const nodes = [node('a', 'Alpha'), node('b', 'Beta'), node('c', 'Gamma', 'What next?\n{{input}}')]
  const edges = [
    { from: 'a', to: 'c' },
    { from: 'b', to: 'c' },
  ]
  const rendered = renderNodePrompt(nodes[2] as any, nodes as any, edges, { a: 'from-a', b: 'from-b' })
  assert.equal(rendered, 'What next?\n[Alpha]\nfrom-a\n\n[Beta]\nfrom-b')
})

test('renderNodePrompt expands {{node:<id>}} for any known node', () => {
  const nodes = [node('a', 'Alpha'), node('b', 'Beta')]
  const rendered = renderNodePrompt(node('b', 'Beta', 'Use {{node:a}} and {{node:missing}}.'), nodes, [], {
    a: 'A-output',
  })
  assert.equal(rendered, 'Use A-output and .')
})

test('renderNodePrompt appends upstream output when no token is present', () => {
  const nodes = [node('a', 'Alpha'), node('b', 'Beta', 'Summarize the previous step.')]
  const edges = [{ from: 'a', to: 'b' }]
  const rendered = renderNodePrompt(nodes[1] as any, nodes as any, edges, { a: 'A-output' })
  assert.equal(rendered, 'Summarize the previous step.\n\n--- 上游节点输出 ---\n[Alpha]\nA-output')
})

test('renderNodePrompt leaves prompts without tokens or predecessors untouched', () => {
  const nodes = [node('a', 'Alpha')]
  assert.equal(renderNodePrompt(nodes[0] as any, nodes as any, [], {}), '')
  assert.equal(renderNodePrompt(node('a', 'Alpha', 'Plain prompt'), nodes, [], {}), 'Plain prompt')
  // A predecessor without an output must not append an empty block.
  assert.equal(renderNodePrompt(node('b', 'Beta', 'Plain'), [node('a')], [{ from: 'a', to: 'b' }], {}), 'Plain')
})

test('renderNodePrompt does not re-expand tokens inside substituted output', () => {
  const nodes = [node('a', 'Alpha'), node('b', 'Beta', '{{input}}')]
  const edges = [{ from: 'a', to: 'b' }]
  const rendered = renderNodePrompt(nodes[1] as any, nodes as any, edges, { a: 'keep {{input}} literal' })
  assert.equal(rendered, '[Alpha]\nkeep {{input}} literal')
})

test('renderNodePrompt substitutes {{input}} with an empty string when no output exists', () => {
  const nodes = [node('b', 'Beta', 'X{{input}}Y')]
  assert.equal(renderNodePrompt(nodes[0] as any, nodes as any, [], {}), 'XY')
})
