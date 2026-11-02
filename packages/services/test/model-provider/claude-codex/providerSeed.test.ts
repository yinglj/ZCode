import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	parsePersonalModelConfigRules,
	parsePersonalProviderConfigMap,
	parseZCodeBuiltinModelConfigRules,
	parseZCodeBuiltinProviderConfigMap,
	type ProviderConfigLayerSnapshot,
	type ProviderConfigSnapshot,
} from "@zcode/provider";
import { seedExternalClaudeProviders } from "../../../src/model-provider/claude-codex/providerSeed.js";

// 完整内置模型配置：与注册表 validateComplete 要求的字段一一对应。
const COMPLETE_MODEL_JSON = {
	enabled: true,
	properties: {
		requiresMfjsToolSchema: false,
		contextWindow: 200_000,
		inputFormat: {
			supportsText: true,
			supportsImage: false,
			supportsVideo: false,
			supportsAudio: false,
			supportsPdf: false,
		},
		outputFormat: { supportsText: true },
		supportsToolCall: true,
		supportsJsonSchemaOutput: true,
		supportsNativeWebSearch: false,
		supportsMidConversationSystem: false,
	},
	optionSpecs: {
		reasoningLevel: {
			values: ["low"],
			map: "{'reasoning': {'effort': reasoningLevel}}",
		},
		maxOutputTokens: { max: 4096, map: "{'max_tokens': maxOutputTokens}" },
	},
};

// 内置层与个人层的 rule schema 是两套 strict 形状：内置只认 builtinModelIds，
// 个人只认 personalModelIds / modelOrder。
const BUILTIN_PROVIDER_JSON = {
	group: "zai-family",
	access: { type: "api-key", apiKey: "builtin-key" },
	api: { type: "anthropic-messages", baseUrl: "https://builtin.test" },
	builtinModelIds: ["m1"],
};

const PERSONAL_PROVIDER_JSON = {
	group: "standard-personal",
	access: { type: "api-key", apiKey: "personal-key" },
	api: { type: "anthropic-messages", baseUrl: "https://personal.test" },
	personalModelIds: ["m1"],
	modelOrder: ["m1"],
};

function builtinSnapshot(personalProviders: number): ProviderConfigSnapshot {
	return {
		revision: "test",
		zcodeBuiltinRevision: "b1",
		personalRevision: "p1",
		zcodeBuiltinProviders: parseZCodeBuiltinProviderConfigMap([
			{
				providerId: "builtin-x",
				providerName: "Builtin X",
				enabled: true,
				config: BUILTIN_PROVIDER_JSON,
			},
		]),
		zcodeBuiltinProviderTemplates: undefined,
		personalProviders: parsePersonalProviderConfigMap({
			providerRules:
				personalProviders > 0
					? [
							{
								providerId: "mine",
								providerName: "Mine",
								enabled: true,
								config: PERSONAL_PROVIDER_JSON,
							},
						]
					: [],
		}),
		zcodeBuiltinModelRules: parseZCodeBuiltinModelConfigRules({
			modelRules: [],
			modelApiRules: [],
			providerSiteRules: [],
			templateModelRules: [],
			builtinProviderModelRules: [
				{ providerId: "builtin-x", modelId: "m1", config: COMPLETE_MODEL_JSON },
			],
		}),
		personalModels: parsePersonalModelConfigRules({
			providerModelRules: [],
			manualProviderModelRules: [],
		}),
	} as unknown as ProviderConfigSnapshot;
}

function makeHome(): { home: string; restore: () => void } {
	const home = mkdtempSync(join(tmpdir(), "seed-home-"));
	mkdirSync(home, { recursive: true });
	writeFileSync(
		join(home, ".claude.json"),
		JSON.stringify({
			additionalModelOptionsCache: [
				{ provider: "claude-test", model: "sonnet", baseUrl: "https://a.test" },
			],
		}),
	);
	const previous = process.env.HOME;
	process.env.HOME = home;
	return { home, restore: () => void (process.env.HOME = previous) };
}

describe("seedExternalClaudeProviders", () => {
	let cleanup: (() => void) | undefined;
	afterEach(() => cleanup?.());

	test("skips when ZCODE_AGENT_SERVER_COMMAND is absent", async () => {
		let updates = 0;
		const runtime = fakeRuntime(0, () => updates++);
		await seedExternalClaudeProviders(runtime, {});
		expect(updates).toBe(0);
	});

	test("skips when personal providers already exist", async () => {
		cleanup = makeHome().restore;
		let updates = 0;
		const runtime = fakeRuntime(1, () => updates++);
		await seedExternalClaudeProviders(runtime, {
			ZCODE_AGENT_SERVER_COMMAND: "/x/bridge",
		});
		expect(updates).toBe(0);
	});

	test("seeds the default selection with the highest reasoning level", async () => {
		const home = mkdtempSync(join(tmpdir(), "seed-home-"));
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(
			join(home, ".claude.json"),
			JSON.stringify({
				additionalModelOptionsCache: [
					{ provider: "claude-test", model: "sonnet", baseUrl: "https://a.test" },
				],
			}),
		);
		writeFileSync(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ model: "sonnet[1m]" }),
		);
		const previous = process.env.HOME;
		process.env.HOME = home;
		cleanup = () => void (process.env.HOME = previous);

		let written: ProviderConfigLayerSnapshot | null = null;
		const runtime = fakeRuntime(0, (snapshot) => (written = snapshot));
		await seedExternalClaudeProviders(runtime, {
			ZCODE_AGENT_SERVER_COMMAND: "/x/bridge",
		});
		// 宿主 isSelectionInView 要求 preferredSelection 带档位，否则默认选择被丢弃。
		expect(written!.defaultModelSelection).toEqual({
			providerId: "claude-test",
			modelId: "sonnet",
			options: { reasoningLevel: "low" },
		});
	});

	test("projects a complete, executable provider+model", async () => {
		cleanup = makeHome().restore;
		let written: ProviderConfigLayerSnapshot | null = null;
		const runtime = fakeRuntime(0, (snapshot) => (written = snapshot));
		await seedExternalClaudeProviders(runtime, {
			ZCODE_AGENT_SERVER_COMMAND: "/x/bridge",
		});
		expect(written).not.toBeNull();

		// 注册表口径：provider 与 model 都必须 validateComplete 通过且 model enabled。
		const providers = written!.providers.entries();
		expect(providers).toHaveLength(1);
		const [providerId, provider] = providers[0]!;
		expect(provider.validateComplete()).toEqual([]);
		const modelId = provider.personalModelIds?.[0] ?? "sonnet";
		const model = written!.models.resolve({
			providerId,
			modelId,
			apiType: provider.api?.type,
			baseUrl: provider.api?.baseUrl,
		});
		expect(model.enabled).toBe(true);
		expect(model.validateComplete()).toEqual([]);
	});
});

function fakeRuntime(
	existingProviders: number,
	onUpdate: (snapshot: ProviderConfigLayerSnapshot) => void,
) {
	return {
		configService: { read: async () => builtinSnapshot(existingProviders) },
		personalRepository: {
			update: async (
				transform: (current: ProviderConfigLayerSnapshot) => unknown,
			) => {
				const next = transform({
					revision: "r0",
					providers: parsePersonalProviderConfigMap({ providerRules: [] }),
					models: parsePersonalModelConfigRules({
						providerModelRules: [],
						manualProviderModelRules: [],
					}),
				} as ProviderConfigLayerSnapshot);
				onUpdate(next as ProviderConfigLayerSnapshot);
				return next;
			},
		},
	} as never;
}
