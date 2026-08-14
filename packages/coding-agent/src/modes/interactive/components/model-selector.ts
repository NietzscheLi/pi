import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import {
	formatProviderBalance,
	type ProviderBalanceReader,
	providerBalanceService,
} from "../../../core/provider-balance.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ProviderItem {
	id: string;
	name: string;
	models: ModelItem[];
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

type ModelScope = "all" | "scoped";
type SelectorView = "providers" | "models";

/**
 * Component that renders a two-level provider and model selector with search.
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private providerItems: ProviderItem[] = [];
	private filteredProviders: ProviderItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedProviderIndex = 0;
	private selectedModelIndex = 0;
	private selectedProviderId?: string;
	private selectedModelId?: string;
	private providerOwnQueryMatches = new Set<string>();
	private currentModel?: Model<any>;
	private settingsManager: SettingsManager;
	private modelRuntime: ModelRuntime;
	private balanceService: ProviderBalanceReader;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private view: SelectorView = "providers";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private viewText: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private unsubscribeBalance?: () => void;
	private requestedBalanceProvider?: string;
	private closed = false;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		balanceService: ProviderBalanceReader = providerBalanceService,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRuntime = modelRuntime;
		this.balanceService = balanceService;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.viewText = new Text("", 0, 0);
		this.addChild(this.viewText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) this.searchInput.setValue(initialSearchInput);
		this.searchInput.onSubmit = () => this.confirmSelection();
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.unsubscribeBalance = this.balanceService.subscribe((providerName) => {
			if (providerName !== this.getSelectedProvider()?.id || this.closed) return;
			this.updateList();
			this.tui.requestRender();
		});

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		this.filterItems(this.searchInput.getValue(), Boolean(initialSearchInput));
		this.tui.requestRender();
		void this.refreshModels();
	}

	private loadModelsFromSnapshot(): void {
		const previousProviderId = this.selectedProviderId ?? this.currentModel?.provider;
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.rebuildProviderItems();

		const providerIndex = this.providerItems.findIndex((provider) => provider.id === previousProviderId);
		this.selectedProviderIndex = providerIndex >= 0 ? providerIndex : 0;
		this.selectedProviderId = this.providerItems[this.selectedProviderIndex]?.id;
		if (this.view === "models" && providerIndex < 0) this.view = "providers";
	}

	private rebuildProviderItems(): void {
		const providers = new Map<string, ProviderItem>();
		for (const item of this.activeModels) {
			let provider = providers.get(item.provider);
			if (!provider) {
				provider = {
					id: item.provider,
					name: this.modelRuntime.getProvider(item.provider)?.name ?? item.provider,
					models: [],
				};
				providers.set(item.provider, provider);
			}
			provider.models.push(item);
		}
		this.providerItems = [...providers.values()];
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.filterItems(this.searchInput.getValue(), false);
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
		this.unsubscribeBalance?.();
		this.unsubscribeBalance = undefined;
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: current model first, then by provider. Stable sort preserves provider catalog order.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		const previousProviderId = this.selectedProviderId;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.rebuildProviderItems();
		const providerIndex = this.providerItems.findIndex((provider) => provider.id === previousProviderId);
		if (this.view === "models" && providerIndex < 0) this.view = "providers";
		this.selectedProviderIndex = providerIndex >= 0 ? providerIndex : 0;
		this.selectedProviderId = this.providerItems[this.selectedProviderIndex]?.id;
		if (this.scopeText) this.scopeText.setText(this.getScopeText());
		this.filterItems(this.searchInput.getValue(), false);
	}

	private filterItems(query: string, resetSelection: boolean): void {
		if (this.view === "providers") {
			const previousProviderId = this.selectedProviderId;
			this.providerOwnQueryMatches = new Set(
				query
					? fuzzyFilter(this.providerItems, query, (provider) => `${provider.id} ${provider.name}`).map(
							(provider) => provider.id,
						)
					: [],
			);
			const matchingProviders = query
				? this.providerItems.filter(
						(provider) =>
							this.providerOwnQueryMatches.has(provider.id) ||
							provider.models.some(
								(model) =>
									fuzzyFilter([model], query, ({ id, provider: providerId, model: value }) =>
										getModelSelectorSearchText({ id, provider: providerId, name: value.name }),
									).length > 0,
							),
					)
				: this.providerItems;
			this.filteredProviders = query
				? fuzzyFilter(matchingProviders, query, (provider) => {
						const modelText = provider.models
							.map(({ id, model }) =>
								getModelSelectorSearchText({ id, provider: provider.id, name: model.name }),
							)
							.join(" ");
						return `${provider.id} ${provider.name} ${modelText}`;
					})
				: matchingProviders;
			if (resetSelection) {
				this.selectedProviderIndex = 0;
			} else {
				const previousIndex = this.filteredProviders.findIndex((provider) => provider.id === previousProviderId);
				this.selectedProviderIndex =
					previousIndex >= 0
						? previousIndex
						: Math.min(this.selectedProviderIndex, Math.max(0, this.filteredProviders.length - 1));
			}
			this.selectedProviderId = this.filteredProviders[this.selectedProviderIndex]?.id;
		} else {
			const provider = this.providerItems.find((item) => item.id === this.selectedProviderId);
			const models = provider?.models ?? [];
			this.filteredModels = query
				? fuzzyFilter(
						models,
						query,
						({ id, provider: providerId, model }) =>
							`${getModelSelectorSearchText({ id, provider: providerId, name: model.name })} ${provider?.name ?? ""}`,
					)
				: models;
			if (resetSelection) {
				this.selectedModelIndex = 0;
			} else {
				const previousIndex = this.filteredModels.findIndex((item) => item.id === this.selectedModelId);
				const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
				this.selectedModelIndex =
					previousIndex >= 0
						? previousIndex
						: currentIndex >= 0
							? currentIndex
							: Math.min(this.selectedModelIndex, Math.max(0, this.filteredModels.length - 1));
			}
			this.selectedModelId = this.filteredModels[this.selectedModelIndex]?.id;
		}
		this.updateList();
		this.requestSelectedProviderBalance();
	}

	private getSelectedProvider(): ProviderItem | undefined {
		if (this.view === "providers") return this.filteredProviders[this.selectedProviderIndex];
		return this.providerItems.find((provider) => provider.id === this.selectedProviderId);
	}

	private requestSelectedProviderBalance(): void {
		const providerId = this.getSelectedProvider()?.id;
		if (!providerId || providerId === this.requestedBalanceProvider) return;
		this.requestedBalanceProvider = providerId;
		const model = this.getSelectedProvider()?.models[0]?.model;
		void this.balanceService.refresh(providerId, {
			resolveSource: async () => ({
				baseUrl: model?.baseUrl,
				apiKey: (await this.modelRuntime.getAuth(providerId))?.auth.apiKey,
			}),
		});
	}

	private updateViewText(): void {
		if (this.view === "providers") {
			this.viewText.setText(theme.fg("muted", "Providers"));
			return;
		}
		const provider = this.getSelectedProvider();
		const label = provider ? this.providerLabel(provider) : this.selectedProviderId;
		this.viewText.setText(`${theme.fg("muted", "Providers / ")}${theme.fg("accent", label ?? "")}`);
	}

	private providerLabel(provider: ProviderItem): string {
		return provider.name === provider.id ? provider.id : `${provider.name} [${provider.id}]`;
	}

	private addBalanceDetail(provider: ProviderItem): void {
		const balance = this.balanceService.get(provider.id);
		const value = formatProviderBalance(balance);
		this.listContainer.addChild(
			new Text(`${theme.fg("muted", "  Balance: ")}${theme.fg(balance.error ? "warning" : "text", value)}`, 0, 0),
		);
	}

	private updateList(): void {
		this.listContainer.clear();
		this.updateViewText();

		const maxVisible = 10;
		const items = this.view === "providers" ? this.filteredProviders : this.filteredModels;
		const selectedIndex = this.view === "providers" ? this.selectedProviderIndex : this.selectedModelIndex;
		const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, items.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = items[i];
			if (!item) continue;
			const isSelected = i === selectedIndex;
			let label: string;
			let isCurrent: boolean;
			if (this.view === "providers") {
				const provider = item as ProviderItem;
				label = `${this.providerLabel(provider)} ${theme.fg("muted", `(${provider.models.length} models)`)}`;
				isCurrent = provider.id === this.currentModel?.provider;
			} else {
				const model = item as ModelItem;
				label = model.id;
				isCurrent = modelsAreEqual(this.currentModel, model.model);
			}

			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const itemText = isSelected ? theme.fg("accent", label) : label;
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new Text(`${prefix}${itemText}${checkmark}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < items.length) {
			this.listContainer.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${items.length})`), 0, 0));
		}

		if (this.errorMessage) {
			for (const line of this.errorMessage.split("\n")) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (items.length === 0) {
			this.listContainer.addChild(
				new Text(
					theme.fg("muted", this.view === "providers" ? "  No matching providers" : "  No matching models"),
					0,
					0,
				),
			);
		}

		const provider = this.getSelectedProvider();
		if (provider) {
			this.listContainer.addChild(new Spacer(1));
			this.addBalanceDetail(provider);
			if (this.view === "models" && this.filteredModels.length > 0) {
				const selected = this.filteredModels[this.selectedModelIndex];
				if (selected) {
					this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
				}
			}
		}

		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	private moveSelection(direction: -1 | 1): void {
		const length = this.view === "providers" ? this.filteredProviders.length : this.filteredModels.length;
		if (length === 0) return;
		if (this.view === "providers") {
			this.selectedProviderIndex = (this.selectedProviderIndex + direction + length) % length;
			this.selectedProviderId = this.filteredProviders[this.selectedProviderIndex]?.id;
		} else {
			this.selectedModelIndex = (this.selectedModelIndex + direction + length) % length;
			this.selectedModelId = this.filteredModels[this.selectedModelIndex]?.id;
		}
		this.updateList();
		this.requestSelectedProviderBalance();
	}

	private confirmSelection(): void {
		if (this.view === "providers") {
			const provider = this.filteredProviders[this.selectedProviderIndex];
			if (!provider) return;
			this.selectedProviderId = provider.id;
			this.view = "models";
			this.selectedModelIndex = 0;
			this.selectedModelId = provider.id === this.currentModel?.provider ? this.currentModel.id : undefined;
			if (this.providerOwnQueryMatches.has(provider.id)) this.searchInput.setValue("");
			this.filterItems(this.searchInput.getValue(), Boolean(this.searchInput.getValue()));
			return;
		}
		const selectedModel = this.filteredModels[this.selectedModelIndex];
		if (selectedModel) this.handleSelect(selectedModel.model);
	}

	private returnToProviders(): void {
		this.view = "providers";
		this.filterItems(this.searchInput.getValue(), false);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				this.setScope(this.scope === "all" ? "scoped" : "all");
				if (this.scopeHintText) this.scopeHintText.setText(this.getScopeHintText());
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmSelection();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.view === "models") {
				this.returnToProviders();
			} else {
				this.dispose();
				this.onCancelCallback();
			}
		} else {
			this.searchInput.handleInput(keyData);
			const query = this.searchInput.getValue();
			this.filterItems(query, Boolean(query));
		}
	}

	private handleSelect(model: Model<any>): void {
		this.dispose();
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
