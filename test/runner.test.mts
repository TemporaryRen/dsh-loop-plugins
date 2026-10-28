/**
 * Unit tests for the real node runner (`createAgentNodeRunner`) against fake
 * DSH services: no agent is created and nothing touches the host runtime.
 *
 * This pins the CONTRACT.md §5 recipe: create session -> resolveAgent -> read
 * `session.seq` -> followup(createUserMessage) -> flush -> poll for the matching
 * `turn/end` -> concatenate assistant text parts.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentNodeRunner } from '../lib/engine.js'

/**
 * Build a fake session + agent. `followup` records the message and, by default,
 * synchronously appends a completed turn so the runner's first poll succeeds.
 *
 * @param {object} [options]
 * @param {any[]} [options.priorEvents] - events recorded before the run starts.
 * @param {(state: any) => void} [options.onFollowup] - replace the default turn append.
 * @param {any} [options.reason] - turn/end reason for the appended turn.
 * @param {string[]} [options.texts] - assistant text blocks for the appended turn.
 * @param {any[][]} [options.replyBatches] - one content-block array per assistant message.
 */
function createFakeAgent({
  priorEvents = [],
  onFollowup = undefined,
  reason = { kind: 'completed' },
  texts = ['answer'],
  replyBatches = undefined,
}: any = {}) {
  const state = {
    events: [...priorEvents],
    lastTurn: 0,
    followups: [] as any[],
    cancelled: [] as any[],
    replyTexts: texts,
    replyReason: reason,
  }
  const session = {
    get seq() {
      return state.events.length
    },
    snapshotEvents(fromSeq = 0) {
      return Object.freeze(state.events.slice(fromSeq))
    },
  }
  const agent = {
    session,
    followup(message: string) {
      state.followups.push(message as any)
      if (onFollowup !== undefined) {
        onFollowup(state)
        return
      }
      const turn = state.lastTurn + 1
      state.lastTurn = turn
      state.events.push({ type: 'turn/start', seq: state.events.length, data: { turn } })
      const batches =
        replyBatches === undefined
          ? [
              [
                ...state.replyTexts.map((text: any) => ({ type: 'text', text })),
                { type: 'tool-call', name: 'read_file', arguments: { path: 'x' } },
              ],
            ]
          : replyBatches
      batches.forEach((content: any, index: any) => {
        state.events.push({
          type: 'assistant/message',
          seq: state.events.length,
          data: { turn, step: index + 1, message: { content } },
        })
      })
      state.events.push({ type: 'turn/end', seq: state.events.length, data: { turn, reason: state.replyReason } })
    },
    cancel(cause: any) {
      state.cancelled.push(cause as any)
    },
  }
  return { agent, state }
}

/** Fake sessionController + sessions services around a fake agent. */
function createServices(agent: any, { createArg: _createArg, resolveResult, flush }: any = {}) {
  const service = {
    createArgs: /** @type {any[]} */ [] as any[],
    resolveIds: /** @type {string[]} */ [] as any[],
    selectModelArgs: /** @type {any[]} */ [] as any[],
    flushCalls: 0,
    sessionController: {
      async create(request: any) {
        service.createArgs.push(request as any)
        return { sessionId: 'session-1' }
      },
      async selectModel(request: any) {
        service.selectModelArgs.push(request as any)
        return { selected: { provider: request.provider, model: request.model } }
      },
      async resolveAgent(sessionId: any) {
        service.resolveIds.push(sessionId as any)
        if (resolveResult !== undefined) return resolveResult
        return { agent }
      },
    },
    sessions: {
      async flush() {
        service.flushCalls += 1
        if (typeof flush === 'function') return flush()
        return true
      },
    },
  }
  return service
}

/** Default runner with a short poll interval (only used when a poll happens). */
function makeRunner(service: any, extra: any = {}) {
  return createAgentNodeRunner({
    resolveService: (name) => service[name],
    createUserMessage: (input) => ({ id: 'message-1', role: 'user', ...input }),
    pollIntervalMs: 5,
    ...extra,
  })
}

/** Abort signal for one node run. */
function makeSignal() {
  const controller = new AbortController()
  return { controller, signal: controller.signal }
}

test('the runner creates a session, delivers one user message and splits final answer from thinking', async () => {
  const { agent, state } = createFakeAgent({
    replyBatches: [
      [
        { type: 'reasoning', text: 'metadata 说 description 有 42 字节' },
        { type: 'tool-call', name: 'read_file', arguments: { path: 'x' } },
        { type: 'text', text: '我先看一下文件。' },
      ],
      [{ type: 'text', text: '最终结论：一切都好。' }],
    ],
  })
  const service = createServices(agent)
  const runner = makeRunner(service)
  const { signal } = makeSignal()

  const sessions: any[] = []
  const result = await runner({
    node: { id: 'a', title: 'A', prompt: 'do the thing' },
    prompt: 'do the thing',
    pipeline: { id: 'p1', name: 'P' },
    signal,
    onSession: (sessionId: any) => sessions.push(sessionId),
  } as any)

  assert.equal(result.sessionId, 'session-1')
  // Only the last assistant text is the result; reasoning, tool calls and the
  // earlier step's prose are folded into `thinking` (rendered collapsed).
  assert.equal(result.output, '最终结论：一切都好。')
  assert.equal(result.thinking, 'metadata 说 description 有 42 字节\n\n· 调用工具 read_file\n\n我先看一下文件。')
  assert.deepEqual(sessions, ['session-1'])
  assert.deepEqual(service.resolveIds, ['session-1'])
  assert.deepEqual(service.createArgs, [{ agentPreset: 'standard' }])
  assert.equal(service.flushCalls, 1)
  assert.equal(state.followups.length, 1)
  assert.equal(state.followups[0].source.kind, 'loop-manager')
  assert.deepEqual(state.followups[0].content, [{ type: 'text', text: 'do the thing' }])
  assert.deepEqual(state.cancelled, [])
})

test('the runner forwards the pipeline cwd to session creation only when set', async () => {
  const { agent } = createFakeAgent()
  const service = createServices(agent)
  const runner = makeRunner(service)
  const { signal } = makeSignal()

  await runner({ node: { id: 'a' }, prompt: 'x', pipeline: { id: 'p1', cwd: ' /tmp/work ' }, signal } as any)
  await runner({ node: { id: 'b' }, prompt: 'x', pipeline: { id: 'p1', cwd: '  ' }, signal } as any)

  assert.deepEqual(service.createArgs, [{ cwd: '/tmp/work', agentPreset: 'standard' }, { agentPreset: 'standard' }])
})

test('a node model is pinned through the session controller before the prompt', async () => {
  const { agent } = createFakeAgent()
  const service = createServices(agent)
  const runner = makeRunner(service)
  const { signal } = makeSignal()

  const result = await runner({
    node: { id: 'a', model: { provider: 'ark-gateway', model: 'deepseek-v4-1-flash-261017' } },
    prompt: 'x',
    pipeline: { id: 'p1' },
    signal,
  } as any)

  assert.deepEqual(service.selectModelArgs, [
    { sessionId: 'session-1', provider: 'ark-gateway', model: 'deepseek-v4-1-flash-261017' },
  ])
  assert.equal(result.output, 'answer')
  // No model on the node means no selection call at all.
  service.selectModelArgs.length = 0
  await runner({ node: { id: 'b' }, prompt: 'x', pipeline: { id: 'p1' }, signal } as any)
  assert.deepEqual(service.selectModelArgs, [])
})

test('live progress reports the folded thinking and latest text before the turn ends', async () => {
  const { agent } = createFakeAgent({
    onFollowup: (state: any) => {
      const turn = state.lastTurn + 1
      state.lastTurn = turn
      state.events.push({ type: 'turn/start', seq: state.events.length, data: { turn } })
      state.events.push({
        type: 'assistant/message',
        seq: state.events.length,
        data: {
          turn,
          step: 1,
          message: {
            content: [
              { type: 'reasoning', text: '先读一下文件' },
              { type: 'text', text: '中间说明' },
            ],
          },
        },
      })
      setTimeout(() => {
        state.events.push({
          type: 'assistant/message',
          seq: state.events.length,
          data: { turn, step: 2, message: { content: [{ type: 'text', text: '最终答案' }] } },
        })
        state.events.push({ type: 'turn/end', seq: state.events.length, data: { turn, reason: { kind: 'completed' } } })
      }, 25)
    },
  })
  const service = createServices(agent)
  const runner = makeRunner(service)
  const { signal } = makeSignal()
  /** @type {Array<{ output: string, thinking: string }>} */
  const progress: Array<{ output: string; thinking: string }> = []

  const result = await runner({
    node: { id: 'a' },
    prompt: 'x',
    pipeline: { id: 'p1' },
    signal,
    onProgress: (value: any) => progress.push(value),
  } as any)

  assert.ok(progress.length > 0, 'at least one progress frame was reported')
  assert.equal(progress[0].output, '中间说明')
  assert.equal(progress[0].thinking, '先读一下文件')
  assert.equal(result.output, '最终答案')
  assert.equal(result.thinking, '先读一下文件\n\n中间说明')
})

test('a node without its own model inherits the run-start default selection', async () => {
  const { agent } = createFakeAgent()
  const service = createServices(agent)
  const runner = makeRunner(service)
  const { signal } = makeSignal()

  await runner({
    node: { id: 'a' },
    prompt: 'x',
    pipeline: { id: 'p1' },
    signal,
    defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  } as any)

  assert.deepEqual(service.selectModelArgs, [
    { sessionId: 'session-1', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  ])
})

test('the runner ignores assistant events from before the delivered message', async () => {
  // A prior turn already exists in the session; only the new turn may be read.
  const priorEvents = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 1,
      data: { turn: 1, message: { content: [{ type: 'text', text: 'old output' }] } },
    },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const { agent } = createFakeAgent({ priorEvents, texts: ['new output'] })
  const service = createServices(agent)
  const runner = makeRunner(service)
  const { signal } = makeSignal()

  const result = await runner({ node: { id: 'a' }, prompt: 'x', pipeline: { id: 'p1' }, signal } as any)
  assert.equal(result.output, 'new output')
})

test('a non-completed turn fails the node and cancels the agent', async () => {
  const { agent, state } = createFakeAgent({ reason: { kind: 'error', error: { message: 'provider exploded' } } })
  const service = createServices(agent)
  const runner = makeRunner(service)
  const { signal } = makeSignal()

  await assert.rejects(
    runner({ node: { id: 'a' }, prompt: 'x', pipeline: { id: 'p1' }, signal } as any),
    /provider exploded/,
  )
  assert.deepEqual(state.cancelled, [{ kind: 'user' }])
})

test('an aborted signal cancels the agent turn', async () => {
  // The fake agent never ends its turn, so the runner stays in its poll loop.
  const { agent, state } = createFakeAgent({ onFollowup: () => undefined })
  const service = createServices(agent)
  const runner = makeRunner(service)
  const { controller, signal } = makeSignal()

  const pending = runner({ node: { id: 'a' }, prompt: 'x', pipeline: { id: 'p1' }, signal } as any)
  setTimeout(() => controller.abort(new Error('stopped by test')), 10)

  await assert.rejects(pending, /stopped by test/)
  assert.deepEqual(state.cancelled, [{ kind: 'user' }])
})

test('a missing session controller or session store fails with a clear message', async () => {
  const runner = createAgentNodeRunner({
    resolveService: () => undefined,
    createUserMessage: (input) => input,
    pollIntervalMs: 5,
  })
  const { signal } = makeSignal()

  await assert.rejects(
    runner({ node: { id: 'a' }, prompt: 'x', pipeline: { id: 'p1' }, signal } as any),
    /the session controller service is not mounted in this deployment/,
  )

  const noSessions = createAgentNodeRunner({
    resolveService: (name) => (name === 'sessionController' ? {} : undefined),
    createUserMessage: (input) => input,
    pollIntervalMs: 5,
  })
  await assert.rejects(
    noSessions({ node: { id: 'a' }, prompt: 'x', pipeline: { id: 'p1' }, signal } as any),
    /the session store service is not mounted in this deployment/,
  )
})

test('a resolveAgent error is surfaced and a false flush is tolerated', async () => {
  const { agent } = createFakeAgent()
  const errorService = createServices(agent, { resolveResult: { error: new Error('session unavailable') } })
  const errorRunner = makeRunner(errorService)
  const { signal } = makeSignal()
  await assert.rejects(
    errorRunner({ node: { id: 'a' }, prompt: 'x', pipeline: { id: 'p1' }, signal } as any),
    /session unavailable/,
  )

  const flushService = createServices(agent, { flush: () => false })
  const flushRunner = makeRunner(flushService)
  const result = await flushRunner({ node: { id: 'a' }, prompt: 'x', pipeline: { id: 'p1' }, signal } as any)
  assert.equal(result.output, 'answer')
})

test('a throwing flush does not fail the node', async () => {
  const { agent } = createFakeAgent()
  const service = createServices(agent, {
    flush: () => {
      throw new Error('no durability listener')
    },
  })
  const runner = makeRunner(service)
  const { signal } = makeSignal()

  const result = await runner({ node: { id: 'a' }, prompt: 'x', pipeline: { id: 'p1' }, signal } as any)
  assert.equal(result.output, 'answer')
})
