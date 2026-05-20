/**
 * RunOutcome — the honest, discriminated result of a single subagent run.
 *
 * One resolver (`resolveOutcomeTerminal`) classifies; one builder (`buildOutcome`)
 * constructs. Foreground, background, and reconciler share the same precedence —
 * the only difference between them is the inputs they gather.
 *
 * Legacy `exitCode` / `error` / `savedOutputPath` mirrors are populated by
 * `populateLegacyMirrors` for the duration of the α-3 sunset. New readers consume
 * `result.outcome`; the legacy fields are retired by the CI grep in
 * `scripts/check-legacy-mirrors.sh`.
 */

import type {
	ErrorInfo,
	ModelAttempt,
	SingleResult,
	TruncationResult,
	Usage,
} from "../../shared/types.ts";

// ─── Outcome ─────────────────────────────────────────────────────────────

export type AbortReason = "interrupt" | "timeout" | "depth_limit";

export type RunWarning =
	| { code: "output_save_failed"; path: string; detail: string };

export type ModelFailureKind =
	| "transport"
	| "provider"
	| "auth"
	| "quota"
	| "tool"
	| "completion_guard"
	| "spawn"
	| "unknown";

export interface ModelAttemptFailure {
	kind: ModelFailureKind;
	detail?: string;
}

export type CompletionGuardEvidence =
	| { partialOutput: string; savedPath?: string }
	| { partialOutput?: string; savedPath: string };

export type RunError =
	| { code: "completion_guard_no_mutation"; detail: string; evidence: CompletionGuardEvidence }
	| { code: "subagent_internal_failure"; exitCode: number; detail: string }
	| { code: "tool_error"; tool: string; exitCode?: number; detail: string }
	| { code: "model_unavailable"; attempts: readonly ModelAttempt[]; detail: string }
	| { code: "unknown"; detail: string };

export type RunOutcome =
	| {
		kind: "succeeded";
		output: string;
		savedPath?: string;
		requestedPath?: string;
		usage: Usage;
		warnings?: readonly RunWarning[];
	}
	| {
		kind: "failed";
		error: RunError;
		partialOutput?: string;
		savedPath?: string;
		requestedPath?: string;
		mutated: boolean;
		usage: Usage;
		warnings?: readonly RunWarning[];
	}
	| {
		kind: "aborted";
		reason: AbortReason;
		partialOutput?: string;
		savedPath?: string;
		requestedPath?: string;
		mutated: boolean;
		usage: Usage;
		warnings?: readonly RunWarning[];
	};

export type GroupedRunOutcome = {
	kind: "group";
	children: RunOutcome[];
};

// ─── Resolver / builder split ────────────────────────────────────────────

export type OutcomeTerminal =
	| { kind: "success" }
	| { kind: "failed"; error: RunError; mutated: boolean }
	| { kind: "aborted"; reason: AbortReason; mutated: boolean };

export interface ResolvedOutput {
	text: string;
	savedPath?: string;
	requestedPath?: string;
	saveError?: string;
	truncation?: TruncationResult;
}

export interface OutcomeResolverInputs {
	rawExitCode: number;
	rawError?: string;
	modelAttempts?: readonly ModelAttempt[];
	hiddenToolError?: ErrorInfo;
	completionGuard?: {
		triggered: boolean;
		expectedMutation: boolean;
		unexpectedMutation: boolean;
	};
	abort?: { reason: AbortReason };
	overrideError?: RunError;
	observedMutationAttempt: boolean;
	resolvedOutput: ResolvedOutput;
}

const PROMOTABLE_FAILURE_KINDS: ReadonlySet<ModelFailureKind> = new Set<ModelFailureKind>([
	"transport",
	"provider",
	"auth",
	"quota",
]);

function allAttemptsPromotable(attempts: readonly ModelAttempt[] | undefined): boolean {
	if (!attempts || attempts.length === 0) return false;
	return attempts.every((attempt) =>
		attempt.failure !== undefined && PROMOTABLE_FAILURE_KINDS.has(attempt.failure.kind),
	);
}

function toolErrorFromInfo(info: ErrorInfo): Extract<RunError, { code: "tool_error" }> {
	const tool = info.errorType ?? "tool";
	const detail = info.details
		? `${tool} failed (exit ${info.exitCode ?? 1}): ${info.details}`
		: `${tool} failed with exit code ${info.exitCode ?? 1}`;
	return {
		code: "tool_error",
		tool,
		...(info.exitCode !== undefined ? { exitCode: info.exitCode } : {}),
		detail,
	};
}

function modelUnavailableError(attempts: readonly ModelAttempt[]): Extract<RunError, { code: "model_unavailable" }> {
	const trail = attempts
		.map((a) => `${a.model}: ${a.failure?.kind ?? "unknown"}${a.error ? ` (${a.error.trim()})` : ""}`)
		.join("; ");
	return {
		code: "model_unavailable",
		attempts,
		detail: `All model attempts failed transport/provider/auth/quota: ${trail}`,
	};
}

function buildEvidence(output: ResolvedOutput): CompletionGuardEvidence {
	if (output.savedPath && output.text) {
		return { partialOutput: output.text, savedPath: output.savedPath };
	}
	if (output.savedPath) return { savedPath: output.savedPath };
	// Empty partialOutput is legitimate — the guard fired precisely because the
	// agent returned nothing. The empty string IS the evidence.
	return { partialOutput: output.text ?? "" };
}

/**
 * Precedence (top wins; identical for foreground / background / reconciler):
 *   1. abort                                            → aborted
 *   2. overrideError                                    → failed
 *   3. rawExitCode !== 0 ∧ all attempts promotable      → failed{model_unavailable}
 *   4. hiddenToolError                                  → failed{tool_error}
 *      (wins regardless of rawExitCode — hidden tool errors commonly
 *       report on exit 0; gating this on exit !== 0 would dead-code
 *       the tool_error variant for the common case.)
 *   5. rawExitCode === 0 ∧ !rawError ∧ completionGuard.triggered
 *                                                       → failed{completion_guard_no_mutation, evidence}
 *      (rawError wins over completion guard — a real process-level error
 *       describes the cause more accurately than "no mutation".)
 *   6. rawExitCode !== 0 ∨ rawError                     → failed{subagent_internal_failure}
 *   7. else                                             → success
 */
export function resolveOutcomeTerminal(inputs: OutcomeResolverInputs): OutcomeTerminal {
	const mutated = inputs.observedMutationAttempt;

	if (inputs.abort) {
		return { kind: "aborted", reason: inputs.abort.reason, mutated };
	}
	if (inputs.overrideError) {
		return { kind: "failed", error: inputs.overrideError, mutated };
	}
	if (inputs.rawExitCode !== 0 && allAttemptsPromotable(inputs.modelAttempts)) {
		return {
			kind: "failed",
			error: modelUnavailableError(inputs.modelAttempts as readonly ModelAttempt[]),
			mutated,
		};
	}
	if (inputs.hiddenToolError?.hasError) {
		return { kind: "failed", error: toolErrorFromInfo(inputs.hiddenToolError), mutated };
	}
	if (inputs.rawExitCode === 0 && !inputs.rawError && inputs.completionGuard?.triggered) {
		return {
			kind: "failed",
			error: {
				code: "completion_guard_no_mutation",
				detail:
					"Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.",
				evidence: buildEvidence(inputs.resolvedOutput),
			},
			mutated,
		};
	}
	if (inputs.rawExitCode !== 0 || inputs.rawError) {
		const exitCode = inputs.rawExitCode !== 0 ? inputs.rawExitCode : 1;
		return {
			kind: "failed",
			error: {
				code: "subagent_internal_failure",
				exitCode,
				detail: inputs.rawError ?? `Subagent exited with code ${exitCode}`,
			},
			mutated,
		};
	}
	return { kind: "success" };
}

export interface BuildOutcomeInput {
	terminal: OutcomeTerminal;
	output: ResolvedOutput;
	usage: Usage;
	warnings?: readonly RunWarning[];
}

/**
 * Constructs the outcome value. `completion_guard_no_mutation` carries
 * evidence (type-enforced by `CompletionGuardEvidence`). Empty-output success
 * is legitimate — a worker that succeeded by mutating files without narrating
 * still succeeded — so no runtime guard is needed on the success path.
 */
export function buildOutcome(input: BuildOutcomeInput): RunOutcome {
	const { terminal, output, usage, warnings } = input;
	const requestedPath = output.requestedPath;
	const savedPath = output.savedPath;
	const warningsOpt = warnings && warnings.length > 0 ? warnings : undefined;

	if (terminal.kind === "success") {
		return {
			kind: "succeeded",
			output: output.text,
			...(savedPath !== undefined ? { savedPath } : {}),
			...(requestedPath !== undefined ? { requestedPath } : {}),
			usage,
			...(warningsOpt ? { warnings: warningsOpt } : {}),
		};
	}
	if (terminal.kind === "aborted") {
		return {
			kind: "aborted",
			reason: terminal.reason,
			...(output.text ? { partialOutput: output.text } : {}),
			...(savedPath !== undefined ? { savedPath } : {}),
			...(requestedPath !== undefined ? { requestedPath } : {}),
			mutated: terminal.mutated,
			usage,
			...(warningsOpt ? { warnings: warningsOpt } : {}),
		};
	}
	return {
		kind: "failed",
		error: terminal.error,
		...(output.text ? { partialOutput: output.text } : {}),
		...(savedPath !== undefined ? { savedPath } : {}),
		...(requestedPath !== undefined ? { requestedPath } : {}),
		mutated: terminal.mutated,
		usage,
		...(warningsOpt ? { warnings: warningsOpt } : {}),
	};
}

// ─── Legacy mirrors ──────────────────────────────────────────────────────

export function legacyExitCode(outcome: RunOutcome): number {
	switch (outcome.kind) {
		case "succeeded":
		case "aborted":
			return 0;
		case "failed":
			switch (outcome.error.code) {
				case "subagent_internal_failure":
					return outcome.error.exitCode;
				case "tool_error":
					return outcome.error.exitCode ?? 1;
				default:
					return 1;
			}
	}
}

export function legacyError(outcome: RunOutcome): string | undefined {
	if (outcome.kind === "succeeded" || outcome.kind === "aborted") return undefined;
	return outcome.error.detail;
}

export function populateLegacyMirrors(result: SingleResult, outcome: RunOutcome): void {
	result.outcome = outcome;
	result.exitCode = legacyExitCode(outcome);
	result.error = legacyError(outcome);
	// Mirror savedPath on every kind. File-only consumers and the
	// outputReference reader expect it on success too.
	result.savedOutputPath = outcome.savedPath;
}

// ─── Legacy on-disk shim ─────────────────────────────────────────────────

const ABORT_EXIT_CODE_MAP: Record<number, AbortReason> = {
	130: "interrupt",
	143: "timeout",
	137: "timeout",
};

interface LegacySingleResultRaw {
	exitCode?: number;
	error?: string;
	finalOutput?: string;
	savedOutputPath?: string;
	outputSaveError?: string;
	usage?: Usage;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function parseLegacySingleResult(raw: LegacySingleResultRaw): RunOutcome {
	const exitCode = raw.exitCode ?? 0;
	const usage = raw.usage ?? emptyUsage();
	const text = raw.finalOutput ?? "";
	const savedPath = raw.savedOutputPath;
	const saveWarnings: RunWarning[] = raw.outputSaveError
		? [{
			code: "output_save_failed",
			path: raw.savedOutputPath ?? "",
			detail: raw.outputSaveError,
		}]
		: [];
	const warningsOpt = saveWarnings.length > 0 ? saveWarnings : undefined;

	const abortReason = ABORT_EXIT_CODE_MAP[exitCode];
	if (abortReason) {
		return {
			kind: "aborted",
			reason: abortReason,
			...(text ? { partialOutput: text } : {}),
			...(savedPath !== undefined ? { savedPath } : {}),
			mutated: false,
			usage,
			...(warningsOpt ? { warnings: warningsOpt } : {}),
		};
	}
	if (exitCode !== 0 || raw.error) {
		return {
			kind: "failed",
			error: {
				code: "unknown",
				detail: raw.error ?? `Subagent exited with code ${exitCode}`,
			},
			...(text ? { partialOutput: text } : {}),
			...(savedPath !== undefined ? { savedPath } : {}),
			mutated: false,
			usage,
			...(warningsOpt ? { warnings: warningsOpt } : {}),
		};
	}
	return {
		kind: "succeeded",
		output: text,
		...(savedPath !== undefined ? { savedPath } : {}),
		usage,
		...(warningsOpt ? { warnings: warningsOpt } : {}),
	};
}

export function parseLegacyGroupedResult(raw: { results?: unknown[] }): GroupedRunOutcome {
	const children: RunOutcome[] = (raw.results ?? [])
		.filter((entry): entry is LegacySingleResultRaw => typeof entry === "object" && entry !== null)
		.map((entry) => parseLegacySingleResult(entry));
	return { kind: "group", children };
}
