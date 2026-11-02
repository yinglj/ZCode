import {
	ModelConfig,
	parsePersonalModelConfigRules,
	parsePersonalProviderConfigMap,
	type ProviderConfigSnapshot,
} from "@zcode/provider";
import type { ProviderConfigRuntime } from "../providerConfigRuntime.js";
import { loadExternalClaudeSeedPayload } from "./modelCatalog.js";

/**
 * 外部 agent 模式（ZCODE_AGENT_SERVER_COMMAND）下把 claude-codex 的模型目录投影为
 * 个人 provider：否则宿主 modelSelection 视图为空，输入框永远禁用。
 *
 * 两条硬约束（都是实测出来的，别再猜）：
 * 1. 注册表只发布 `enabled:true` 且 `validateComplete()` 通过的模型；
 * 2. 完整 ModelConfig 含 optionSpecs 的 map 迷你语言，手写必错。
 * 因此模型配置从内置 provider 的完整模型规则克隆，只覆盖 enabled / 模型 ID。
 *
 * 走 Repository.update（与文件 codec 同一套解析器），不手工拼 JSON；已有 provider
 * 时完全不碰。
 */
export async function seedExternalClaudeProviders(
	runtime: ProviderConfigRuntime,
	env: NodeJS.ProcessEnv = process.env,
	onSkip?: (reason: string, detail?: unknown) => void,
): Promise<void> {
	const payload = loadExternalClaudeSeedPayload(env);
	if (!payload) return onSkip?.("no-catalog");

	const snapshot = await runtime.configService.read();
	if (snapshot.personalProviders.entries().length > 0)
		return onSkip?.("personal-providers-exist", {
			count: snapshot.personalProviders.entries().length,
		});

	const template = findCompleteBuiltinModelConfig(snapshot);
	if (!template)
		return onSkip?.("no-complete-builtin-template", {
			builtinProviderCount: snapshot.zcodeBuiltinProviders.entries().length,
			sample: snapshot.zcodeBuiltinProviders
				.entries()
				.slice(0, 3)
				.map(([id, provider]) => [id, provider.builtinModelIds ?? []]),
		});

	const modelJson = template.overlay(new ModelConfig({ enabled: true })).toJSON();
	// 宿主用 isSelectionInView 校验 preferredSelection：没有 options.reasoningLevel
	// 就整条丢弃，默认选择会退回注册表第一个 provider。档位取模型支持的最高档。
	const reasoningLevels = (
		modelJson as { optionSpecs?: { reasoningLevel?: { values?: string[] } } }
	).optionSpecs?.reasoningLevel?.values;
	const highestReasoningLevel =
		reasoningLevels && reasoningLevels.length > 0
			? reasoningLevels[reasoningLevels.length - 1]
			: undefined;
	const defaultModelSelection = payload.defaultModelSelection
		? {
				...payload.defaultModelSelection,
				...(highestReasoningLevel
					? { options: { reasoningLevel: highestReasoningLevel } }
					: {}),
			}
		: undefined;
	const modelConfigRules = {
		providerModelRules: payload.modelConfigRules.providerModelRules.map(
			(rule) => ({ ...rule, config: modelJson }),
		),
		manualProviderModelRules: [],
	};

	await runtime.personalRepository.update((current) =>
		current.providers.entries().length > 0
			? current
			: {
					providers: parsePersonalProviderConfigMap(
						payload.providerConfigRules,
					),
					models: parsePersonalModelConfigRules(modelConfigRules),
					providerOrder: current.providerOrder,
					defaultModelSelection:
						defaultModelSelection ?? current.defaultModelSelection,
				},
	);
}

/** 第一个 validateComplete 通过的内置模型配置；注册表口径的"可执行"模板。 */
function findCompleteBuiltinModelConfig(
	snapshot: ProviderConfigSnapshot,
): ModelConfig | null {
	for (const [
		providerId,
		provider,
	] of snapshot.zcodeBuiltinProviders.entries()) {
		for (const modelId of provider.builtinModelIds ?? []) {
			const config = snapshot.zcodeBuiltinModelRules.resolve({
				providerId,
				modelId,
				apiType: provider.api?.type,
				baseUrl: provider.api?.baseUrl,
			});
			if (config.validateComplete().length === 0) return config;
		}
	}
	return null;
}
