import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { getAgentDir } from "../config.ts";
import { BALANCE_CONFIG_FILE_NAME } from "./default-config.ts";

type JsonObject = Record<string, unknown>;

export interface ProviderBalanceState {
	text: string;
	loading: boolean;
	error?: string;
	updatedAt?: number;
}

export interface ProviderBalanceSource {
	baseUrl?: string;
	apiKey?: string;
}

export interface ProviderBalanceRefreshOptions {
	force?: boolean;
	resolveSource?: () => Promise<ProviderBalanceSource>;
}

export interface ProviderBalanceReader {
	get(providerName: string): ProviderBalanceState;
	refresh(providerName: string, options?: ProviderBalanceRefreshOptions): Promise<ProviderBalanceState>;
	subscribe(listener: (providerName: string, state: ProviderBalanceState) => void): () => void;
}

interface ProviderBalanceServiceOptions {
	agentDir?: string;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
}

const DEFAULT_REFRESH_INTERVAL_MINUTES = 5;
const EMPTY_BALANCE: ProviderBalanceState = { text: "--", loading: false };

export function formatProviderBalance(state: ProviderBalanceState): string {
	if (state.loading) return `${state.text} (refreshing…)`;
	if (state.error && state.text === "--") return "unavailable";
	if (state.error) return `${state.text} (stale)`;
	return state.text;
}

function valueAt(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((current, key) => {
		if (!current || typeof current !== "object") return undefined;
		if (Array.isArray(current)) {
			const index = Number(key);
			return Number.isInteger(index) && index >= 0 ? current[index] : undefined;
		}
		return (current as JsonObject)[key];
	}, value);
}

function objectAt(value: unknown, path: string): JsonObject | undefined {
	const result = valueAt(value, path);
	return result && typeof result === "object" && !Array.isArray(result) ? (result as JsonObject) : undefined;
}

function objectValue(value: unknown, key: string): JsonObject | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result = (value as JsonObject)[key];
	return result && typeof result === "object" && !Array.isArray(result) ? (result as JsonObject) : undefined;
}

function stringValue(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Balance configuration is missing ${name}`);
	return value;
}

function numberValue(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const result = Number(value);
	return Number.isFinite(result) ? result : null;
}

function readYaml(path: string): JsonObject {
	const value: unknown = parse(readFileSync(path, "utf8"), { merge: true });
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Balance configuration ${path} must contain an object`);
	}
	return value as JsonObject;
}

function interpolate(value: string, variables: Record<string, string>): string {
	return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
		const replacement = variables[name];
		if (!replacement) throw new Error(`Balance configuration is missing ${name}`);
		return replacement;
	});
}

function interpolateValue(value: unknown, variables: Record<string, string>): unknown {
	if (typeof value === "string") return interpolate(value, variables);
	if (Array.isArray(value)) return value.map((item) => interpolateValue(item, variables));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as JsonObject).map(([key, item]) => [key, interpolateValue(item, variables)]),
		);
	}
	return value;
}

function mergeConfig(profile: JsonObject | undefined, provider: JsonObject): JsonObject {
	return {
		...(profile ?? {}),
		...provider,
		headers: { ...(objectAt(profile, "headers") ?? {}), ...(objectAt(provider, "headers") ?? {}) },
		validity: { ...(objectAt(profile, "validity") ?? {}), ...(objectAt(provider, "validity") ?? {}) },
	};
}

function isValidResponse(body: unknown, extractor: JsonObject): boolean {
	const validity = objectAt(extractor, "validity");
	if (!validity) return true;

	if (Array.isArray(validity.allTruthy)) {
		return validity.allTruthy.every((path) => typeof path === "string" && Boolean(valueAt(body, path)));
	}
	if (Array.isArray(validity.firstDefined)) {
		for (const path of validity.firstDefined) {
			if (typeof path !== "string") continue;
			const value = valueAt(body, path);
			if (value !== undefined) return Boolean(value);
		}
		return validity.fallback === undefined ? true : Boolean(validity.fallback);
	}
	if (typeof validity.path === "string") {
		const value = valueAt(body, validity.path);
		return value === undefined ? Boolean(validity.fallback) : Boolean(value);
	}
	return validity.fallback === undefined ? true : Boolean(validity.fallback);
}

function responseError(body: unknown, extractor: JsonObject): string {
	if (typeof extractor.errorPath === "string") {
		const message = valueAt(body, extractor.errorPath);
		if (typeof message === "string" && message) return message;
	}
	return typeof extractor.errorFallback === "string" && extractor.errorFallback
		? extractor.errorFallback
		: "Balance query failed";
}

export class ProviderBalanceService implements ProviderBalanceReader {
	private readonly agentDir: string | undefined;
	private readonly fetch: typeof globalThis.fetch;
	private readonly now: () => number;
	private readonly balances = new Map<string, ProviderBalanceState>();
	private readonly pendingQueries = new Map<string, Promise<ProviderBalanceState>>();
	private readonly listeners = new Set<(providerName: string, state: ProviderBalanceState) => void>();

	constructor(options: ProviderBalanceServiceOptions = {}) {
		this.agentDir = options.agentDir;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.now = options.now ?? Date.now;
	}

	get(providerName: string): ProviderBalanceState {
		return this.balances.get(providerName) ?? EMPTY_BALANCE;
	}

	getRefreshIntervalMinutes(): number {
		try {
			const value = numberValue(readYaml(this.balanceConfigPath).refreshIntervalMinutes);
			return Math.max(1, value ?? DEFAULT_REFRESH_INTERVAL_MINUTES);
		} catch {
			return DEFAULT_REFRESH_INTERVAL_MINUTES;
		}
	}

	async refresh(providerName: string, options: ProviderBalanceRefreshOptions = {}): Promise<ProviderBalanceState> {
		const pending = this.pendingQueries.get(providerName);
		if (pending) return pending;

		const current = this.balances.get(providerName);
		const maxAge = this.getRefreshIntervalMinutes() * 60_000;
		if (!options.force && current?.updatedAt !== undefined && this.now() - current.updatedAt < maxAge) {
			return current;
		}

		this.publish(providerName, { text: current?.text ?? "--", loading: true });
		const query = this.query(providerName, options.resolveSource)
			.then((text): ProviderBalanceState => ({ text, loading: false, updatedAt: this.now() }))
			.catch(
				(error: unknown): ProviderBalanceState => ({
					text: current?.text ?? "--",
					loading: false,
					error: error instanceof Error ? error.message : String(error),
					updatedAt: this.now(),
				}),
			)
			.then((state) => {
				this.pendingQueries.delete(providerName);
				this.publish(providerName, state);
				return state;
			});
		this.pendingQueries.set(providerName, query);
		return query;
	}

	subscribe(listener: (providerName: string, state: ProviderBalanceState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private get resolvedAgentDir(): string {
		return this.agentDir ?? getAgentDir();
	}

	private get balanceConfigPath(): string {
		return join(this.resolvedAgentDir, BALANCE_CONFIG_FILE_NAME);
	}

	private publish(providerName: string, state: ProviderBalanceState): void {
		this.balances.set(providerName, state);
		for (const listener of this.listeners) listener(providerName, state);
	}

	private async query(
		providerName: string,
		resolveSource: (() => Promise<ProviderBalanceSource>) | undefined,
	): Promise<string> {
		const config = readYaml(this.balanceConfigPath);
		const provider = objectValue(objectAt(config, "providers"), providerName);
		if (!provider) throw new Error(`Balance is not configured for ${providerName}`);

		const profileName = typeof provider.profile === "string" ? provider.profile : undefined;
		const profile = profileName
			? objectValue(objectAt(config, "profiles"), profileName)
			: provider.profile === undefined
				? undefined
				: objectAt(provider, "profile");
		if (profileName && !profile) throw new Error(`Unknown balance profile: ${profileName}`);
		if (provider.profile !== undefined && !profile) {
			throw new Error(`Invalid balance profile for ${providerName}`);
		}
		const request = mergeConfig(objectAt(profile, "request"), objectAt(provider, "request") ?? {});
		const extractor = mergeConfig(objectAt(profile, "extractor"), objectAt(provider, "extractor") ?? {});
		const credentials = { ...(objectAt(profile, "credentials") ?? {}), ...(objectAt(provider, "credentials") ?? {}) };
		const source = (await resolveSource?.()) ?? {};
		const baseUrl = (typeof request.baseUrl === "string" ? request.baseUrl : (source.baseUrl ?? "")).replace(
			/\/v1\/?$/,
			"",
		);
		const apiKey = typeof credentials.apiKey === "string" ? credentials.apiKey : (source.apiKey ?? "");
		const variables = {
			baseUrl,
			apiKey,
			accessToken: typeof credentials.accessToken === "string" ? credentials.accessToken : apiKey,
			userId: typeof credentials.userId === "string" ? credentials.userId : "",
		};
		const headers = Object.fromEntries(
			Object.entries(objectAt(request, "headers") ?? {}).map(([name, value]) => [
				name,
				interpolate(String(value), variables),
			]),
		);
		const response = await this.fetch(interpolate(stringValue(request.url, "request.url"), variables), {
			method: typeof request.method === "string" ? request.method : "GET",
			headers,
			body: request.body === undefined ? undefined : JSON.stringify(interpolateValue(request.body, variables)),
			signal: AbortSignal.timeout(Math.max(1, numberValue(request.timeoutSeconds) ?? 10) * 1000),
		});
		if (!response.ok) throw new Error(`Balance API error (${response.status})`);
		const body = (await response.json()) as unknown;
		if (!isValidResponse(body, extractor)) throw new Error(responseError(body, extractor));

		const remainingPath = extractor.remainingPath;
		let remaining: number | null;
		if (typeof remainingPath === "string" && remainingPath) {
			remaining = numberValue(valueAt(body, remainingPath));
			if (remaining === null) throw new Error(`Balance field is missing: ${remainingPath}`);
		} else {
			// remainingPath 为 null 时，由 total - used 自动计算剩余额度。
			const total = numberValue(valueAt(body, stringValue(extractor.totalPath, "extractor.totalPath")));
			const used = numberValue(valueAt(body, stringValue(extractor.usedPath, "extractor.usedPath")));
			if (total === null || used === null) throw new Error("Balance fields are missing: total/used");
			remaining = total - used;
		}
		const scale =
			numberValue(extractor.scale) ??
			(numberValue(extractor.multiplyBy) ?? 1) / (numberValue(extractor.divideBy) ?? 1);
		if (!Number.isFinite(scale)) throw new Error("Balance configuration has an invalid scale");
		const unitPath = typeof extractor.unitPath === "string" ? extractor.unitPath : undefined;
		const responseUnit = unitPath ? valueAt(body, unitPath) : undefined;
		const unit =
			typeof responseUnit === "string" ? responseUnit : typeof extractor.unit === "string" ? extractor.unit : "";
		return `${unit ? `${unit}` : ""}${(remaining * scale).toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
	}
}

export const providerBalanceService = new ProviderBalanceService();
