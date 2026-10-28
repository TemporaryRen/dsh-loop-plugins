/**
 * Smoke tests for the hand-written client bundle `lib/client.js`.
 *
 * The bundle is not a module: it calls `window.__ModuleLoader__.load(...)` and
 * receives `react` through the loader's `require`. These tests stand up that
 * contract in a `node:vm` sandbox with a minimal React stub and a minimal DOM
 * stub, then drive the factory, `apply()`, slot registration and one page
 * mount exactly like the host does.
 *
 * What is pinned here (the parts a host upgrade can break):
 *   - the bundle registers exactly one factory with id `dsh-loop-manager`;
 *   - `react` is the only module required;
 *   - `apply()` registers the sidebar row (id/label) and the main panel (key);
 *   - the injected stylesheet is the scoped design-prototype CSS;
 *   - mounting the page builds the workbench shell and polls the plugin API.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const BUNDLE_URL = new URL('../lib/client.js', import.meta.url)

// ---------------------------------------------------------------------------
// stubs
// ---------------------------------------------------------------------------

/** Minimal React stub; `useEffect` runs its effect immediately. */
function createReact(onEffect?: any) {
  function createElement(type: any, config: any, ...children: any) {
    const props = Object.assign({}, config)
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { type, props }
  }
  return {
    createElement,
    Fragment: Symbol.for('react.fragment'),
    useRef(initial: any) {
      return { current: initial }
    },
    useEffect(effect: any) {
      if (typeof onEffect === 'function') {
        const dispose = effect()
        onEffect(dispose)
      }
    },
    useState(initial: any) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useCallback(fn: any) {
      return fn
    },
    useMemo(fn: any) {
      return fn()
    },
  }
}

/** A minimal element stub: enough for the bundle's querySelector/render path. */
function createElementStub(className: any) {
  const element = {
    className: className || '',
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    children: [] as any[],
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false
      },
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return createElementStub('')
    },
    querySelectorAll() {
      return []
    },
    focus() {},
    setSelectionRange() {},
  }
  return element
}

/** A `document.head` that records injected styles. */
function createDocument() {
  const head = {
    children: [] as any[],
    appendChild(element: any) {
      head.children.push(element as any)
    },
    removeChild(element: any) {
      const index = head.children.indexOf(element as any)
      if (index >= 0) head.children.splice(index, 1)
    },
  }
  return {
    head,
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    createElement(tagName: any) {
      return {
        tagName: String(tagName).toUpperCase(),
        attributes: {} as Record<string, string>,
        textContent: '',
        setAttribute(name: string, value: any) {
          this.attributes[name] = value
        },
      }
    },
  }
}

/** Fake Cordis client context: captures slot registrations and effects. */
function createCtx() {
  const registered: any[] = []
  const injected: any[] = []
  const effects: any[] = []
  const ctx = {
    slots: {
      inject(name: string, callback: any) {
        injected.push(name)
        return callback()
      },
      register(options: any, component: any) {
        registered.push({ options, component })
        return function dispose() {}
      },
    },
    effect(fn: any) {
      effects.push(fn)
      const dispose = fn()
      return dispose
    },
  }
  return { ctx, registered, injected, effects }
}

/**
 * Evaluate the bundle in a fresh vm sandbox.
 * @returns {Promise<{registration: any, source: string}>}
 */
async function loadBundle(options: any = {}): Promise<{ registration: any; source: string }> {
  const registrations: any[] = []
  const sandbox: Record<string, any> = {
    console: { warn() {}, error() {}, log() {} },
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: {
        load(registration: any) {
          registrations.push(registration)
        },
      },
    },
  }
  if (typeof options.fetch === 'function') sandbox.fetch = options.fetch
  if (typeof options.crypto === 'object') sandbox.crypto = options.crypto
  if (options.document !== undefined) sandbox.document = options.document
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  const source = await readFile(BUNDLE_URL, 'utf8')
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1, 'bundle must register exactly one factory')
  return { registration: registrations[0], source }
}

/** Run the factory with a recording require. */
function materialize(registration: any, react: any) {
  const required: any[] = []
  const exports = registration.factory((spec: any) => {
    required.push(spec)
    if (spec === 'react') return react
    throw new Error(`unexpected require(${JSON.stringify(spec)})`)
  })
  return { exports, required }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('bundle registers one factory, id dsh-loop-manager, react only', async () => {
  const { registration, source } = await loadBundle()
  assert.equal(registration.id, 'dsh-loop-manager')
  const react = createReact()
  const { exports, required } = materialize(registration, react)
  assert.deepEqual(required, ['react'])
  assert.equal(exports.name, 'dsh-loop-manager')
  // Cross-realm arrays: compare copies, not the vm realm's Array prototype.
  assert.deepEqual(Array.from(exports.inject), ['slots'])
  assert.equal(typeof exports.apply, 'function')
  // The design prototype's stylesheet is embedded, scoped under .lm-root, with
  // the EMBER palette (the user's chosen colour style).
  assert.ok(source.includes('--ember:#B95C3A'), 'ember design tokens are embedded')
  assert.ok(source.includes('#B95C3A'), 'rust primary is used')
  assert.ok(source.includes('.lm-root .graph-node'), 'editor canvas is styled')
  assert.ok(source.includes('.lm-root .pipeline-row'), 'pipeline table is styled')
  // Model selection (same catalog as the chat composer) and the chat-like run log.
  assert.ok(source.includes("api('/models')"), 'model catalog endpoint is used')
  assert.ok(source.includes('lm-field-model'), 'node modal has a model dropdown')
  assert.ok(source.includes('跟随 Harness 默认模型'), 'the default-model option is offered')
  assert.ok(source.includes('lm-think'), 'run log folds the thinking process')
  assert.ok(source.includes('openThinking'), 'expanded thinking survives state re-renders')
  assert.ok(source.includes('data-think-key'), 'each thinking block carries a stable key')
  assert.ok(source.includes('thinkingScroll'), 'inner thinking scroll offsets survive re-renders')
  assert.ok(source.includes('最终结果'), 'run log shows the final result label')
  assert.ok(source.includes('standard mode'), 'execution is described as standard mode')
  // Start/stop require an explicit confirmation step.
  assert.ok(source.includes('function openRunConfirm'), 'start asks for confirmation')
  assert.ok(source.includes('function openStopConfirm'), 'stop asks for confirmation')
  assert.ok(source.includes('开始任务？'), 'start confirmation copy exists')
  assert.ok(source.includes('停止任务？'), 'stop confirmation copy exists')
  assert.ok(source.includes('data-action="confirm-run"'), 'start confirmation button exists')
  assert.ok(source.includes('data-action="confirm-stop"'), 'stop confirmation button exists')
  // PostgreSQL configuration entry and its read-source switch.
  assert.ok(source.includes('数据库配置'), 'database config nav entry exists')
  assert.ok(source.includes('function openDbModal'), 'database config modal exists')
  assert.ok(source.includes('lm-field-db-read'), 'read-from-database switch exists')
  assert.ok(source.includes("api('/db')"), 'database status endpoint is used')
  assert.ok(source.includes('保存并初始化'), 'save initializes the database')

  // ---- v9 Loop tab (CONTRACT.md §13.7) -----------------------------------
  // Navigation: the Loop button sits between Agent Pipeline and 运行记录.
  assert.ok(source.includes('data-nav="loops"'), 'Loop nav button exists')
  const navAll = source.indexOf('data-nav="all"')
  const navLoops = source.indexOf('data-nav="loops"')
  const navRecent = source.indexOf('data-nav="recent"')
  assert.ok(navAll >= 0 && navRecent >= 0, 'Agent Pipeline and 运行记录 nav buttons exist')
  assert.ok(navAll < navLoops && navLoops < navRecent, 'Loop tab renders right after Agent Pipeline')
  assert.ok(source.includes('lm-loop-count'), 'Loop nav carries the loop count badge')

  // Loop list view.
  assert.ok(source.includes('PIPELINE → GATE, UNTIL IT PASSES'), 'Loop list eyebrow copy exists')
  assert.ok(source.includes('还没有 Loop。新建一个'), 'Loop list empty state exists')
  assert.ok(source.includes('data-action="create-loop"'), 'new-Loop button is wired')
  assert.ok(source.includes('自动循环'), 'autoLoop policy is displayed')
  assert.ok(source.includes('手动循环'), 'manual-loop policy is displayed')
  assert.ok(source.includes('data-loop-run'), 'loop rows can start a run')
  assert.ok(source.includes('data-loop-stop'), 'a running loop can be stopped')
  assert.ok(source.includes('data-open-loop'), 'loop rows open the detail view')

  // Loop detail flow + the manual retry affordance.
  assert.ok(source.includes('lm-loop-flow'), 'loop detail flow markup exists')
  assert.ok(source.includes('lm-loop-stage'), 'each group renders as one stage')
  assert.ok(source.includes('lm-loop-pipeline'), 'pipeline card markup exists')
  assert.ok(source.includes('lm-loop-gate'), 'gate card markup exists')
  assert.ok(source.includes('lm-loop-retry'), 'gate retry button is styled')
  assert.ok(source.includes('data-loop-retry'), 'retry button carries the step id')
  assert.ok(source.includes('重新循环'), 'manual retry copy exists')
  assert.ok(source.includes('lm-loop-link'), 'groups are linked top-to-bottom')
  assert.ok(source.includes('lm-loop-finish'), 'the completion rule closes the flow')
  assert.ok(source.includes('即完成'), 'the loop completion rule is shown')

  // Loop editor modal (steps + gate fields).
  assert.ok(source.includes('lm-loop-form'), 'the Loop editor has its own scoped modal class')
  assert.ok(source.includes('data-loop-step-action'), 'step add/remove/reorder controls are wired')
  assert.ok(source.includes('data-action="add-step"'), '＋ 添加一组 Pipeline + 门禁 button exists')
  assert.ok(source.includes('lm-field-gate-auto'), 'autoLoop switch exists')
  assert.ok(source.includes('lm-field-gate-max'), 'auto-loop maxIterations input exists')
  assert.ok(source.includes('lm-field-gate-skill'), 'skill gate picker exists')
  assert.ok(source.includes('lm-field-gate-command'), 'agent gate command textarea exists')

  // API wiring.
  assert.ok(source.includes("api('/loops'"), 'POST /api/loops is used')
  assert.ok(source.includes('api(`/loops/'), 'PUT/PATCH/DELETE /api/loops/:id are used')
  assert.ok(source.includes('api(`/loop-runs/'), 'loop run stop/retry/delete are used')

  // Polling: faster while a LoopRun is running (CONTRACT.md §13.7).
  assert.ok(source.includes('POLL_RUNNING_MS = 700'), 'running poll is 700 ms')
  assert.ok(source.includes('POLL_IDLE_MS = 1500'), 'idle poll is 1500 ms')
  assert.ok(source.includes('.badge.awaiting'), 'awaiting badge style exists')
})

test('apply registers the sidebar row and the main panel', async () => {
  const documentStub = createDocument()
  const { registration } = await loadBundle({ document: documentStub })
  const { ctx, registered, injected } = createCtx()
  const { exports } = materialize(registration, createReact())
  exports.apply(ctx)

  assert.deepEqual(injected, ['sidebar.panellist', 'main'])
  assert.equal(registered.length, 2)

  const [row, panel] = registered
  assert.equal(row.options.name, 'sidebar.panellist')
  assert.equal(row.options.id, 'loop-manager')
  assert.equal(row.options.order, 5)
  assert.equal(row.options.label(), 'Loop Manager')
  const glyphElement = row.component({ size: 18, active: true })
  const glyph = glyphElement.type(glyphElement.props)
  assert.equal(glyph.type, 'svg')
  assert.equal(glyph.props.width, 18)
  assert.equal(glyph.props.stroke, 'currentColor')

  assert.equal(panel.options.name, 'main')
  assert.equal(panel.options.key, 'loop-manager')

  // The stylesheet landed in document.head with our data marker.
  assert.equal(documentStub.head.children.length, 1)
  const style = documentStub.head.children[0]
  assert.equal(style.attributes['data-dsh-loop-manager'], '')
  assert.ok(style.textContent.includes('.lm-root .metric'))
})

test('the panel component mounts the workbench and polls the state API', async () => {
  const requests: any[] = []
  const sandboxFetch = async (url: any) => {
    requests.push(String(url))
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, pipelines: [] as any[], runs: [] as any[], loops: [] as any[], loopRuns: [] }
      },
    }
  }
  const documentStub = createDocument()
  const { registration } = await loadBundle({ fetch: sandboxFetch, document: documentStub })
  const { ctx, registered } = createCtx()

  const root = createElementStub('lm-root')
  const disposers: any[] = []
  const react = createReact((dispose: any) => {
    if (typeof dispose === 'function') disposers.push(dispose)
  })
  // The page mounts into the ref React hands it: point that ref at our stub.
  react.useRef = () => ({ current: root })

  try {
    const { exports } = materialize(registration, react)
    exports.apply(ctx)
    const panel = registered[1]

    // Host render of the `main` slot: () => h(LoopPage); render LoopPage here.
    const pageElement = panel.component()
    const rendered = pageElement.type()
    assert.equal(rendered.type, 'div')
    assert.equal(rendered.props.className, 'lm-root')

    assert.ok(root.innerHTML.includes('lm-shell'), 'workbench shell was mounted')

    // Let the mount-time refresh hit the API.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(
      requests.some((url) => url === '/loop-manager/api/state'),
      'state endpoint was polled',
    )
    assert.ok(
      requests.some((url) => url === '/loop-manager/api/models'),
      'model catalog was requested',
    )

    // Design-system markers in the injected, scoped stylesheet.
    const style = documentStub.head.children[0]
    assert.ok(style.textContent.includes('.lm-root .canvas'), 'canvas rules are scoped')
    assert.ok(style.textContent.includes('.lm-root .logs'), 'log panel rules are scoped')
    assert.ok(style.textContent.includes('.lm-root .logs .lm-think'), 'folded thinking rules are scoped')
    assert.ok(style.textContent.includes('.lm-root .modal'), 'modal rules are scoped')
    assert.ok(style.textContent.includes('.lm-root .lm-switch'), 'database read switch is styled')
  } finally {
    for (const dispose of disposers) dispose()
  }
  assert.equal(root.innerHTML, '', 'unmount clears the mounted DOM')
})
