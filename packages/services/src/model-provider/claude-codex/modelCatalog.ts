/**
 * claude-codex → ZCode model catalog mapper (external-agent mode).
 *
 * When ZCode drives an external agent (claude-bridge, identified by
 * ZCODE_AGENT_SERVER_COMMAND), inference and credentials live in claude-codex.
 * ZCode's own provider registry is therefore empty, which disables the composer
 * and trips the WelcomeScreen gate. This module mirrors claude-codex's model
 * catalog into ZCode's personal provider-config shape so the UI has usable
 * models.
 *
 * Credentials are never copied: `apiKey` is a marker and `baseUrl` is never
 * dialed — the host hands the resolved modelConfig to the bridge, which maps it
 * back onto bin/claude's own auth and --model flag.
 *
 * Pure: no ZCode or claude-codex imports, so the mapping is testable alone.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeModelEntry {
	provider: string;
	model: string;
	baseUrl?: string;
}

export interface SeedPayload {
	providerConfigRules: {
		providerRules: Array<{
			providerId: string;
			providerName: string;
			enabled: boolean;
			config: {
				/** 注册表完整性要求（completeProviderConfigDataSchema）必须有 group。 */
				group: "standard-personal";
				access: { type: "api-key"; apiKey: string };
				api: { type: "anthropic-messages"; baseUrl: string };
				personalModelIds: string[];
				modelOrder: string[];
			};
		}>;
	};
	modelConfigRules: {
		providerModelRules: Array<{
			modelId: string;
			providerId: string;
			config: { properties: { contextWindow: number } };
		}>;
		manualProviderModelRules: [];
	};
	/** 宿主默认模型选择：跟随 claude-codex 自己的默认模型解析结果。 */
	defaultModelSelection?: { providerId: string; modelId: string };
}

// Placeholders only — never dialed, never treated as secrets.
const PLACEHOLDER_API_KEY = "claude-managed";
const PLACEHOLDER_BASE_URL = "http://127.0.0.1:1";
const CONTEXT_WINDOW_DEFAULT = 200_000;

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function slug(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * claude-codex model catalog, most authoritative source first:
 *   1. ~/.claude.json `additionalModelOptionsCache` (discovered provider models)
 *   2. ~/.claude/auth.json `credentials` entries carrying provider + model
 */
export function readClaudeModelCatalog(
	options: { homeDir?: string } = {},
): ClaudeModelEntry[] {
	// 用显式 homeDir 而不是 os.homedir()：后者读取时机受宿主环境影响，
	// 测试与嵌入式宿主都需要能指定配置根。
	const configDir = options.homeDir ?? homedir();

	const claudeJson = readJson(join(configDir, ".claude.json")) as {
		additionalModelOptionsCache?: Array<Partial<ClaudeModelEntry>>;
	} | null;
	const cached = claudeJson?.additionalModelOptionsCache;
	if (Array.isArray(cached)) {
		const entries = cached
			.filter(
				(entry): entry is ClaudeModelEntry =>
					typeof entry?.provider === "string" &&
					typeof entry?.model === "string" &&
					entry.provider.length > 0 &&
					entry.model.length > 0,
			)
			.map((entry) => ({
				provider: entry.provider,
				model: entry.model,
				...(typeof entry.baseUrl === "string"
					? { baseUrl: entry.baseUrl }
					: {}),
			}));
		if (entries.length > 0) return dedupe(entries);
	}

	const claudeConfigDir =
		process.env.CLAUDE_CONFIG_DIR || join(configDir, ".claude");
	const auth = readJson(join(claudeConfigDir, "auth.json")) as {
		credentials?: Record<string, Partial<ClaudeModelEntry>>;
	} | null;
	const credentials = Object.values(auth?.credentials ?? {});
	const entries = credentials
		.filter(
			(cred): cred is ClaudeModelEntry =>
				typeof cred?.provider === "string" &&
				typeof cred?.model === "string" &&
				cred.provider.length > 0 &&
				cred.model.length > 0,
		)
		.map((cred) => ({
			provider: cred.provider,
			model: cred.model,
			...(typeof cred.baseUrl === "string" ? { baseUrl: cred.baseUrl } : {}),
		}));
	return dedupe(entries);
}

function dedupe(entries: ClaudeModelEntry[]): ClaudeModelEntry[] {
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const key = `${entry.provider}\u0000${entry.model}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * claude-codex 自己怎么定默认模型（src/utils/model/model.ts 的优先级）：
 *   1. 会话内 /model 覆盖（宿主侧不可见，忽略）
 *   2. --model 启动参数（宿主不传，忽略）
 *   3. settings.json 的 model
 *   4. ANTHROPIC_MODEL 环境变量
 *   5. ANTHROPIC_DEFAULT_MODEL 环境变量
 * 订阅档位兜底是 Anthropic 托管概念，目录里没有对应模型，忽略。
 * 返回裸模型 id：去掉 [1m] 上下文标记，解码 __provider_model__ 编码。
 */
export function readClaudeDefaultModel(
	options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
	const configDir = options.homeDir ?? homedir();
	const env = options.env ?? process.env;
	const claudeConfigDir =
		process.env.CLAUDE_CONFIG_DIR || join(configDir, ".claude");
	const settings = readJson(join(claudeConfigDir, "settings.json")) as {
		model?: string;
		env?: { ANTHROPIC_MODEL?: string; ANTHROPIC_DEFAULT_MODEL?: string };
	} | null;
	const raw =
		settings?.model ||
		settings?.env?.ANTHROPIC_MODEL ||
		env.ANTHROPIC_MODEL ||
		settings?.env?.ANTHROPIC_DEFAULT_MODEL ||
		env.ANTHROPIC_DEFAULT_MODEL;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	return normalizeClaudeModelId(raw.trim());
}

/** 去掉 [1m] 标记，解码 __provider_model__:<provider>:<model>。 */
export function normalizeClaudeModelId(value: string): string {
	const encoded = value.startsWith("__provider_model__:")
		? value.slice("__provider_model__:".length)
		: value;
	const bare = encoded.includes(":") ? encoded.slice(encoded.indexOf(":") + 1) : encoded;
	return bare.replace(/\[1m\]$/, "").trim();
}

/** Builds the personal-provider payload, or null when there is nothing to mirror. */
export function buildSeedPayload(
	entries: ClaudeModelEntry[],
	options: { defaultModel?: string } = {},
): SeedPayload | null {
	if (entries.length === 0) return null;

	const modelsByProvider = new Map<string, string[]>();
	for (const entry of entries) {
		const providerId = slug(entry.provider) || "external";
		const models = modelsByProvider.get(providerId) ?? [];
		if (!models.includes(entry.model)) models.push(entry.model);
		modelsByProvider.set(providerId, models);
	}

	const providerModelRules = entries.map((entry) => ({
		// modelId 必须与 claude-codex 的模型标识完全一致：宿主要把它原样回传给
		// bridge 映射成 bin/claude 的 --model，前缀或 slug 都会打断往返。
		modelId: entry.model,
		providerId: slug(entry.provider) || "external",
		config: { properties: { contextWindow: CONTEXT_WINDOW_DEFAULT } },
	}));

	const defaultModel = options.defaultModel
		? normalizeClaudeModelId(options.defaultModel)
		: "";
	const defaultEntry = defaultModel
		? entries.find(
				(entry) =>
					normalizeClaudeModelId(entry.model) === defaultModel ||
					entry.model === defaultModel,
			)
		: undefined;

	return {
		providerConfigRules: {
			providerRules: [...modelsByProvider.entries()].map(
				([providerId, models]) => ({
					providerId,
					providerName: providerId,
					enabled: true,
					config: {
						group: "standard-personal" as const,
						access: { type: "api-key" as const, apiKey: PLACEHOLDER_API_KEY },
						api: {
							type: "anthropic-messages" as const,
							baseUrl: PLACEHOLDER_BASE_URL,
						},
						personalModelIds: models,
						modelOrder: models,
					},
				}),
			),
		},
		modelConfigRules: {
			providerModelRules,
			manualProviderModelRules: [],
		},
		...(defaultEntry
			? {
					defaultModelSelection: {
						providerId: slug(defaultEntry.provider) || "external",
						modelId: defaultEntry.model,
					},
				}
			: {}),
	};
}

/** Env gate + catalog read, for callers that just want "seed if applicable". */
export function loadExternalClaudeSeedPayload(
	env: NodeJS.ProcessEnv = process.env,
): SeedPayload | null {
	if (!env.ZCODE_AGENT_SERVER_COMMAND?.trim()) return null;
	const homeDir = env.HOME ?? process.env.HOME;
	return buildSeedPayload(readClaudeModelCatalog({ homeDir }), {
		defaultModel: readClaudeDefaultModel({ homeDir, env }),
	});
}
