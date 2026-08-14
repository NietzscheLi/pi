import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import {
	loadMcpRegistry,
	loadProjectPresetSelection,
	removeProjectPresetSelection,
	resolvePreset,
	writeProjectPresetSelection,
} from "../src/core/preset-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function writeJson(path: string, value: unknown, mode = 0o644): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
	chmodSync(path, mode);
}

function writePresets(path: string, value: unknown): void {
	writeFileSync(path, stringify(value));
}

describe("preset manager", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-presets-"));
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	function createResource(name: string, fileName = "SKILL.md"): string {
		const path = join(agentDir, "resources", name);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, fileName), `${name}\n`);
		return `./resources/${name}`;
	}

	function writeMcpRegistry(mode = 0o600): void {
		writeJson(
			join(agentDir, "mcp-registry.json"),
			{
				version: 1,
				mcpServers: {
					memory: { command: "node", args: ["server.js"], lifecycle: "lazy" },
				},
			},
			mode,
		);
	}

	it("resolves resource ID anchors in preset selections", () => {
		const sharedSkill = createResource("shared-skill");
		writeMcpRegistry();
		writeFileSync(
			join(agentDir, "presets.yml"),
			`version: 1
resources:
  skills:
    &skill-shared shared: ${sharedSkill}
  mcp:
    - &mcp-memory memory
  packages:
    &package-lsp lsp: npm:@example/lsp@1.0.0
presets:
  Vue:
    enable:
      skills: [*skill-shared]
      mcp: [*mcp-memory]
      packages: [*package-lsp]
`,
		);

		const resolved = resolvePreset({ cwd: projectDir, agentDir, cliPreset: "Vue" });
		expect(resolved?.settings).toMatchObject({
			skills: [sharedSkill],
			packages: ["npm:@example/lsp@1.0.0"],
		});
		expect(resolved?.mcpServerIds).toEqual(["memory"]);
	});

	it("resolves CLI, project, default, and Base selections in priority order", () => {
		const baseSkill = createResource("base-skill");
		const vueSkill = createResource("vue-skill");
		writeMcpRegistry();
		writePresets(join(agentDir, "presets.yml"), {
			version: 1,
			defaultPreset: "Vue",
			resources: { skills: { base: baseSkill, vue: vueSkill } },
			base: {
				enable: { skills: ["base"], mcp: ["memory"] },
				settings: { theme: "base", retry: { enabled: true, maxRetries: 1 } },
			},
			presets: {
				Vue: { enable: { skills: ["vue"] }, settings: { theme: "vue", retry: { maxRetries: 2 } } },
				Tools: { disable: { skills: ["base"] }, settings: { theme: "tools" } },
			},
		});

		const defaultPreset = resolvePreset({ cwd: projectDir, agentDir });
		expect(defaultPreset).toMatchObject({ name: "Vue", source: "default", mcpServerIds: ["memory"] });
		expect(defaultPreset?.settings.skills).toEqual([baseSkill, vueSkill]);
		expect(defaultPreset?.settings.retry).toEqual({ enabled: true, maxRetries: 2 });

		writeProjectPresetSelection(projectDir, "Tools");
		const projectPreset = resolvePreset({ cwd: projectDir, agentDir });
		expect(projectPreset).toMatchObject({ name: "Tools", source: "project" });
		expect(projectPreset?.settings.skills).toBeUndefined();

		const cliPreset = resolvePreset({ cwd: projectDir, agentDir, cliPreset: "Vue" });
		expect(cliPreset).toMatchObject({ name: "Vue", source: "cli" });

		writeProjectPresetSelection(projectDir, null);
		const basePreset = resolvePreset({ cwd: projectDir, agentDir });
		expect(basePreset).toMatchObject({ name: undefined, source: "project" });
		expect(basePreset?.settings.theme).toBe("base");
		expect(loadProjectPresetSelection(projectDir)).toEqual({ version: 1, preset: null });
	});

	it("layers project and session settings over the selected preset while keeping project trust user-owned", async () => {
		writeJson(join(agentDir, "settings.json"), {
			theme: "global",
			defaultProjectTrust: "ask",
			retry: { enabled: false, baseDelayMs: 100 },
		});
		writeJson(join(projectDir, ".pi", "settings.json"), {
			theme: "project",
			defaultProjectTrust: "always",
			retry: { baseDelayMs: 200 },
		});
		writePresets(join(agentDir, "presets.yml"), {
			version: 1,
			base: {
				settings: { theme: "base", defaultProjectTrust: "never", retry: { enabled: true, maxRetries: 1 } },
			},
			presets: { Vue: { settings: { theme: "preset", retry: { maxRetries: 2 } } } },
		});
		writeProjectPresetSelection(projectDir, "Vue");

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getTheme()).toBe("project");
		expect(manager.getDefaultProjectTrust()).toBe("never");
		expect(manager.getRetrySettings()).toMatchObject({ enabled: true, maxRetries: 2, baseDelayMs: 200 });
		expect(manager.getResolvedPreset()).toMatchObject({ name: "Vue", source: "project" });

		manager.applyOverrides({ theme: "session" });
		expect(manager.getTheme()).toBe("session");
		writeProjectPresetSelection(projectDir, null);
		await manager.validateReload();
		await manager.reload();
		expect(manager.getTheme()).toBe("session");
		expect(manager.getResolvedPreset()).toMatchObject({ name: undefined, source: "project" });
	});

	it("rejects MCP registries that are not mode 0600", () => {
		writeMcpRegistry(0o644);
		expect(() => loadMcpRegistry(agentDir)).toThrow("must use mode 0600");
	});

	it("rejects missing resources and malformed MCP transports before activation", () => {
		writeJson(
			join(agentDir, "mcp-registry.json"),
			{ version: 1, mcpServers: { broken: { command: "node", url: "https://example.test/mcp" } } },
			0o600,
		);
		writePresets(join(agentDir, "presets.yml"), {
			version: 1,
			resources: { skills: { missing: "./does-not-exist" } },
			presets: { Broken: { enable: { skills: ["missing"], mcp: ["broken"] } } },
		});
		expect(() => resolvePreset({ cwd: projectDir, agentDir, cliPreset: "Broken" })).toThrow(
			"must define exactly one of command, socket, or url",
		);
	});

	it("conditionally enables a package while a matching global package remains installed but inactive", async () => {
		const packageDir = join(agentDir, "packages", "lsp");
		mkdirSync(packageDir, { recursive: true });
		writeJson(join(packageDir, "package.json"), {
			name: "test-lsp",
			type: "module",
			pi: { extensions: ["./index.ts"] },
		});
		writeFileSync(join(packageDir, "index.ts"), "export default function extension() {}\n");
		writeJson(join(agentDir, "settings.json"), {
			packages: [{ source: "./packages/lsp", autoload: false }],
		});
		writePresets(join(agentDir, "presets.yml"), {
			version: 1,
			resources: { packages: { lsp: "./packages/lsp" } },
			presets: { Vue: { enable: { packages: ["lsp"] } } },
		});
		writeProjectPresetSelection(projectDir, "Vue");

		const manager = SettingsManager.create(projectDir, agentDir);
		const packageManager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: manager });
		const active = await packageManager.resolve();
		expect(active.extensions.filter((entry) => entry.enabled).map((entry) => entry.path)).toEqual([
			join(packageDir, "index.ts"),
		]);

		writeProjectPresetSelection(projectDir, null);
		await manager.reload();
		const base = await packageManager.resolve();
		expect(base.extensions.filter((entry) => entry.enabled)).toEqual([]);
	});

	it("orders selected preset resources ahead of explicit global resources", async () => {
		const globalSkill = createResource("global-skill");
		const presetSkill = createResource("preset-skill");
		writeJson(join(agentDir, "settings.json"), { skills: [globalSkill] });
		writePresets(join(agentDir, "presets.yml"), {
			version: 1,
			resources: { skills: { preset: presetSkill } },
			presets: { Vue: { enable: { skills: ["preset"] } } },
		});
		writeProjectPresetSelection(projectDir, "Vue");

		const manager = SettingsManager.create(projectDir, agentDir);
		const packageManager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: manager });
		const resolved = await packageManager.resolve();
		const selectedResources = resolved.skills.filter((entry) =>
			[globalSkill, presetSkill].some((path) => entry.path.startsWith(join(agentDir, path))),
		);

		expect(selectedResources.map((entry) => entry.metadata.source)).toEqual(["preset", "local"]);
	});

	it("writes project selections without changing the user preset library", () => {
		writePresets(join(agentDir, "presets.yml"), { version: 1, presets: { Vue: {} } });
		const before = readFileSync(join(agentDir, "presets.yml"), "utf-8");
		const path = writeProjectPresetSelection(projectDir, "Vue");

		expect(path).toBe(join(projectDir, ".pi", "preset.json"));
		expect(loadProjectPresetSelection(projectDir)).toEqual({ version: 1, preset: "Vue" });
		expect(readFileSync(join(agentDir, "presets.yml"), "utf-8")).toBe(before);

		removeProjectPresetSelection(projectDir);
		expect(loadProjectPresetSelection(projectDir)).toBeUndefined();
		expect(readFileSync(join(agentDir, "presets.yml"), "utf-8")).toBe(before);
	});
});
