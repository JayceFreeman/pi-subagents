import type { ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { ModelAttempt, Usage } from "../../shared/types.ts";
import type { ModelFailureKind } from "./run-outcome.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const raw of [primaryModel, ...(fallbackModels ?? [])]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
];

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}

const QUOTA_PATTERNS = [/rate\s*limit/i, /too many requests/i, /\b429\b/, /quota/i, /billing/i, /credit/i];
const AUTH_PATTERNS = [/auth(?:entication)?/i, /unauthori[sz]ed/i, /forbidden/i, /api key/i, /token expired/i, /invalid key/i];
const PROVIDER_PATTERNS = [/provider.*unavailable/i, /model.*unavailable/i, /model.*disabled/i, /model.*not found/i, /unknown model/i, /overloaded/i, /service unavailable/i, /temporar(?:ily)? unavailable/i];
const TRANSPORT_PATTERNS = [/connection refused/i, /fetch failed/i, /network error/i, /socket hang up/i, /upstream/i, /timed? out/i, /timeout/i, /\b502\b/, /\b503\b/, /\b504\b/];

/**
 * Classify a failed model attempt against the same retry-pattern surface used by
 * `isRetryableModelFailure`. Used by the outcome resolver to decide whether a
 * non-zero exit promotes to `model_unavailable` (all attempts transport/provider/
 * auth/quota) or stays as `subagent_internal_failure`.
 *
 * Returns "unknown" for successful attempts — callers should not classify success.
 */
export function classifyAttemptFailure(attempt: ModelAttempt): ModelFailureKind {
	if (attempt.success) return "unknown";
	const error = attempt.error;
	if (!error) return "unknown";
	if (QUOTA_PATTERNS.some((p) => p.test(error))) return "quota";
	if (AUTH_PATTERNS.some((p) => p.test(error))) return "auth";
	if (TRANSPORT_PATTERNS.some((p) => p.test(error))) return "transport";
	if (PROVIDER_PATTERNS.some((p) => p.test(error))) return "provider";
	return "unknown";
}
