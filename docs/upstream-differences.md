/

# 本地改动与上游同步指南

本文记录本仓库相对原始 pi 仓库的长期本地功能，供后续拉取上游更新、处理冲突和回归验证时使用。本文只记录代码契约与配置结构，不记录本机密钥、访问令牌、用户 ID 或余额。

## 基线

记录日期：2026-08-14（Asia/Shanghai）。

| 引用            | 提交                                         | 说明                                                 |
| --------------- | -------------------------------------------- | ---------------------------------------------------- |
| `origin/main` | `9d2ec7ffabe927bfad2214c1cee25b6632a78dcf` | 原始仓库`https://github.com/earendil-works/pi.git` |
| `target/main` | `9d2ec7ffabe927bfad2214c1cee25b6632a78dcf` | 当前与`origin/main` 相同的一次性快照               |
| 本地`HEAD`    | `cbd1ef0dc39f4adfa1fc102e547f48881aa6addf` | 命名预设提交，不含本文记录的未提交工作树改动         |

`target/main` 当前没有对应的 `remote.target` 配置，不能认为它会自动更新。它最初由 `https://github.com/NietzscheLi/pi.git` 直接 fetch 得到。比较原始 pi 时以 `origin/main` 为权威；使用 `target/main` 前必须先确认来源和提交 SHA。

基线更新前执行：

```bash
git status --short
git fetch origin main
git rev-parse origin/main target/main HEAD
git log --oneline --decorate origin/main..HEAD
git diff --stat origin/main...HEAD
```

不要在脏工作树上 rebase 或 merge。先把不同功能整理成独立提交，并显式纳入 untracked 文件。

## 差异总览

本地功能分成两个独立变更组。同步上游时也应保持这个顺序重放，避免把 preset、余额和 TUI 冲突混成一个整文件选择。

| 变更组               | 当前状态            | 用户可见行为                                                    |
| -------------------- | ------------------- | --------------------------------------------------------------- |
| 命名预设             | 已提交：`cbd1ef0` | `--preset`、`/preset`、项目预设持久化、资源组合与切换回滚   |
| 供应商余额与模型选择 | 当前工作树          | 两级模型选择、供应商余额、TPS/余额 footer、统一原生 footer 布局 |
| Plan mode 顺序执行   | 当前工作树          | 每个 agent run 只执行一个计划步骤，逐项更新并持久化完成状态     |

## Plan mode 顺序执行

### 问题与行为契约

旧实现把所有剩余步骤一次性交给模型。模型通常在最终回复才统一输出全部 `[DONE:n]`，导致任务列表在整个计划结束时才一次性变为 completed。

当前实现必须保持以下行为：

- 每个 agent run 只接收并执行当前一个步骤，不能提前开始后续步骤。
- 当前步骤完成后，assistant 回复包含对应的 `[DONE:n]`。
- `turn_end` 收到标记后立即更新 footer、todo widget，并通过 `appendEntry("plan-mode", ...)` 持久化状态。
- 当前 run 的 `agent_end` 只在当前步骤确实 completed 后排队启动下一步骤。
- 持久化 `executingStep`，恢复 session 时重新扫描当前计划执行标记之后的 assistant 消息，并从首个未完成步骤继续。
- 所有步骤完成后才清空执行状态并显示 `plan-complete` 消息。

### 关键文件

| 文件                                                              | 本地职责                                           | 合并注意点                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/coding-agent/src/extensions/plan-mode/index.ts`       | 内置 plan mode 的逐项调度、状态刷新和 session 恢复 | 保留`turn_end` 即时持久化与 `agent_end` 下一项调度的职责分离 |
| `packages/coding-agent/examples/extensions/plan-mode/index.ts`  | 面向扩展作者的同步参考实现                         | 行为应与内置实现保持一致                                         |
| `packages/coding-agent/test/plan-mode-extension.test.ts`        | 验证首个提示不泄露后续步骤、逐项完成和下一项调度   | 修改执行生命周期时必须运行                                       |
| `packages/coding-agent/examples/extensions/plan-mode/README.md` | 记录顺序执行和逐项进度行为                         | 与实现保持同步                                                   |

### 回归验证

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/plan-mode-extension.test.ts \
  test/built-in-plan-mode.test.ts
cd ../..
npm run check
```

## 命名预设

### 行为契约

- 预设选择优先级从低到高为：`defaultPreset`、项目 `.pi/preset.json`、显式 `--preset`。没有命名预设时使用 `Base`。
- 设置合并优先级从低到高为：全局设置、Base 层、命名预设、项目设置、显式进程参数。
- `defaultProjectTrust` 是例外，只读取全局或预设值，项目文件不能改变信任决策。
- 预设可以组合 settings、skills、extensions、packages 和 MCP server ID，并分别 enable/disable。
- 资源冲突优先级从高到低为：项目显式、项目自动发现、preset、用户显式、用户自动发现、package 资源。
- `/preset` 在写入项目选择前预检资源；reload 失败时恢复旧选择并尝试恢复旧运行时。
- `--preset` 只覆盖当前进程。此时 `/preset` 可以保存项目默认值，但不会替换当前进程的 CLI 选择。

### 外部配置

- `~/.pi/agent/presets.yml`：预设库。
- `~/.pi/agent/mcp-registry.json`：私有 MCP 定义；POSIX 权限必须精确为 `0600`。
- `<project>/.pi/preset.json`：项目选择，只保存预设名或 `Base`。

MCP 注册表只定义服务器和选中的 ID，不提供 MCP 客户端实现。对应扩展或 package 仍必须存在。

### 关键文件

| 文件                                                                | 本地职责                                          | 合并注意点                                        |
| ------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| `packages/coding-agent/src/core/preset-manager.ts`                | 配置校验、层合并、项目选择读写、MCP 权限检查      | 新增文件，保留严格校验和原子写入                  |
| `packages/coding-agent/src/core/settings-manager.ts`              | 将 Base/命名预设插入设置优先级                    | 上游若调整设置层，重新推导优先级，不能直接选 ours |
| `packages/coding-agent/src/core/package-manager.ts`               | preset 资源来源与冲突排序                         | 保留上述资源优先级契约                            |
| `packages/coding-agent/src/extensions/preset.ts`                  | `/preset`、预检、reload 与失败回滚、footer 状态 | 与扩展 reload 生命周期一起审查                    |
| `packages/coding-agent/src/main.ts`                               | 启动时解析预设、项目 cwd 和首次选择               | 上游启动顺序变化时风险最高                        |
| `packages/coding-agent/src/cli/args.ts`                           | `--preset` 参数                                 | 同步参数解析和帮助文本测试                        |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 首次交互选择与 reload 错误回传                    | 不覆盖上游新增 TUI 生命周期逻辑                   |
| `packages/coding-agent/src/core/agent-session.ts`                 | reload 前校验入口                                 | 改动小但属于回滚契约                              |

详细使用说明继续维护在 `packages/coding-agent/docs/presets.md`。

## 供应商余额与两级模型选择

### 余额共享层

`packages/coding-agent/src/core/provider-balance.ts` 是余额的唯一实现。模型选择器和 footer 必须共用以下 API，不能各自复制请求、缓存或格式化逻辑：

- `providerBalanceService`：按供应商缓存、并发请求合并、刷新时效和状态订阅。
- `formatProviderBalance()`：统一 normal、`refreshing`、`unavailable` 和 `stale` 文本。
- `ProviderBalanceReader`：模型选择器可测试注入边界。

余额请求使用 Pi 运行时已经解析的 `baseUrl` 和认证结果，因此必须继续兼容 `auth.json`、CLI key、OAuth、环境变量和 `!command`。不要退回直接读取 `models.json` 的字面 `apiKey`。

供应商和 profile 名称必须作为精确对象键读取。`Toioto-Codex-0.12` 一类包含点号的 ID 不能作为点分对象路径解析。

共享服务只从 `~/.pi/agent/balance-config.yaml` 读取余额协议，仓库不跟踪本机配置。支持的结构包括：

- `refreshIntervalMinutes`，默认 5 分钟，最小 1 分钟。
- `profiles` 和 `providers` 两层覆盖。
- `request`：`baseUrl`、URL、method、headers、body、timeout。
- `credentials`：余额接口专用 `apiKey`、`accessToken`、`userId`，优先于模型认证。
- `extractor`：remaining path、validity、error path、scale/multiply/divide 和 unit。

不要把真实 `balance-config.yaml`、`models.json` 或认证值加入 Git、测试快照、日志和本文。

### Footer

`packages/coding-agent/src/extensions/status-footer.ts` 是隐藏内置扩展：

- `/update-balance` 强制刷新当前供应商。
- session start、model select 和配置周期触发余额刷新。
- 最近一个 assistant turn 计算输出 TPS。
- 通过 `setStatus("status-footer", ...)` 发布 `TPS ... · balance: ...`。

命名预设通过 `setStatus("preset", ...)` 发布状态。原生 `FooterComponent` 将所有 extension statuses 按 key 排序、以原生 `•` 分隔并统一使用 `dim` 色，然后并入第二行统计区域。因此当前顺序是 `preset`、TPS/balance，不再渲染颜色和排列都不同的第三行。

footer 仍保持两行：第一行 cwd/branch/session，第二行左侧统计和扩展状态、右侧当前模型。窄终端优先截断左侧尾部的扩展状态，并保留右侧模型；40、80、120 列都要覆盖。

### 模型选择器

`packages/coding-agent/src/modes/interactive/components/model-selector.ts` 在一个组件内维护两级视图，不能连续创建两个 `showSelector()`：

1. 一级选择供应商，显示模型数、当前供应商标记和高亮供应商余额。
2. 二级只显示该供应商的模型。
3. 模型层 Escape 返回供应商层；供应商层 Escape 才关闭。

必须保留的既有语义：

- `all/scoped` 切换；scoped 模型在同一供应商内保持配置顺序。
- 打开选择器后使用缓存目录立即渲染，同时在后台刷新模型目录。
- `/model <term>` 的精确匹配快速路径和扁平参数补全不变。
- 一级查询按“供应商自身完整匹配，或至少一个子模型完整匹配”筛选，不能跨两个子模型拼出假匹配。
- 查询命中供应商自身时，进入二级清空查询并显示全部模型；命中子模型时保留查询。
- 后台刷新按 provider/model ID 保留用户当前高亮，目标消失后才回退。
- 余额只在高亮供应商变化时请求；共享请求完成后只刷新仍然高亮该供应商的界面。

### 关键文件

| 文件                                                                         | 本地职责                                           | 合并注意点                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------- |
| `packages/coding-agent/src/core/provider-balance.ts`                       | 余额协议、运行时凭据输入、缓存、去重、订阅和格式化 | 新增文件，保持唯一实现                      |
| `packages/coding-agent/src/extensions/status-footer.ts`                    | TPS、定时余额、命令和 status 发布                  | 新增文件，检查 extension event/context 变化 |
| `packages/coding-agent/src/extensions/index.ts`                            | 注册 preset 和 status-footer 两个隐藏内置扩展      | 两个本地功能共享冲突点                      |
| `packages/coding-agent/src/modes/interactive/components/model-selector.ts` | 两级状态机、搜索、scope、目录刷新、余额展示        | 接近整体改写，是上游同步热点                |
| `packages/coding-agent/src/modes/interactive/components/footer.ts`         | 将扩展状态并入原生统计行并保证左右布局             | 保留上游新增统计项和宽度逻辑                |

## 上游同步流程

1. 确认工作树干净，并建立可恢复分支。
2. fetch `origin/main`，记录旧/新上游 SHA；不要把未配置 remote 的 `target/main` 当成最新上游。
3. 从新上游建立集成分支。
4. 先重放 preset 提交，再重放余额/模型/footer 提交，最后重放文档提交。
5. 以新上游文件结构为基础逐块恢复本地契约，不对冲突文件整份选择 ours。
6. 用 `range-diff` 检查重放前后本地语义是否丢失。

示例：

```bash
git status --short
git fetch origin main
git branch backup/local-before-upstream-sync
git switch -c integrate/upstream-YYYYMMDD origin/main

# 依次 cherry-pick 本地功能提交并解决冲突，然后比较重放结果。
git range-diff <old-upstream>..<old-local-head> origin/main..HEAD
```

重点冲突处理顺序：

1. `settings-manager.ts`、`main.ts`、`package-manager.ts` 的预设优先级和启动契约。
2. `model-selector.ts` 的上游目录刷新与本地两级状态机。
3. `footer.ts` 的上游统计项与本地扩展状态布局。
4. `extensions/index.ts`、`interactive-mode.ts`、`agent-session.ts` 的接线和生命周期。
5. tests、CHANGELOG 和使用文档。

## 回归门禁

同步或修改上述功能后至少运行：

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/args.test.ts \
  test/preset-manager.test.ts \
  test/provider-balance.test.ts \
  test/model-selector.test.ts \
  test/footer-width.test.ts \
  test/suite/regressions/3217-scoped-model-order.test.ts \
  test/suite/regressions/6999-models-json-hot-reload.test.ts \
  test/suite/regressions/7209-model-selector-filter-resets-selection.test.ts

cd ../..
npm run check
```

上游大版本同步还应运行仓库根目录 `./test.sh`。不要直接运行完整 Vitest suite；仓库规则要求通过 `./test.sh` 跳过可能使用真实供应商凭据的 e2e 用例。

## 本机构建与安装

当前全局 `pi` 通过 npm link 指向 `packages/coding-agent`，不是隔离 tarball 安装。完成所有代码、测试和文档后使用：

```bash
npm run build
cd packages/coding-agent
npm link --ignore-scripts

command -v pi
readlink -f "$(command -v pi)"
pi --version
```

安装后还要从仓库外启动 `pi`，打开 `/model` 验证供应商层、余额、模型层和 Escape 返回，并确认 footer 仍为两行且当前模型可见。

## 当前验证

2026-08-14 已对本文记录的本地改动完成以下验证：

- 定向 Vitest：8 个测试文件、110 个用例全部通过，覆盖 preset、共享余额服务、两级模型选择器、footer 宽度及 #3217、#6999、#7209 回归。
- 根目录 `npm run check` 通过，包括 Biome、固定依赖、TypeScript import、shrinkwrap、install lock、`tsgo --noEmit` 和 browser smoke。
- 根目录 `npm run build` 通过；各 workspace 均完成构建，模型目录重新生成并通过数据校验，未产生额外工作树差异。
- `packages/coding-agent` 中执行 `npm link --ignore-scripts` 成功；全局 `pi` 解析到本仓库的 `packages/coding-agent/dist/cli.js`，`pi --version` 输出 `0.84.1`。
- 在 120x36 的隔离 tmux 终端中以 `pi --no-session --preset Base` 启动已安装命令：`/model` 首层显示供应商与高亮供应商余额，包含点号的供应商 ID 可正常查询；Enter 进入该供应商模型层，第一次 Escape 返回供应商层，第二次 Escape 关闭选择器。
- 实际 footer 保持两行；`preset`、TPS、balance 按原生分隔与颜色并入第二行左侧，右侧当前模型保持可见。验证记录不保存真实供应商余额或认证信息。

## 文档维护检查

每次同步上游或修改本地功能时，同时更新：

- 本文基线日期与三个 SHA。
- 本地功能提交列表和新增/删除文件。
- Plan mode 的逐项执行、完成标记、持久化和恢复契约。
- 外部配置结构，但不写真实值。
- 冲突热点和回归测试命令。
- 构建、安装及实际 TUI 验证结果。
