import { getAgentDir } from "../config.ts";
import { loadExtensions } from "../core/extensions/loader.ts";
import type { ExtensionAPI, InlineExtension } from "../core/extensions/types.ts";
import { DefaultPackageManager } from "../core/package-manager.ts";
import {
	loadPresetsConfig,
	loadProjectPresetSelection,
	type ResolvedPreset,
	removeProjectPresetSelection,
	resolvePreset,
	writeProjectPresetSelection,
} from "../core/preset-manager.ts";
import { type PackageSource, SettingsManager } from "../core/settings-manager.ts";
import { loadSkills } from "../core/skills.ts";
import { resolvePath } from "../utils/paths.ts";

const BASE_LABEL = "Base";
const RESTART_SETTING_KEYS = [
	"sessionDir",
	"httpProxy",
	"defaultProjectTrust",
	"tuiMode",
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"enabledModels",
] as const;

function displayName(preset: ResolvedPreset): string {
	return preset.name ?? BASE_LABEL;
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function restartSettingsChanged(current: ResolvedPreset, target: ResolvedPreset): string[] {
	return RESTART_SETTING_KEYS.filter((key) => !sameValue(current.settings[key], target.settings[key]));
}

function resolveTargetName(value: string, names: string[]): string | null | undefined {
	if (value.toLowerCase() === BASE_LABEL.toLowerCase()) return null;
	return names.find((name) => name.toLowerCase() === value.toLowerCase());
}

function packageSource(entry: PackageSource): string {
	return typeof entry === "string" ? entry : entry.source;
}

async function validateTargetResources(options: {
	target: ResolvedPreset;
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}): Promise<void> {
	const { target, cwd, agentDir, projectTrusted } = options;
	const skillResult = loadSkills({
		cwd,
		agentDir,
		skillPaths: (target.settings.skills ?? []).map((path) => resolvePath(path, agentDir)),
		includeDefaults: false,
	});
	if (skillResult.diagnostics.length > 0) {
		throw new Error(skillResult.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
	}

	const targetSettings = SettingsManager.create(cwd, agentDir, {
		projectTrusted,
		cliPreset: target.name ?? BASE_LABEL,
	});
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager: targetSettings });
	const resolved = await packageManager.resolve(async () => "error");
	const targetPackages = new Set((target.settings.packages ?? []).map(packageSource));
	const resolvedTargetPackages = new Set(
		[resolved.extensions, resolved.skills, resolved.prompts, resolved.themes]
			.flat()
			.filter((resource) => resource.metadata.origin === "package" && targetPackages.has(resource.metadata.source))
			.map((resource) => resource.metadata.source),
	);
	for (const source of targetPackages) {
		if (!resolvedTargetPackages.has(source)) throw new Error(`Preset package is unavailable: ${source}`);
	}
	const extensionPaths = resolved.extensions
		.filter(
			(resource) =>
				resource.enabled &&
				(resource.metadata.source === "preset" ||
					(resource.metadata.origin === "package" && targetPackages.has(resource.metadata.source))),
		)
		.map((resource) => resource.path);
	const loaded = await loadExtensions(extensionPaths, cwd);
	loaded.runtime.invalidate("Preset resource preflight completed");
	if (loaded.errors.length > 0) {
		throw new Error(loaded.errors.map(({ error }) => error).join("; "));
	}
}

function restoreProjectSelection(cwd: string, selection: ReturnType<typeof loadProjectPresetSelection>): void {
	if (selection) {
		writeProjectPresetSelection(cwd, selection.preset);
	} else {
		removeProjectPresetSelection(cwd);
	}
}

export function createPresetExtension(cliPreset?: string): InlineExtension {
	return {
		name: "preset",
		hidden: true,
		factory: (pi: ExtensionAPI) => {
			const agentDir = getAgentDir();

			pi.on("session_start", (_event, ctx) => {
				const active = resolvePreset({ cwd: ctx.cwd, agentDir, cliPreset });
				ctx.ui.setStatus("preset", active ? `preset:${displayName(active)}` : undefined);
			});

			pi.registerCommand("preset", {
				description: "Show or switch the active preset",
				getArgumentCompletions: (prefix) => {
					const config = loadPresetsConfig(agentDir);
					if (!config) return null;
					const values = [BASE_LABEL, ...Object.keys(config.presets), "status"].filter((value) =>
						value.toLowerCase().startsWith(prefix.toLowerCase()),
					);
					return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
				},
				handler: async (args, ctx) => {
					const ui = ctx.ui;
					const config = loadPresetsConfig(agentDir);
					if (!config) {
						ui.notify(`No preset configuration found in ${agentDir}`, "warning");
						return;
					}

					const current = resolvePreset({ cwd: ctx.cwd, agentDir, cliPreset });
					if (!current) return;
					const rawArgument = args.trim();
					if (rawArgument.toLowerCase() === "status") {
						ui.notify(
							`${displayName(current)} (${current.source}); ${current.settings.skills?.length ?? 0} skills, ${
								current.mcpServerIds.length
							} MCP servers`,
							"info",
						);
						return;
					}

					const names = Object.keys(config.presets);
					const selectedLabel = rawArgument || (await ui.select("Select preset", [BASE_LABEL, ...names]));
					if (!selectedLabel) return;
					const selected = resolveTargetName(selectedLabel, names);
					if (selected === undefined) {
						ui.notify(
							`Unknown preset ${JSON.stringify(selectedLabel)}. Available: ${[BASE_LABEL, ...names].join(", ")}`,
							"error",
						);
						return;
					}

					const target = resolvePreset({
						cwd: ctx.cwd,
						agentDir,
						cliPreset: selected ?? BASE_LABEL,
						includeProjectSelection: false,
					});
					if (!target) return;
					try {
						await validateTargetResources({
							target,
							cwd: ctx.cwd,
							agentDir,
							projectTrusted: ctx.isProjectTrusted(),
						});
					} catch (error) {
						ui.notify(
							`Cannot switch to ${displayName(target)}: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
					const changedRestartSettings = restartSettingsChanged(current, target);
					const previousSelection = loadProjectPresetSelection(ctx.cwd);
					writeProjectPresetSelection(ctx.cwd, selected);

					if (cliPreset) {
						ui.notify(
							`Saved project preset ${displayName(target)}. --preset ${displayName(current)} remains active in this process.`,
							"info",
						);
						return;
					}

					if (changedRestartSettings.length > 0) {
						ui.notify(
							`Switching to ${displayName(target)}. Restart Pi to apply: ${changedRestartSettings.join(", ")}.`,
							"warning",
						);
					} else {
						ui.notify(`Switching to ${displayName(target)}...`, "info");
					}
					try {
						await ctx.reload();
					} catch (error) {
						restoreProjectSelection(ctx.cwd, previousSelection);
						try {
							await ctx.reload();
							ui.notify(
								`Preset switch failed; restored ${displayName(current)}: ${
									error instanceof Error ? error.message : String(error)
								}`,
								"error",
							);
						} catch (restoreError) {
							ui.notify(
								`Preset switch failed and the previous runtime could not be reloaded. The project selection was restored; restart Pi. ${
									restoreError instanceof Error ? restoreError.message : String(restoreError)
								}`,
								"error",
							);
						}
					}
				},
			});
		},
	};
}
