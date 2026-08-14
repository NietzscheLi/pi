import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	BALANCE_CONFIG_FILE_NAME,
	initializeDefaultConfigFiles,
	PRESETS_CONFIG_FILE_NAME,
} from "../src/core/default-config.ts";

describe("default config initialization", () => {
	let testDir: string | undefined;

	afterEach(() => {
		if (testDir) rmSync(testDir, { recursive: true, force: true });
		testDir = undefined;
	});

	it("creates parseable templates in a missing agent directory", () => {
		testDir = mkdtempSync(join(tmpdir(), "pi-default-config-"));
		const agentDir = join(testDir, "agent");

		initializeDefaultConfigFiles(agentDir);

		const balance = parse(readFileSync(join(agentDir, BALANCE_CONFIG_FILE_NAME), "utf-8")) as Record<string, unknown>;
		const presets = parse(readFileSync(join(agentDir, PRESETS_CONFIG_FILE_NAME), "utf-8")) as Record<string, unknown>;
		expect(balance).toMatchObject({ refreshIntervalMinutes: 5, providers: {} });
		expect(presets).toMatchObject({ version: 1, presets: {} });
	});

	it("does not overwrite existing files", () => {
		testDir = mkdtempSync(join(tmpdir(), "pi-default-config-"));
		const balancePath = join(testDir, BALANCE_CONFIG_FILE_NAME);
		const presetsPath = join(testDir, PRESETS_CONFIG_FILE_NAME);
		writeFileSync(balancePath, "existing balance\n");
		writeFileSync(presetsPath, "existing presets\n");

		initializeDefaultConfigFiles(testDir);

		expect(readFileSync(balancePath, "utf-8")).toBe("existing balance\n");
		expect(readFileSync(presetsPath, "utf-8")).toBe("existing presets\n");
		expect(existsSync(join(testDir, "presets.json"))).toBe(false);
	});
});
