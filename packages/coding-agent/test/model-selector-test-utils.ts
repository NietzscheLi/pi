import type { ProviderBalanceReader, ProviderBalanceState } from "../src/core/provider-balance.ts";

export function createNoopBalanceReader(): ProviderBalanceReader {
	const empty: ProviderBalanceState = { text: "--", loading: false };
	return {
		get: () => empty,
		refresh: async () => empty,
		subscribe: () => () => {},
	};
}
