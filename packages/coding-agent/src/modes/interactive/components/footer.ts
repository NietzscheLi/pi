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
			theme.fg("accent", `T: ${formatTokens(totalTokens)}`),
			theme.fg("muted", `(${cacheHitRate.toFixed(1)}% cached)`),
			theme.fg("success", `↑ ${formatTokens(usageTotals.input)}`),
			theme.fg("text", `↓ ${formatTokens(usageTotals.output)}`),
		];

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}`
				: `${contextPercent}%/${formatTokens(contextWindow)}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else if (contextPercent === "?") {
			contextPercentStr = theme.fg("muted", contextPercentDisplay);
		} else {
			contextPercentStr = theme.fg("success", contextPercentDisplay);
		}
		contextPercentStr += theme.fg("dim", autoIndicator);
		statsParts.push(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(theme.bold(theme.fg("warning", "xp")));
		}
		const footerSettings = this.session.settingsManager.getFooterSettings();
		const customStatusOrder = ["preset", "tps", "balance", "mcp"];
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
			.map(([key, text]) => {
				const status = sanitizeStatusText(text);
				if (key === "preset") return theme.fg("accent", status);
				if (key === "tps") return theme.fg("success", status);
				if (key === "balance") return theme.fg("warning", status);
				return status;
			});
		for (const status of extensionStatuses) {
			statsParts.push(status);
		}

		let statsLeft = statsParts.slice(0, 4).join(" ");
		for (const status of statsParts.slice(4)) {
			statsLeft += ` ${theme.fg("dim", "•")} ${status}`;
		}

		// Show provider, model, and thinking level before the working directory so they
		// remain visible when the growing stats line is truncated.
		const modelName = state.model?.id || "no-model";
		let modelInfo = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			modelInfo = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}
		if (state.model) {
			modelInfo = `(${state.model.provider}) ${modelInfo}`;
		}

		const minPadding = 2;
		const minimumPwdWidth = Math.min(visibleWidth(pwd), Math.max(0, Math.floor(width * 0.45)));
		const maximumModelWidth = Math.max(0, width - minimumPwdWidth - minPadding);
		modelInfo = truncateToWidth(modelInfo, maximumModelWidth, "");
		const modelInfoWidth = visibleWidth(modelInfo);
		const availablePwdWidth = Math.max(0, width - modelInfoWidth - (modelInfoWidth > 0 ? minPadding : 0));
		const truncatedPwd = truncateToWidth(pwd, availablePwdWidth, "...");
		const truncatedPwdWidth = visibleWidth(truncatedPwd);
		const pwdGapWidth = modelInfoWidth > 0 && truncatedPwdWidth > 0 ? minPadding : 0;
		const pwdPadding = " ".repeat(Math.max(pwdGapWidth, width - modelInfoWidth - truncatedPwdWidth));
		const pwdLine = theme.fg("dim", modelInfo + pwdPadding + truncatedPwd);

		// Extension statuses are appended to the stats line, so they are the first
		// content truncated when the terminal is narrow.
		statsLeft = truncateToWidth(statsLeft, width, "...");

		// Each status segment already has its own theme color. MCP status text is left
		// untouched so extensions can supply their own compatible styling.
		return [pwdLine, statsLeft];
	}
}
