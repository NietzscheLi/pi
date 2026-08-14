import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatProviderBalance, ProviderBalanceService } from "../src/core/provider-balance.ts";

function writeBalanceFiles(agentDir: string): void {
	writeFileSync(
		join(agentDir, "balance-config.yaml"),
		`refreshIntervalMinutes: 5
profiles:
  basic: &basic
    request:
      url: "{{baseUrl}}/balance"
      headers:
        Authorization: "Bearer {{apiKey}}"
    extractor:
      remainingPath: data.remaining
      validity:
        path: success
      errorPath: message
providers:
  test.0:
    profile: *basic
    request:
      baseUrl: https://balance.example.test
    extractor:
      divideBy: 2
      unit: CNY
`,
	);
}

describe("ProviderBalanceService", () => {
	let agentDir: string | undefined;

	afterEach(() => {
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	});

	it("formats loading, unavailable, and stale states consistently", () => {
		expect(formatProviderBalance({ text: "--", loading: true })).toBe("-- (refreshing…)");
		expect(formatProviderBalance({ text: "--", loading: false, error: "not configured" })).toBe("unavailable");
		expect(formatProviderBalance({ text: "8 CNY", loading: false, error: "timeout" })).toBe("8 CNY (stale)");
	});

	it("shares pending requests and caches the formatted provider balance", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-provider-balance-"));
		writeBalanceFiles(agentDir);
		let resolveResponse: ((response: Response) => void) | undefined;
		const fetchMock = vi.fn<typeof fetch>(
			() =>
				new Promise<Response>((resolve) => {
					resolveResponse = resolve;
				}),
		);
		const service = new ProviderBalanceService({ agentDir, fetch: fetchMock });
		const states: string[] = [];
		service.subscribe((_provider, state) => states.push(`${state.loading}:${state.text}`));

		const resolveSource = async () => ({ baseUrl: "https://models.example.test/v1", apiKey: "model-key" });
		const first = service.refresh("test.0", { resolveSource });
		const second = service.refresh("test.0", { resolveSource });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		expect(service.get("test.0")).toMatchObject({ text: "--", loading: true });
		resolveResponse?.(
			new Response(JSON.stringify({ success: true, data: { remaining: 25 } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		expect(await first).toMatchObject({ text: "12.5 CNY", loading: false });
		expect(await second).toMatchObject({ text: "12.5 CNY", loading: false });
		expect(states).toEqual(["true:--", "false:12.5 CNY"]);
		await service.refresh("test.0", { resolveSource });
		expect(fetchMock).toHaveBeenCalledOnce();

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://balance.example.test/balance");
		expect(init?.headers).toMatchObject({ Authorization: "Bearer model-key" });
	});

	it("keeps the last value when a forced refresh receives an invalid response", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-provider-balance-"));
		writeBalanceFiles(agentDir);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true, data: { remaining: 10 } }), {
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: false, message: "account disabled" }), {
					headers: { "Content-Type": "application/json" },
				}),
			);
		const service = new ProviderBalanceService({ agentDir, fetch: fetchMock });

		const resolveSource = async () => ({ baseUrl: "https://models.example.test/v1", apiKey: "model-key" });
		expect(await service.refresh("test.0", { resolveSource })).toMatchObject({ text: "5 CNY", loading: false });
		expect(await service.refresh("test.0", { force: true, resolveSource })).toMatchObject({
			text: "5 CNY",
			loading: false,
			error: "account disabled",
		});
	});
});
