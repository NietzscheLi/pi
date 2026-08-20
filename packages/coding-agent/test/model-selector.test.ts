import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ProviderBalanceReader, ProviderBalanceState } from "../src/core/provider-balance.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

class FakeBalanceReader implements ProviderBalanceReader {
	readonly refreshes: string[] = [];
	private readonly states = new Map<string, ProviderBalanceState>();
	private readonly listeners = new Set<(providerName: string, state: ProviderBalanceState) => void>();

	get(providerName: string): ProviderBalanceState {
		return this.states.get(providerName) ?? { text: "--", loading: false };
	}

	refresh(providerName: string): Promise<ProviderBalanceState> {
		this.refreshes.push(providerName);
		return Promise.resolve(this.get(providerName));
	}

	subscribe(listener: (providerName: string, state: ProviderBalanceState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	set(providerName: string, state: ProviderBalanceState): void {
		this.states.set(providerName, state);
		for (const listener of this.listeners) listener(providerName, state);
	}
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			undefined,
			new FakeBalanceReader(),
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	it("selects a provider before its model and shows the highlighted provider balance", async () => {
		harness = await createHarness({
			models: [
				{ id: "first-model", name: "First Model" },
				{ id: "other-model", name: "Other Model" },
			],
		});
		const current = harness.getModel("first-model")!;
		const secondProviderModel = {
			...current,
			provider: "second-provider",
			id: "second-model",
			name: "Second Model",
		};
		const secondProviderOtherModel = {
			...secondProviderModel,
			id: "second-other-model",
			name: "Second Other Model",
		};
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([
			...harness.models,
			secondProviderModel,
			secondProviderOtherModel,
		]);
		const firstProvider = harness.session.modelRuntime.getProvider(current.provider);
		vi.spyOn(harness.session.modelRuntime, "getProvider").mockImplementation((providerId) => {
			if (providerId === "second-provider" && firstProvider) {
				return { ...firstProvider, id: providerId, name: "Second Provider" };
			}
			return providerId === current.provider ? firstProvider : undefined;
		});
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const balances = new FakeBalanceReader();
		balances.set(current.provider, { text: "10 CNY", loading: false });
		balances.set(secondProviderModel.provider, { text: "20 CNY", loading: false });
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRuntime,
			[],
			onSelect,
			onCancel,
			undefined,
			undefined,
			balances,
		);

		let rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("Providers");
		expect(rendered).toContain(`${current.provider} (2 models)`);
		expect(rendered).toContain("Balance: 10 CNY");
		expect(rendered).not.toContain("first-model");
		expect(balances.refreshes).toEqual([current.provider]);

		selector.handleInput("\x1b[B");
		rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("→ Second Provider [second-provider] (2 models)");
		expect(rendered).toContain("Balance: 20 CNY");
		expect(balances.refreshes).toEqual([current.provider, "second-provider"]);
		balances.set(current.provider, { text: "99 CNY", loading: false });
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Balance: 20 CNY");

		selector.handleInput("\r");
		rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("Providers / Second Provider [second-provider]");
		expect(rendered).toContain("→ second-model");
		expect(rendered).not.toContain("first-model");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(secondProviderModel);
		expect(onCancel).not.toHaveBeenCalled();

		const searchSelector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			"Second Provider",
			undefined,
			balances,
		);
		expect(stripAnsi(searchSelector.render(120).join("\n"))).toContain(
			"→ Second Provider [second-provider] (2 models)",
		);
		searchSelector.handleInput("\r");
		const searchResult = stripAnsi(searchSelector.render(120).join("\n"));
		expect(searchSelector.getSearchInput().getValue()).toBe("");
		expect(searchResult).toContain("second-model");
		expect(searchResult).toContain("second-other-model");
		searchSelector.dispose();
	});

	it("returns to providers before closing the two-level selector", async () => {
		harness = await createHarness();
		const onCancel = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			onCancel,
			undefined,
			undefined,
			new FakeBalanceReader(),
		);

		selector.handleInput("\r");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Providers /");
		selector.handleInput("\x1b");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Providers");
		expect(onCancel).not.toHaveBeenCalled();
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
	});
});
