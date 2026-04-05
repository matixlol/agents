/**
 * Codex Fast Mode Extension
 *
 * Experimental extension that injects `service_tier` into requests for the
 * `openai-codex` provider. This is not a built-in pi feature; it patches the
 * provider payload right before the request is sent.
 *
 * It also installs a custom footer so the active fast override is shown next to
 * the model/thinking indicator in the bottom-right footer area.
 *
 * Usage:
 *   pi -e ./extensions/codex-fast-mode.ts
 *   pi -e ./extensions/codex-fast-mode.ts --codex-fast
 *   PI_CODEX_FAST=1 pi
 *
 * Commands:
 *   /codex-fast            Open selector / show status
 *   /codex-fast on         Enable with priority tier
 *   /codex-fast off        Disable override
 *   /codex-fast toggle     Toggle override
 *   /codex-fast priority   Enable with priority tier
 *   /codex-fast status     Show current status
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type CodexServiceTier = "priority";

type ProviderPayload = Record<string, unknown> & {
	service_tier?: unknown;
};

interface SelectOption {
	label: string;
	value: string;
}

function isProviderPayload(value: unknown): value is ProviderPayload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTier(
	value: string | undefined,
): CodexServiceTier | undefined {
	switch (value?.trim().toLowerCase()) {
		case "fast":
		case "priority":
			return "priority";
		default:
			return undefined;
	}
}

function isCodexModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex";
}

function describeState(
	enabled: boolean,
	tier: CodexServiceTier,
	ctx: ExtensionContext,
): string {
	if (!enabled) {
		return "Codex fast override: off";
	}

	if (isCodexModel(ctx)) {
		return `Codex fast override: on (${tier})`;
	}

	const modelLabel = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: "no active model";
	return `Codex fast override: on (${tier}), waiting for openai-codex (current: ${modelLabel})`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

export default function codexFastModeExtension(pi: ExtensionAPI) {
	let enabled = false;
	let tier: CodexServiceTier = "priority";

	const installFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (
							entry.type === "message" &&
							entry.message.role === "assistant"
						) {
							const message = entry.message as AssistantMessage;
							totalInput += message.usage.input;
							totalOutput += message.usage.output;
							totalCacheRead += message.usage.cacheRead;
							totalCacheWrite += message.usage.cacheWrite;
							totalCost += message.usage.cost.total;
						}
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow =
						contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent =
						contextUsage?.percent !== null
							? contextPercentValue.toFixed(1)
							: "?";

					let pwd = ctx.sessionManager.getCwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}

					const branch = footerData.getGitBranch();
					if (branch) {
						pwd = `${pwd} (${branch})`;
					}

					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) {
						pwd = `${pwd} • ${sessionName}`;
					}

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead)
						statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite)
						statsParts.push(`W${formatTokens(totalCacheWrite)}`);

					const usingSubscription = ctx.model
						? ctx.modelRegistry.isUsingOAuth(ctx.model)
						: false;
					if (totalCost || usingSubscription) {
						statsParts.push(
							`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
						);
					}

					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)} (auto)`
							: `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
					const contextPercentStr =
						contextPercentValue > 90
							? theme.fg("error", contextPercentDisplay)
							: contextPercentValue > 70
								? theme.fg("warning", contextPercentDisplay)
								: contextPercentDisplay;
					statsParts.push(contextPercentStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = ctx.model?.id || "no-model";
					const thinkingLevel = ctx.model?.reasoning
						? pi.getThinkingLevel()
						: undefined;
					let rightSideWithoutProvider = modelName;
					if (thinkingLevel) {
						rightSideWithoutProvider =
							thinkingLevel === "off"
								? `${modelName} • thinking off`
								: `${modelName} • ${thinkingLevel}`;
					}

					if (enabled && isCodexModel(ctx)) {
						rightSideWithoutProvider += ` • fast:${tier}`;
					}

					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}

					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + 2 + rightSideWidth;

					let statsLine: string;
					if (totalNeeded <= width) {
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - 2;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(
								rightSide,
								availableForRight,
								"",
							);
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(
								Math.max(0, width - statsLeftWidth - truncatedRightWidth),
							);
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);
					const lines = [
						truncateToWidth(
							theme.fg("dim", pwd),
							width,
							theme.fg("dim", "..."),
						),
						dimStatsLeft + dimRemainder,
					];

					const statusLine = Array.from(
						footerData.getExtensionStatuses().entries(),
					)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text))
						.join(" ");
					if (statusLine) {
						lines.push(
							truncateToWidth(statusLine, width, theme.fg("dim", "...")),
						);
					}

					return lines;
				},
			};
		});
	};

	const notifyState = (ctx: ExtensionContext) => {
		ctx.ui.notify(describeState(enabled, tier, ctx), "info");
	};

	const enable = (ctx: ExtensionContext, nextTier?: CodexServiceTier) => {
		enabled = true;
		if (nextTier) {
			tier = nextTier;
		}
		installFooter(ctx);
		notifyState(ctx);
	};

	const disable = (ctx: ExtensionContext) => {
		enabled = false;
		installFooter(ctx);
		notifyState(ctx);
	};

	const toggle = (ctx: ExtensionContext) => {
		if (enabled) {
			disable(ctx);
		} else {
			enable(ctx);
		}
	};

	const getCompletions = (
		prefix: string,
	): Array<{ value: string; label: string }> | null => {
		const values = ["on", "off", "toggle", "priority", "status"];
		const matches = values.filter((value) =>
			value.startsWith(prefix.toLowerCase()),
		);
		return matches.length > 0
			? matches.map((value) => ({ value, label: value }))
			: null;
	};

	const runAction = async (
		action: string | undefined,
		ctx: ExtensionContext,
	) => {
		switch (action) {
			case undefined:
			case "status":
				notifyState(ctx);
				return;
			case "on":
				enable(ctx, "priority");
				return;
			case "off":
				disable(ctx);
				return;
			case "toggle":
				toggle(ctx);
				return;
			case "priority":
				enable(ctx, "priority");
				return;
			default:
				ctx.ui.notify(`Unknown codex-fast action: ${action}`, "warning");
		}
	};

	pi.registerFlag("codex-fast", {
		description:
			"Enable experimental Codex fast override (injects service_tier for openai-codex)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("codex-fast-tier", {
		description: "Codex fast tier override: priority",
		type: "string",
		default: "priority",
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle experimental Codex fast override",
		getArgumentCompletions: getCompletions,
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || undefined;

			if (!action && ctx.hasUI) {
				const options: SelectOption[] = [
					{ value: "on", label: "Enable priority tier" },
					{ value: "off", label: "Disable override" },
					{ value: "toggle", label: "Toggle current state" },
					{ value: "status", label: "Show current status" },
				];
				const selected = await ctx.ui.select(
					"Codex fast override",
					options.map((option) => option.label),
				);
				if (!selected) {
					return;
				}
				const matched = options.find((option) => option.label === selected);
				await runAction(matched?.value, ctx);
				return;
			}

			await runAction(action, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled =
			pi.getFlag("codex-fast") === true ||
			isTruthyEnv(process.env.PI_CODEX_FAST);

		const tierFlag = pi.getFlag("codex-fast-tier");
		const envTier = normalizeTier(process.env.PI_CODEX_FAST_TIER);
		const normalizedTier =
			typeof tierFlag === "string" ? normalizeTier(tierFlag) : undefined;
		if (typeof tierFlag === "string" && !normalizedTier) {
			ctx.ui.notify(
				`Invalid --codex-fast-tier value: ${tierFlag}. Using priority.`,
				"warning",
			);
		} else if (process.env.PI_CODEX_FAST_TIER && !envTier) {
			ctx.ui.notify(
				`Invalid PI_CODEX_FAST_TIER value: ${process.env.PI_CODEX_FAST_TIER}. Using priority.`,
				"warning",
			);
		}
		tier = normalizedTier ?? envTier ?? "priority";

		installFooter(ctx);
		if (enabled) {
			notifyState(ctx);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !isCodexModel(ctx)) {
			return;
		}

		if (!isProviderPayload(event.payload)) {
			return;
		}

		return {
			...event.payload,
			service_tier: tier,
		};
	});
}
