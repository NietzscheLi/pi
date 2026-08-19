import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { formatProviderBalance, providerBalanceService } from "../core/provider-balance.ts";

export default function statusFooterExtension(pi: ExtensionAPI): void {
	let turnStartedAt: number | undefined;
	let lastOutputTps: number | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshGeneration = 0;
	let refreshStatuses: (() => void) | undefined;
	let unsubscribeBalance: (() => void) | undefined;

	const refreshBalance = async (ctx: ExtensionContext, force = false) => {
		const model = ctx.model;
		if (!model) return { text: "--", loading: false, error: "No model provider selected" };
		return providerBalanceService.refresh(model.provider, {
			force,
			resolveSource: async () => ({
				baseUrl: model.baseUrl,
				apiKey: (await ctx.modelRegistry.getProviderAuth(model.provider))?.auth.apiKey,
			}),
		});
	};

	pi.registerCommand("update-balance", {
		description: "Update balance for the current provider",
		handler: async (_args, ctx) => {
			const state = await refreshBalance(ctx, true);
			ctx.ui.notify(state.error ?? `Balance updated: ${state.text}`, state.error ? "error" : "info");
		},
	});

	pi.on("turn_start", (event) => {
		turnStartedAt = event.timestamp;
	});
	pi.on("turn_end", (event) => {
		if (event.message.role === "assistant" && turnStartedAt !== undefined) {
			const message = event.message as AssistantMessage;
			lastOutputTps = message.usage.output / Math.max((Date.now() - turnStartedAt) / 1000, 0.001);
		}
		refreshStatuses?.();
	});
	pi.on("model_select", (_event, ctx) => {
		refreshStatuses?.();
		void refreshBalance(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		refreshStatuses = () => {
			const balanceText = ctx.model ? formatProviderBalance(providerBalanceService.get(ctx.model.provider)) : "--";
			const tps = lastOutputTps === undefined ? "TPS --" : `TPS ${lastOutputTps.toFixed(1)}`;
			ctx.ui.setStatus("tps", tps);
			ctx.ui.setStatus("balance", balanceText);
		};
		unsubscribeBalance?.();
		unsubscribeBalance = providerBalanceService.subscribe((providerName) => {
			if (providerName === ctx.model?.provider) refreshStatuses?.();
		});
		refreshStatuses();
		const intervalMinutes = providerBalanceService.getRefreshIntervalMinutes();
		const generation = ++refreshGeneration;
		const schedule = (): void => {
			refreshTimer = setTimeout(async () => {
				await refreshBalance(ctx, true);
				if (generation === refreshGeneration) schedule();
			}, intervalMinutes * 60_000);
			refreshTimer.unref?.();
		};
		schedule();
		void refreshBalance(ctx);
	});
	pi.on("session_shutdown", () => {
		refreshGeneration += 1;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = undefined;
		refreshStatuses = undefined;
		unsubscribeBalance?.();
		unsubscribeBalance = undefined;
	});
}
