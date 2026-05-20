import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildModelCandidates,
	isRetryableModelFailure,
	resolveModelCandidate,
	tryResolveModelCandidate,
	type AvailableModelInfo,
} from "../../src/runs/shared/model-fallback.ts";

describe("model fallback helpers", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{
			provider: "anthropic",
			id: "claude-sonnet-4",
			fullId: "anthropic/claude-sonnet-4",
		},
	];

	it("keeps explicit provider/model ids unchanged", () => {
		assert.equal(
			resolveModelCandidate("openai/gpt-5-mini", availableModels),
			"openai/gpt-5-mini",
		);
	});

	it("resolves a bare id when there is exactly one registry match", () => {
		assert.equal(
			resolveModelCandidate("gpt-5-mini", availableModels),
			"openai/gpt-5-mini",
		);
	});

	it("preserves thinking suffix when resolving a bare id", () => {
		assert.equal(
			resolveModelCandidate("gpt-5-mini:high", availableModels),
			"openai/gpt-5-mini:high",
		);
	});

	it("leaves ambiguous bare ids untouched", () => {
		const ambiguous = [
			...availableModels,
			{
				provider: "github-copilot",
				id: "gpt-5-mini",
				fullId: "github-copilot/gpt-5-mini",
			},
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous), "gpt-5-mini");
	});

	it("prefers the current provider when an ambiguous bare id exists there", () => {
		const ambiguous = [
			...availableModels,
			{
				provider: "github-copilot",
				id: "gpt-5-mini",
				fullId: "github-copilot/gpt-5-mini",
			},
		];
		assert.equal(
			resolveModelCandidate("gpt-5-mini", ambiguous, "github-copilot"),
			"github-copilot/gpt-5-mini",
		);
	});

	it("falls back to the unique registry match when the current provider does not offer the model", () => {
		assert.equal(
			resolveModelCandidate(
				"claude-sonnet-4",
				availableModels,
				"github-copilot",
			),
			"anthropic/claude-sonnet-4",
		);
	});

	it("builds a deduplicated ordered candidate list", () => {
		assert.deepEqual(
			buildModelCandidates(
				"gpt-5-mini",
				["openai/gpt-5-mini", "anthropic/claude-sonnet-4", "gpt-5-mini"],
				availableModels,
				availableModels,
			),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("applies the current provider preference to fallback candidates too", () => {
		const ambiguous = [
			...availableModels,
			{
				provider: "github-copilot",
				id: "gpt-5-mini",
				fullId: "github-copilot/gpt-5-mini",
			},
		];
		assert.deepEqual(
			buildModelCandidates(
				"gpt-5-mini",
				["gpt-5-mini", "anthropic/claude-sonnet-4"],
				ambiguous,
				ambiguous,
				"github-copilot",
			),
			["github-copilot/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("detects retryable provider/model failures", () => {
		assert.equal(
			isRetryableModelFailure("rate limit exceeded for provider"),
			true,
		);
		assert.equal(isRetryableModelFailure("model unavailable"), true);
		assert.equal(isRetryableModelFailure("authentication failed"), true);
	});

	it("does not treat ordinary task/tool failures as retryable model failures", () => {
		assert.equal(
			isRetryableModelFailure("bash failed (exit 1): command not found"),
			false,
		);
		assert.equal(
			isRetryableModelFailure(
				"read failed (exit 1): no such file or directory",
			),
			false,
		);
		assert.equal(isRetryableModelFailure(undefined), false);
	});
});

describe("tryResolveModelCandidate", () => {
	const known: AvailableModelInfo[] = [
		{ provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5" },
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{
			provider: "anthropic",
			id: "claude-opus-4-7",
			fullId: "anthropic/claude-opus-4-7",
		},
		{
			provider: "amazon-bedrock",
			id: "amazon.nova-lite-v1:0",
			fullId: "amazon-bedrock/amazon.nova-lite-v1:0",
		},
	];
	const available: AvailableModelInfo[] = known.slice(0, 2);

	it("preserves real colon-bearing model ids", () => {
		const result = tryResolveModelCandidate(
			"amazon-bedrock/amazon.nova-lite-v1:0",
			known,
			available,
		);
		assert.equal(result.resolved, undefined);
		assert.match(result.error!, /not authed/);
		assert.match(result.error!, /amazon-bedrock/);
	});

	it("returns not-authed error when model in knownModels but not availableModels", () => {
		const result = tryResolveModelCandidate(
			"anthropic/claude-opus-4-7",
			known,
			available,
		);
		assert.equal(result.resolved, undefined);
		assert.match(result.error!, /not authed/);
	});

	it("suggests the nearest model id on a bare-id typo (suggestion-first)", () => {
		const result = tryResolveModelCandidate(
			"openai/gpt-5-mimi",
			known,
			available,
		);
		assert.equal(result.resolved, undefined);
		assert.match(result.error!, /^Did you mean 'openai\/gpt-5-mini'\?/);
	});

	it("refuses to suggest when two candidates tie at minimum edit distance", () => {
		const registry: AvailableModelInfo[] = [
			{ provider: "p", id: "abc", fullId: "p/abc" },
			{ provider: "p", id: "abd", fullId: "p/abd" },
		];
		const result = tryResolveModelCandidate("p/abx", registry, registry);
		assert.equal(result.resolved, undefined);
		assert.doesNotMatch(result.error!, /Did you mean/);
		assert.match(result.error!, /Unknown model/);
	});

	it("suggests a valid thinking level for unrecognized colon-suffix on known base", () => {
		const result = tryResolveModelCandidate(
			"openai/gpt-5-mini:hihg",
			known,
			available,
		);
		assert.equal(result.resolved, undefined);
		assert.match(result.error!, /^Did you mean 'openai\/gpt-5-mini:high'\?/);
	});

	it("returns the unchanged string when registries are empty", () => {
		const result = tryResolveModelCandidate("anything/at-all:xhigh", [], []);
		assert.equal(result.resolved, "anything/at-all:xhigh");
		assert.equal(result.error, undefined);
	});

	it("passes through an exact-known model unchanged (smoke gate case a)", () => {
		const result = tryResolveModelCandidate(
			"openai-codex/gpt-5.5:xhigh",
			known,
			available,
		);
		assert.equal(result.resolved, "openai-codex/gpt-5.5:xhigh");
		assert.equal(result.error, undefined);
	});

	it("surfaces unknown-model error for reported failure shape without login/auth fallback", () => {
		const result = tryResolveModelCandidate(
			"openai/gpt-5.5-codex:xhigh",
			known,
			available,
		);
		assert.equal(result.resolved, undefined);
		assert.match(
			result.error!,
			/Unknown model: 'openai\/gpt-5\.5-codex:xhigh'/,
		);
		assert.doesNotMatch(result.error!, /Use \/login/);
	});
});

describe("buildModelCandidates fallback semantics", () => {
	const known: AvailableModelInfo[] = [
		{ provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5" },
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	];

	it("drops invalid fallbacks but keeps the valid primary", () => {
		const candidates = buildModelCandidates(
			"openai-codex/gpt-5.5:high",
			["bogus/typo:high"],
			known,
			known,
		);
		assert.deepEqual(candidates, ["openai-codex/gpt-5.5:high"]);
	});

	it("uses a valid fallback when the primary is unknown (no throw)", () => {
		const candidates = buildModelCandidates(
			"bogus/typo:high",
			["openai-codex/gpt-5.5:high"],
			known,
			known,
		);
		assert.deepEqual(candidates, ["openai-codex/gpt-5.5:high"]);
	});

	it("throws aggregated suggestion-first error when every candidate is invalid", () => {
		assert.throws(
			() =>
				buildModelCandidates(
					"bogus/typo:high",
					["another/wrong:low"],
					known,
					known,
				),
			(err: Error) => /Unknown model: 'bogus\/typo:high'/.test(err.message),
		);
	});
});
