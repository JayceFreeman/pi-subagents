import test from "node:test";
import assert from "node:assert/strict";

import type { ModelAttempt, Usage } from "../../src/shared/types.ts";
import {
	buildOutcome,
	legacyError,
	legacyExitCode,
	parseLegacyGroupedResult,
	parseLegacySingleResult,
	populateLegacyMirrors,
	resolveOutcomeTerminal,
	type ResolvedOutput,
	type RunOutcome,
} from "../../src/runs/shared/run-outcome.ts";
import { declaredCannotMutate, evaluateCompletionMutationGuard } from "../../src/runs/shared/completion-guard.ts";
import { classifyAttemptFailure } from "../../src/runs/shared/model-fallback.ts";

function usage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function compose(inputs: {
	rawExitCode?: number;
	rawError?: string;
	modelAttempts?: ModelAttempt[];
	hiddenToolError?: { hasError: true; exitCode?: number; errorType?: string; details?: string };
	completionGuard?: { triggered: boolean; expectedMutation?: boolean; unexpectedMutation?: boolean };
	abort?: { reason: "interrupt" | "timeout" | "depth_limit" };
	observedMutationAttempt?: boolean;
	resolvedOutput?: Partial<ResolvedOutput>;
}): RunOutcome {
	const resolved: ResolvedOutput = {
		text: inputs.resolvedOutput?.text ?? "",
		...(inputs.resolvedOutput?.savedPath !== undefined ? { savedPath: inputs.resolvedOutput.savedPath } : {}),
		...(inputs.resolvedOutput?.requestedPath !== undefined ? { requestedPath: inputs.resolvedOutput.requestedPath } : {}),
		...(inputs.resolvedOutput?.saveError !== undefined ? { saveError: inputs.resolvedOutput.saveError } : {}),
	};
	const terminal = resolveOutcomeTerminal({
		rawExitCode: inputs.rawExitCode ?? 0,
		rawError: inputs.rawError,
		modelAttempts: inputs.modelAttempts,
		hiddenToolError: inputs.hiddenToolError,
		completionGuard: inputs.completionGuard
			? {
				triggered: inputs.completionGuard.triggered,
				expectedMutation: inputs.completionGuard.expectedMutation ?? true,
				unexpectedMutation: inputs.completionGuard.unexpectedMutation ?? false,
			}
			: undefined,
		abort: inputs.abort,
		observedMutationAttempt: inputs.observedMutationAttempt ?? false,
		resolvedOutput: resolved,
	});
	return buildOutcome({ terminal, output: resolved, usage: usage() });
}

// ── Test 1: regression pin from α-1 ─────────────────────────────────────
test("declaredCannotMutate / completion-guard short-circuit invariants survive α-2", () => {
	assert.equal(declaredCannotMutate({ tools: ["read", "grep", "find", "ls"] }), true);
	assert.equal(declaredCannotMutate({ tools: ["read", "edit"] }), false);
	const result = evaluateCompletionMutationGuard({
		agent: "architect",
		task: "Produce a proposal",
		messages: [],
		tools: ["read", "grep", "find", "ls"],
	});
	assert.equal(result.triggered, false);
	assert.equal(result.expectedMutation, false);
});

// ── Test 3: PINS the architect-40KB misdiagnosis case ────────────────────
test("completion_guard_no_mutation carries partialOutput + savedPath evidence", () => {
	const body = "x".repeat(40_000);
	const outcome = compose({
		rawExitCode: 0,
		completionGuard: { triggered: true, expectedMutation: true },
		resolvedOutput: { text: body, savedPath: "/tmp/architect.md", requestedPath: "/tmp/architect.md" },
	});
	assert.equal(outcome.kind, "failed");
	if (outcome.kind !== "failed") return;
	assert.equal(outcome.error.code, "completion_guard_no_mutation");
	if (outcome.error.code !== "completion_guard_no_mutation") return;
	assert.equal(outcome.partialOutput, body);
	assert.equal(outcome.savedPath, "/tmp/architect.md");
	assert.equal(outcome.error.evidence.partialOutput, body);
	assert.equal(outcome.error.evidence.savedPath, "/tmp/architect.md");
	assert.equal(outcome.mutated, false);
});

// ── Test 4: save-failure does NOT promote success to failure ─────────────
test("output_save_failed surfaces as warning on succeeded outcome", () => {
	const outcome = buildOutcome({
		terminal: { kind: "success" },
		output: { text: "ok", saveError: "EACCES", requestedPath: "/no/perm.md" },
		usage: usage(),
		warnings: [{ code: "output_save_failed", path: "/no/perm.md", detail: "EACCES" }],
	});
	assert.equal(outcome.kind, "succeeded");
	if (outcome.kind !== "succeeded") return;
	assert.equal(outcome.output, "ok");
	assert.deepEqual(outcome.warnings, [{ code: "output_save_failed", path: "/no/perm.md", detail: "EACCES" }]);
});

// ── Test 5: model_unavailable requires EVERY attempt promotable ──────────
test("model_unavailable fires only when every attempt is transport/provider/auth/quota", () => {
	const mkAttempt = (kind: "transport" | "tool" | "provider"): ModelAttempt => ({
		model: `m-${kind}`,
		success: false,
		exitCode: 1,
		error: kind,
		failure: { kind },
	});
	const allTransport = compose({
		rawExitCode: 1,
		modelAttempts: [mkAttempt("transport"), mkAttempt("transport")],
	});
	assert.equal(allTransport.kind, "failed");
	if (allTransport.kind !== "failed") return;
	assert.equal(allTransport.error.code, "model_unavailable");

	const mixed = compose({
		rawExitCode: 1,
		rawError: "child crashed",
		modelAttempts: [mkAttempt("transport"), mkAttempt("tool")],
	});
	assert.equal(mixed.kind, "failed");
	if (mixed.kind !== "failed") return;
	assert.equal(mixed.error.code, "subagent_internal_failure");
});

// ── Test 6: abort wins over everything; mutated flag preserved ───────────
test("abort takes precedence; mutated flag is preserved on interrupted runs", () => {
	const outcome = compose({
		rawExitCode: 130,
		abort: { reason: "interrupt" },
		observedMutationAttempt: true,
		resolvedOutput: { text: "halfway done" },
	});
	assert.equal(outcome.kind, "aborted");
	if (outcome.kind !== "aborted") return;
	assert.equal(outcome.reason, "interrupt");
	assert.equal(outcome.mutated, true);
	assert.equal(outcome.partialOutput, "halfway done");
	assert.equal(legacyExitCode(outcome), 0);
	assert.equal(legacyError(outcome), undefined);
});

// ── Test 7: parseLegacySingleResult — on-disk shim ──────────────────────
test("parseLegacySingleResult maps SIGINT exit codes and surfaces save warnings", () => {
	const interrupted = parseLegacySingleResult({ exitCode: 130, error: "Interrupted" });
	assert.equal(interrupted.kind, "aborted");
	if (interrupted.kind !== "aborted") return;
	assert.equal(interrupted.reason, "interrupt");

	const timeout = parseLegacySingleResult({ exitCode: 143 });
	assert.equal(timeout.kind, "aborted");
	if (timeout.kind === "aborted") assert.equal(timeout.reason, "timeout");

	const kill = parseLegacySingleResult({ exitCode: 137 });
	assert.equal(kill.kind, "aborted");
	if (kill.kind === "aborted") assert.equal(kill.reason, "timeout");

	const savedSucceeded = parseLegacySingleResult({
		exitCode: 0,
		finalOutput: "ok",
		outputSaveError: "EACCES",
		savedOutputPath: "/x.md",
	});
	assert.equal(savedSucceeded.kind, "succeeded");
	if (savedSucceeded.kind !== "succeeded") return;
	assert.equal(savedSucceeded.output, "ok");
	assert.deepEqual(savedSucceeded.warnings, [{ code: "output_save_failed", path: "/x.md", detail: "EACCES" }]);
});

test("parseLegacyGroupedResult walks children", () => {
	const grouped = parseLegacyGroupedResult({
		results: [
			{ exitCode: 0, finalOutput: "ok" },
			{ exitCode: 130, error: "interrupted mid-task" },
		],
	});
	assert.equal(grouped.kind, "group");
	assert.equal(grouped.children.length, 2);
	assert.equal(grouped.children[0]?.kind, "succeeded");
	assert.equal(grouped.children[1]?.kind, "aborted");
});

// ── Test 8: construction guards & legacy mirrors ─────────────────────────
test("buildOutcome accepts empty-text success (mutation-only workers are legitimate)", () => {
	const outcome = buildOutcome({
		terminal: { kind: "success" },
		output: { text: "" },
		usage: usage(),
	});
	assert.equal(outcome.kind, "succeeded");
	if (outcome.kind === "succeeded") assert.equal(outcome.output, "");
});

test("buildOutcome accepts an empty-text succeeded outcome when savedPath is present", () => {
	const outcome = buildOutcome({
		terminal: { kind: "success" },
		output: { text: "", savedPath: "/artifact.md" },
		usage: usage(),
	});
	assert.equal(outcome.kind, "succeeded");
	if (outcome.kind === "succeeded") assert.equal(outcome.savedPath, "/artifact.md");
});

test("hidden tool error wins regardless of exit code", () => {
	const onExitZero = compose({
		rawExitCode: 0,
		hiddenToolError: { hasError: true, exitCode: 2, errorType: "bash", details: "command not found" },
	});
	assert.equal(onExitZero.kind, "failed");
	if (onExitZero.kind !== "failed") return;
	assert.equal(onExitZero.error.code, "tool_error");
	if (onExitZero.error.code !== "tool_error") return;
	assert.equal(onExitZero.error.tool, "bash");
	assert.equal(onExitZero.error.exitCode, 2);
});

test("rawError beats completion-guard: real process error wins over no-mutation signal", () => {
	const outcome = compose({
		rawExitCode: 0,
		rawError: "streaming aborted mid-response",
		completionGuard: { triggered: true, expectedMutation: true },
		resolvedOutput: { text: "partial" },
	});
	assert.equal(outcome.kind, "failed");
	if (outcome.kind !== "failed") return;
	assert.equal(outcome.error.code, "subagent_internal_failure");
	if (outcome.error.code !== "subagent_internal_failure") return;
	assert.equal(outcome.error.detail, "streaming aborted mid-response");
});

test("completion-guard with empty output produces empty evidence, not a throw", () => {
	const outcome = compose({
		rawExitCode: 0,
		completionGuard: { triggered: true, expectedMutation: true },
		resolvedOutput: { text: "" },
	});
	assert.equal(outcome.kind, "failed");
	if (outcome.kind !== "failed") return;
	assert.equal(outcome.error.code, "completion_guard_no_mutation");
	if (outcome.error.code !== "completion_guard_no_mutation") return;
	assert.equal(outcome.error.evidence.partialOutput, "");
});

test("bare rawError on exit 0 still produces subagent_internal_failure", () => {
	const outcome = compose({ rawExitCode: 0, rawError: "streaming abort" });
	assert.equal(outcome.kind, "failed");
	if (outcome.kind !== "failed") return;
	assert.equal(outcome.error.code, "subagent_internal_failure");
	if (outcome.error.code !== "subagent_internal_failure") return;
	assert.equal(outcome.error.exitCode, 1);
	assert.equal(outcome.error.detail, "streaming abort");
});

test("populateLegacyMirrors mirrors savedPath on success as well as failure", () => {
	const succeeded = buildOutcome({
		terminal: { kind: "success" },
		output: { text: "ok", savedPath: "/out.md", requestedPath: "/out.md" },
		usage: usage(),
	});
	const result: { exitCode: number; error?: string; outcome?: RunOutcome; savedOutputPath?: string } = { exitCode: 0 };
	populateLegacyMirrors(result as Parameters<typeof populateLegacyMirrors>[0], succeeded);
	assert.equal(result.savedOutputPath, "/out.md");
	assert.equal(result.exitCode, 0);
	assert.equal(result.error, undefined);
});

test("legacyExitCode and legacyError mirror outcomes without losing interrupt semantics", () => {
	const aborted = compose({ rawExitCode: 130, abort: { reason: "interrupt" }, resolvedOutput: { text: "x" } });
	assert.equal(legacyExitCode(aborted), 0);
	assert.equal(legacyError(aborted), undefined);

	const internal = compose({ rawExitCode: 7, rawError: "boom" });
	assert.equal(legacyExitCode(internal), 7);
	assert.equal(legacyError(internal), "boom");

	const result: { exitCode: number; error?: string; outcome?: RunOutcome; savedOutputPath?: string } = { exitCode: 0 };
	populateLegacyMirrors(result as Parameters<typeof populateLegacyMirrors>[0], aborted);
	assert.equal(result.exitCode, 0);
	assert.equal(result.error, undefined);
	assert.equal(result.outcome, aborted);
});

test("classifyAttemptFailure routes retry-pattern errors to the right kind", () => {
	assert.equal(classifyAttemptFailure({ model: "m", success: false, error: "429 rate limit" }), "quota");
	assert.equal(classifyAttemptFailure({ model: "m", success: false, error: "unauthorized" }), "auth");
	assert.equal(classifyAttemptFailure({ model: "m", success: false, error: "fetch failed: ECONNRESET" }), "transport");
	assert.equal(classifyAttemptFailure({ model: "m", success: false, error: "model unavailable" }), "provider");
	assert.equal(classifyAttemptFailure({ model: "m", success: false, error: "weird thing nobody recognizes" }), "unknown");
	assert.equal(classifyAttemptFailure({ model: "m", success: true }), "unknown");
});

// ── Test 9 (stretch): unexpectedMutation control event ───────────────────
// The wiring lives inline in execution.ts / subagent-runner.ts and emits a
// distinct reason: "unexpected_mutation" control event independently of the
// outcome. Unit-level testing would require extracting a pure helper
// (redesign) or spawning a fork (out of unit scope); see §11 smoke test.
test.skip("(stretch) unexpectedMutation control event fires distinctly from completion_guard");
