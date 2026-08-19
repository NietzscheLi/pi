import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line using the same compact token summary as Pikit.
		const totalTokens = usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite;
		const promptTokens = usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite;
		const cacheHitRate = promptTokens > 0 ? (usageTotals.cacheRead / promptTokens) * 100 : 0;
		const statsParts = [
			`T: ${formatTokens(totalTokens)} (${cacheHitRate.toFixed(1)}% cached)`,
			`↑ ${formatTokens(usageTotals.input)}`,
			`↓ ${formatTokens(usageTotals.output)}`,
		];

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}
		const nativeStatsLeft = statsParts.join(" ");

		const footerSettings = this.session.settingsManager.getFooterSettings();
		const customStatusOrder = ["preset", "tps", "balance"];
		const statusEnabled = (key: string): boolean => {
			if (key === "preset") return footerSettings.showPreset;
			if (key === "tps") return footerSettings.showTps;
			if (key === "balance") return footerSettings.showBalance;
			return true;
		};
		const extensionStatuses = Array.from(this.footerData.getExtensionStatuses().entries())
			.filter(([key]) => statusEnabled(key))
			.sort(([a], [b]) => {
				const aIndex = customStatusOrder.indexOf(a);
				const bIndex = customStatusOrder.indexOf(b);
				if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
				if (aIndex === -1) return -1;
				if (bIndex === -1) return 1;
				return aIndex - bIndex;
			})
			.map(([, text]) => theme.fg("dim", sanitizeStatusText(text)));
		for (const status of extensionStatuses) {
			statsParts.push(theme.fg("dim", "•"), status);
		}

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			const withProvider = `(${state.model.provider}) ${rightSideWithoutProvider}`;
			if (visibleWidth(nativeStatsLeft) + minPadding + visibleWidth(withProvider) <= width) rightSide = withProvider;
		}

		// Keep both native columns visible. Extension statuses are appended to the left,
		// so they are the first content truncated when the terminal is narrow.
		const minimumLeftWidth = Math.min(visibleWidth(nativeStatsLeft), Math.max(0, Math.floor(width * 0.45)));
		const maximumRightWidth = Math.max(0, width - minimumLeftWidth - minPadding);
		rightSide = truncateToWidth(rightSide, maximumRightWidth, "");
		const rightSideWidth = visibleWidth(rightSide);
		const availableLeft = Math.max(0, width - rightSideWidth - (rightSideWidth > 0 ? minPadding : 0));
		statsLeft = truncateToWidth(statsLeft, availableLeft, "...");
		const statsLeftWidth = visibleWidth(statsLeft);
		const gapWidth = statsLeftWidth > 0 && rightSideWidth > 0 ? minPadding : 0;
		const padding = " ".repeat(Math.max(gapWidth, width - statsLeftWidth - rightSideWidth));
		const statsLine = statsLeft + padding + rightSide;

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		return [pwdLine, dimStatsLeft + dimRemainder];
	}
}
