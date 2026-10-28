/**
 * Unit tests for lib/loop.js — the pure host half of v9 Loop orchestration
 * (CONTRACT.md §13.2): validateLoop, parseGateDecision, renderGatePrompt and
 * aggregatePipelineOutput. No host services and no filesystem are involved.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOOP_ERROR_CODE,
  MAX_GATE_OUTPUT_CHARS,
  MAX_LOOP_STEPS,
  aggregatePipelineOutput,
  parseGateDecision,
  renderGatePrompt,
  validateLoop,
} from '../lib/loop.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * A Set that also answers `.includes`, so the test does not depend on whether
 * validateLoop reads `{ pipelineIds }` as a Set or an array (it is a set).
 * @param {string[]} ids - known pipeline ids.
 * @returns {Set<string> & { includes: (id: string) => boolean }}
 */
function pipelineIdSet(ids: string[]): Set<string> & { includes: (id: string) => boolean } {
  const set = new Set(ids) as Set<string> & { includes: (id: string) => boolean }
  set.includes = (id: any) => set.has(id)
  return set
}

/** Gate fixture: valid by default. */
function makeGate(overrides: any = {}) {
  return {
    id: 's1-gate',
    name: '门禁',
    type: 'agent',
    command: '检查输出里是否包含 DONE',
    autoLoop: false,
    maxIterations: 3,
    ...overrides,
  }
}

/** Step fixture: valid by default. */
function makeStep(overrides: any = {}) {
  return {
    id: 's1',
    pipelineId: 'p1',
    gate: makeGate(),
    ...overrides,
  }
}

/** Loop fixture: valid by default. */
function makeLoop(overrides: any = {}) {
  return {
    id: 'loop-1',
    name: 'Loop one',
    desc: '',
    icon: '⟳',
    color: '',
    star: false,
    steps: [makeStep()],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const PIPELINE_IDS = pipelineIdSet(['p1', 'p2', 'p3'])

/** Run validateLoop with the shared pipeline id set. */
function validate(loop: any, pipelineIds = PIPELINE_IDS) {
  return validateLoop(loop, { pipelineIds })
}

/** Assert one rejected loop carries the contract error code. */
function assertInvalid(loop: any, messageMatcher?: RegExp) {
  const result = validate(loop)
  assert.equal(result.ok, false, 'expected the loop to be rejected')
  assert.equal(result.code, LOOP_ERROR_CODE)
  assert.equal(result.code, 'invalid-loop')
  assert.equal(typeof result.message, 'string')
  assert.ok(result.message.trim() !== '', 'a rejection must explain itself')
  if (messageMatcher !== undefined) assert.match(result.message, messageMatcher)
}

// ---------------------------------------------------------------------------
// validateLoop — accepted shapes
// ---------------------------------------------------------------------------

test('validateLoop accepts a minimal valid loop', () => {
  assert.deepEqual(validate(makeLoop()), { ok: true })
})

test('validateLoop accepts optional presentation fields and defaults absence', () => {
  assert.equal(validate(makeLoop({ desc: '说明', icon: '◈', color: 'purple', star: true })).ok, true)
  const bare = makeLoop()
  delete bare.desc
  delete bare.icon
  delete bare.color
  delete bare.star
  assert.equal(validate(bare).ok, true, 'desc/icon/color/star are optional')
})

test('validateLoop accepts every documented color and both gate types', () => {
  for (const color of ['', 'blue', 'peach', 'purple']) {
    assert.equal(validate(makeLoop({ color })).ok, true, `color ${JSON.stringify(color)}`)
  }
  assert.equal(
    validate(makeLoop({ steps: [makeStep({ gate: makeGate({ type: 'skill', skill: 'office-docx', command: '' }) })] }))
      .ok,
    true,
    'a skill gate only needs a kebab-case skill',
  )
  assert.equal(
    validate(
      makeLoop({ steps: [makeStep({ gate: makeGate({ type: 'skill', skill: 'office-docx', command: '补充信息' }) })] }),
    ).ok,
    true,
  )
})

test('validateLoop accepts exactly MAX_LOOP_STEPS groups with unique ids', () => {
  const steps = Array.from({ length: MAX_LOOP_STEPS }, (_, index) =>
    makeStep({
      id: `s${index + 1}`,
      pipelineId: 'p1',
      gate: makeGate({ id: `s${index + 1}-gate`, name: `门禁 ${index + 1}` }),
    }),
  )
  assert.equal(MAX_LOOP_STEPS, 20)
  assert.equal(validate(makeLoop({ steps })).ok, true)
})

test('validateLoop accepts the maxIterations boundaries 1 and 20', () => {
  for (const maxIterations of [1, 20]) {
    assert.equal(
      validate(makeLoop({ steps: [makeStep({ gate: makeGate({ maxIterations }) })] })).ok,
      true,
      `maxIterations ${maxIterations}`,
    )
  }
})

test('validateLoop accepts a pinned model with both provider and model', () => {
  const gate = makeGate({ model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.equal(validate(makeLoop({ steps: [makeStep({ gate })] })).ok, true)
})

// ---------------------------------------------------------------------------
// validateLoop — rejected shapes
// ---------------------------------------------------------------------------

test('validateLoop rejects an empty or missing name', () => {
  assertInvalid(makeLoop({ name: '' }))
  assertInvalid(makeLoop({ name: '   ' }))
  assertInvalid(makeLoop({ name: 42 }))
  const missing = makeLoop()
  delete missing.name
  assertInvalid(missing)
})

test('validateLoop rejects names over 50 characters', () => {
  assert.equal(validate(makeLoop({ name: 'a'.repeat(50) })).ok, true)
  assertInvalid(makeLoop({ name: 'a'.repeat(51) }))
})

test('validateLoop rejects a desc over 160 characters', () => {
  assert.equal(validate(makeLoop({ desc: 'd'.repeat(160) })).ok, true)
  assertInvalid(makeLoop({ desc: 'd'.repeat(161) }))
})

test('validateLoop rejects an icon over 4 characters and unknown colors', () => {
  assert.equal(validate(makeLoop({ icon: 'abcd' })).ok, true)
  assertInvalid(makeLoop({ icon: 'abcde' }))
  assertInvalid(makeLoop({ color: 'red' }))
  assertInvalid(makeLoop({ color: 'BLUE' }))
})

test('validateLoop rejects a non-boolean star', () => {
  assertInvalid(makeLoop({ star: 'yes' }))
  assertInvalid(makeLoop({ star: 1 }))
})

test('validateLoop rejects missing, empty and oversized step lists', () => {
  const missing = makeLoop()
  delete missing.steps
  assertInvalid(missing)
  assertInvalid(makeLoop({ steps: [] }))
  assertInvalid(makeLoop({ steps: 'nope' }))
  const steps = Array.from({ length: MAX_LOOP_STEPS + 1 }, (_, index) => makeStep({ id: `s${index + 1}` }))
  assertInvalid(makeLoop({ steps }))
})

test('validateLoop rejects empty and duplicate step ids', () => {
  assertInvalid(makeLoop({ steps: [makeStep({ id: '' })] }))
  const missingId = makeStep()
  delete missingId.id
  assertInvalid(makeLoop({ steps: [missingId] }))
  assertInvalid(makeLoop({ steps: [makeStep({ id: 's1' }), makeStep({ id: 's1' })] }))
})

test('validateLoop rejects a step whose pipeline was not saved, naming the group', () => {
  const loop = makeLoop({
    steps: [makeStep({ id: 's1', pipelineId: 'p1' }), makeStep({ id: 's2', pipelineId: 'ghost' })],
  })
  const result = validate(loop)
  assert.equal(result.ok, false)
  assert.equal(result.code, LOOP_ERROR_CODE)
  assert.match(result.message, /第 2 组引用的 Pipeline 不存在/)
})

test('validateLoop rejects missing pipelineId and a pipelineIds set without it', () => {
  assertInvalid(makeLoop({ steps: [makeStep({ pipelineId: '' })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ pipelineId: 'p9' })] }))
  const result = validate(makeLoop({ steps: [makeStep({ pipelineId: 'p9' })] }))
  assert.match((result as { ok: false; code: string; message: string }).message, /第 1 组引用的 Pipeline 不存在/)
})

test('validateLoop accepts omitted gate defaults and an array pipelineIds', () => {
  // Missing name/type/autoLoop/maxIterations/id are server defaults, not errors.
  const gate = { command: '检查是否完成' }
  assert.equal(validate(makeLoop({ steps: [makeStep({ gate })] })).ok, true)
  assert.equal(validateLoop(makeLoop(), { pipelineIds: ['p1', 'p2'] }).ok, true, 'pipelineIds may be a plain array')
})

test('validateLoop rejects malformed gates', () => {
  assertInvalid(makeLoop({ steps: [makeStep({ gate: null })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ name: '' }) })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ name: '   ' }) })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ name: 'x'.repeat(41) }) })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ type: 'tool' }) })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ autoLoop: 'true' }) })] }))
})

test('validateLoop rejects maxIterations outside the integer range 1–20', () => {
  for (const maxIterations of [0, 21, 1.5, '3']) {
    assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ maxIterations }) })] }), /maxIterations|上限|迭代/)
  }
  // Omitted -> contract default 3 (not an error).
  const gate = makeGate()
  delete gate.maxIterations
  assert.equal(validate(makeLoop({ steps: [makeStep({ gate })] })).ok, true)
})

test('validateLoop requires a trimmed agent command', () => {
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ command: '' }) })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ command: '   ' }) })] }))
  const missing = makeGate()
  delete missing.command
  assertInvalid(makeLoop({ steps: [makeStep({ gate: missing })] }))
})

test('validateLoop requires a kebab-case skill for skill gates but allows an empty command', () => {
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ type: 'skill', command: 'x' }) })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ type: 'skill', skill: '', command: 'x' }) })] }))
  assertInvalid(
    makeLoop({ steps: [makeStep({ gate: makeGate({ type: 'skill', skill: 'Office Docx', command: 'x' }) })] }),
  )
  assertInvalid(
    makeLoop({ steps: [makeStep({ gate: makeGate({ type: 'skill', skill: 'office_docx', command: 'x' }) })] }),
  )
})

test('validateLoop validates a pinned model when present', () => {
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ model: { provider: '', model: 'm' } }) })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ model: { provider: 'p', model: '  ' } }) })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ model: { provider: 'p' } }) })] }))
  assertInvalid(makeLoop({ steps: [makeStep({ gate: makeGate({ model: 'deepseek' }) })] }))
})

test('validateLoop rejects a non-object loop', () => {
  for (const value of [null, undefined, 'loop', 42, []]) {
    const result = validateLoop(value, { pipelineIds: PIPELINE_IDS })
    assert.equal(result.ok, false)
    assert.equal(result.code, LOOP_ERROR_CODE)
  }
})

// ---------------------------------------------------------------------------
// parseGateDecision — priority order (CONTRACT.md §13.2)
// ---------------------------------------------------------------------------

test('parseGateDecision reads a bare TRUE/FALSE in any case', () => {
  assert.equal(parseGateDecision('TRUE'), 'TRUE')
  assert.equal(parseGateDecision('FALSE'), 'FALSE')
  assert.equal(parseGateDecision('true'), 'TRUE')
  assert.equal(parseGateDecision('false'), 'FALSE')
  assert.equal(parseGateDecision('  True  '), 'TRUE')
  assert.equal(parseGateDecision('True\n理由：输出符合要求'), 'TRUE')
  assert.equal(parseGateDecision('FALSE\n理由：缺少 DONE'), 'FALSE')
})

test('parseGateDecision prefers a JSON pass/ok/decision/verdict field', () => {
  assert.equal(parseGateDecision('{"pass": true}'), 'TRUE')
  assert.equal(parseGateDecision('{"pass": false}'), 'FALSE')
  assert.equal(parseGateDecision('{"ok": true}'), 'TRUE')
  assert.equal(parseGateDecision('{"ok": false}'), 'FALSE')
  assert.equal(parseGateDecision('{"decision": "TRUE"}'), 'TRUE')
  assert.equal(parseGateDecision('{"decision": "false"}'), 'FALSE')
  assert.equal(parseGateDecision('{"verdict": "true"}'), 'TRUE')
  assert.equal(parseGateDecision('{"verdict": "FALSE"}'), 'FALSE')
})

test('parseGateDecision reads JSON wrapped in prose or a code fence', () => {
  assert.equal(parseGateDecision('```json\n{"pass": true, "reason": "has DONE"}\n```'), 'TRUE')
  assert.equal(parseGateDecision('判断结果如下：\n{"pass": false}\n以上。'), 'FALSE')
})

test('parseGateDecision prefers JSON over a later bare verdict line', () => {
  assert.equal(parseGateDecision('{"pass": false}\nTRUE'), 'FALSE')
  assert.equal(parseGateDecision('{"pass": true}\nFALSE'), 'TRUE')
})

test('parseGateDecision reads <verdict> tags before bare words', () => {
  assert.equal(parseGateDecision('<verdict>TRUE</verdict>'), 'TRUE')
  assert.equal(parseGateDecision('<verdict>false</verdict>'), 'FALSE')
  assert.equal(parseGateDecision('<verdict> TRUE </verdict>\nFALSE'), 'TRUE')
  assert.equal(parseGateDecision('结论：<verdict>FALSE</verdict>'), 'FALSE')
})

test('parseGateDecision reads a standalone markdown line, stripping emphasis and punctuation', () => {
  assert.equal(parseGateDecision('**TRUE**\n理由：OK'), 'TRUE')
  assert.equal(parseGateDecision('`FALSE`'), 'FALSE')
  assert.equal(parseGateDecision('TRUE。'), 'TRUE')
  assert.equal(parseGateDecision('FALSE — 缺少必要输出'), 'FALSE')
  assert.equal(parseGateDecision('### 结论\nTRUE'), 'TRUE')
})

test('parseGateDecision reads explicit 结论/结果/判定/verdict/decision lines', () => {
  assert.equal(parseGateDecision('结论：TRUE'), 'TRUE')
  assert.equal(parseGateDecision('结论: FALSE'), 'FALSE')
  assert.equal(parseGateDecision('结果：true'), 'TRUE')
  assert.equal(parseGateDecision('判定：False'), 'FALSE')
  assert.equal(parseGateDecision('verdict: true'), 'TRUE')
  assert.equal(parseGateDecision('decision: FALSE'), 'FALSE')
  assert.equal(parseGateDecision('结论：通过'), 'TRUE')
  assert.equal(parseGateDecision('结论：不通过'), 'FALSE')
})

test('parseGateDecision falls back to the first independent TRUE/FALSE word in prose', () => {
  assert.equal(parseGateDecision('I think the answer is TRUE because DONE is present.'), 'TRUE')
  assert.equal(parseGateDecision('The result looks like false to me.'), 'FALSE')
})

test('parseGateDecision never fires on substrings or ambiguous prose', () => {
  assert.equal(parseGateDecision('TRUEFALSE'), 'UNKNOWN')
  assert.equal(parseGateDecision('untrue'), 'UNKNOWN')
  assert.equal(parseGateDecision('falsey'), 'UNKNOWN')
  assert.equal(parseGateDecision('是否通过取决于上游输出。'), 'UNKNOWN')
  assert.equal(parseGateDecision('不通过风险已经被排除。'), 'UNKNOWN')
  assert.equal(parseGateDecision('通过'), 'UNKNOWN', 'bare 通过 is not an explicit conclusion line')
  assert.equal(parseGateDecision(''), 'UNKNOWN')
  assert.equal(parseGateDecision(null), 'UNKNOWN')
  assert.equal(parseGateDecision(undefined), 'UNKNOWN')
  assert.equal(parseGateDecision(42), 'UNKNOWN')
})

test('parseGateDecision priority: JSON beats tags and standalone lines', () => {
  assert.equal(parseGateDecision('{"pass": false}\n<verdict>TRUE</verdict>'), 'FALSE')
  assert.equal(parseGateDecision('{"pass": true}\nFALSE\nthe body says FALSE'), 'TRUE')
})

test('parseGateDecision priority: a tag beats standalone lines and prose', () => {
  assert.equal(parseGateDecision('<verdict>FALSE</verdict>\nTRUE\nthe body is not TRUE'), 'FALSE')
})

test('parseGateDecision priority: a standalone line beats an explicit conclusion line', () => {
  // CONTRACT.md §13.2 lists the standalone line (rule 3) before the
  // 结论/verdict line (rule 4).
  assert.equal(parseGateDecision('结论：FALSE\nTRUE'), 'TRUE')
})

test('parseGateDecision priority: an explicit conclusion line beats prose words', () => {
  assert.equal(parseGateDecision('The body says FALSE.\n结论：TRUE'), 'TRUE')
})

test('parseGateDecision fallback takes the first independent word even after NOT', () => {
  // CONTRACT.md §13.2 rule 5 is a last-resort fallback: the first independent
  // TRUE/FALSE word. Real gates follow the first-line protocol, so negation in
  // prose is out of scope (that is why rule 5 exists as a fallback only).
  assert.equal(parseGateDecision('The answer is not TRUE.'), 'TRUE')
  assert.equal(parseGateDecision('This is NOT false in any sense.'), 'FALSE')
})

test('parseGateDecision rejects non-string and whitespace-only input', () => {
  assert.equal(parseGateDecision({ pass: true }), 'UNKNOWN')
  assert.equal(parseGateDecision(['TRUE']), 'UNKNOWN')
  assert.equal(parseGateDecision('   \n\t '), 'UNKNOWN')
})

test('validateLoop skips the pipeline reference check when pipelineIds is omitted', () => {
  // CONTRACT.md: validateLoop(loop, { pipelineIds }); without the set the
  // reference rule cannot be evaluated and is skipped (still validates the rest).
  assert.deepEqual(validateLoop(makeLoop({ steps: [makeStep({ pipelineId: 'ghost' })] })), { ok: true })
  assert.deepEqual(validateLoop(makeLoop()), { ok: true })
  assert.equal(validateLoop(makeLoop({ name: '' })).ok, false)
})

test('validateLoop treats an empty pipelineIds collection as no saved pipelines', () => {
  const result = validateLoop(makeLoop(), { pipelineIds: pipelineIdSet([]) })
  assert.equal(result.ok, false)
  assert.equal(result.code, LOOP_ERROR_CODE)
  assert.match(result.message, /第 1 组引用的 Pipeline 不存在/)
})

// ---------------------------------------------------------------------------
// aggregatePipelineOutput
// ---------------------------------------------------------------------------

/** Pipeline fixture with named nodes and a matching run. */
function makePipelineRun(): any {
  const pipeline = {
    id: 'p1',
    name: 'Pipeline one',
    nodes: [
      { id: 'a', name: '节点 A', command: 'first' },
      { id: 'b', name: '节点 B', command: 'second' },
      { id: 'c', name: '节点 C', command: 'third' },
    ],
    edges: [] as any[],
  }
  const run = {
    id: 'run-1',
    pipelineId: 'p1',
    status: 'completed',
    order: ['b', 'a', 'c'],
    nodeStates: {
      a: { status: 'completed', output: 'out-a' },
      b: { status: 'completed', output: 'out-b' },
      c: { status: 'completed', output: 'out-c' },
    },
  }
  return { pipeline, run }
}

test('aggregatePipelineOutput joins node outputs in run order with headers', () => {
  const { pipeline, run } = makePipelineRun()
  const text = aggregatePipelineOutput(pipeline, run as any)
  assert.equal(text, '【节点 B】\nout-b\n\n【节点 A】\nout-a\n\n【节点 C】\nout-c')
  assert.ok(text.indexOf('out-b') < text.indexOf('out-a'), 'run.order drives the aggregation order')
})

test('aggregatePipelineOutput skips empty and failed node outputs', () => {
  const { pipeline, run } = makePipelineRun()
  run.nodeStates.b.output = ''
  delete run.nodeStates.c.output
  run.nodeStates.a = { status: 'failed', error: 'boom' }
  assert.equal(aggregatePipelineOutput(pipeline, run as any), '（Pipeline 没有产出文本输出）')

  // Partial output: only the node that actually produced text is included.
  run.nodeStates.b.output = 'out-b'
  assert.equal(aggregatePipelineOutput(pipeline, run as any), '【节点 B】\nout-b')
})

test('aggregatePipelineOutput falls back to the placeholder when the pipeline produced nothing', () => {
  const { pipeline } = makePipelineRun()
  const emptyRun = { id: 'run-1', pipelineId: 'p1', status: 'completed', order: [] as any[], nodeStates: {} }
  assert.equal(aggregatePipelineOutput(pipeline, emptyRun as any), '（Pipeline 没有产出文本输出）')
})

test('aggregatePipelineOutput truncates the combined text to MAX_GATE_OUTPUT_CHARS', () => {
  assert.equal(MAX_GATE_OUTPUT_CHARS, 20000)
  const pipeline = {
    id: 'p1',
    name: 'Pipeline one',
    nodes: [{ id: 'a', name: '节点 A', command: '' }],
    edges: [] as any[],
  }
  const run = {
    id: 'run-1',
    pipelineId: 'p1',
    status: 'completed',
    order: ['a'],
    nodeStates: { a: { status: 'completed', output: 'x'.repeat(MAX_GATE_OUTPUT_CHARS + 5000) } },
  }
  assert.equal(aggregatePipelineOutput(pipeline, run as any).length, MAX_GATE_OUTPUT_CHARS)
})

// ---------------------------------------------------------------------------
// renderGatePrompt
// ---------------------------------------------------------------------------

/** Prompt fixture inputs. */
function makePromptInputs(overrides: any = {}) {
  const { pipeline, run } = makePipelineRun()
  return {
    gate: makeGate({ name: '结果门禁', command: '输出必须包含 DONE' }),
    pipeline,
    pipelineRun: run,
    pipelineOutput: '【节点 A】\nout-a',
    stepIndex: 0,
    iteration: 2,
    ...overrides,
  }
}

test('renderGatePrompt renders the group/attempt header and the agent command', () => {
  const prompt = renderGatePrompt(makePromptInputs())
  assert.equal(typeof prompt, 'string')
  assert.match(prompt, /门禁节点/)
  assert.match(prompt, /第 1 组 \/ 第 2 次尝试/)
  assert.ok(prompt.includes('输出必须包含 DONE'), 'the agent command is the judgement requirement')
  assert.ok(prompt.includes('Pipeline one'), 'the pipeline name is named in the prompt')
  assert.ok(prompt.includes('【节点 A】\nout-a'), 'the aggregated pipeline output is embedded')
  assert.match(prompt, /结论规则/)
  assert.match(prompt, /TRUE/)
  assert.match(prompt, /FALSE/)
  assert.match(prompt, /第一行/)
})

test('renderGatePrompt offsets the group number by stepIndex', () => {
  const prompt = renderGatePrompt(makePromptInputs({ stepIndex: 2, iteration: 1 }))
  assert.match(prompt, /第 3 组 \/ 第 1 次尝试/)
})

test('renderGatePrompt wraps a skill gate with the skill instruction and optional supplement', () => {
  const gate = makeGate({ type: 'skill', skill: 'office-docx', command: '用 docx skill 检查文档结构' })
  const prompt = renderGatePrompt(makePromptInputs({ gate }))
  assert.ok(prompt.includes('office-docx'))
  assert.match(prompt, /请使用 skill/)
  assert.match(prompt, /任务补充信息/)
  assert.ok(prompt.includes('用 docx skill 检查文档结构'))

  const noSupplement = renderGatePrompt(makePromptInputs({ gate: { ...gate, command: '' } }))
  assert.ok(noSupplement.includes('office-docx'))
  assert.doesNotMatch(noSupplement, /任务补充信息/)
})

test('renderGatePrompt falls back to the empty-output placeholder when aggregation is empty', () => {
  const inputs = makePromptInputs({ pipelineOutput: '' })
  inputs.pipelineRun = { ...inputs.pipelineRun, order: [] as any[], nodeStates: {} }
  const prompt = renderGatePrompt(inputs)
  assert.ok(prompt.includes('（Pipeline 没有产出文本输出）'))
})
