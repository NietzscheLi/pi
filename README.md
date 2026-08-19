<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi monorepo

Pi is a minimal, extensible coding-agent harness and the TypeScript libraries that power it. This repository contains the terminal agent, a provider-neutral LLM API, the agent runtime, terminal UI components, and experimental remote-session packages.

## Fork and upstream differences

This is a fork of [earendil-works/pi](https://github.com/earendil-works/pi). See [Upstream differences](docs/upstream-differences.md) for this fork's long-lived local changes, their behavioral contracts, and guidance for synchronizing future upstream updates, resolving conflicts, and running regression checks.

Chinese documentation is available in [README.zh-CN.md](README.zh-CN.md).

Pi is designed to be adapted through [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), [themes](packages/coding-agent/docs/themes.md), and [Pi packages](packages/coding-agent/docs/packages.md), rather than by forking the core.

## Use the coding agent

Install the CLI from npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

Authenticate with an API key or run `/login` inside Pi to use a supported subscription. See the [coding-agent README](packages/coding-agent/README.md) for provider setup, CLI modes, customization, and platform notes.

## Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding-agent CLI with sessions, tools, extensions, skills, and SDK/RPC modes |
| **[@earendil-works/pi-agent-core](packages/agent)** | General-purpose agent runtime with transport abstraction, state management, and attachments |
| **[@earendil-works/pi-ai](packages/ai)** | Unified LLM API with automatic model discovery and provider configuration |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts and typed schema utilities |
| **[@earendil-works/pi-protocol](packages/protocol)** | Experimental runtime-neutral CBOR protocol for remote Pi sessions |
| **[@earendil-works/pi-client](packages/client)** | Transport-neutral client for remote Pi sessions over framed CBOR |
| **[@earendil-works/pi-server](packages/server)** | Server core and Unix transport for remote Pi sessions |
| **[@earendil-works/pi-session-backend-sqlite-node](packages/session-backends/sqlite-node)** | Node SQLite session backend for agent-core sessions |
| **[@earendil-works/pi-evals](packages/evals)** | Evaluation tools for coding-agent workflows |

The remote-session packages are experimental. Read their package READMEs for protocol, transport, and service integration details.

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest)
* [Read the coding-agent documentation](packages/coding-agent/docs/index.md)

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it. Treat model-generated commands and tool calls as having the same access as Pi itself.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules. Package APIs and behavior are documented in each package's README and in the [coding-agent documentation](packages/coding-agent/docs/index.md). Longer-term plans for Pi can be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install dependencies without lifecycle scripts
npm run build                # Build all packages and refresh model data
npm run build:offline        # Build with the existing model data
npm run check                # Format, lint, and type check
./test.sh                    # Run the non-e2e test suite
./pi-test.sh                 # Run the coding agent from source
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
