# 验证记录 (verification notes)

本文件记录 `dsh-loop-manager` 实际跑通的验证路径、命令与结果，供后续改动复现。

TypeScript 迁移后，以下历史记录中的 `lib/*.js` 源码对应现在的 `lib/*.ts`，测试与工具源码为 `.mts`。运行工具前先执行 `npm run build`，再使用 `node dist/scripts/<名称>.mjs` 或 `node dist/tools/<名称>.mjs`；两个 `.sh` 验证入口会自动构建。`npm run check` 现在执行严格类型检查，`npm test` 先编译再运行 `dist/test/` 中的测试。下文保留历史执行命令和结果。

环境：macOS (arm64)，Node v24.19.0，pnpm 11.22.0，Chrome 156，
运行中的桌面版 DSH 0.2.1-rc.3 (Web GUI `http://127.0.0.1:58042`)，
隔离验证用全局 CLI `dsh` 0.2.1-rc.2。

> ⚠️ 隔离验证使用独立的 `DSH_HOME=/tmp/dsh-loop-verify-home`。
> 桌面版的 `~/.dsh/profiles/desktop` 由 Electron 独占，**任何脚本都不要碰它**
> （`dsh --profile desktop` 也会被 CLI 拒绝）。
> 注意：当前 shell 从 app 继承了 `DSH_HOME=~/.dsh`，所以每条命令都要显式覆盖：

```bash
DSH_HOME=/tmp/dsh-loop-verify-home bash scripts/create-verify-profile.sh
DSH_HOME=/tmp/dsh-loop-verify-home SKIP_PROFILE=1 VERIFY_LOG=/tmp/loop-verify-server.log bash scripts/run-verify.sh
```

## 1. 隔离验证 profile

`scripts/create-verify-profile.sh` 的步骤（幂等）：

1. `dsh --profile loopverify --from-default-profile web --dump-config`
   —— 在隔离 home 里从 `web` 模板生成 `loopverify`；
2. 把 `"dsh-loop-manager": "link:/Users/temporary/github/dsh-loop-plugins"`
   写入 profile 的 `package.json` dependencies，并把 `dsh-loop-manager` 追加到
   `dsh.profile.bundles`；
3. `pnpm install --prefer-offline`（link 安装，秒级完成，不需要下载宿主包）；
4. 校验 `node_modules/dsh-loop-manager` 是指向本仓库的符号链接。

`link:` 而不是 `file:` 是必须的：只有被 app-boot 识别为「已链接包」时，
`@deepseek-ai/*` 这类宿主包才会被解析到运行 installation；前提是本包在
`peerDependencies` 里声明了它们（这里只有 `@deepseek-ai/dsh-llm`）。

## 2. HTTP smoke（`scripts/smoke.mjs`）

`scripts/run-verify.sh` 负责：建/复用 profile → 后台启动
`dsh --profile loopverify --host 127.0.0.1 --port 58099 --no-open` →
从启动日志的 `dsh web: http://127.0.0.1:58099/?token=...` 取 launch token →
用 `/?token=` 换 cookie → 跑 smoke → 无论成败都杀掉服务。

实测输出（9/9 通过）：

```
PASS  auth token exchange            HTTP 303 -> browser cookie minted
PASS  GET /                          HTTP 200, 37642 bytes, contains __DSH_BOOT__
PASS  boot graph                     release 0.2.1-rc.2 (332895e), 70 rows, row rev 5d288cd026c5
PASS  client bundle                  /plugins/??dsh-loop-manager/client.js&rev=5d288cd026c5 HTTP 200, 61727 bytes
PASS  GET /loop-manager/api/state    HTTP 200 {"ok":true,"pipelines":0}
PASS  POST /loop-manager/api/pipelines HTTP 200, pipeline id d834…
PASS  GET state contains pipeline    pipeline d834… present (1 total)
PASS  DELETE /loop-manager/api/pipelines/:id HTTP 200 {"ok":true}
PASS  GET state after delete         pipeline removed from state
INFO  unauthenticated API access     HTTP 401 (fenced)
SMOKE PASS — 9/9 checks in 67 ms
```

要点：

- client bundle 的 URL 形状是 `/plugins/??<package>/client.js&rev=<artifact-rev>`，
  其中 `rev = hash(mtimeMs, ctimeMs, size)`；不带 `rev` 的 URL 返回 404。
- `/loop-manager/api/ping` 是唯一不鉴权的路由；其余路由在无 cookie 时返回
  `401 {"ok":false,"code":"unauthorized"}`（这是刻意设计：这些接口能启动 agent）。

## 3. 真实浏览器验证（`scripts/browser-verify.mjs`）

无头 Chrome + CDP（Node 24 自带 `WebSocket`，无需装依赖）。
Chrome 启动参数必须带 `--disable-crash-reporter --disable-breakpad --no-sandbox`，
否则在 DSH 文件沙箱下 crashpad 写 `~/Library/...` 被拒绝会把整个浏览器进程打崩。

实测输出（5/5 通过）：

```
PASS  app shell boots                    window.__DSH_BOOT__ present
PASS  sidebar Loop Manager row           found 1 button[aria-label="Loop Manager"]
PASS  panel renders after click          list header + 新建 Loop visible
PASS  loop-manager markup mounted        .lm-view nodes: 1
PASS  no uncaught page errors            0 unrelated console errors
BROWSER PASS — 5/5 checks
```

截图（首次启动会有一个宿主自己的 Preview Notice 弹窗，脚本会先点 Continue 再截图）：

- `docs/screenshot-list.png` 列表视图
- `docs/screenshot-editor.png` 新建/编辑视图
- `docs/screenshot-run.png` 运行详情
- `docs/screenshot-run-expanded.png` 展开节点输出

## 4. 端到端真实 agent 执行（`scripts/e2e-run.mjs`）

验证 profile 需要模型凭证：把桌面版的 `~/.dsh/.credentials.yaml` 复制到
`/tmp/dsh-loop-verify-home/.credentials.yaml`（web 模板默认
`provider: deepseek-official / model: deepseek-flash`），重启验证服务后执行：

```bash
TOKEN=$(grep -m1 "dsh web:" /tmp/loop-verify-server3.log | sed -n 's/.*token=//p')
DSH_HOME=/tmp/dsh-loop-verify-home node scripts/e2e-run.mjs \
  --base http://127.0.0.1:58099 --token "$TOKEN" --out /tmp/loopshots
```

脚本在页面上下文里调用 API（自动带上 cookie），建一条 A→B 的两节点 pipeline 并运行：

```
PASS  app shell boots
PASS  sidebar row present                 buttons: 1
PASS  create pipeline                     id 525fc0cc-…
PASS  start run                           run a3e66293-…
PASS  run settles                         status=completed after 4634 ms
PASS  node A completed                    output="LOOPMVRJ7AW3-OK"
PASS  node B completed                    output="我收到 [A: 说一个标记] LOOPMVRJ7AW3-OK"
PASS  A output reached B                  true
PASS  run completed
E2E PASS (0 failed)
```

这证明了核心语义：**节点就是真实 agent turn**（每节点一个 session，可在会话列表点进去），
按拓扑序串行执行，`{{input}}` 把上游输出注入下游指令。
状态确实落盘：`/tmp/dsh-loop-verify-home/loop-manager/state.json`。

## 5. 安装到桌面版（真实使用）

`~/.dsh/profiles/desktop` 只能由 Electron 应用管理，CLI 拒绝，但应用内建 HMR
会监听 profile `package.json`（`dsh.profile.bundles` 变化会触发 profile 重组）。

```bash
DSH_HOME=/Users/temporary/.dsh node tools/install-desktop-profile.mjs           # 安装 + 验证
DSH_HOME=/Users/temporary/.dsh node tools/install-desktop-profile.mjs --revert  # 回滚
```

脚本做的事（全部可逆，`package.json` 备份为 `package.json.loop-manager.bak`）：

1. profile `package.json` 增加 `"dsh-loop-manager": "link:<本仓库>"`；
2. `dsh.profile.bundles` 末尾追加 `dsh-loop-manager`；
3. `node_modules/dsh-loop-manager` 建符号链接（不触碰 lockfile）。

**实测（无需重启应用，HMR 直接生效）：**

```
$ curl -s http://127.0.0.1:58042/loop-manager/api/ping
{"ok":true,"name":"dsh-loop-manager","version":"0.1.0"}          # HTTP 200：host 半已挂载
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:58042/loop-manager/api/state
401                                                              # 连接层鉴权生效
$ curl -s -o /dev/null -w "%{http_code}" \
    "http://127.0.0.1:58042/plugins/??dsh-loop-manager/client.js&rev=5d288cd026c5"
200                                                              # client bundle 已被图形化进 boot graph
```

> 注意：写 `~/.dsh/profiles/desktop` 超出 DSH 工作区沙箱（workspace-write），需要
> 一次性放宽到 danger-full-access 才能执行安装脚本；`--revert` 同样需要。

宿主 API 全部在**刷新浏览器页面**后才进入页面（boot graph 是页面加载时注入的）。

## 6. 设计对齐（v2 / loop-pipeline-ui）

UI 重做为设计稿 `/Users/temporary/source/workflow-skill/loop-pipeline-ui` 的工作台形态，数据模型同步
升级（`pipeline.desc/icon/color/star`、`node.name/command/skills/mcp`、`PATCH /api/pipelines/:id`、
run 的 `pipelineName`）。验证结果：

- 单元/集成：`npm test` → **51/51**（含 `test/v2.test.mjs` 的字段迁移、Skills/MCP 提示、run 历史、50 条上限）
- 浏览器：`node scripts/browser-verify.mjs --base http://127.0.0.1:58099 --token <token>` → **5/5**
  - `button[aria-label="Loop Manager"]` 唯一命中、点击后 `.lm-root` 工作台渲染、0 未捕获异常
- 端到端：`node scripts/e2e-run.mjs ...` → **9 checks PASS**，A→B 真实 agent 3.3s 完成、
  B 收到 A 输出；另用 4 条演示 pipeline 跑通 5 节点「每日行业情报」，129s 全链输出
- 截图（设计稿同款视图）：`docs/screenshot-list.png`、`screenshot-editor.png`、
  `screenshot-node.png`、`screenshot-history.png`

### 桌面版更新后的 bundle 校验（无需浏览器 cookie）

HMR 重组后，用 artifact rev 直接取 client bundle 验证线上就是新代码
（`framedHash = sha1("plugin-artifact\0" + "${len}:${part}"...)` 取前 12 位，part 为
`mtimeMs/ctimeMs/size`）：

```bash
node -e 'const {statSync}=require("node:fs"),{createHash}=require("node:crypto");
const st=statSync("/Users/temporary/github/dsh-loop-plugins/lib/client.js");
const h=createHash("sha1").update("plugin-artifact").update("\0");
for(const p of [String(st.mtimeMs),String(st.ctimeMs),String(st.size)])h.update(`${Buffer.byteLength(p)}:`).update(p);
console.log(h.digest("hex").slice(0,12))'
# 然后（假定 rev 为 9fe51518b095）：
curl -s "http://127.0.0.1:58042/plugins/??dsh-loop-manager/client.js&rev=9fe51518b095" | grep -c "YOUR AGENTS, IN FLOW"
```

实测：桌面版 `GET /loop-manager/api/ping` → 200，`client.js&rev=9fe51518b095` → 200 且包含设计稿标记。

## 7. 节点直接使用已有 Skill / MCP 的验证（节点无独立 skills/mcp 字段）

节点模型改为「命令即 skill」后，用真实 agent 运行验证了两条通道（隔离 profile，
`/tmp/dsh-loop-verify-home`，脚本见 `/tmp/check2.mjs`、`/tmp/check3.mjs`）：

| 验证 | 节点命令（原文） | 结果 |
|---|---|---|
| 已有 Skill | `请调用 skill 工具加载名为 \`arkcli-shared\` 的 skill，然后只输出该 skill frontmatter 里的 version 值` | 输出 **`2.2.4`** —— 与 `~/.agents/skills/arkcli-shared/SKILL.md` 的 `version: 2.2.4` 完全一致，证明节点确实通过 skill 工具读到了已有 skill 的正文 |
| 已有 MCP 工具 | `请调用 MCP 工具 \`mcp__demo__echo\`，参数 text 设为 "hello-loop"，然后只输出该工具返回的文本` | 输出 **`echo: hello-loop`** —— 只可能来自 MCP 工具的返回 |

MCP 那条需要部署里真的挂了一个 server 才能测：本机 desktop profile **没有任何 MCP server 配置**
（`dsh-base` 只挂 `dsh-mcp-resources`；`dsh-mcp-client` 需显式配置，profile/patch 里都没有），
所以我在隔离 profile 里加了一个本地 stdio MCP server 复现（`/tmp/mcp-demo-server.mjs`，
一个 60 行的 JSON-RPC server，暴露 `echo` 工具），patch 片段：

```yaml
- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: demo          # 工具名变成 mcp__demo__<tool>
        transport: stdio
        command: node
        args: ['/tmp/mcp-demo-server.mjs']
```

结论：**只要部署里有 skill / MCP server，节点命令里点名即可直接使用**——节点是真实 agent 会话，
工具面与会话完全一致；插件不做任何名单解析或拦截。

注：`office-*` 系列 skill 由桌面版 runtime 的 `office-skills` 目录提供（隔离 CLI profile 不含），
所以隔离环境里验证用的是 `~/.agents/skills` 下的用户 skill。

## 8. 节点类型 SKILL 的验证（v3）

- `GET /loop-manager/api/skills`（隔离 profile，`customSkillDirs` 指向 `~/.agents/skills`）→
  **42 个已安装 skill**（`arkcli-*` / `dingtalk-*`），带 name/description/source。
- SKILL 节点端到端：节点 `type=skill, skill=arkcli-shared`，补充信息「只输出该 skill frontmatter 里的
  version 值」→ 真实 agent 运行输出 **`2.2.4`**（与 `~/.agents/skills/arkcli-shared/SKILL.md` 一致），
  下游 Agent 节点继续接收该输出。
- 渲染出的提示词（`renderNodePrompt`）：
  ```
  请使用 skill `arkcli-shared` 完成本节点任务：先调用 skill 工具加载它，然后严格按该 skill 的说明执行。

  任务补充信息：
  只输出该 skill frontmatter 里的 version 值，不要解释。
  ```
- 截图：`docs/screenshot-node-skill.png`（类型下拉 + 已安装 skill 下拉 + 补充信息）、
  `docs/screenshot-editor.png`（画布上 skill 节点显示 `Skill: arkcli-shared`）。

注：`~/.dsh/skills` 默认为空；桌面版另有安装自带的 `office-*` skill，会被一并发现
（`Resources/runtime/office-skills` 或 `@deepseek-ai/dsh-skill-office/assets`）。

## 9. EMBER 暖色主题

配色从设计稿的鼠尾草绿切换为用户指定的 EMBER 暖色（陶土红 + 米色工作台），
结构、字号、布局与交互不变。色值经参考图取样：primary `#B95C3A`、page `#F8F5EE`、
card `#FCFBF7`、ink `#2E261C`、line `#E7DED0`、nav-active `#EBD8C9`、log `#2B1D15`。
新增列表页 hero 横幅与页头 `EMBER / 01` 标识。截图见 `docs/`。

桌面版验证：`/loop-manager/api/ping` 200；线上 bundle rev `76b156d2e596`（70,159 B）包含
`--ember:#B95C3A` 与 `lm-hero-title`，即刷新页面后即为新配色。

## 10. 表单控件改版（下拉框不再拥挤）

原生 `select` 的两行式选项在窄框里几乎撑满，于是：

- 所有 `select` 统一重做：40px 高、`padding:10px 36px 10px 12px`、自绘 chevron
  （`appearance:none` + data-URI 背景，修掉 `.filters select`/`.modal select` 的 `background` 简写覆盖）、
  13px 字号、8px 圆角、暖色边框 + 焦点环；排序下拉最小宽 136px，连接面板下拉 38px 高。
- **节点类型** 由下拉改成两段式 pill 控件（Agent 指令 / Skill）。
- **选择 Skill** 改为自定义选择器：触发器显示「skill 名 + 描述」两行（超出省略），
  点开是带搜索框的菜单，选项同样是「名字加粗 + 最多两行描述」，无匹配时给提示，回车选中第一项、Esc 关闭。
  菜单在弹窗内流式展开，不会被 `overflow` 裁剪。

截图：`docs/screenshot-skill-picker.png`（选择器展开）、`docs/screenshot-node-skill.png`（弹窗整体）、
`docs/screenshot-list.png`（排序下拉）。

## 11. SKILL 选择器搜索修复

现象：在 skill 选择器里输入文字没有过滤效果。原因与修复：

1. **`hidden` 被 CSS 覆盖**：`.lm-picker-option{display:flex}` 的优先级高于 UA 的 `[hidden]{display:none}`，
   所以 `option.hidden = true` 不生效。补 `.lm-root [hidden]{display:none!important}`。
2. **搜索改成实时 + 分词 + 相关度排序**：空格分词做 AND 匹配（名称/描述任一命中），
   按 `名称全等 > 名称前缀 > 名称包含 > 部分名称 > 仅描述` 重排 DOM，首项自动高亮；
   ↑/↓ 移动、Enter 选中、Esc 关闭；无匹配显示提示。
3. **顺带修掉描述解析 bug**：真实 SKILL.md 用 YAML 块标量（`description: >-` / `|`），
   旧解析只取到 `>-`，导致下拉里描述显示成 `>-`。`lib/skills.js` 现在支持 `>`/`|` 及 `-`/`+` 修饰、
   折叠/字面两种模式、块内空行与后续 key。

浏览器实测（隔离 profile，32 个已安装 skill）：
`code-review` → 仅 1 项；`ding doc` → 10 项且 **dingtalk-doc 排首位**，Enter 选中它；
`requirement`（仅描述命中）→ 6 项；清空恢复 32 项；无匹配显示提示；0 页面异常。
截图：`docs/screenshot-skill-filter.png`。单元测试新增块标量用例（`test/skills.test.mjs`，现 58 项全绿）。

## 12. 节点模型选择 + standard mode 运行日志（v4）

### 12.1 实现要点

- `/loop-manager/api/models` 直接读 `sessionController.modelCatalog()`（chat composer 同一个目录），
  返回 provider 分组、模型名和部署默认模型；拿不到时回退 `ctx.llm`。
- 节点新增可选 `model: {provider, model}`；节点弹窗里是与 chat 一致的模型下拉框，第一项
  「跟随 Harness 默认模型（<默认模型名>）」。画布节点卡显示 `模型 · <name>`。
- 每个节点 session 用 `agentPreset: 'standard'` 创建；节点钉了模型时先
  `sessionController.selectModel()`，投递指令前完成。
- runner 把同一 turn 里的 reasoning / 工具调用 / 中间文本折叠进 `thinking`，最后一条 assistant
  文本作为 `output`；轮询期间通过 `onProgress` 回填实时 output/thinking。
- 运行日志用 `<details class="lm-think">` 默认折叠「思考 · N 字」，`.lm-log-output-text`
  完整展示「最终结果」（运行中标签为「实时输出」）。

### 12.2 隔离 profile 实测（2026-10-28）

服务：`DSH_HOME=/tmp/dsh-loop-verify-home dsh --profile loopverify --host 127.0.0.1 --port 58099`。

```bash
# smoke（10/10，含 /api/models）
DSH_HOME=/tmp/dsh-loop-verify-home SKIP_PROFILE=1 bash scripts/run-verify.sh

# 模型目录（真实返回）
GET /loop-manager/api/models
{"ok":true,"providers":[
  {"id":"deepseek-official","name":"DeepSeek","models":[
    {"id":"deepseek-flash","name":"DeepSeek-V4.1-Flash"},
    {"id":"deepseek-v4-pro","name":"DeepSeek-V4-Pro",...}]},
  {"id":"deepseek-account","name":"DeepSeek Account","models":[...]}],
 "default":{"provider":"deepseek-official","model":"deepseek-flash"}}

# 真实 agent e2e（19/19，v4b 当时的检查集；v5–v7 累计增加确认框、思考展开/滚动保持与数据库配置检查后为 38/38，见 §13–§15）
node scripts/e2e-run.mjs --base http://127.0.0.1:58099 --token <token> --out /tmp/loopshots-v4b
```

e2e 关键输出：

```
PASS  model catalog available            deepseek-official/deepseek-flash
PASS  model picker present               5 options, first="跟随 Harness 默认模型（DeepSeek-V4.1-Flash）"
PASS  model picker offers the Harness default
PASS  run settles                        status=completed after 4671 ms
PASS  node A completed                   output="LOOPMVRRFVHS-OK"
PASS  node B completed                   output="我收到 [A: 说一个标记]\nLOOPMVRRFVHS-OK"
PASS  run log renders per-node blocks    2 blocks
PASS  run log shows the final result     "LOOPMVRRFVHS-OK"
PASS  thinking starts folded             summary="思考 · 1510 字"
PASS  thinking expands on click          open=true
E2E PASS (0 failed)
```

落盘校验（`/tmp/dsh-loop-verify-home/loop-manager/state.json`）：

- pipeline 节点 A 的 `model` = `{"provider":"deepseek-official","model":"deepseek-flash"}`；
- run `nodeStates.node-a` 含 `output: "LOOPMVRRFVHS-OK"` 与一段 1510 字的 `thinking`；
- 节点 B 没有 `model`，按 Harness 默认模型执行，并收到 A 的输出。

多节点模型隔离（v4c：A 钉 flash、部署默认在 run 开始时是 v4-pro，随后再跑一次）：

```bash
node scripts/e2e-run.mjs --base http://127.0.0.1:58099 --token <token> --out /tmp/loopshots-v4c
# 19/19 PASS，A output=LOOPMVRRP1EO-OK，B output=我收到 [A: 说一个标记]\nLOOPMVRRP1EO-OK
```

```
node-a session header: agentPreset=standard, model/selection={deepseek-official, deepseek-flash, high}
node-b session header: agentPreset=standard, model/selection={deepseek-official, deepseek-v4-pro, high}
```

即：A 的显式模型生效；A 调用 `selectModel()` 后默认值变成 flash，但 B 仍用 run 开始时快照的
v4-pro——某个节点选模型不会污染同 run 里的「跟随默认」节点。

浏览器验证 `node scripts/browser-verify.mjs` → **5/5**（顺带修正了旧的
`我的 Pipelines` 文案断言为当前 UI 的 `Agent Pipeline`）。

截图：
- `docs/screenshot-node-model.png` 节点弹窗里的模型下拉框（含「跟随 Harness 默认模型」）；
- `docs/screenshot-run-folded.png` 运行日志：思考默认折叠 + 完整最终结果；
- `docs/screenshot-run-expanded.png` 点开思考后的运行日志。

## 13. 开始 / 停止任务二次确认（v5）

- `开始任务`（列表行、编排页）点击后先弹「开始任务？」确认框：显示 pipeline 名、节点数、
  standard mode 说明与模型说明，按钮为 `取消` / `开始任务`；确认后才 `POST /api/pipelines/:id/run`。
- `停止任务`（编排页、运行记录）点击后先弹「停止任务？」确认框：显示当前运行时长与正在执行的节点，
  按钮为 `取消` / `停止任务`；确认后才 `POST /api/runs/:runId/stop`。
- 空图 / 有环时在弹确认框之前就 Toast 拦截，不会让用户确认一个必然失败的任务。
- Escape / `取消` 关闭确认框，不产生任何 agent 会话。

隔离 profile 真实浏览器 e2e（v5）：

```bash
node scripts/e2e-run.mjs --base http://127.0.0.1:58099 --token <token> --out /tmp/loopshots-v5
```

新增检查全部通过：

```
PASS  start button opens a dialog        start clicked
PASS  start asks for confirmation        title="开始任务？" cancel=true confirm=true
PASS  start confirmation can be cancelled dialog closed
PASS  confirm starts the run             run bec0947b-…
PASS  stop asks for confirmation         title="停止任务？" cancel=true confirm=true
PASS  stop confirmation can be cancelled dialog closed
PASS  stop probe pipeline opens          row clicked
PASS  stop probe run starts              run 5de7a578-…
PASS  stop confirmation stops the run    status=stopped
E2E PASS (0 failed)   # 31/31（模型未返回 reasoning 时为 25/25 + INFO）
```

其中最后一段用一条 `sleep 6` 的节点验证「停止任务」确认按钮确实会调用 stop API，
最终 run 状态为 `stopped`；前面的停止确认检查只取消、不中止正常流程。

截图：
- `docs/screenshot-confirm-start.png` 开始任务确认框；
- `docs/screenshot-confirm-stop.png` 停止任务确认框（含已运行时长/当前节点）。

确认框复用现有 `.modal` 样式，不新增视觉体系；运行日志截图仍来自 v4b
（`docs/screenshot-run-folded.png` 等）。

## 14. 思考块展开状态跨轮询保持（v6）

现象：运行日志里的思考过程默认折叠；用户点开后，大约 0.7–1.5s 内又自动折叠。

根因：日志面板每次 `GET /api/state` 轮询都会 `app.innerHTML = editorMarkup(...)` 整体重绘，
`<details>` 元素被重建，浏览器只保留 DOM 上的 `open` 属性，用户手动展开的状态没有写回数据源。

修复：
- client 增加 `state.openThinking: Set<string>`，key 为 `${runId}:${nodeId}`；
- 点击 `<summary>` 时在默认 toggle 之前记录目标状态（closed→add，open→delete）；
- `logMarkup` 按 key 写回 `open` 属性：`<details class="lm-think" data-think-key="..." open>`；
- 因此轮询重绘后展开状态保留，收起状态也不会被重新打开。
- 同一类问题也发生在思考内容的内部滚动：重绘前按 key 收集 `.lm-think-body.scrollTop`，
  重绘后写回，用户往下拖动查看长思考时不会每次轮询跳回开头。

真实浏览器 e2e 新增两条检查，并在点击后等待 2.5s（> 两次 0.7s 轮询）：

```
PASS  thinking starts folded                    summary="思考 · 1516 字"
PASS  thinking expands on click                 open=true
PASS  thinking stays expanded across polls      open=true
PASS  thinking stays collapsed after closing    open=false
PASS  thinking body can scroll                  scrollTop=60
PASS  thinking scroll position survives polls   open=true scrollTop=60 (was 60)
E2E PASS (0 failed)   # 31/31（模型未返回 reasoning 时为 25/25 + INFO）
```

测试时临时把思考体 `max-height` 调小到 80px 以制造可滚动区域；滚动到 60px 后等待 2.5s
（超过两次轮询），`scrollTop` 仍为 60。

截图：`docs/screenshot-run-expanded.png`（展开状态）。

## 15. PostgreSQL 持久化（v7）

### 15.1 依赖与本地验证实例

插件新增运行时依赖 `pg`（package.json dependencies）：

```bash
cd /Users/temporary/github/dsh-loop-plugins && npm install   # 生成 node_modules/pg
```

隔离验证没有系统 PostgreSQL，使用 **PGlite + pglite-socket** 暴露真实 PostgreSQL wire protocol：

```bash
cd /tmp && mkdir pglite-verify && cd pglite-verify
npm init -y
npm install @electric-sql/pglite@0.5.12 @electric-sql/pglite-socket@0.2.15

cat > server.mjs <<'JS'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
const db = await PGlite.create()
await db.waitReady
const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 55432, maxConnections: 20 })
await server.start()
console.log('PGLITE READY 127.0.0.1:55432')
JS
node server.mjs   # 后台运行
```

DSH 侧仍用隔离 profile 启动：

```bash
DSH_HOME=/tmp/dsh-loop-verify-home dsh --profile loopverify \
  --host 127.0.0.1 --port 58099 --no-open
```

### 15.2 首次连接初始化 + 本地数据导入

```bash
PUT /loop-manager/api/db
{"host":"127.0.0.1","port":55432,"database":"postgres","user":"postgres",
 "password":"postgres","ssl":false,"readFromDb":true}

{
  "ok": true,
  "db": {"configured":true,"readFromDb":true,"connected":true,"initialized":true,
         "config":{"hasPassword":true,...}},
  "imported": {"importedPipelines":22,"importedRuns":18}
}
```

直接查库：

```
loop_manager_meta        1 row   {schema_version: "1"}
loop_manager_pipelines   22 rows
loop_manager_runs        18 rows
```

### 15.3 读写开关与镜像

- HTTP smoke `scripts/smoke.mjs`：**11/11**（新增 `GET /api/db`）。
- `readFromDb=true` → `GET /api/state`：`source=db`，22 pipelines / 18 runs。
- 关闭开关（密码留空）→ `source=local`，仍 22 pipelines；重新打开 → `source=db`。
- 读库模式创建 pipeline：`GET /api/state.source=db` 立刻可见；直接查库确认
  `name/description/nodes/model` 已写入。
- 运行真实 agent（`DB-MIRROR-OK`）后：
  - `GET /api/state.source=db` 返回 `completed`，`output=DB-MIRROR-OK`，thinking 126 字；
  - `loop_manager_runs` 对应行同样有 `status=completed`、`output`、`thinking`。
- 删除 pipeline 后：state 中消失，库中 `loop_manager_pipelines` 与对应 runs 计数均为 0。
- 启动恢复：清空 PGlite 后重启 DSH，本地 22 pipelines/18 runs 自动 backfill 到空库，
  `GET /api/state.source=db` 恢复 22/18（验证启动期 init + import）。

### 15.4 接口与错误

- `POST /api/db/test` 正常连接 → `{ok:true, db:{connected:true, initialized:true}}`。
- 错误端口 → HTTP 400 `{"code":"db-error","error":"connect ECONNREFUSED ..."}`。
- `GET /api/db` 从不返回密码，只返回 `hasPassword`。
- 数据库进程被杀后，`pg` pool 的 idle client 会发出 error；lib/db.js 已监听 pool
  `error` 事件并记录，不再导致 DSH 进程 fatal uncaught exception。

### 15.5 真实浏览器 e2e（含数据库弹窗）

```bash
node scripts/e2e-run.mjs --base http://127.0.0.1:58099 --token <token> --out /tmp/loopshots-db2
```

```
PASS  database config entry opens        nav clicked
PASS  database config modal opens        title="数据库配置" host=true port=true db=true user=true
PASS  database read switch is on top     switch=true status="已连接 · 已初始化 · 当前从数据库读取"
PASS  database read switch toggles       true → false → true
PASS  database test connection works     status="连接成功，数据库已初始化。"
PASS  database config saves read switch off readFromDb=false
PASS  database config saves read switch on readFromDb=true
...
E2E PASS (0 failed)   # 38/38（连接数据库 + 模型返回 reasoning 时）
```

截图：`docs/screenshot-db-config.png`。

## 16. v9 Loop 编排（Loop tab，CONTRACT.md §13）

实现：`lib/loop.js`（纯函数）、`lib/loopengine.js`（状态机）、`lib/store.js` / `lib/db.js` /
`lib/index.js`（host）、`lib/client.js`（Loop tab / 列表 / 详情 / 编辑器）。
测试：`test/loop.test.mjs`、`test/loopengine.test.mjs`、`test/store.test.mjs`、
`test/db.test.mjs`、`test/client-bundle.test.mjs`、`scripts/smoke.mjs`、`scripts/browser-verify.mjs`。

### 16.1 单元测试 / 静态检查（2026-10-28）

```bash
npm test        # node --test
npm run check   # 含 lib/loop.js、lib/loopengine.js
npm run lint
```

```
ℹ tests 149
ℹ pass 149
ℹ fail 0
```

- 新增测试 73 个（原有 76）：`loop.test.mjs` 47 个（validateLoop 合法/缺 pipeline/
  空 steps/>20 组/gate 字段/maxIterations 1|20|21、parseGateDecision 六级优先级与
  UNKNOWN/假阳性正文、renderGatePrompt agent|skill/空输出、aggregatePipelineOutput
  顺序/空输出/20000 截断）；`loopengine.test.mjs` 16 个（TRUE 前进、FALSE+autoLoop
  重跑到上限 awaiting、FALSE 手动 awaiting+retry、UNKNOWN、门禁抛错、pipeline failed/
  stopped/run-in-progress、stop/dispose、retry 的 not-awaiting/step-not-found/
  loop-run-not-found、同 loop run-in-progress、listRuns）；store/db/client-bundle 增量。
- `npm run check`：exit 0（脚本包含 `node --check lib/loop.js` 与
  `node --check lib/loopengine.js`）。
- `npm run lint`：exit 0，`0 errors, 8 warnings`（warning 均在既有代码/工具 +
  `lib/loopengine.js:738 targetIndex`、`lib/index.js:764/773` 的 no-useless-assignment）。

### 16.2 隔离 profile HTTP smoke（20/20）

```bash
DSH_HOME=/tmp/dsh-loop-verify-home bash scripts/create-verify-profile.sh
DSH_HOME=/tmp/dsh-loop-verify-home SKIP_PROFILE=1 \
  VERIFY_LOG=/tmp/loop-verify-server.log bash scripts/run-verify.sh
```

```
PASS  auth token exchange            HTTP 303 -> browser cookie minted
PASS  GET /                          HTTP 200, 37642 bytes, contains __DSH_BOOT__
PASS  boot graph                     release 0.2.1-rc.2 (332895e), 70 rows, row rev 9526373a5b84
PASS  client bundle                  /plugins/??dsh-loop-manager/client.js&rev=9526373a5b84 HTTP 200, 167753 bytes
PASS  GET /loop-manager/api/state    HTTP 200 {"ok":true,"pipelines":32,"loops":0,"loopRuns":0}
PASS  GET /loop-manager/api/models   HTTP 200, 2 providers / 4 models
PASS  GET /loop-manager/api/db       HTTP 200, configured=true connected=false
PASS  POST /loop-manager/api/pipelines HTTP 200, pipeline id …   (smoke probe)
PASS  GET state contains pipeline    … present (33 total)
PASS  DELETE /loop-manager/api/pipelines/:id HTTP 200 {"ok":true}
PASS  GET state after delete         pipeline removed from state
PASS  POST pipeline for Loop probe   HTTP 200, pipeline id …     (§13.6 引用对象)
PASS  POST /loop-manager/api/loops   HTTP 200, loop id …
PASS  GET state contains loop        loop … present (1 total, 0 loop runs)
PASS  PATCH /loop-manager/api/loops/:id HTTP 200, star persisted
PASS  POST /api/loops invalid pipeline HTTP 400 {"code":"invalid-loop"}
PASS  POST /api/loops/:id/run unknown loop HTTP 404 {"code":"loop-not-found"}
PASS  POST /api/loop-runs/:id/retry unknown run HTTP 404 {"code":"loop-run-not-found"}
PASS  DELETE /loop-manager/api/loops/:id HTTP 200, loop removed from state
PASS  DELETE pipeline for Loop probe HTTP 200, probe pipeline removed
INFO  unauthenticated API access    HTTP 401 (fenced)
SMOKE PASS — 20/20 checks in 333 ms
```

要点：`/api/state` 在本地与 readFromDb 两条路径都返回 `loops` / `loopRuns`
（smoke 断言字段类型）；Loop 的 CRUD、Pipeline 引用校验（`invalid-loop` 400）、
未知 Loop 404、未知 LoopRun 404 均按 §13.6 通过；smoke 自身创建/删除所有探针数据
（跑完 state.loops=0、无 loopRuns 残留）。

### 16.3 真实浏览器（Chrome 156 + CDP，11/11）

验证服务由一次性启动脚本管理（起服务 → 从启动日志取 token → 跑脚本 → kill），
不碰桌面版（127.0.0.1:60677）：

```bash
DSH_HOME=/tmp/dsh-loop-verify-home \
  dsh --profile loopverify --host 127.0.0.1 --port 58099 --no-open   # 后台
TOKEN=$(sed -n 's/^dsh web: .*[?&]token=\([^& ]*\).*/\1/p' <启动日志> | head -1)
node scripts/browser-verify.mjs --base http://127.0.0.1:58099 --token "$TOKEN" \
  --out /tmp/loopshots-v9
```

```
PASS  app shell boots                    window.__DSH_BOOT__ present
PASS  sidebar Loop Manager row           found 1 button[aria-label="Loop Manager"]
PASS  panel renders after click          list header + 新建 Loop visible
PASS  loop-manager markup mounted        .lm-root workbench nodes: 1
PASS  Loop tab sits after Agent Pipeline tabs: ["all","loops","recent","star"]
PASS  Loop list renders after clicking Loop eyebrow="PIPELINE → GATE, UNTIL IT PASSES", emptyState=true
PASS  Loop count matches state           badge=0 loops=0
PASS  new-Loop editor adds/removes steps steps 1 -> 2 -> 1, name=true pipeline=true gateName=true auto=true max=true
PASS  Loop row renders in the list       loop … has a row   (API 建探针 Loop，轮询后出现在列表)
PASS  Loop detail flow renders           pipeline card + gate card + loop policy visible
PASS  no uncaught page errors            0 unrelated console errors

BROWSER PASS — 11/11 checks
```

截图（`/tmp`，一次性验证产物）：`verify-loop-tab.png`、`verify-loop-editor.png`、
`verify-loop-detail.png`、`verify-panel.png`、`verify-sidebar.png`。

覆盖 §13.8.4：Loop tab 紧跟 Agent Pipeline、列表/空态、`＋ 新建 Loop` 按钮、
编辑器增删步骤，以及列表行 + 详情流程卡渲染；探针 Loop 在脚本 finally 中 DELETE
（验证后 state.loops=0），未留下数据。

### 16.4 真实 agent e2e（环境受限，未通过）

`scripts/e2e-run.mjs` 在隔离 profile 上跑真实两节点 pipeline 时，模型 credential 失效：

```
FAIL  run settles     status=failed after 510 ms
FAIL  node A completed  status=failed output=""
FAIL  run completed     status=failed
      error=node "node-a" failed: Authentication Fails, Your api key: ****101e is invalid
```

原因：`/tmp/dsh-loop-verify-home/.credentials.yaml` 里 `DEEPSEEK_API_KEY`（sk-…101e）
已失效（桌面版轮换过），与 v9 代码无关；本次未复制新 credential，因此
“真实 agent 跑 Loop、由真实模型给出 TRUE/FALSE”这一条只能在具备有效凭据时补跑，
其余 Loop 行为已由单元状态机测试 + HTTP smoke + 浏览器验证覆盖。

### 16.5 契约 §13.8 对照

1. `npm test` 全绿、含全部新增覆盖：✅ 149/149（见 16.1）。
2. `node --check`（check 脚本含新文件）：✅ exit 0。
3. 隔离 profile `GET /api/state` 返回 loops/loopRuns，Loop CRUD + 错误码 round trip：✅ smoke 20/20。
4. 真实浏览器 Loop tab 顺序 / 列表 / 新建按钮 / 编辑器增删步骤 / 列表+详情渲染 /
   无未捕获异常 / 截图：✅ 11/11。gate 等待人工时的「↻ 重新循环」按钮需真实 LoopRun
   处于 awaiting 才会出现；本次因凭据失效未在浏览器里制造真实 awaiting（按钮的渲染
   条件与点击 → `POST /api/loop-runs/:id/retry` 已由 client-bundle 断言 + loopengine
   单测覆盖）。
5. TRUE 前进 / FALSE+autoLoop 自动重跑 / FALSE 手动 awaiting + retry 恢复：✅ 单测
   （fake engine + fake runGate 驱动真实状态机）；真实模型判定路径见 16.4 受限说明。

### 16.6 残留风险

- 真实模型 credential 失效，未跑通“真实 agent 门禁 TRUE/FALSE”端到端（环境问题）。
- PostgreSQL 的两张新表（`loop_manager_loops` / `loop_manager_loop_runs`）只用 fake pg
  单测覆盖 DDL/mirror/loadState/backfill，未连真实 PostgreSQL/PGlite 复核；§15 的
  PGlite 实例本次未启动。
- lint 有 8 个 warning（0 error）；其中 `lib/loopengine.js:738`、`lib/index.js:764/773`
  是本功能引入的 no-useless-assignment。
