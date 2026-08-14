# Presets

Presets switch a named set of settings, skills, extensions, packages, and MCP server IDs. They are user-owned configuration: project files select a preset but do not copy the preset library or private MCP definitions.

## Files

| Location | Purpose |
|----------|---------|
| `~/.pi/agent/presets.yml` | User preset library and resource registry |
| `~/.pi/agent/mcp-registry.json` | Private MCP server definitions; mode `0600` on POSIX |
| `.pi/preset.json` | Project selection written by Pi |

Pi treats `Base` as a built-in selection. It applies the `base` layer without a named preset.

## Selecting a Preset

When `presets.yml` exists and defines named presets, and a project has no selection, interactive startup asks for one and writes `.pi/preset.json`. Use these commands later:

```text
/preset              # choose and persist a project preset
/preset Vue          # switch and persist directly
/preset Base         # use only the Base layer
/preset status       # show the active source and resource counts
```

Use `--preset` for a process-only override:

```bash
pi --preset Vue
```

The selection order is:

1. `--preset <name>`
2. `.pi/preset.json`
3. `defaultPreset` in `presets.yml`
4. `Base`

While `--preset` is active, `/preset` can update the saved project selection, but the CLI selection remains active until the process exits.

## Configuration

```yaml
version: 1
resources:
  skills:
    vue: ./preset-resources/skills/vue
  extensions:
    mcp-web: ./preset-runtime/web.ts
  packages:
    lsp: npm:@example/pi-lsp@1.0.0
base:
  settings:
    theme: dark
presets:
  Vue:
    enable:
      skills: [vue]
      extensions: [mcp-web]
      packages: [lsp]
      mcp: [context7]
    settings:
      defaultThinkingLevel: medium
```

Every named resource must exist in the matching registry. `disable` accepts the same keys as `enable` and removes inherited Base resources:

```yaml
presets:
  Minimal:
    disable:
      skills: [vue]
      packages: [lsp]
```

Settings are merged in this order, from lowest to highest precedence:

1. `~/.pi/agent/settings.json`
2. preset `base.settings`
3. named preset `settings`
4. `.pi/settings.json`
5. explicit CLI options

Nested setting objects are merged. Project resources take precedence over preset resources, which take precedence over other user resources when names collide.

## MCP Registry

MCP definitions are kept separate so project selection files never contain credentials:

```json
{
  "version": 1,
  "mcpServers": {
    "context7": {
      "url": "https://mcp.example.com/mcp",
      "lifecycle": "lazy"
    }
  }
}
```

On POSIX systems, protect the file before starting Pi:

```bash
chmod 600 ~/.pi/agent/mcp-registry.json
```

Pi validates selected MCP IDs and registry transport fields. Pi does not include an MCP client; enable an MCP adapter extension or package in the same preset to consume those definitions.

## Reload and Failure Behavior

`/preset` preflights target skills, packages, and extensions before changing the project selection. A validation or extension-load failure leaves the current preset selected. A successful switch reloads extensions, skills, prompts, themes, context files, and runtime settings.

Settings bound to process startup produce a restart notice. These include session storage, proxy configuration, project-trust defaults, startup TUI mode, and default model or thinking selection.
