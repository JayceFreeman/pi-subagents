import {
	findModelInfo,
	splitKnownThinkingSuffix,
	THINKING_LEVELS,
	type ModelInfo as AvailableModelInfo,
} from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export interface ModelResolution {
	resolved: string | undefined;
	error?: string;
}

export function tryResolveModelCandidate(
	model: string | undefined,
	knownModels: AvailableModelInfo[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): ModelResolution {
	if (!model) return { resolved: undefined };
	const trimmed = model.trim();
	if (!trimmed) return { resolved: undefined };
	if (!availableModels?.length) return { resolved: trimmed };

	const hit = findModelInfo(trimmed, availableModels, preferredProvider);
	if (hit) {
		const { thinkingSuffix } = splitKnownThinkingSuffix(trimmed);
		return { resolved: `${hit.fullId}${thinkingSuffix}` };
	}

	const knownHit = knownModels?.length
		? findModelInfo(trimmed, knownModels, preferredProvider)
		: undefined;
	if (knownHit) {
		return {
			resolved: undefined,
			error: `Model '${trimmed}' is registered but not authed (provider: ${knownHit.provider}). Run \`pi auth ${knownHit.provider}\`.`,
		};
	}

	const suggestion = findSuggestion(trimmed, knownModels ?? availableModels);
	return {
		resolved: undefined,
		error: suggestion
			? `Did you mean '${suggestion}'? Unknown model: '${trimmed}'.`
			: `Unknown model: '${trimmed}'. Run \`pi -m list\` to see available ids.`,
	};
}

// Backward-compat shim. Validation surfaces via buildModelCandidates.
export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	const resolution = tryResolveModelCandidate(
		model,
		availableModels,
		availableModels,
		preferredProvider,
	);
	return resolution.resolved ?? model;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	knownModels: AvailableModelInfo[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const errors: string[] = [];
	for (const raw of [primaryModel, ...(fallbackModels ?? [])]) {
		if (!raw) continue;
		const resolution = tryResolveModelCandidate(
			raw.trim(),
			knownModels,
			availableModels,
			preferredProvider,
		);
		if (resolution.resolved) {
			if (seen.has(resolution.resolved)) continue;
			seen.add(resolution.resolved);
			candidates.push(resolution.resolved);
			continue;
		}
		if (resolution.error) errors.push(resolution.error);
	}
	if (candidates.length === 0 && errors.length > 0) {
		throw new Error(errors.join("\n"));
	}
	return candidates;
}

function findSuggestion(
	input: string,
	registry: AvailableModelInfo[],
): string | undefined {
	const colonIdx = input.lastIndexOf(":");
	if (colonIdx > 0) {
		const suffixGuess = input.substring(colonIdx + 1);
		const baseGuess = input.substring(0, colonIdx);
		const isKnownLevel = (THINKING_LEVELS as readonly string[]).includes(
			suffixGuess,
		);
		if (!isKnownLevel) {
			const baseEntry = registry.find(
				(m) => m.id === baseGuess || m.fullId === baseGuess,
			);
			if (baseEntry) {
				const ranked = (THINKING_LEVELS as readonly string[])
					.map((level) => ({
						level,
						distance: levenshtein(suffixGuess, level),
					}))
					.filter(
						(entry) =>
							entry.distance > 0 &&
							entry.distance <= 2 &&
							entry.distance < suffixGuess.length,
					)
					.sort((a, b) => a.distance - b.distance);
				if (
					ranked[0] &&
					(!ranked[1] || ranked[1].distance > ranked[0].distance)
				) {
					return `${baseEntry.fullId}:${ranked[0].level}`;
				}
			}
		}
	}

	const { baseModel } = splitKnownThinkingSuffix(input);
	const target = baseModel.includes("/")
		? (baseModel.split("/").pop() ?? baseModel)
		: baseModel;
	if (!target) return undefined;
	const maxDist = Math.min(3, Math.floor(target.length / 3));
	const ranked = registry
		.map((m) => ({ model: m, distance: levenshtein(target, m.id) }))
		.filter((entry) => entry.distance > 0 && entry.distance <= maxDist)
		.sort((a, b) => a.distance - b.distance);
	if (!ranked[0]) return undefined;
	if (ranked[1] && ranked[1].distance === ranked[0].distance) return undefined;
	return ranked[0].model.fullId;
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length]!;
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
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) =>
		pattern.test(error),
	);
}

export function formatModelAttemptNote(
	attempt: ModelAttemptSummary,
	nextModel?: string,
): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
