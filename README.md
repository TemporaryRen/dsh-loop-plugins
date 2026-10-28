# dsh-loop-manager

Loop Manager 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的工作流编排插件，用于把多个 Agent 任务串联起来，按依赖顺序自动执行。

在 DSH 左侧边栏打开 Loop Manager，即可通过节点和连线组织任务。每个节点对应一次真实的 Agent 会话，上游任务的输出会自动传给下游任务。

- 可视化编排任务依赖，自动检查循环依赖和无效连接。
- 支持 Agent 指令节点和 Skill 节点，复用宿主提供的 Skill、MCP 等工具能力。
- 支持为不同节点选择模型。
- 实时查看执行状态、任务输出和运行记录，并可中途停止任务。
- 支持本地保存工作流与运行结果，也可使用 PostgreSQL 持久化。

## 开发与构建

开发环境使用 Node.js 24（见 `.nvmrc`），发布产物仍兼容 Node.js 20+。

```sh
npm install
npm run build
npm run validate
```

源码使用 TypeScript：`lib/*.ts` 为插件实现，`test/*.mts` 为测试，`scripts/*.mts` 与 `tools/*.mts` 为验证和安装工具。编译产物写入 `dist/`；包入口指向 `dist/lib/index.js` 和 `dist/lib/client.js`。宿主模块同时生成类型声明及 source map。浏览器入口保留 DSH 的 `window.__ModuleLoader__.load` 注册协议。

- `npm run check`：严格检查服务端、浏览器端、测试与工具的类型。
- `npm run build`：编译全部 TypeScript。
- `npm test`：先编译，再运行编译后的 Node.js 测试。
- `npm run dev`：持续编译，源码修改后更新 `dist/`。
- `npm run test:watch`：编译并监听测试；编辑源码时同时运行 `npm run dev`。
- `npm run test:coverage`：运行测试并统计编译产物覆盖率。
- `npm run validate`：执行类型检查、ESLint 和全部测试。

本地通过 `link:` 接入 DSH 时，先执行 `npm run build`，源码修改后重新构建并按宿主流程重新加载插件。打包时 `prepack` 会自动构建；可以用 `npm pack --dry-run` 核对发布内容。

验证工具先构建再运行，例如 `node dist/scripts/smoke.mjs --help`。桌面配置安装工具改为 `node dist/tools/install-desktop-profile.mjs`，执行前仍需遵循原有配置操作流程。

## Loop：Pipeline + 门禁循环

顶部导航在 `Agent Pipeline` 之后新增 `Loop` tab。一个 Loop 把已有 Agent Pipeline 与「门禁节点」按顺序串成
`pipeline → gate → pipeline → gate`：

- **成对出现**：每组 = 一条 Agent Pipeline + 紧跟其后的一个门禁节点，门禁永远在该组 pipeline 之后。
- **门禁判定**：门禁可以是一个 Skill 或一段 Agent 指令，用来判断上一段 Pipeline 是否得出了符合要求的结果。
  输出 `TRUE`（符合）进入下一组；`FALSE`（不符合）重新执行本组 pipeline，直到通过。
- **自动 / 手动循环**：每个门禁可配置「自动循环」及次数上限。开启时 `FALSE` 自动重跑本组 pipeline；
  关闭时 Loop 停在 `awaiting`。
- **人工重新循环**：失败或未通过、需要人工介入时，门禁节点上出现「↻ 重新循环」按钮，等待人工点击后继续。

Loop 的 pipeline 执行复用现有 Agent Pipeline 引擎（真实 agent 会话、模型选择、日志），Loop 与运行记录同样
支持本地 `state.json` 与 PostgreSQL 双写。接口契约见 [spec/CONTRACT.md](spec/CONTRACT.md) §13。
