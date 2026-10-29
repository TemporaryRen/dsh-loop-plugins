# Loop Manager — 实现契约 (implementation contract)

DSH 插件 `dsh-loop-manager`。左侧 sidebar 增加 **Loop Manager** 按钮，点击进入主页；主页是
所有 loop pipeline 的列表，可以新建 / 编辑 / 删除 / 运行。一个 pipeline 是一张有向无环图 (DAG)，
节点是一段 agent 任务指令，运行时按拓扑顺序逐节点执行。

本文件是 host 半（`lib/index.ts` 等）与 client 半（`lib/client.ts`）之间唯一的接口契约。
**两侧必须严格遵守，任何改动都要同步改本文件。**

> **v2（设计对齐）**：UI 与数据模型对齐设计原型
> `/Users/temporary/source/workflow-skill/loop-pipeline-ui`（`design/design-spec.md`、
> `design/tokens.json`、`ui/style.css`、`ui/app.js`）。见 §9；§2/§4 的字段以 §9 为准。

---

## 9. v2 设计对齐（最高优先级，覆盖 §2 / §4 中冲突的字段）

### 9.1 设计来源（必须实际读这些文件，不要凭印象）

```
/Users/temporary/source/workflow-skill/loop-pipeline-ui/design/design-spec.md   # 页面结构/交互规则
/Users/temporary/source/workflow-skill/loop-pipeline-ui/design/tokens.json      # 颜色/字号/圆角/布局
/Users/temporary/source/workflow-skill/loop-pipeline-ui/ui/style.css            # 精确样式（压缩成 3 行）
/Users/temporary/source/workflow-skill/loop-pipeline-ui/ui/app.js               # 布局算法/交互（压缩）
/Users/temporary/source/workflow-skill/loop-pipeline-ui/ui/index.html           # DOM 骨架
```

### 9.2 数据模型（v2）

```ts
interface Pipeline {
  id: string
  name: string // 必填，trim 非空，≤50
  desc?: string // ≤160
  icon?: string // 1–2 个字符的图形字符，默认 '◈'
  color?: string // '' | 'blue' | 'peach' | 'purple'（对应设计里的图标底色类）
  nodes: PipelineNode[]
  edges: PipelineEdge[] // { from, to }
  star?: boolean // 收藏
  cwd?: string // 保留：节点 agent 的工作目录，可选
  createdAt: number
  updatedAt: number
}

interface PipelineNode {
  id: string
  name: string // 必填，trim 非空，≤40
  type?: 'agent' | 'skill' // 缺省 'agent'（§10）
  command: string // 必填，agent 指令（可含 {{input}} / {{node:<id>}}）
  skill?: string // type='skill' 时必填：已安装 skill 的 kebab-case 名称
  model?: { provider: string; model: string } // 可选：该节点钉住的 DSH 模型；缺省 = 跟随 Harness 默认模型
}
```

**节点有两种类型**（§10）：`agent`（自由指令）与 `skill`（钉住一个已安装 skill）。
MCP 工具没有独立字段：需要时在命令或补充信息里直接点名（`mcp__<server>__<tool>`）。
历史数据里 v2 的 `skills`/`mcp` 字段会在加载时折叠进 `command`，不会丢信息。
节点可选 `model`（v4，§11）：`{provider, model}` 必须是 DSH 模型目录里的路由；
缺省 / 空值时节点 session 使用部署的默认模型。

兼容：读入时接受旧字段 `title`→`name`、`prompt`→`command`、`description`→`desc`
（`normalizeNode` / `normalizePipelineInput` 里做迁移），写回一律新字段。

Run 增加 `pipelineName`（运行历史展示用，pipeline 删除后仍可读）：

```ts
interface Run {
  id
  pipelineId
  pipelineName
  status
  startedAt
  finishedAt
  order: string[]
  nodeStates: Record<string, NodeState>
  error?
}
```

### 9.3 节点指令组装（host `renderNodePrompt`）

只做 §3 的 `{{input}}` / `{{node:<id>}}` 替换，**不再附加任何 Skills/MCP 说明块** ——
命令文本原样交给 agent（命令即 skill；需要已有 skill/MCP 时在命令里直接说明）。

### 9.4 HTTP API v2（在 §4 基础上）

| Method    | Path                                  | Body                                            | 说明                                                                                                                                             |
| --------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET       | `/loop-manager/api/state`             | —                                               | `{ok, pipelines, runs, source}`；`runs` 为历史（新→旧，最多 50 条）                                                                              |
| GET       | `/loop-manager/api/skills`            | —                                               | 已安装 skill 目录：`{ok, skills:[{name,description,source}]}`（供 SKILL 节点下拉框）                                                             |
| GET       | `/loop-manager/api/db`                | —                                               | PostgreSQL 配置/状态（§12）                                                                                                                      |
| PUT       | `/loop-manager/api/db`                | v2 见 §12                                       | 保存并初始化，`readFromDb` 控制读取源                                                                                                            |
| POST      | `/loop-manager/api/db/test`           | v2 见 §12                                       | 连接测试 + 建表初始化，不保存                                                                                                                    |
| GET       | `/loop-manager/api/models`            | —                                               | DSH 模型目录：`{ok, providers:[{id,name,models:[{id,name,description?}]}], default?, failures?}`（供节点模型下拉框，与 chat composer 一致，§11） |
| POST      | `/loop-manager/api/pipelines`         | v2 pipeline（节点可带 `model`）                 | 新建（`star` 默认 false）                                                                                                                        |
| PUT       | `/loop-manager/api/pipelines/:id`     | v2 pipeline（节点可带 `model`）                 | 整体替换（保留 `createdAt`；`star` 省略时保留旧值）                                                                                              |
| **PATCH** | `/loop-manager/api/pipelines/:id`     | 任意子集 `{name?, desc?, icon?, color?, star?}` | 部分更新（星星收藏/改标题走这里）                                                                                                                |
| DELETE    | `/loop-manager/api/pipelines/:id`     | —                                               | 删除（同时删掉其运行记录）                                                                                                                       |
| POST      | `/loop-manager/api/pipelines/:id/run` | —                                               | 202 `{ok, run}`                                                                                                                                  |
| POST      | `/loop-manager/api/runs/:runId/stop`  | —                                               | 停止                                                                                                                                             |
| DELETE    | `/loop-manager/api/runs/:runId`       | —                                               | 删除已结束记录                                                                                                                                   |

校验：`name` 必填 ≤50；`desc` ≤160；节点 `name` ≤40、`command` 必填；
节点 `model` 若存在必须同时给出 `provider` 与 `model`（各 ≤64 / ≤128，trim 非空，否则 `bad-request`）；
图校验同 §3。错误 code 同 §4，另加 `pipeline-not-found`/`run-not-found`。

### 9.5 Client 适配规则（重要）

原型是**独立整页应用**（自带左侧 aside 品牌/工作空间/导航/个人信息）。我们的页面活在
DSH 的 `main` 面板里，DSH 已有左侧边栏，因此：

1. **不要**渲染原型的 `<aside>`（brand / workspace / nav-label / tip / profile）。
2. 原型导航改为面板内的顶部分段导航（三个 pill 按钮）：`我的 Pipelines` / `运行记录` / `已收藏`，
   激活态沿用 `.nav.active` 的样式（`#EAF1E6` 底、`#286E53` 字、600 字重）。
3. 保留并移植：`header`（面包屑 + 右侧保存状态）、`.heading`、`.metrics`（4 个统计）、
   `.toolbar`（tabs + 搜索 + 排序）、`.table`（表头 + `.pipeline-row`）、`.mini-dag`、
   `.badge`（draft/running/success/error）、`.footer`、`.editor-bar`、`.canvas`+`.graph`
   （点阵背景、按依赖层级左→右自动布局、SVG 贝塞尔箭头）、`.detail-grid`（右侧 `.panel`
   连接面板 + 执行规则说明）、`.logs`（深绿日志面板）、`.modal`、`#toast`、`.empty`、
   `.history-row`。
4. 所有选择器作用域到 `.lm-root` 下（样式注入时统一加前缀），避免污染 DSH 全局样式。
5. **不要** `@import` Google Fonts（离线环境会阻塞）；字体族写
   `'DM Sans','Noto Sans SC',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`。
6. 表单控件规范（v5）：所有 `select` 统一 40px 高、`padding:10px 36px 10px 12px`、
   自绘 chevron（`appearance:none` + data-URI 背景）、13px 字号、8px 圆角、暖色边框与焦点环；
   排序下拉最小宽 136px，连接面板下拉 38px 高。禁止依赖浏览器原生窄下拉。
   颜色/圆角/尺寸严格取 `tokens.json`；不要用 DSH 主题变量（本面板是设计稿的浅色工作台）。
   **v4 起配色切换为 EMBER 暖色主题**（用户指定）：陶土红 `#B95C3A`、暖底 `#F8F5EE`、
   卡片 `#FCFBF7`、文字 `#2E261C`、边框 `#E7DED0`、日志面板 `#2B1D15`；结构/字号/布局不变。
   列表页新增 hero 横幅（`AGENT WORKBENCH` 眉标 + `Make room for deep work.` 标题 +
   等宽命令条 + 右下 `READY WHEN YOU ARE.`），页头右侧显示主题标识 `EMBER / 01`。
   **表格配色（用户指定）**：内容单元格 `#FFFDF7`、表头单元格 `#F2E8D8`、表格外边框
   `#E1CDB1`、流程表行分隔线 `#ECE0CD`（`.table` / `.table-head` / `.pipeline-row` /
   `.history-row`）；行 hover 用同色系浅底 `#FBF6EC`。**统计信息栏 `.metrics` 同底色与外边框**
   （`#FFFDF7` + `#E1CDB1`），与表格连成一套暖白卡片；`.metric` 之间的竖分隔线仍取 `--line`。
7. 文案：标题用 `Loop Manager`；**Agent Pipeline 列表的主按钮是 `新建 Pipeline`**（它创建的是
   pipeline），**Loop 列表的主按钮是 `新建 Loop`**；其余文案照设计稿。
8. 交互对齐设计稿：点行进入编排页、`开始任务` 运行、`更多` 菜单（收藏/删除）、
   Escape 关闭弹窗、Toast、运行中禁用编辑、日志面板按节点状态追加、
   空工作流不能运行、添加连接时校验自连接/重复/环并 Toast 提示。
   **v5 起 `开始任务` 与 `停止任务` 点击后先弹确认框**（删除 Pipeline 原本就有二次确认）：
   - 开始：「开始任务？」+ 节点数 / standard mode 说明 / 模型说明，按钮 `取消` / `开始任务`；
   - 停止：「停止任务？」+ 已运行时长 / 当前节点说明，按钮 `取消` / `停止任务`。
     确认后才发 `POST /api/pipelines/:id/run` 或 `POST /api/runs/:runId/stop`。
9. 节点弹窗**不再有** Skills / MCP 输入框，只有「节点名称 + Agent 命令」；
   画布节点卡副标题固定为 `Agent 指令`（因为能力都写在命令里）。
10. 侧边栏按钮注册保持不变：`sidebar.panellist` id=`loop-manager`、label=`Loop Manager`；
    main 面板 key=`loop-manager`。
11. 真实执行语义不变：节点仍由 host 按拓扑序串行执行真实 agent turn；日志/状态来自
    `GET /api/state` 轮询（1.5s 空闲 / 0.7s 运行中），不是设计稿的模拟定时器。

## 1. 包结构

```
package.json          # 已完成（name=dsh-loop-manager, dsh.bundle.patch, dsh.client）
cordis.patch.yml      # 已完成（insert 行：id=loop-manager, name=dsh-loop-manager）
icon.svg
lib/index.ts          # host 半（ESM，Cordis 插件：export name / inject / apply）
lib/dag.ts            # host 半：纯函数图算法（拓扑排序、环检测、校验）
lib/store.ts          # host 半：JSON 持久化
lib/engine.ts         # host 半：运行编排（调用 sessionController / agents 跑真实 agent turn）
lib/db.ts             # host 半：PostgreSQL 持久化（建表初始化 / mirror / 可选从库读取）
lib/client.ts         # client 半：__ModuleLoader__ 工厂 bundle（TypeScript 编译，保留浏览器脚本注册协议）
test/*.test.mts       # node:test，覆盖 dag / store / engine / runner / db / client bundle
README.md
```

Host 半只依赖 Node 标准库 + 一个 DSH 包：

```js
import { createUserMessage } from '@deepseek-ai/dsh-llm'
```

（`dsh-better-sidebar`、`dsh-schedule` 都这样 import 宿主包，profile 的 ESM 解析链能解析；
不要 import 其它宿主包。）

---

## 2. 数据模型

所有 id 都是 `crypto.randomUUID()` 生成的字符串。

```ts
interface Pipeline {
  id: string
  name: string // 展示名，trim 后非空，≤200 字符
  description?: string
  cwd?: string // 节点 agent 的工作目录；空 = 宿主默认目录
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  createdAt: number // epoch ms
  updatedAt: number
}

interface PipelineNode {
  id: string
  title: string // 节点名，trim 后非空，≤200
  prompt: string // agent 指令（可含 {{input}} / {{node:<id>}} 占位符）
  model?: { provider: string; model: string } // v4：节点钉住的模型；见 §11
}

interface PipelineEdge {
  from: string
  to: string
} // from -> to（from 先执行）
```

运行记录（只保存在内存中，同时把每个 pipeline 的最近一次 run 落盘）：

```ts
interface Run {
  id: string
  pipelineId: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  finishedAt?: number
  order: string[] // 本次运行的拓扑序（nodeId）
  nodeStates: Record<string, NodeState>
  error?: string // run 级错误
}

interface NodeState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  sessionId?: string // 该节点 agent 所在 session，可让用户点进去看
  output?: string // 该节点最终 assistant 文本（≤20000 字符截断）
  thinking?: string // v4：折叠展示的思考过程（≤12000 字符截断）
  error?: string
  startedAt?: number
  finishedAt?: number
}
```

---

## 3. 图语义与校验

- 有向无环图。允许孤立节点（无边的节点 = 起点）。不允许自环。
- 边引用的节点必须存在。
- 环检测：Kahn 算法；剩余节点即环成员，报错信息列出环上节点标题。
- 执行顺序：拓扑序（Kahn，多个可执行节点时按 `nodes` 数组中的先后顺序，稳定排序）。
- 起点 = 入度为 0 的节点；从起点开始按拓扑序**串行**执行。
- 节点失败或 run 被停止：后续所有节点记为 `skipped`，run 状态 `failed` / `stopped`。
- 图中每个可达节点都执行（DAG 中所有节点都有入度为 0 的祖先）。

`lib/dag.ts` 需要导出的纯函数（必须被 test 覆盖）：

```js
export function validateGraph(nodes, edges)      // -> { ok: true } | { ok: false, code, message }
export function topologicalOrder(nodes, edges)   // -> { ok: true, order: string[] } | { ok: false, code, message }
export function predecessors(edges, nodeId)      // -> string[]（直接前驱，按 edges 顺序去重）
export function renderNodePrompt(node, nodes, edges, outputs) // -> string
```

`renderNodePrompt` 规则（`outputs` 是 `Record<nodeId, string|undefined>`）：

1. 替换 `{{node:<id>}}`：该前驱（或任意已知节点）的输出；未知 / 未产出 → 空字符串。
2. 替换 `{{input}}`：把所有**直接前驱**的输出按前驱顺序拼接，每段格式：
   ```
   [<前驱节点标题>]
   <输出>
   ```
   段之间用 `\n\n` 分隔。
3. 如果 prompt 里既没有 `{{input}}` 也没有 `{{node:...}}`，并且存在前驱输出，则在 prompt 末尾追加：
   ```
   \n\n--- 上游节点输出 ---\n
   ```
   后接同上格式的拼接段。

---

## 4. Host HTTP API

前缀路由：`/loop-manager`（`ctx.webServer.register({ kind: 'prefix', path: '/loop-manager', handler })`）。

鉴权（重要）：

- 插件第二个参数就是 loader 传来的 config：`export function apply(ctx, config = {})`，
  用 `const requireAuth = config?.requireAuth !== false`（默认 `true`）。
- `requireAuth` 为 true 时，除 `GET /loop-manager/api/ping` 外的每个请求先做
  `ctx.connection.requestRejection(req) !== undefined` → 回 `401`（带 JSON 信封）。
- `GET /loop-manager/api/ping` 永远放行，只回 `{ok:true, name:'dsh-loop-manager', version}`，
  不读任何数据 —— 用于验证插件是否挂载（无需浏览器 cookie）。
- 不要 export `Config` schema（避免依赖 schemastery）；config 按普通对象读取。

所有响应是 JSON，`content-type: application/json; charset=utf-8`。
统一信封：成功 `{ ok: true, ...payload }`，失败 `{ ok: false, code, error }`（HTTP 400/401/404/409/500）。

| Method | Path                                  | Body / Query                                                 | 成功响应                                                                                            |
| ------ | ------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| GET    | `/loop-manager/api/state`             | —                                                            | `{ ok:true, pipelines, runs, source: 'local'                                                        | 'db', dbError? }` |
| GET    | `/loop-manager/api/models`            | —                                                            | `{ ok:true, providers, default?, failures? }`（§11；与 chat composer 同一目录）                     |
| GET    | `/loop-manager/api/db`                | —                                                            | `{ ok:true, db: { configured, readFromDb, connected, initialized, error, config? } }`（密码不返回） |
| PUT    | `/loop-manager/api/db`                | `{host, port, database, user, password?, ssl?, readFromDb?}` | 保存 + 连接 + 建表初始化 + 空库导入；返回 `{ok, db, imported}`                                      |
| POST   | `/loop-manager/api/db/test`           | 同上（不保存）                                               | 测试连接并初始化 schema                                                                             |
| POST   | `/loop-manager/api/pipelines`         | `{name, description?, cwd?, nodes, edges}`                   | `{ ok:true, pipeline }`                                                                             |
| PUT    | `/loop-manager/api/pipelines/:id`     | 同上（整体替换）                                             | `{ ok:true, pipeline }`                                                                             |
| DELETE | `/loop-manager/api/pipelines/:id`     | —                                                            | `{ ok:true }`                                                                                       |
| POST   | `/loop-manager/api/pipelines/:id/run` | —                                                            | `{ ok:true, run }`（202）                                                                           |
| POST   | `/loop-manager/api/runs/:runId/stop`  | —                                                            | `{ ok:true, run }`                                                                                  |
| DELETE | `/loop-manager/api/runs/:runId`       | —                                                            | `{ ok:true }`（只允许非 running）                                                                   |

错误 code 取值：
`bad-request`（400）、`invalid-graph`（400）、`pipeline-not-found`（404）、`run-not-found`（404）、
`run-in-progress`（409：同一 pipeline 已有 running run）、`db-error`（400：数据库连接/初始化失败）、
`internal`（500）。

- `POST /pipelines` 的 `nodes`/`edges` 必须是数组；`id`、`createdAt`、`updatedAt` 由服务端生成。
- `PUT` 保留 `id`/`createdAt`，重算 `updatedAt`；节点 / 边的 `id` 由客户端提供，服务端校验唯一性。
- 保存前必须 `validateGraph`，失败返回 `invalid-graph`。
- 运行中的 run 才出现在 `runs` 里；已结束的 run 保留在内存中（最多保留每个 pipeline 最近 5 条）。

---

## 5. 节点执行（host 关键实现）

参考已验证的宿主用法（`dsh-schedule` 投递提醒、`dsh-better-sidebar` 的 side chat）：

```js
// 1. 新建一个真实 session（用户可以在会话列表里看到并点进去看执行过程）
//    节点统一跑在 DSH 的 standard preset 上，工具面与普通 chat 会话一致。
const created = await ctx.sessionController.create({ cwd, agentPreset: 'standard' }) // -> { sessionId }
const resolved = await ctx.sessionController.resolveAgent(created.sessionId)
if ('error' in resolved) throw resolved.error
const agent = resolved.agent

// 1b. 节点钉了模型时，用 chat composer 同一条选择缝固定本 session 的模型；
//     失败即节点失败（不能悄悄换成另一个模型）。
await ctx.sessionController.selectModel({ sessionId: created.sessionId, provider, model })

// 2. 记录起点 seq，再投递指令
const startSeq = lastSeq(agent.session.snapshotEvents())
agent.followup(
  createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'loop-manager' },
  }),
)
await ctx.sessions.flush(agent.session)

// 3. 轮询 session 事件，等待本次 turn 结束
//    turn/end 事件 data = { turn, reason: { kind: 'completed' | 'error' | 'aborted' | ... } }
//    assistant/message 事件 data = { message: { content: [{type:'text',text}, {type:'reasoning',text}, {type:'tool-call'}, ...] }, turn, step }
//    只取 seq > startSeq 的事件：
//      output   = 该 turn 最后一条 assistant/message 的 text 块（只有最终结果）
//      thinking = 同一 turn 内 reasoning 块 + 工具调用标记 + 较早 assistant 文本（折叠展示）
//    轮询期间把当前已提交的 output/thinking 作为 live progress 回填 nodeStates，让日志边跑边显示。
```

要求：

- 轮询间隔 400ms；单节点默认超时 30 分钟（超时 → `agent.cancel({ kind: 'user' })`，节点 failed）。
- 节点失败判定：`turn/end.reason.kind !== 'completed'`（`aborted`/`error` 均为失败）或超时或抛错。
- 停止 run：对当前 running 节点 `agent.cancel({ kind: 'user' })`，后续节点 skipped。
- 每个 run 开始时快照一次部署默认模型；无 `model` 的节点都钉到这份快照（避免上一个节点
  改默认模型后影响下一个节点）。
- 同一节点执行期间要更新 `nodeStates` 并落盘（状态变化立即落盘；live progress 只更新内存状态即可，
  完成/失败时再落盘）。
- 每个节点完成后，把 output 传给下游节点（`renderNodePrompt`）；`thinking` 永不进入下游上下文。
- `nodeStates[nodeId].thinking` 只保留最近一次节点的折叠过程（≤12000 字符，节流后落盘）。
- 异常兜底：`sessionController` / `sessions` 服务缺失时，`POST run` 返回 `internal` 并在 run.error
  里写清楚 "the session controller service is not mounted in this deployment"。
- `apply()` 必须 `ctx.effect(() => () => { /* 停止所有 run 的调度 */ })` 清理。

服务注入：`export const inject = ['webServer', 'connection', 'sessions', 'sessionController', 'agents']`
（这些服务在 `dsh-base` + web-app 组合里都存在；`agents` 用于 cancel）。

---

## 6. 持久化

文件：`<DSH_HOME 或 ~/.dsh>/loop-manager/state.json`，`DSH_HOME` 从 `process.env.DSH_HOME` 取。

```json
{ "version": 1, "pipelines": [Pipeline...], "lastRuns": { "<pipelineId>": Run } }
```

- 原子写：写 `state.json.tmp-<rand>` → `rename`。
- 启动时读；文件不存在 = 空库；JSON 损坏 → 记日志、按空库启动并在下次写时覆盖（不要抛异常阻断插件加载）。
- 写失败只记日志，不能让 HTTP 请求 500（除了确实要落盘的 CRUD 失败）。

`lib/store.ts` 导出 `createStore({ file, logger })`，方法：
`load()`、`listPipelines()`、`getPipeline(id)`、`upsertPipeline(p)`、`removePipeline(id)`、
`listRuns()`、`setRun(run)`、`removeRun(runId)`、`saveLastRun(pipelineId, run)`。

---

## 7. Client 半（`lib/client.ts`）

手写 bundle，格式（`dshmarket` / `dsh-better-sidebar` 同款，`id` 必须是包名）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-loop-manager',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useMemo, useRef, useCallback } = React
    // ...组件...
    const name = 'dsh-loop-manager'
    const inject = ['slots']
    function apply(ctx) {
      /* 注册样式 + main 面板 + sidebar 行 */
    }
    return { name, inject, apply }
  },
})
```

可用的 `require` 平台模块（static module table）：`react`、`react/jsx-runtime`、`react-dom`、
`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
**只用 `react`**，其余不 require，避免版本漂移。

注册（顺序无所谓，用 `slots.inject` 等 slot 出现）：

```js
const PANEL_ID = 'loop-manager'

// 左侧 sidebar 的一行：图标 + label，点击后 layout 自动 selectPanel(PANEL_ID)
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 5,
      label: () => 'Loop Manager',
    },
    (owner) => h(LoopGlyph, { size: owner?.size ?? 18 }),
  ),
)

// 主页（main 插槽里的一个 panel）
ctx.slots.inject('main', () =>
  ctx.slots.register(
    {
      name: 'main',
      key: PANEL_ID,
    },
    () => h(LoopPage),
  ),
)

// 样式：apply() 内一次性注入 <style data-dsh-plugin="dsh-loop-manager">
```

`sidebar.panellist` 的渲染组件收到 `{ size, active }`；`main` 的组件无 props。
`slots.register` 返回 disposer，用 `ctx.effect` 或直接在 inject 回调里返回。

样式一律用 DSH 主题变量（有 fallback），亮/暗主题都能看：

```css
--dsw-alias-label-primary --dsw-alias-label-secondary --dsw-alias-label-tertiary
--dsw-alias-bg-layer-1 --dsw-alias-bg-layer-2 --dsw-alias-bg-layer-3
--dsw-alias-border-l2 --dsw-alias-border-l3 --dsw-alias-interactive-bg-hover
--dsw-alias-brand-primary --dsw-alias-state-success-primary
--dsw-alias-state-error-primary --dsw-alias-state-warn-primary
--dsw-radius-sm --dsw-radius-md --dsw-radius-lg --dsw-radius-xl
--dsw-shadow-lv1 --dsw-alias-label-primary-foreground
```

### 页面结构（中文 UI）

**列表视图**（默认）：

- 标题 `Loop Manager` + 副标题说明；右侧「新建 Pipeline」按钮（创建 pipeline，不是 Loop）。
- pipeline 卡片列表：名称、节点数、最近运行状态徽标（运行中/成功/失败/已停止 + 时间）、
  「开始任务」「编辑」「删除」按钮。空态提示"还没有 loop，点击新建开始"。
- 「开始任务」→ 确认框 → `POST /api/pipelines/:id/run`，然后切到运行视图。

**编辑视图**（新建 / 编辑）：

- 名称输入；可选工作目录输入。
- 节点列表：每行 title 输入 + prompt 多行 textarea + 删除按钮；「添加节点」。
- 依赖关系：每个节点一块「前置节点」多选（checkbox 列出其它节点）→ 映射成 edges。
  保存时前端做一次 `topologicalOrder` 预览校验（重复实现纯函数即可，几十行），
  有环则显示错误并禁止保存。
- 保存 → `POST` 或 `PUT`；取消返回列表。

**运行视图**：

- pipeline 名称 + run 状态 + 「停止」按钮（running 时）；点击先弹停止确认框。
- 按 `run.order` 列出节点：状态点、标题、耗时、模型、session 链接（`sessionId`，点击用
  `window.location.assign('/?session=' + sessionId)` 之类不必实现，显示 id 即可）。
- 每个节点一个日志块：`nodeStates[id].thinking` 渲染为**默认折叠**的「思考 · N 字」区块（chat 同款），
  `nodeStates[id].output` 作为「最终结果」**完整展示**（`white-space: pre-wrap`，不折叠、不截断 UI）。
- 面板每 0.7–1.5s 用 `GET /api/state` 重绘日志，因此 `<details>` 的展开状态必须存在页面状态里
  （按 `runId:nodeId` 记录，渲染时写回 `open` 属性），否则用户点开思考后下一次轮询会立刻折叠。
- `.lm-think-body` 的内部滚动位置同样在每次重绘前按 key 暂存、重绘后写回 `scrollTop`，
  否则用户往下拖动查看长思考时会每次轮询跳回开头。
  运行中的节点把实时的 output 标成「实时输出」，完成后改标「最终结果」。

**数据获取**：`GET /loop-manager/api/state` 拉全量；页面打开后 1500ms 轮询一次，
有 running run 时 700ms 一次；`document.visibilityState === 'hidden'` 时暂停。
`fetch(..., { cache: 'no-store' })`；失败显示顶部错误条（不弹 alert）。

---

## 8. 验收标准

1. `npm test` 全绿（`node --test test/`）：dag 纯函数覆盖 无环/有环/自环/悬空边/多起点/稳定拓扑序/
   prompt 渲染三种情况。
2. `node --check` 全部通过。
3. 在验证 profile 里插件能正常加载：`GET /loop-manager/api/state` 返回 `{ok:true,pipelines:[]}`，
   浏览器 boot graph 里出现 `dsh-loop-manager`，client bundle 200 且无语法错误。
4. 端到端：创建两个节点的 pipeline（A→B），运行后 A 输出传给 B，两个节点 `completed`，
   run `completed`。
5. 循环图保存被拒绝，报错信息可读。

---

## 10. 节点类型（v3）：AGENT / SKILL

节点支持两种类型，共存于同一张 DAG：

```ts
interface PipelineNode {
  id: string
  name: string
  type: 'agent' | 'skill' // 缺省 'agent'（兼容旧数据）
  command?: string // agent: 必填（完整指令）；skill: 可选（补充信息）
  skill?: string // skill 节点必填：已安装 skill 的 kebab-case 名称
  model?: { provider: string; model: string } // 可选：该节点钉住的 DSH 模型（§11）
}
```

### 10.1 语义

- `agent`：`command` 就是完整指令（命令即 skill）。要用已有 skill / MCP 工具，在文本里点名即可。
- `skill`：节点**直接钉住**一个已安装 skill（`skill`），`command` 作为本次任务的补充信息。
  host 在渲染提示词时生成（`renderNodePrompt`）：

  ```
  请使用 skill `<skill>` 完成本节点任务：先调用 skill 工具加载它，然后严格按该 skill 的说明执行。

  任务补充信息：
  <command（已做 {{input}} / {{node:<id>}} 替换）>

  --- 上游节点输出 ---
  …
  ```

  补充信息为空时省略该段；上游输出规则与 §3 一致。

### 10.2 已安装 skill 目录 API

`GET /loop-manager/api/skills`（受鉴权保护）返回：

```json
{ "ok": true, "skills": [{ "name": "office-docx", "description": "Create, read, edit…", "source": "bundled" }] }
```

实现（`lib/skills.ts`）先尝试 `ctx.skills.list()`（宿主 root 作用域挂了 provider 时权威），
再扫描与官方 provider 相同的目录：`<cwd>/.dsh/skills`、`<cwd>/.agents/skills`、
`~/.agents/skills`、`~/.dsh/skills`、以及安装自带的 office skills 目录；同名按
project > user > bundled 覆盖。结果在 HTTP 层缓存 15 秒。

### 10.3 UI

- 节点弹窗：`节点类型` **分段控件**（Agent 指令 / Skill 两个 pill，替代原来的窄下拉）。
  - agent：名称 + Agent 命令（必填）。
  - skill：名称 + `选择 Skill` **自定义选择器**（来自 `/api/skills`）+ 补充信息（可选）。
    选择器由三部分组成：触发器（两行：skill 名 + 描述，超长省略）、可搜索的菜单（选项同样两行，
    `name` 加粗 + 最多两行描述）、无匹配提示。菜单在弹窗内以流式展开（不遮挡、不被裁剪），
    长描述不会挤满控件。目录为空时退化为文本输入并给出提示，编辑器不可用性为零。
    **搜索是实时的**：输入即以空格分词做 AND 匹配（名称或描述任一命中），并按相关度重排
    （名称全等 > 名称前缀 > 名称包含 > 部分名称 > 仅描述），首项自动高亮；↑/↓ 移动、Enter 选中、
    Esc 关闭。`hidden` 用 `.lm-root [hidden]{display:none!important}` 保证生效（选项本身有 display 规则）。
  - 两种类型都带 `模型` 下拉框（§11）。
- 画布节点卡副标题：skill 节点显示 `Skill: <name>`，agent 节点显示 `Agent 指令`；
  节点钉了模型时再显示一行 `模型 · <name>`。
- 校验：skill 节点必须有 `skill`，且名称满足 kebab-case；agent 节点 `command` 非空。

---

## 11. v4：节点模型选择 + standard mode 执行输出

### 11.1 模型目录（与 chat composer 一致）

`GET /loop-manager/api/models` 直接读 `sessionController.modelCatalog()`（chat composer 的同一个
目录接口），返回：

```ts
interface ModelsResponse {
  ok: true
  providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }>
  default?: { provider: string; model: string }
  failures?: Array<{ id: string; name: string; message: string }>
  unavailable?: true // 旧宿主没有 catalog 方法时
}
```

- 缓存 30s；`sessionController.modelCatalog()` 不可用时回退到 `ctx.llm.listProviders()` +
  `ctx.llm.listModels()`；再不行回退到空的 `providers` + `unavailable: true`。
- 不把 `failures` 当成整体失败：其它 provider 的模型仍要可选。

### 11.2 节点 `model` 字段

- `model` 可选；存在时必须同时有 `provider` 与 `model`（trim 非空），否则 `bad-request`。
- 缺省 / 空 = 跟随部署默认模型（`agentDefaultModel.currentSelection()`）。
- 节点保存 / 读回 / 写回都保留 `model`；v1/v2 旧数据没有该字段时按「跟随默认」处理。
- 节点弹窗的 `模型` 下拉框选项：第一项 `跟随 Harness 默认模型（<当前默认模型名>）`，
  之后按 chat picker 的顺序（`deepseek-account`、`deepseek-official`、其它）用
  `<optgroup label="provider 名">` 列出模型；选项标签用模型 `name`。
- 画布节点卡显示 `模型 · <name>`（`title` 属性保留 `provider / model` 全路径）。

### 11.3 执行与日志

- 节点 session 一律以 `agentPreset: 'standard'` 创建（旧宿主不支持该 preset 时回退默认 preset）。
- 一次 run 在开始时快照部署默认模型（`agentDefaultModel.currentSelection()`，含可选的
  `reasoningEffort`）。节点有 `model` 时用节点模型；没有时用这份快照；创建 session 后、投递指令前
  调用 `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`。
  这样某个节点选了别的模型也不会影响同 run 里「跟随默认」的后续节点。显式节点模型选择失败即节点失败。
- `nodeStates[id]` 增加 `thinking?: string`（≤12000 字符）：同一 turn 内 reasoning 块、
  工具调用标记、较早 assistant 文本按序拼接；`output` 仍是该 turn 最后一条 assistant 文本。
- 运行日志按节点渲染：
  - `thinking` → `<details class="lm-think">`，**默认折叠**，summary 为 `思考 · N 字`；
    展开状态按 `runId:nodeId` 保存在 client 内存中，轮询重绘后仍保持展开/收起；
    `.lm-think-body` 的 `scrollTop` 在重绘前后按同一 key 保存/恢复；
  - `output` → `.lm-log-output`，标签 `最终结果`，文本 `white-space: pre-wrap` **完整展示**；
  - 运行中：`output` 显示为「实时输出」，完成后切到「最终结果」；
  - 失败/跳过：保留已产生的思考与输出，并显示错误。
- 轮询期间 runner 通过 `onProgress` 把实时 `{output, thinking}` 回填到当前 nodeState（仅内存），
  完成或失败时再持久化。

---

## 12. v7：PostgreSQL 持久化

Agent Pipeline、Loop、节点与运行记录在保留本地 `state.json` 的同时，可镜像到 PostgreSQL；
首页导航「已收藏」后新增「数据库配置」入口。配置弹窗最上方是「从数据库读取」开关。

### 12.1 配置与文件

- 配置文件：`$DSH_HOME/loop-manager/db-config.json`，权限 `0600`。包含
  `host / port / database / user / password / ssl / readFromDb / updatedAt`。
- `password` 为明文（等同本机凭证文件）；HTTP 响应只返回 `hasPassword`，绝不返回密码。
- PUT 时密码字段为空表示沿用已保存密码（方便改 host/port）；新配置为空密码则按空密码连接。
- 字段校验：host / database / user 非空；port 1–65535（缺省 5432）；ssl / readFromDb 布尔。
- 依赖 `pg`（package.json dependency）。host 半用动态 `import('pg')` 惰性加载：
  驱动缺失时插件仍可加载，数据库路由返回可读的 `db-error`。

### 12.2 表结构与初始化

固定表名（每次成功连接执行全部 `IF NOT EXISTS` DDL；首次连接即初始化）：

```sql
loop_manager_meta       (key TEXT PRIMARY KEY, value TEXT NOT NULL)
loop_manager_pipelines  (id TEXT PK, name TEXT, description TEXT, icon TEXT, color TEXT,
                         star BOOLEAN, cwd TEXT, nodes JSONB, edges JSONB,
                         created_at BIGINT, updated_at BIGINT)
loop_manager_runs       (id TEXT PK, pipeline_id TEXT, pipeline_name TEXT, status TEXT,
                         started_at BIGINT, finished_at BIGINT, order_ids JSONB,
                         node_states JSONB, error TEXT, updated_at BIGINT)
loop_manager_loops      (id TEXT PK, name TEXT, description TEXT, icon TEXT, color TEXT,
                         star BOOLEAN, steps JSONB, created_at BIGINT, updated_at BIGINT)
loop_manager_loop_runs  (id TEXT PK, loop_id TEXT, loop_name TEXT, status TEXT,
                         started_at BIGINT, finished_at BIGINT, order_ids JSONB,
                         step_states JSONB, error TEXT, updated_at BIGINT)
```

`loop_manager_meta` 写入 `schema_version = 2`（v9 新增两张 Loop 表；旧库重连时按
`IF NOT EXISTS` 补齐）；索引建在 `runs(pipeline_id)` / `runs(started_at DESC)` /
`loop_runs(loop_id)` / `loop_runs(started_at DESC)`。nodes / edges / order / nodeStates /
steps / stepStates 一律以 JSONB 保存（节点 `model`、run 的 `thinking`、Loop 的门禁配置都在里面）。

### 12.3 写路径（双写）

- 本地 `state.json` 仍是插件自身读写的第一落点；`createStore({ mirror })` 在
  `upsertPipeline` / `removePipeline` / `setRun` / `removeRun` / `upsertLoop` /
  `removeLoop` / `setLoopRun` / `removeLoopRun` 成功后把同一份记录投递到 PostgreSQL
  mirror 队列。mirror 串行、异步、失败只记录 `db.status.error`，不影响本地操作。
- 删除 pipeline 时数据库同时删除其 runs（按 pipeline_id）；删除 Loop 时同时删除其
  loop runs（按 loop_id）。Loop 与 Pipeline 的 `star`（收藏）随行一起写入。
- mirror 错误不会让 HTTP 500；`GET /api/db` 暴露最近错误。

### 12.4 读路径（开关）

- `readFromDb=false`（默认）：`/api/state` 读本地 store。
- `readFromDb=true`：`/api/state` 先 `flush()` mirror 队列，再从 PostgreSQL 读取
  pipelines + runs + loops + loopRuns（两类 run 各取最近 50 条）；无本地 running run 时用数据库快照替换内存 store
  （不重写本地文件）；有 running run 时把本地 running 对象合并进 runs，保证实时进度。
- 数据库读失败：回退本地返回，并在响应里带 `dbError`，前端不阻塞。
- UI 位置：「数据库配置」弹窗（checkbox + switch 开关在表单最上方），字段 host / port / database /
  user / password / SSL；按钮 `测试连接` / `保存并初始化`。保存成功 Toast 并刷新。

### 12.5 首次连接 / 启动

- `PUT /api/db` 或 `POST /api/db/test` 会连接并执行建表初始化；PUT 成功后才保存配置。
- 保存后若数据库为空（pipelines 计数 0），把当前本地 pipelines + loops + runs + loopRuns
  导入；`imported` 返回 `importedPipelines` / `importedRuns` / `importedLoops` /
  `importedLoopRuns` 四个计数，UI Toast 逐项展示。
- 插件启动时：本地 store 加载完成后，若 PostgreSQL 已配置且可连接，同样执行空库导入；
  若 `readFromDb=true` 则把数据库快照灌入内存 store（无 running run 时）。
- 启动连接失败不影响插件加载：`/api/state` 继续用本地，`/api/db` 暴露错误，
  用户在弹窗里测试/保存即可重连。

### 12.6 UI

- 顶部导航：`Agent Pipeline` / `Loop` / `运行记录` / `已收藏` / `数据库配置`
  （`Loop` 位于 Agent Pipeline 之后，见 §13；数据库配置位于已收藏之后）。
- 弹窗顶部开关使用 `input[type=checkbox].lm-field-db-read` + `.lm-switch` 样式；
  状态行 `data-db-status` 展示「已连接 · 已初始化 · 当前从数据库读取」或错误。
- 密码框留空时占位提示「留空则保留已保存密码」。取消/Escape 不保存。

### 12.7 验收

- 首次连接自动建表；`loop_manager_meta.schema_version` 存在。
- 空库首次保存时导入本地数据（`importedPipelines` / `importedRuns` / `importedLoops` /
  `importedLoopRuns` 与本地一致）。
- 开关关闭时 `/api/state.source === 'local'`；打开时为 `'db'`。
- 创建/修改/删除 pipeline、开始/停止 run 后，PostgreSQL 对应行与本地一致；
  run 的 `nodeStates`（含 output / thinking）可读。
- 创建/修改/删除 Loop、收藏 Loop、开始/停止 LoopRun 后，`loop_manager_loops` /
  `loop_manager_loop_runs` 与本地一致；`step_states`（含门禁判定与输出）可读。
- 数据库不可达时插件仍可用本地；`GET /api/db` 有可读 error。

---

## 13. v9：Loop 编排（Loop tab）

在顶部导航 **Agent Pipeline** 之后新增 **Loop** tab。一个 Loop 把已有 Agent Pipeline 与
「门禁节点」按 `pipeline → gate → pipeline → gate` 的顺序串起来：

1. Loop 有两种节点：**Agent Pipeline 节点**（引用 Agent Pipeline tab 里配置的一条 pipeline）
   与 **门禁节点**（gate，一个 agent 指令或一个 skill）。
2. 两者**成对出现**：每组 = 一个 pipeline + 紧跟其后的一个 gate；gate 永远在该组 pipeline 之后。
   没有孤立的 gate，也不能出现 gate + pipeline 的倒序。
3. gate 判断上一段 pipeline 是否得出了符合要求的结果：`TRUE` → 进入下一组 pipeline；
   `FALSE` → 重新执行本组 pipeline，循环直到 gate 通过。
4. 每个 gate 可配置**是否自动循环**：`autoLoop=true` 时 gate 得到 FALSE 自动重跑本组 pipeline；
   `autoLoop=false` 时 run 停在 `awaiting`，等待人工启动。
5. 需要人工重新循环的步骤，在失败/未通过后，**gate 节点上出现「↻ 重新循环」按钮**，等人工点击
   （点击先弹确认框，再 `POST /api/loop-runs/:runId/retry`）。

### 13.1 数据模型（v9）

```ts
interface Loop {
  id: string
  name: string // 必填，trim 非空，≤50
  desc?: string // ≤160
  icon?: string // 默认 '⟳'
  color?: string // '' | 'blue' | 'peach' | 'purple'
  star?: boolean // 缺省 false
  steps: LoopStep[] // ≥1 且 ≤20，数组顺序即执行顺序
  createdAt: number
  updatedAt: number
}

interface LoopStep {
  id: string // 客户端提供；缺省由服务端生成
  pipelineId: string // 引用 Pipeline.id：保存时该 Pipeline 必须存在
  gate: LoopGate // 本组门禁节点，恒在该组 pipeline 之后
}

interface LoopGate {
  id: string // 缺省 '<stepId>-gate'
  name: string // 必填，trim 非空，≤40；缺省 '门禁'
  type: 'agent' | 'skill' // 缺省 'agent'
  command: string // agent：判断要求全文（必填）；skill：补充信息（可为空）
  skill?: string // type='skill' 时必填，kebab-case
  model?: { provider: string; model: string } // 可选，语义同 §11.2
  autoLoop: boolean // 缺省 false：FALSE 时等待人工点「重新循环」
  maxIterations: number // 自动循环时 pipeline 执行次数上限，缺省 3，范围 1–20
}
```

- **成对出现由结构保证**：`steps[i].gate` 永远属于 `steps[i].pipelineId`；不存在独立 gate 数组，
  因此「gate 必须在 pipeline 后面」不可能被写错；`steps` 线性执行。
- 一个 pipeline 可被多个 Loop / 多个 step 引用；引用关系是「活链接」（存 id），不是快照。
- 历史数据兼容：没有 `steps` 的旧 loop 数据按空数组加载（不可运行，需用户补齐）。

### 13.2 校验与规范化

`lib/loop.ts`（host 半，纯函数、无宿主依赖，必须被单测覆盖）导出：

```js
export const LOOP_ERROR_CODE = 'invalid-loop'
export const MAX_LOOP_STEPS = 20
export const MAX_GATE_OUTPUT_CHARS = 20000

export function validateLoop(loop, { pipelineIds })   // -> { ok:true } | { ok:false, code:'invalid-loop', message }
export function aggregatePipelineOutput(pipeline, run) // -> string（≤20000 字符）
export function renderGatePrompt({ gate, pipeline, pipelineRun, pipelineOutput, stepIndex, iteration })
export function parseGateDecision(text)                // -> 'TRUE' | 'FALSE' | 'UNKNOWN'
```

**validateLoop 规则**（错误 code 一律 `invalid-loop`）：

- `name` 非空 ≤50；`desc` ≤160；`icon` ≤4；`color` ∈ 允许集合；`star` 布尔。
- `steps` 是数组且 1–20 组；每组 `id` 非空字符串且全局唯一。
- 每组 `pipelineId` 必须出现在 `pipelineIds`（当前已保存 pipeline 的 id 集合）里；
  否则 `第 N 组引用的 Pipeline 不存在`。
- 每组 `gate`：`name` 非空 ≤40；`type` ∈ {agent, skill}；`autoLoop` 布尔；
  `maxIterations` 整数 1–20；`model` 若存在必须 provider/model 都非空（规则同 §11.2）。
  - agent：`command` trim 非空。
  - skill：`skill` 必填且 kebab-case；`command` 可空。

**gate 输出协议**：门禁 run 完成后，host 用 `parseGateDecision(gateOutput)` 解析结论：

- `TRUE`：通过，进入下一组；最后一组通过 = Loop run `completed`。
- `FALSE`：未通过；按 `autoLoop` / 迭代余量决定自动重跑或等待人工。
- `UNKNOWN`（模型没按协议输出）：按**门禁失败**处理（`awaiting`，可人工重试），
  `gateError='门禁没有给出 TRUE/FALSE 结论'`，保留原始 `gateOutput` 供诊断。

解析优先级（纯函数，单测固定）：

1. JSON 对象里的 `pass` / `ok` / `decision` / `verdict`（布尔或字符串，大小写不敏感）；
2. `<verdict>TRUE</verdict>` 之类的标签；
3. 单独成行（去掉前后 markdown 粗体/反引号/标点后）的 `TRUE` / `FALSE`（取第一条）；
4. `结论|结果|判定|verdict|decision` 后跟 `:`/`：` 再跟 `TRUE|FALSE`（取第一条）；
5. 全文首个独立的 `TRUE` / `FALSE` 单词（大小写不敏感）；
6. 都不命中 → `UNKNOWN`。
   中文 `通过`/`不通过` 只在第 4 条的显式结论行里识别（避免正文里的“不通过风险”之类误判）。

**aggregatePipelineOutput**：按 `run.order` 顺序拼接每个节点
`【<节点名>】\n<nodeStates[id].output>`，段间 `\n\n`，跳过空输出；总长截断到 20000 字符。
`pipeline.output` 为空时用 `（Pipeline 没有产出文本输出）`。

**renderGatePrompt**（host 组装门禁提示词，`command` 即判断要求）：

```
你是 Loop Manager 的「门禁节点」（第 N 组 / 第 K 次尝试）。
请判断上一段 Agent Pipeline 是否得出了符合要求的结果。

判断要求：
<gate.command（agent）；skill 节点先加 §10.1 的 skill 包裹再放 command 作为补充信息>

Agent Pipeline「<pipeline.name>」本次运行结果：
<aggregatePipelineOutput>

结论规则：
- 第一行只输出 TRUE 或 FALSE：
  TRUE = 满足判断要求，可以进入下一组 Pipeline；
  FALSE = 不满足判断要求，需要重新运行本组 Pipeline；
- 第一行之后可以用一句话说明理由。
```

### 13.3 运行记录（LoopRun）

```ts
interface LoopRun {
  id: string
  loopId: string
  loopName: string // 运行历史展示用，loop 删除后仍可读
  status: 'running' | 'awaiting' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  finishedAt?: number
  order: string[] // 本次运行的 stepId 顺序
  stepStates: Record<string, LoopStepState>
  error?: string
}

interface LoopStepState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'awaiting'
  iteration: number // 本组 pipeline 已执行次数（0 = 尚未执行）
  pipelineRunId?: string // 该组 pipeline 的普通 Run id（同时出现在 /api/state.runs）
  pipelineStatus?: 'running' | 'completed' | 'failed' | 'stopped'
  pipelineOutput?: string // 交给门禁判断的聚合输出（≤20000）
  gateStatus: 'pending' | 'running' | 'passed' | 'failed' | 'awaiting' | 'skipped'
  decision?: 'TRUE' | 'FALSE' | 'UNKNOWN'
  gateOutput?: string // 门禁最终文本（≤20000）
  gateThinking?: string // 折叠展示（≤12000）
  gateSessionId?: string
  gateError?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}
```

**状态机**：

- 启动：`status='running'`；所有 step `{status:'pending', iteration:0, gateStatus:'pending'}`。
- 每组循环（`iteration` 从 1 开始）：
  1. `step.status='running'`，`iteration += 1`，用 `engine.start(pipeline)` 跑该组 pipeline
     （普通 Run，同一个 pipeline 同时只能有一个 running run）。等该 Run 结束后：
     - `completed` → `pipelineStatus='completed'`，聚合输出 → `pipelineOutput`，进入门禁；
     - `failed` / `stopped` → 该组失败：`step.status='failed'`、`error`、`gateStatus='awaiting'`，
       LoopRun `status='awaiting'`（人工重试按钮出现在该组 gate 上）；
  2. 门禁：`gateStatus='running'`，以真实 agent/skill turn 运行 `renderGatePrompt`；
     - 成功且 `TRUE` → `gateStatus='passed'`、`decision='TRUE'`、step `completed`，进入下一组；
     - 成功且 `FALSE` → `decision='FALSE'`；若 `autoLoop=true` 且 `iteration < maxIterations`
       → 保持 `step.status='running'` 回到 1 重跑本组 pipeline；
       否则 `gateStatus='awaiting'`、step `awaiting`、LoopRun `awaiting`（等人工「重新循环」）；
       自动循环次数用完时 `gateError` 写明 `自动循环已达上限 N 次`；
     - `UNKNOWN` 或门禁 turn 抛错/超时 → `gateStatus='failed'`、`gateError`、step `awaiting`、
       LoopRun `awaiting`（可人工重试）。
- 人工重试 `retry(runId, stepId?)`：仅在 LoopRun `status` 为 `awaiting` 或 `failed` 时允许；
  默认 step = 第一个 `awaiting`/`failed` 的 step。把该 step 重置为 pending 状态、后续 step 重置为
  pending，`status='running'`，从该 step 继续执行；人工重试不受 `maxIterations` 限制
  （`iteration` 继续累加，用于展示）。
- 停止：`POST /api/loop-runs/:id/stop` → 取消当前门禁 turn、`engine.stop(当前 pipelineRunId)`；
  当前 step 与后续 step 记 `skipped`，LoopRun `status='stopped'`。
- 全部 step `completed` → LoopRun `completed`。
- 插件卸载 / 宿主重启：未结束的 LoopRun 在加载时降级为 `failed`
  （`error='宿主已重启，本次 Loop 未完成'`），可人工重试。
- 同一 Loop 同时只允许一个 running LoopRun（`run-in-progress`）。

### 13.4 持久化

- 本地 `state.json` 新增两个顶层字段（旧文件没有时按空数组加载，`version` 仍为 1）：

```json
{ "version": 1, "pipelines": [...], "lastRuns": {...},
  "loops": [Loop...], "loopRuns": [LoopRun...], "lastLoopRuns": { "<loopId>": LoopRun } }
```

- `lib/store.ts` 新增：`listLoops()`、`getLoop(id)`、`upsertLoop(loop)`、`removeLoop(id)`
  （同时删除其 loopRuns 与 lastLoopRun）、`listLoopRuns()`（新→旧，最多 50）、
  `getLoopRun(id)`、`setLoopRun(run)`（内存，保留每个 loop 最近 5 条已结束记录）、
  `saveLoopRun(loopId, run)`（落盘，失败只记日志）、`removeLoopRun(id)`。
  `replaceAll({ pipelines, runs, loops, loopRuns })` 同样替换 loop 数据。
- PostgreSQL：新增两张表（DDL 幂等，`DB_SCHEMA_VERSION` 升到 2，meta 用 upsert 写入）：

```sql
loop_manager_loops      (id TEXT PK, name TEXT, description TEXT, icon TEXT, color TEXT,
                         star BOOLEAN, steps JSONB, created_at BIGINT, updated_at BIGINT)
loop_manager_loop_runs  (id TEXT PK, loop_id TEXT, loop_name TEXT, status TEXT,
                         started_at BIGINT, finished_at BIGINT, order_ids JSONB,
                         step_states JSONB, error TEXT, updated_at BIGINT)
```

mirror 方法：`upsertLoop` / `removeLoop`（连带删除其 loop_runs）/ `setLoopRun` /
`removeLoopRun`；`loadState()` 返回 `{pipelines, runs, loops, loopRuns}`；
`backfillIfEmpty` 一并导入 loops 与 loopRuns。读路径开关、空库导入、失败回退语义与 §12 一致。

### 13.5 Loop 引擎（lib/loopengine.ts）

```js
export function createLoopEngine({
  store, engine,            // store = createStore()；engine = createEngine()
  runGate,                  // 注入：跑门禁 turn，默认用 createAgentNodeRunner
  logger, now,              // now 可注入（测试）
  pollIntervalMs = 400,     // 轮询 pipeline run 状态的间隔
})
// -> { start(loop), stop(runId), retry(runId, stepId), deleteRun(runId), listRuns(), dispose() }
```

- `start(loop)`：校验 + 同 Loop running 检查 → 建 LoopRun → 后台执行。返回
  `{ ok:true, run }`；失败 `{ ok:false, code, message }`（`bad-request` / `invalid-loop` /
  `run-in-progress`）。
- pipeline 执行统一走 `engine.start(pipeline)`，然后轮询 `store.getRun(pipelineRunId)` 直到
  `status !== 'running'`；`run-in-progress`（该 pipeline 已有手动运行）→ 该组失败
  （`awaiting` 可人工重试），错误信息可读。
- 门禁 turn 的 runner 复用 `createAgentNodeRunner`：把 gate 包成合成节点
  `{ id: gate.id, name: gate.name, type: gate.type, skill: gate.skill, model: gate.model }`，
  `pipeline` 用 `{}`（门禁 session 用宿主默认工作目录）；`prompt = renderGatePrompt(...)`。
  捕获 output / thinking / sessionId，实时进度写回 `stepStates[stepId]`（内存），
  完成/失败落盘。默认模型快照语义同 §5：一次 LoopRun 开始时快照一次部署默认模型，
  门禁没有自己的 model 时用它。
- 每次状态变化调用 `store.setLoopRun(run)`；step 完成/失败/等待与 LoopRun 结束时
  再 `saveLoopRun` 落盘。
- `dispose()` 停止所有 LoopRun（取消门禁 turn、停止 pipeline run）。
- 依赖服务缺失（sessionController/sessions）：`start` 返回 `internal` 并在 run.error 写明
  `'the session controller service is not mounted in this deployment'`。

### 13.6 HTTP API（在 §9.4 / §12 基础上新增）

| Method | Path                      | Body                 | 成功响应                                   |
| ------ | ------------------------- | -------------------- | ------------------------------------------ |
| GET    | `/loop-manager/api/state` | —                    | 增加 `loops`, `loopRuns`（新→旧，最多 50） |
| POST   | `/loop-manager/api/loops` | Loop（无 id/时间戳） | `{ ok:true, loop }`                        |
