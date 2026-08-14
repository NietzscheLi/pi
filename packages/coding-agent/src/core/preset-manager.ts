import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { PackageSource, Settings } from "./settings-manager.ts";

export const PRESETS_FILE_NAME = "presets.json";
export const MCP_REGISTRY_FILE_NAME = "mcp-registry.json";
export const PROJECT_PRESET_FILE_NAME = "preset.json";

export interface PresetResourceSelection {
	skills?: string[];
	mcp?: string[];
	extensions?: string[];
	packages?: string[];
}

export interface PresetLayer {
	enable?: PresetResourceSelection;
	disable?: PresetResourceSelection;
	settings?: Partial<Settings>;
}

export interface PresetResourceRegistry {
	skills?: Record<string, string>;
	extensions?: Record<string, string>;
	packages?: Record<string, PackageSource>;
}

export interface PresetsConfig {
	version: 1;
	defaultPreset?: string;
	resources?: PresetResourceRegistry;
	base?: PresetLayer;
	presets: Record<string, PresetLayer>;
}

export interface McpRegistry {
	version: 1;
	mcpServers: Record<string, Record<string, unknown>>;
	settings?: Record<string, unknown>;
}

export interface ProjectPresetSelection {
	version: 1;
	preset: string | null;
}

export interface ResolvedPreset {
	name?: string;
	source: "cli" | "project" | "default" | "base";
	settings: Partial<Settings>;
	mcpServerIds: string[];
	config: PresetsConfig;
}

export interface ResolvePresetOptions {
	cwd: string;
	agentDir: string;
	cliPreset?: string;
	includeProjectSelection?: boolean;
}

const RESOURCE_KEYS = ["skills", "mcp", "extensions", "packages"] as const;
const MCP_LIFECYCLES = new Set(["keep-alive", "lazy", "lazy-keep-alive", "eager"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read preset configuration ${path}: ${message}`);
	}
}

function assertKnownFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw new Error(`Invalid preset configuration: unknown field ${field}.${key}`);
		}
	}
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
		throw new Error(`Invalid preset configuration: ${field} must be an array of non-empty strings`);
	}
}

function validateSelection(value: unknown, field: string): PresetResourceSelection | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(`Invalid preset configuration: ${field} must be an object`);
	}
	for (const key of Object.keys(value)) {
		if (!RESOURCE_KEYS.includes(key as (typeof RESOURCE_KEYS)[number])) {
			throw new Error(`Invalid preset configuration: unknown field ${field}.${key}`);
		}
		assertStringArray(value[key], `${field}.${key}`);
	}
	return value as PresetResourceSelection;
}

function validateLayer(value: unknown, field: string): PresetLayer {
	if (!isRecord(value)) {
		throw new Error(`Invalid preset configuration: ${field} must be an object`);
	}
	for (const key of Object.keys(value)) {
		if (key !== "enable" && key !== "disable" && key !== "settings") {
			throw new Error(`Invalid preset configuration: unknown field ${field}.${key}`);
		}
	}
	const enable = validateSelection(value.enable, `${field}.enable`);
	const disable = validateSelection(value.disable, `${field}.disable`);
	if (value.settings !== undefined && !isRecord(value.settings)) {
		throw new Error(`Invalid preset configuration: ${field}.settings must be an object`);
	}
	return {
		...(enable ? { enable } : {}),
		...(disable ? { disable } : {}),
		...(value.settings ? { settings: value.settings as Partial<Settings> } : {}),
	};
}

function validateStringRegistry(value: unknown, field: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(`Invalid preset configuration: ${field} must be an object`);
	}
	for (const [id, path] of Object.entries(value)) {
		if (!id || typeof path !== "string" || path.trim().length === 0) {
			throw new Error(`Invalid preset configuration: ${field} entries must map non-empty IDs to paths`);
		}
	}
	return value as Record<string, string>;
}

function validatePackageRegistry(value: unknown): Record<string, PackageSource> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error("Invalid preset configuration: resources.packages must be an object");
	}
	for (const [id, entry] of Object.entries(value)) {
		if (!id || (typeof entry !== "string" && !isRecord(entry))) {
			throw new Error("Invalid preset configuration: resources.packages contains an invalid entry");
		}
		if (isRecord(entry) && typeof entry.source !== "string") {
			throw new Error(`Invalid preset configuration: resources.packages.${id}.source must be a string`);
		}
	}
	return value as Record<string, PackageSource>;
}

function validateMcpServer(name: string, definition: Record<string, unknown>, path: string): void {
	const transports = ["command", "socket", "url"].filter(
		(key) => typeof definition[key] === "string" && definition[key].trim().length > 0,
	);
	if (transports.length !== 1) {
		throw new Error(
			`Invalid preset MCP registry ${path}: ${name} must define exactly one of command, socket, or url`,
		);
	}
	if (definition.args !== undefined && !Array.isArray(definition.args)) {
		throw new Error(`Invalid preset MCP registry ${path}: ${name}.args must be an array`);
	}
	if (Array.isArray(definition.args) && definition.args.some((value) => typeof value !== "string")) {
		throw new Error(`Invalid preset MCP registry ${path}: ${name}.args must contain only strings`);
	}
	for (const field of ["env", "headers"] as const) {
		const value = definition[field];
		if (
			value !== undefined &&
			(!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string"))
		) {
			throw new Error(`Invalid preset MCP registry ${path}: ${name}.${field} must contain only string values`);
		}
	}
	if (
		definition.lifecycle !== undefined &&
		(typeof definition.lifecycle !== "string" || !MCP_LIFECYCLES.has(definition.lifecycle))
	) {
		throw new Error(`Invalid preset MCP registry ${path}: ${name}.lifecycle is invalid`);
	}
}

export function loadPresetsConfig(agentDir: string): PresetsConfig | undefined {
	const path = join(resolvePath(agentDir), PRESETS_FILE_NAME);
	if (!existsSync(path)) return undefined;
	const raw = readJsonFile(path);
	if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.presets)) {
		throw new Error(`Invalid preset configuration ${path}: expected version 1 with a presets object`);
	}
	assertKnownFields(raw, ["version", "defaultPreset", "resources", "base", "presets"], "root");
	if (raw.defaultPreset !== undefined && typeof raw.defaultPreset !== "string") {
		throw new Error(`Invalid preset configuration ${path}: defaultPreset must be a string`);
	}
	if (raw.resources !== undefined && !isRecord(raw.resources)) {
		throw new Error(`Invalid preset configuration ${path}: resources must be an object`);
	}

	const resources = raw.resources as Record<string, unknown> | undefined;
	if (resources) {
		for (const key of Object.keys(resources)) {
			if (key !== "skills" && key !== "extensions" && key !== "packages") {
				throw new Error(`Invalid preset configuration ${path}: unknown resources field ${key}`);
			}
		}
	}

	const presets: Record<string, PresetLayer> = {};
	for (const [name, value] of Object.entries(raw.presets)) {
		if (!name.trim()) throw new Error(`Invalid preset configuration ${path}: preset names cannot be empty`);
		presets[name] = validateLayer(value, `presets.${name}`);
	}
	const config: PresetsConfig = {
		version: 1,
		...(raw.defaultPreset ? { defaultPreset: raw.defaultPreset } : {}),
		resources: {
			skills: validateStringRegistry(resources?.skills, "resources.skills"),
			extensions: validateStringRegistry(resources?.extensions, "resources.extensions"),
			packages: validatePackageRegistry(resources?.packages),
		},
		...(raw.base === undefined ? {} : { base: validateLayer(raw.base, "base") }),
		presets,
	};

	if (config.defaultPreset && !config.presets[config.defaultPreset]) {
		throw new Error(`Invalid preset configuration ${path}: unknown default preset ${config.defaultPreset}`);
	}
	const layers: Array<[string, PresetLayer | undefined]> = [["base", config.base], ...Object.entries(config.presets)];
	const referencedMcpServers = new Set<string>();
	for (const [name, layer] of layers) {
		if (!layer) continue;
		for (const key of ["skills", "extensions", "packages"] as const) {
			for (const id of [...(layer.enable?.[key] ?? []), ...(layer.disable?.[key] ?? [])]) {
				const registry = config.resources?.[key];
				if (!registry?.[id]) {
					throw new Error(
						`Invalid preset configuration ${path}: ${name} references unknown ${key} resource ${id}`,
					);
				}
			}
		}
		for (const id of [...(layer.enable?.mcp ?? []), ...(layer.disable?.mcp ?? [])]) {
			referencedMcpServers.add(id);
		}
	}
	if (referencedMcpServers.size > 0) {
		const registry = loadMcpRegistry(agentDir);
		for (const id of referencedMcpServers) {
			if (!registry.mcpServers[id]) {
				throw new Error(`Invalid preset configuration ${path}: references unknown MCP server ${id}`);
			}
		}
	}
	return config;
}

export function loadMcpRegistry(agentDir: string): McpRegistry {
	const path = join(resolvePath(agentDir), MCP_REGISTRY_FILE_NAME);
	if (!existsSync(path)) {
		throw new Error(`Preset MCP registry not found: ${path}`);
	}
	const stats = statSync(path);
	if (!stats.isFile()) {
		throw new Error(`Preset MCP registry must be a file: ${path}`);
	}
	if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
		throw new Error(`Preset MCP registry has invalid permissions: ${path} must use mode 0600`);
	}
	const raw = readJsonFile(path);
	if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.mcpServers)) {
		throw new Error(`Invalid preset MCP registry ${path}: expected version 1 with an mcpServers object`);
	}
	for (const key of Object.keys(raw)) {
		if (key !== "version" && key !== "mcpServers" && key !== "settings") {
			throw new Error(`Invalid preset MCP registry ${path}: unknown field ${key}`);
		}
	}
	if (raw.settings !== undefined && !isRecord(raw.settings)) {
		throw new Error(`Invalid preset MCP registry ${path}: settings must be an object`);
	}
	const mcpServers: Record<string, Record<string, unknown>> = {};
	for (const [name, definition] of Object.entries(raw.mcpServers)) {
		if (!name.trim() || !isRecord(definition)) {
			throw new Error(`Invalid preset MCP registry ${path}: server entries must be named objects`);
		}
		validateMcpServer(name, definition, path);
		mcpServers[name] = definition;
	}
	return {
		version: 1,
		mcpServers,
		...(raw.settings ? { settings: raw.settings } : {}),
	};
}

export function loadProjectPresetSelection(cwd: string): ProjectPresetSelection | undefined {
	const path = join(resolvePath(cwd), CONFIG_DIR_NAME, PROJECT_PRESET_FILE_NAME);
	if (!existsSync(path)) return undefined;
	const raw = readJsonFile(path);
	if (
		!isRecord(raw) ||
		raw.version !== 1 ||
		(raw.preset !== null && (typeof raw.preset !== "string" || !raw.preset.trim()))
	) {
		throw new Error(`Invalid project preset selection ${path}: preset must be a non-empty string or null for Base`);
	}
	return { version: 1, preset: raw.preset };
}

function mergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) continue;
		const baseValue = base[key];
		merged[key] = isRecord(baseValue) && isRecord(value) ? mergeObjects(baseValue, value) : value;
	}
	return merged;
}

function combineIds(
	base: string[] | undefined,
	layer: PresetLayer | undefined,
	key: keyof PresetResourceSelection,
): string[] {
	const enabled = new Set(base ?? []);
	for (const id of layer?.enable?.[key] ?? []) enabled.add(id);
	for (const id of layer?.disable?.[key] ?? []) enabled.delete(id);
	return [...enabled];
}

function resolveRegistryEntries<T>(ids: string[], registry: Record<string, T> | undefined, field: string): T[] {
	return ids.map((id) => {
		const value = registry?.[id];
		if (value === undefined) throw new Error(`Preset references unknown ${field} resource ${id}`);
		return structuredClone(value);
	});
}

function validateResourcePaths(paths: string[], agentDir: string, field: string): void {
	for (const path of paths) {
		const resolved = resolvePath(path, agentDir);
		if (!existsSync(resolved)) {
			throw new Error(`Preset ${field} resource not found: ${resolved}`);
		}
	}
}

export function resolvePreset(options: ResolvePresetOptions): ResolvedPreset | undefined {
	const config = loadPresetsConfig(options.agentDir);
	if (!config) {
		if (options.cliPreset)
			throw new Error(`--preset requires ${join(resolvePath(options.agentDir), PRESETS_FILE_NAME)}`);
		return undefined;
	}

	const selection = options.includeProjectSelection === false ? undefined : loadProjectPresetSelection(options.cwd);
	const cliSelectsBase = options.cliPreset?.toLowerCase() === "base";
	const name = options.cliPreset
		? cliSelectsBase
			? undefined
			: options.cliPreset
		: selection
			? (selection.preset ?? undefined)
			: config.defaultPreset;
	const source = options.cliPreset ? "cli" : selection ? "project" : config.defaultPreset ? "default" : "base";
	const layer = name ? config.presets[name] : undefined;
	if (name && !layer) {
		throw new Error(`Unknown preset ${JSON.stringify(name)}. Available: ${Object.keys(config.presets).join(", ")}`);
	}

	const base = config.base;
	const skillIds = combineIds(combineIds(undefined, base, "skills"), layer, "skills");
	const extensionIds = combineIds(combineIds(undefined, base, "extensions"), layer, "extensions");
	const packageIds = combineIds(combineIds(undefined, base, "packages"), layer, "packages");
	const mcpServerIds = combineIds(combineIds(undefined, base, "mcp"), layer, "mcp");
	const settings = mergeObjects(
		(base?.settings ?? {}) as Record<string, unknown>,
		(layer?.settings ?? {}) as Record<string, unknown>,
	) as Partial<Settings>;

	const presetSettings: Partial<Settings> = {
		...settings,
		...(skillIds.length > 0 ? { skills: resolveRegistryEntries(skillIds, config.resources?.skills, "skills") } : {}),
		...(extensionIds.length > 0
			? { extensions: resolveRegistryEntries(extensionIds, config.resources?.extensions, "extensions") }
			: {}),
		...(packageIds.length > 0
			? { packages: resolveRegistryEntries(packageIds, config.resources?.packages, "packages") }
			: {}),
	};
	validateResourcePaths((presetSettings.skills ?? []) as string[], options.agentDir, "skill");
	validateResourcePaths((presetSettings.extensions ?? []) as string[], options.agentDir, "extension");
	return { name, source, settings: presetSettings, mcpServerIds, config };
}

export function writeProjectPresetSelection(cwd: string, preset: string | null): string {
	const path = join(resolvePath(cwd), CONFIG_DIR_NAME, PROJECT_PRESET_FILE_NAME);
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const lockPath = `${path}.lock`;
	const release = lockfile.lockSync(dir, { realpath: false, lockfilePath: lockPath });
	const tempPath = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify({ version: 1, preset }, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o644,
		});
		renameSync(tempPath, path);
		return path;
	} finally {
		rmSync(tempPath, { force: true });
		release();
	}
}

export function removeProjectPresetSelection(cwd: string): void {
	const path = join(resolvePath(cwd), CONFIG_DIR_NAME, PROJECT_PRESET_FILE_NAME);
	if (!existsSync(path)) return;
	const release = lockfile.lockSync(dirname(path), { realpath: false, lockfilePath: `${path}.lock` });
	try {
		rmSync(path, { force: true });
	} finally {
		release();
	}
}
