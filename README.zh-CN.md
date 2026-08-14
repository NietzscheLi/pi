<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 新贡献者提交的新 Issue 和 PR 默认会自动关闭，维护者每天会审核自动关闭的 Issue。详情请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

# Pi monorepo

Pi 是一个简洁、可扩展的编码代理框架，以及驱动它运行的 TypeScript 库集合。本仓库包含终端编码代理、统一的 LLM API、代理运行时、终端 UI 组件，以及实验性的远程会话软件包。

Pi 鼓励通过[扩展](packages/coding-agent/docs/extensions.md)、[技能](packages/coding-agent/docs/skills.md)、[提示模板](packages/coding-agent/docs/prompt-templates.md)、[主题](packages/coding-agent/docs/themes.md)和 [Pi Packages](packages/coding-agent/docs/packages.md) 进行定制，而不是修改或 fork 核心代码。

## 使用编码代理

从 npm 安装 CLI：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

配置 API key，或在 Pi 中运行 `/login` 使用受支持的订阅服务。有关 provider 配置、CLI 模式、定制方式和平台说明，请参阅 [coding-agent README](packages/coding-agent/README.md)。

## 软件包

| 软件包 | 说明 |
|---------|-------------|
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式编码代理 CLI，支持会话、工具、扩展、技能以及 SDK/RPC 模式 |
| **[@earendil-works/pi-agent-core](packages/agent)** | 通用代理运行时，提供传输抽象、状态管理和附件支持 |
| **[@earendil-works/pi-ai](packages/ai)** | 统一的 LLM API，支持自动发现模型和配置 provider |
| **[@earendil-works/pi-tui](packages/tui)** | 支持差分渲染的终端 UI 库 |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | 与厂商无关的 telemetry 契约和类型化 schema 工具 |
| **[@earendil-works/pi-protocol](packages/protocol)** | 实验性的、与运行时无关的远程 Pi 会话 CBOR 协议 |
| **[@earendil-works/pi-client](packages/client)** | 基于带帧 CBOR 的远程 Pi 会话传输无关客户端 |
| **[@earendil-works/pi-server](packages/server)** | 远程 Pi 会话服务端核心和 Unix 传输实现 |
| **[@earendil-works/pi-session-backend-sqlite-node](packages/session-backends/sqlite-node)** | 面向 agent-core 会话的 Node SQLite 后端 |
| **[@earendil-works/pi-evals](packages/evals)** | 面向编码代理工作流的评估工具 |

远程会话相关软件包目前处于实验阶段。协议、传输和服务集成方式请阅读对应软件包的 README。

了解更多 Pi 信息：

* [访问 pi.dev](https://pi.dev)，查看项目网站和演示
* [阅读在线文档](https://pi.dev/docs/latest)
* [阅读 coding-agent 文档](packages/coding-agent/docs/index.md)

## 权限与容器化

Pi 没有内置的权限系统来限制文件系统、进程、网络或凭据访问。默认情况下，Pi 具有启动它的用户和进程所拥有的权限。请将模型生成的命令和工具调用视为具有与 Pi 相同的访问权限。

如果需要更强的隔离，请对 Pi 进行容器化或沙箱化。详见[容器化文档](packages/coding-agent/docs/containerization.md)，其中介绍了三种方案：

- **Gondolin 扩展**：将 Pi 和 provider 身份验证保留在宿主机上，同时把内置工具和 `!` 命令路由到本地 Linux micro-VM。
- **普通 Docker**：将整个 Pi 进程运行在本地容器中，配置简单。
- **OpenShell**：在受策略控制的沙箱中运行整个 Pi 进程。

## 贡献

贡献指南请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，项目级规则请参阅 [AGENTS.md](AGENTS.md)。各软件包的 README 和 [coding-agent 文档](packages/coding-agent/docs/index.md)中记录了对应的 API 与行为。Pi 的长期规划请参阅 [RFCs](https://rfc.earendil.com/keyword/pi/)。

## 开发

Pi 要求 Node.js `>=22.19.0`。

```bash
npm install --ignore-scripts  # 安装依赖，但不运行生命周期脚本
npm run build                # 构建所有软件包并刷新模型数据
npm run build:offline        # 使用现有模型数据构建
npm run check                # 格式化、Lint 和类型检查
./test.sh                    # 运行非 e2e 测试套件
./pi-test.sh                 # 从源码运行编码代理
```

本仓库使用 npm workspaces。可以通过 `npm --prefix packages/<package> ...` 执行指定软件包的命令。编码代理的开发细节请参阅 [packages/coding-agent/docs/development.md](packages/coding-agent/docs/development.md)。

## 从发布源码构建独立二进制文件

GitHub Release 会提供带版本号的源码压缩包，并在 `SHA256SUMS` 文件中提供校验和。解压后，运行官方独立二进制文件使用的相同构建脚本：

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

源码压缩包包含该版本发布所使用的 provider 模型数据。`--offline-model-data` 会使用这份快照，而不会从在线 provider 目录刷新数据。脚本仍会安装依赖、构建 monorepo、编译 Bun 可执行文件并准备运行时资源。需要单独提供依赖的软件包维护者可以传入 `--skip-install --skip-deps`。

## 供应链安全

我们将 npm 依赖变更视为需要审查的代码变更。

- 外部直接依赖固定为精确版本，内部 workspace 软件包仍使用版本范围。
- `.npmrc` 设置 `save-exact=true` 和 `min-release-age=2`，避免安装当天刚发布的依赖。
- `package-lock.json` 是依赖的事实来源。提交前检查会阻止意外提交 lockfile，除非设置 `PI_ALLOW_LOCKFILE_CHANGE=1`。
- `npm run check` 会检查直接依赖版本固定、TypeScript 原生 import 兼容性，以及生成的 coding-agent shrinkwrap。
- 发布的 CLI 软件包包含 `packages/coding-agent/npm-shrinkwrap.json`，它由根目录 lockfile 生成，用于固定 npm 用户安装时的传递依赖版本。
- 发布 smoke test 使用 `npm run release:local`，在打 tag 前构建、打包，并在仓库外创建隔离的 npm 和 Bun 安装环境。
- 本地发布安装、文档中的 npm 安装以及 `pi update --self` 在支持时都会使用 `--ignore-scripts`。
- CI 使用 `npm ci --ignore-scripts` 安装依赖，定时 GitHub workflow 会运行 `npm audit --omit=dev` 和 `npm audit signatures --omit=dev`。
- shrinkwrap 生成器包含生命周期脚本依赖的明确 allowlist。新增此类依赖前必须经过审查，否则检查会失败。

## 分享开源编码代理会话

如果你使用 Pi 或其他编码代理进行开源项目开发，欢迎分享会话。

公开的开源项目会话可以帮助改进编码代理的模型、提示词、工具和评估，并且来源于真实的开发工作流。

完整说明请参阅 [X 上的介绍文章](https://x.com/badlogicgames/status/2037811643774652911)。

发布会话可以使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。请先阅读它的 README。你只需要 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

也可以观看[演示视频](https://x.com/badlogicgames/status/2041151967695634619)，了解如何发布 `pi-mono` 会话。

我会定期在这里发布自己的 `pi-mono` 工作会话：

- [Hugging Face 上的 badlogicgames/pi-mono](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 许可证

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a> 慷慨捐赠
</p>
