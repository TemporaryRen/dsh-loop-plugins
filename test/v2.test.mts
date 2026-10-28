/**
 * v2 (design-aligned) regression tests: the renamed pipeline/node fields, the
 * declared Skills/MCP block, the run's `pipelineName`, and the v1 -> v2 state
 * file migration. See CONTRACT.md §9.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { renderNodePrompt } from '../lib/dag.js'
import { createEngine } from '../lib/engine.js'
import { createStore } from '../lib/store.js'

/** @returns {Promise<string>} a fresh temp state-file path. */
async function tempStateFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'loop-manager-v2-'))
  return join(directory, 'state.json')
}

test('renderNodePrompt sends the command verbatim (the command IS the skill)', () => {
  const nodes = [
    { id: 'a', name: '抓取', command: '用 web-search skill 搜索今天的新闻' },
    { id: 'b', name: '汇总', command: '整理：{{input}}' },
  ]
  const edges = [{ from: 'a', to: 'b' }]
  const outputs = { a: '今天的新闻' }

  const rendered = renderNodePrompt(nodes[1], nodes, edges, outputs)
  assert.equal(rendered, '整理：[抓取]\n今天的新闻', 'only upstream substitution, no tool block appended')

  // A command that names an existing Skill / MCP tool is passed through as-is.
  const first = renderNodePrompt(nodes[0], nodes, edges, {})
  assert.equal(first, '用 web-search skill 搜索今天的新闻')

  // No `{{input}}` token and no upstream output -> nothing is appended either.
  const lonely = renderNodePrompt(nodes[0], nodes, [], {})
  assert.equal(lonely, '用 web-search skill 搜索今天的新闻')
})

test('a SKILL node pins one installed skill and wraps the supplementary text', () => {
  const nodes = [
    { id: 'n1', name: '准备', type: 'agent', command: '输出一行素材' },
    { id: 'n2', name: '用 skill', type: 'skill', skill: 'office-docx', command: '生成周报并保存到 /tmp/w.docx' },
    { id: 'n3', name: '只带补充信息', type: 'skill', skill: 'arkcli-shared', command: '' },
  ]
  const edges = [{ from: 'n1', to: 'n2' }]
  const outputs = { n1: '今天的素材' }

  const withUpstream = renderNodePrompt(nodes[1] as any, nodes as any, edges, outputs)
  assert.ok(withUpstream.startsWith('请使用 skill `office-docx` 完成本节点任务'), 'skill is pinned in the prompt')
  assert.ok(withUpstream.includes('任务补充信息：\n生成周报并保存到 /tmp/w.docx'), 'supplementary text is carried')
  assert.ok(withUpstream.includes('--- 上游节点输出 ---\n[准备]\n今天的素材'), 'upstream output still flows in')

  const bare = renderNodePrompt(nodes[2] as any, nodes as any, [], {})
  assert.ok(bare.includes('`arkcli-shared`'))
  assert.equal(bare.includes('任务补充信息'), false, 'no supplementary section when empty')
})

test('renderNodePrompt still accepts the v1 title/prompt fields', () => {
  const nodes = [{ id: 'a', title: '旧节点', prompt: '旧指令' }]
  assert.equal(renderNodePrompt(nodes[0] as any, nodes as any, [], {}), '旧指令')
})

test('an engine run records the pipeline name (survives pipeline deletion)', async () => {
  const store = createStore({ file: await tempStateFile() })
  const engine = createEngine({
    store,
    runNode: async () => ({ output: 'done', sessionId: 'session-x' }),
  })
  const pipeline = {
    id: 'p1',
    name: '每日情报',
    desc: '把想法变成简报',
    icon: '◈',
    color: 'blue',
    star: true,
    nodes: [{ id: 'n1', name: '节点', command: '做点什么' }],
    edges: [] as any[],
    createdAt: 1,
    updatedAt: 1,
  }
  const started = engine.start(pipeline)
  assert.equal(started.ok, true)
  assert.equal(started.run.pipelineName, '每日情报')

  // Let the fake node finish before tearing the engine down.
  let run = started.run
  for (let attempt = 0; attempt < 100 && run.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    run = engine.listRuns()[0]
  }
  assert.equal(run.status, 'completed')
  assert.equal(run.pipelineName, '每日情报')
  await engine.dispose()
})

test('loading a v1 state file migrates every pipeline/node field to v2', async () => {
  const file = await tempStateFile()
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      pipelines: [
        {
          id: 'p1',
          name: '旧 Pipeline',
          description: 'v1 的 description',
          nodes: [{ id: 'n1', title: '旧节点', prompt: '旧指令', skills: '', mcp: 'browser' }],
          edges: [] as any[],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      lastRuns: {},
    }),
    'utf8',
  )

  const store = createStore({ file })
  await store.load()
  const [pipeline] = store.listPipelines()

  assert.equal(pipeline.desc, 'v1 的 description')
  assert.equal(pipeline.description, undefined)
  assert.equal(pipeline.icon, '◈')
  assert.equal(pipeline.color, '')
  assert.equal(pipeline.star, false)
  // A v2 node's declared Skills/MCP are folded into the command, not dropped.
  assert.deepEqual(pipeline.nodes[0], {
    id: 'n1',
    name: '旧节点',
    type: 'agent',
    command: '旧指令\n\n（可用 MCP 工具：browser）',
  })

  // A later write persists the migrated shape.
  await store.upsertPipeline(pipeline)
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(written.pipelines[0].description, undefined)
  assert.equal(written.pipelines[0].nodes[0].command, '旧指令\n\n（可用 MCP 工具：browser）')
})

test('listRuns is newest-first and bounded by the history cap', () => {
  const store = createStore({})
  // setRun keeps at most 5 finished runs per pipeline, so spread the history
  // over enough pipelines to cross the 50-row view cap.
  let clock = 0
  for (let pipeline = 0; pipeline < 12; pipeline += 1) {
    for (let run = 0; run < 5; run += 1) {
      store.setRun({
        id: `r${pipeline}-${run}`,
        pipelineId: `p${pipeline}`,
        status: 'completed',
        startedAt: clock++,
        order: [] as any[],
        nodeStates: {},
      })
    }
  }
  const runs = store.listRuns()
  assert.equal(runs.length, 50)
  assert.equal(runs[0].startedAt, 59)
  for (let index = 1; index < runs.length; index += 1) {
    assert.ok(runs[index - 1].startedAt >= runs[index].startedAt, 'newest first')
  }
})
