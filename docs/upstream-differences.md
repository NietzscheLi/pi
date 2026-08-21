# 本地改动与上游同步指南

本文记录本仓库相对原始 pi 仓库的长期本地功能，供后续拉取上游更新、处理冲突和回归验证时使用。本文只记录代码契约与配置结构，不记录本机密钥、访问令牌、用户 ID 或余额。

## 基线

记录日期：2026-08-21（Asia/Shanghai）。

| 引用              | 提交                                         | 说明                                                 |
| ----------------- | -------------------------------------------- | ---------------------------------------------------- |
| `upstream/main` | `5cd93f688aaab89dbb6dfa4aca535f21796ae185` | 原始仓库`https://github.com/earendil-works/pi.git` |
| `origin/main`   | `8152ba1ec4d988278b5de5a61eba911e3ed9d869` | 当前 fork`https://github.com/NietzscheLi/pi.git`   |
| 本地`HEAD`      | `a0b361ada28fe6354d3bba03b1bc0822f67986b6` | 本次同步后的本地 HEAD（上一个合并提交）              |

比较原始 pi 时以 `upstream/main` 为权威；`origin/main` 是本 fork 的远端，不再将未配置的 `target/main` 作为基线。

基线更新前执行：

```bash
git status --short
git fetch upstream main
git fetch origin main
git rev-parse upstream/main origin/main HEAD
git log --oneline --decorate upstream/main..HEAD
git diff --stat upstream/main...HEAD
```

不要在脏工作树上 rebase 或 merge。先把不同功能整理成独立提交，并显式纳入 untracked 文件。

## 差异总览

本地长期功能应按独立变更组重放，避免把 preset、余额、模型选择、footer 和 plan mode 的冲突混成整文件选择。

| 变更组                   | 当前状态                                      | 用户可见行为                                                            |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| 命名预设                 | 已提交：`cbd1ef0`                           | `--preset`、`/preset`、项目预设持久化、资源组合与切换回滚           |
| 供应商余额与两级模型选择 | 已提交：`3120ee3`                           | 两级模型选择、共享供应商余额、定时刷新和`/update-balance`             |
| Footer 独立状态与设置    | 当前工作树                                    | Pikit 风格 token/cache、独立 preset/TPS/balance、三个`/settings` 开关 |
| Plan mode 逐项执行       | 已提交：`2ab2d2f`、`baa271b`、`d4714d2` | 内置 plan mode、稳定 task ID、逐项更新、恢复与持久化                    |
| 项目默认工具预设         | 已提交：`b800f8f`                           | 当前项目`.pi/preset.json` 默认选择 `Tools`                          |

### 本地提交来源

以下功能历史只总结作者为 `lzy <nietzsche.li@outlook.com>` 的非 merge 提交；合并进来的上游提交不计入本地功能来源：

| 提交        | 本地职责                                      |
| ----------- | --------------------------------------------- |
| `cbd1ef0` | 命名预设、资源组合、项目选择和切换回滚        |
| `3120ee3` | 共享供应商余额、两级模型选择和初版统一 footer |
| `9c171c1` | 项目中英文 README 更新                        |
| `2ab2d2f` | 内置 plan mode、默认配置与基础测试            |
| `baa271b` | plan mode 按 task ID 逐项完成和调度           |
| `d4714d2` | 配置锚点、plan 状态恢复及相关文档/测试修正    |
| `b800f8f` | 将当前项目默认预设切换为`Tools`             |

## Plan mode 逐项执行

### 问题与行为契约

旧实现把所有剩余步骤一次性交给模型。模型通常在最终回复才统一输出全部 `[DONE:n]`，导致任务列表在整个计划结束时才一次性变为 completed。

当前实现必须保持以下行为：

- 每个 agent run 只接收并执行当前一个任务，当前任务完成后才按列表排列调度下一项。
- 模型给出的数字是稳定 task ID，可以乱序且不要求连续，但必须唯一；重复 ID 的计划不能执行。
- 当前任务完成后，assistant 回复包含对应 task ID 的 `[DONE:n]`。
- 实时执行接受任意已知 task ID 的完成标记，并只标识 ID 对应的任务；未知 ID 不改变列表。
- `turn_end` 收到有效标记后立即更新 footer、todo widget，并通过 `appendEntry("plan-mode", ...)` 持久化状态。
- 持久化 `executingStep`，恢复 session 时重新扫描当前计划执行标记之后的 assistant 消息，并从首个未完成任务继续。
- 所有任务完成后才清空执行状态并显示 `plan-complete` 消息。

### 关键文件

| 文件                                                              | 本地职责                                           | 合并注意点                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/coding-agent/src/extensions/plan-mode/index.ts`       | 内置 plan mode 的逐项调度、状态刷新和 session 恢复 | 保留`turn_end` 即时持久化与 `agent_end` 下一项调度的职责分离 |
| `packages/coding-agent/examples/extensions/plan-mode/index.ts`  | 面向扩展作者的同步参考实现                         | 行为应与内置实现保持一致                                         |
| `packages/coding-agent/test/plan-mode-extension.test.ts`        | 验证乱序 task ID、完成映射、即时更新和下一项调度   | 修改执行生命周期时必须运行                                       |
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
- TPS 与余额必须分别通过 `setStatus("tps", ...)` 和 `setStatus("balance", ...)` 发布；余额文本不带 `balance` 标签。

命名预设继续通过 `setStatus("preset", ...)` 发布状态。三个本地状态不能重新合并成一个 `status-footer` 字符串，因为 footer 需要分别排序、截断和控制可见性。

`FooterDataProvider` 在返回 extension statuses 时应用三个设置开关，因此原生 footer 和通过 `setFooter()` 注册的自定义 footer 使用同一可见性契约。当前 Pikit footer 来自本地 fork `/home/hy/project/pikit`，通过独立 `preset`、`tps`、`balance` segment 读取这些状态；不要在 Pikit 中重复计算 TPS 或请求余额。

原生 `FooterComponent` 保持两行：第一行 cwd/branch/session；第二行左侧为 Pikit 风格的 `T: total (hit% cached) ↑ input ↓ output`、context 和扩展状态，右侧保留当前模型。cache 百分比按累计 `cacheRead / (input + cacheRead + cacheWrite)` 计算；费用不再显示，余额作为三个本地状态中的最后一项显示，且不带 `balance` 单词。

本地状态固定顺序为 `preset`、`tps`、`balance`；其他 extension status 仍按 key 稳定排序并位于这些本地状态之前。窄终端优先截断左侧尾部状态并保留右侧模型；40、80、120 列都要覆盖。

`Settings.footer` 提供三个默认开启且可独立持久化的开关：

- `footer.showPreset`
- `footer.showTps`
- `footer.showBalance`

`/settings` 中对应 `Footer preset`、`Footer TPS` 和 `Footer balance`。切换后立即重绘 footer，不需要 reload 或重启。

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

| 文件                                                                            | 本地职责                                                    | 合并注意点                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/coding-agent/src/core/provider-balance.ts`                          | 余额协议、运行时凭据输入、缓存、去重、订阅和格式化          | 新增文件，保持唯一实现                                     |
| `packages/coding-agent/src/core/footer-data-provider.ts`                      | 向原生和自定义 footer 提供经过设置过滤的 extension statuses | 三个开关必须对`setFooter()` 自定义 footer 同样生效       |
| `packages/coding-agent/src/extensions/status-footer.ts`                       | TPS、定时余额、命令及独立`tps`/`balance` status 发布    | 不要重新合并 status key；检查 extension event/context 变化 |
| `packages/coding-agent/src/extensions/preset.ts`                              | `/preset` 与独立 `preset` status 发布                   | preset reload 后必须恢复状态                               |
| `packages/coding-agent/src/extensions/index.ts`                               | 注册 preset 和 status-footer 两个隐藏内置扩展               | 两个本地功能共享冲突点                                     |
| `packages/coding-agent/src/modes/interactive/components/model-selector.ts`    | 两级状态机、搜索、scope、目录刷新、余额展示                 | 接近整体改写，是上游同步热点                               |
| `packages/coding-agent/src/modes/interactive/components/footer.ts`            | Pikit 风格 token/cache、状态排序/过滤和窄终端布局           | 保留右侧模型；balance 必须是最后一个本地状态               |
| `packages/coding-agent/src/core/settings-manager.ts`                          | `footer.showPreset/showTps/showBalance` 合并、读取与保存  | 保持默认`true` 和 nested setting 的递归合并              |
| `packages/coding-agent/src/modes/interactive/components/settings-selector.ts` | 三个 footer 可见性开关                                      | 每项独立回调，不合并成单一开关                             |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts`             | 设置值与回调接线、即时重绘                                  | 切换可见性不应触发 reload                                  |

## 上游同步流程

1. 确认工作树干净，并建立可恢复分支。
2. fetch `upstream/main` 和 `origin/main`，记录原始上游、fork 远端和本地 HEAD SHA。
3. 从新的 `upstream/main` 建立集成分支。
4. 按本地提交依赖顺序重放：`cbd1ef0`（preset）→ `3120ee3`（余额/模型/footer）→ `2ab2d2f`、`baa271b`、`d4714d2`（plan mode）→ `b800f8f`（项目默认预设）；文档提交 `9c171c1` 按目标分支 README 状态决定是否重放。
5. 最后恢复当前工作树中的 footer 独立状态与设置改动。
6. 以新上游文件结构为基础逐块恢复本地契约，不对冲突文件整份选择 ours。
7. 用 `range-diff` 检查重放前后本地语义是否丢失。

示例：

```bash
git status --short
git fetch upstream main
git branch backup/local-before-upstream-sync
git switch -c integrate/upstream-YYYYMMDD upstream/main

# 只重放上表列出的本地提交并解决冲突，然后比较重放结果。
git range-diff <old-upstream>..<old-local-head> upstream/main..HEAD
```

### 2026-08-26 增量同步（9 个上游提交）

直接合并 `upstream/main`（`b7bb00b9`）到 `main`，只产生一个冲突文件：
`model-selector.ts`。上游 #8356 把模型/思考级别改为会话级（Enter 只切换当前
会话，Ctrl+S 持久化为默认），本地两级选择器需移植该语义：

- 构造函数参数顺序变为 `(tui, currentModel, modelRuntime, scopedModels, onSelect, onCancel, initialSearchInput?, onSelectAsDefault?, balanceService?)`；
  `settingsManager` 参数随上游删除，`handleSelect` 不再调用
  `setDefaultModelAndProvider`。
- Ctrl+S 只在 models 视图生效（providers 视图忽略），由
  `onSelectAsDefaultCallback` 回调 `session.setModel(model, { persist: true })`。
- 测试构造调用按新参数顺序修正（`model-selector.test.ts` 与三个
  suite/regressions 文件）。

其余文件（`agent-session.ts`、`settings-manager.ts`、`settings-selector.ts`、
`interactive-mode.ts`、`defaults.ts`、`model-resolver.ts`、`sdk.ts`、
`slash-commands.ts`、`thinking-selector.ts`、`packages/tui/.../settings-list.ts`）
自动合并成功：上游新增 `/thinking` 命令、`settings-submenu.ts`、每个模型思考级别
覆盖，本地三个 footer 开关与预设/余额接线均保留。

新增/受影响测试：`interactive-mode-status.test.ts`、
`agent-session-model-extension.test.ts`、`settings-selector.test.ts` 需要
`availableDefaultModels`/`defaultModel`/`modelThinkingLevels` 配置字段。

## 重点冲突处理顺序

1. `settings-manager.ts`、`main.ts`、`package-manager.ts` 的预设优先级和启动契约。
2. `model-selector.ts` 的上游目录刷新与本地两级状态机。
3. `footer.ts` 的 token/cache 统计、独立状态排序/过滤和右侧模型保留逻辑。
4. `settings-manager.ts`、`settings-selector.ts`、`interactive-mode.ts` 的三个 footer 开关及即时重绘。
5. `extensions/index.ts`、`interactive-mode.ts`、`agent-session.ts` 的接线和生命周期。
6. tests、CHANGELOG 和使用文档。

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
  test/settings-manager.test.ts \
  test/settings-selector.test.ts \
  test/interactive-mode-status.test.ts \
  test/suite/agent-session-model-extension.test.ts \
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

2026-08-26 对本次上游增量同步（`b7bb00b9` → `289080f0` 之上）完成：

- 定向 Vitest：`model-selector.test.ts`、`settings-selector.test.ts`、
  `settings-manager.test.ts`、`footer-width.test.ts`、三个 suite/regressions、
  `interactive-mode-status.test.ts`、`agent-session-model-extension.test.ts`、
  `plan-mode-extension.test.ts`、`built-in-plan-mode.test.ts` 全部通过。
- 根目录 `npm run check` 通过（Biome、固定依赖、ts-imports、shrinkwrap、install lock、
  `tsgo --noEmit`、browser smoke）。
- 根目录 `./test.sh` 隔离环境：sqlite-node 一个偶发 5s 超时（单独运行通过，与本次
  合并无关，`packages/session-backends` 无改动）；coding-agent 7 个 CLI 进程级测试
  失败（clipboard-image、session-file-invalid、session-id-readonly、
  startup-session-name、stdout-cleanliness），已在合并前 HEAD 工作树验证同样失败，
  属环境预存在问题。

2026-08-18 已对本次 footer 独立状态与设置改动完成：

- 定向 Vitest：`footer-data-provider.test.ts`、`footer-width.test.ts`、`settings-manager.test.ts`、`settings-selector.test.ts`，共 64 个用例全部通过。
- 根目录 `npm run check` 通过，包括 Biome、固定依赖、TypeScript import、shrinkwrap、install lock、`tsgo --noEmit` 和 browser smoke。
- 根目录 `npm run build` 通过，并重新生成当前全局 link 使用的 `packages/coding-agent/dist`。
- 本地 Pikit fork `/home/hy/project/pikit` 的 `npm run check` 通过。
- 180x32 tmux 实测本地 Pikit footer 显示 `T: 0 (0.0% cached) ↑ 0 ↓ 0 | preset:Tools | TPS -- | <provider balance>`；关闭 `Footer preset` 后该 segment 立即消失，重新启动并恢复设置后再次显示。

2026-08-14 对提交 `cbd1ef0` 和 `3120ee3` 曾完成两级模型选择、余额和两行 footer 的构建、link 与 tmux 验证；该历史结果不能替代本次未提交 footer 改动的手工验证。

## 文档维护检查

每次同步上游或修改本地功能时，同时更新：

- 本文基线日期与 `upstream/main`、`origin/main`、本地 `HEAD` SHA。
- 只记录作者 `lzy <nietzsche.li@outlook.com>` 的本地非 merge 提交；不要把上游提交总结为本地功能。
- Plan mode 的稳定 task ID、逐项执行、完成标记、持久化和恢复契约。
- 外部配置结构，但不写真实值。
- 冲突热点和回归测试命令。
- 构建、安装及实际 TUI 验证结果。
