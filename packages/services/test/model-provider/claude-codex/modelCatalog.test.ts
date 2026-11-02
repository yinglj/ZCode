/**
 * Tests for the claude-codex → ZCode provider catalog mapper.
 * RED first: the module does not exist yet.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	buildSeedPayload,
	readClaudeDefaultModel,
	readClaudeModelCatalog,
} from "../../../src/model-provider/claude-codex/modelCatalog.js";

describe("readClaudeModelCatalog", () => {
	test("reads additionalModelOptionsCache from ~/.claude.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "claude-cat-"));
		writeFileSync(
			join(dir, ".claude.json"),
			JSON.stringify({
				additionalModelOptionsCache: [
					{
						provider: "claude-test",
						model: "sonnet",
						label: "Sonnet",
						baseUrl: "https://a",
					},
					{
						provider: "claude-test",
						model: "opus",
						label: "Opus",
						baseUrl: "https://a",
					},
				],
			}),
		);
		const options = readClaudeModelCatalog({ homeDir: dir });
		expect(options).toHaveLength(2);
		expect(options[0]).toMatchObject({
			provider: "claude-test",
			model: "sonnet",
		});
	});

	test("falls back to credentials in auth.json when the cache is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "claude-cat-"));
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(
			join(dir, ".claude", "auth.json"),
			JSON.stringify({
				credentials: {
					a: { provider: "claude-test", model: "sonnet", baseUrl: "https://a" },
					b: { name: "incomplete-no-model" },
				},
			}),
		);
		const options = readClaudeModelCatalog({ homeDir: dir });
		expect(options).toEqual([
			{ provider: "claude-test", model: "sonnet", baseUrl: "https://a" },
		]);
	});

	test("returns an empty catalog when nothing is readable", () => {
		const dir = mkdtempSync(join(tmpdir(), "claude-cat-"));
		expect(readClaudeModelCatalog({ homeDir: dir })).toEqual([]);
	});
});

describe("buildSeedPayload", () => {
	test("groups models by provider and emits both rule sets", () => {
		const payload = buildSeedPayload([
			{ provider: "claude-test", model: "sonnet" },
			{ provider: "claude-test", model: "opus" },
			{ provider: "other-test", model: "gemini" },
		]);
		expect(payload.providerConfigRules.providerRules).toHaveLength(2);
		const first = payload.providerConfigRules.providerRules[0];
		expect(first.providerId).toBe("claude-test");
		expect(first.enabled).toBe(true);
		expect(first.config.personalModelIds).toEqual(["sonnet", "opus"]);
		// Credentials are never copied — a marker, and a baseUrl that is never dialed.
		expect(first.config.group).toBe('standard-personal');
    expect(first.config.access).toEqual({
			type: "api-key",
			apiKey: "claude-managed",
		});
		expect(first.config.api).toEqual({
			type: "anthropic-messages",
			baseUrl: "http://127.0.0.1:1",
		});
		expect(payload.modelConfigRules.providerModelRules).toHaveLength(3);
		expect(payload.modelConfigRules.providerModelRules[0]!.providerId).toBe(
			"claude-test",
		);
	});

	test("sanitizes provider/model ids into schema-safe slugs", () => {
		const payload = buildSeedPayload([
			{ provider: "Group/MagPie", model: "claude-sonnet-4.6" },
		]);
		expect(payload.providerConfigRules.providerRules[0]!.providerId).toBe(
			"group-magpie",
		);
		expect(payload.modelConfigRules.providerModelRules[0]!.modelId).toMatch(
			/^[a-z0-9._-]+$/,
		);
	});

	test("returns null when the catalog is empty", () => {
		expect(buildSeedPayload([])).toBeNull();
	});
});

describe("readClaudeDefaultModel", () => {
	test("prefers settings.json model over env", () => {
		const dir = mkdtempSync(join(tmpdir(), "claude-def-"));
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(
			join(dir, ".claude", "settings.json"),
			JSON.stringify({ model: "group/magpie-model[1m]" }),
		);
		expect(readClaudeDefaultModel({ homeDir: dir })).toBe("group/magpie-model");
	});

	test("falls back to ANTHROPIC_MODEL env", () => {
		const dir = mkdtempSync(join(tmpdir(), "claude-def-"));
		expect(readClaudeDefaultModel({ homeDir: dir, env: { ANTHROPIC_MODEL: "env-model" } })).toBe("env-model");
	});

	test("decodes the __provider_model__ picker encoding", () => {
		const dir = mkdtempSync(join(tmpdir(), "claude-def-"));
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(
			join(dir, ".claude", "settings.json"),
			JSON.stringify({ model: "__provider_model__:magpie-anthropic:group/magpie-model" }),
		);
		expect(readClaudeDefaultModel({ homeDir: dir })).toBe("group/magpie-model");
	});
});

describe("buildSeedPayload default selection", () => {
	test("default model selection points at the CLI default model", () => {
		const payload = buildSeedPayload(
			[{ provider: "asiainfo-local", model: "qwen3-6-27b" }, { provider: "magpie-anthropic", model: "group/magpie-model" }],
			{ defaultModel: "group/magpie-model" },
		);
		expect(payload?.defaultModelSelection).toEqual({
			providerId: "magpie-anthropic",
			modelId: "group/magpie-model",
		});
	});

	test("no default model → no selection (host falls back to registry order)", () => {
		const payload = buildSeedPayload([{ provider: "a", model: "b" }]);
		expect(payload?.defaultModelSelection).toBeUndefined();
	});
});
