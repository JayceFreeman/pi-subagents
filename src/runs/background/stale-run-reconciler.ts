import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { RESULTS_DIR, type AsyncParallelGroupStatus, type AsyncStatus, type SubagentRunMode } from "../../shared/types.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import {
	buildOutcome,
	parseLegacySingleResult,
	resolveOutcomeTerminal,
	type RunError,
	type RunOutcome,
} from "../shared/run-outcome.ts";

function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export type PidLiveness = "alive" | "dead" | "unknown";

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

interface StartedRunMetadata {
	runId: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agents?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	startedAt?: number;
	sessionFile?: string;
}

interface ReconcileAsyncRunOptions {
	resultsDir?: string;
	kill?: KillFn;
	now?: () => number;
	startedRun?: StartedRunMetadata;
	missingStatusGraceMs?: number;
	staleAlivePidMs?: number;
}

interface ReconcileAsyncRunResult {
	status: AsyncStatus | null;
	repaired: boolean;
	resultPath?: string;
	message?: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function appendJsonl(filePath: string, payload: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

function readStatusFile(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");
	let content: string;
	try {
		content = fs.readFileSync(statusPath, "utf-8");
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return JSON.parse(content) as AsyncStatus;
	} catch (error) {
		throw new Error(`Failed to parse async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

interface ResultChildOutcome {
	agent?: string;
	success?: boolean;
	error?: string;
	exitCode?: number;
	finalOutput?: string;
	output?: string;
	savedOutputPath?: string;
	outputSaveError?: string;
	sessionFile?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: NonNullable<AsyncStatus["steps"]>[number]["modelAttempts"];
	outcome?: RunOutcome;
}

interface ResultRepairData {
	state: "complete" | "failed" | "paused";
	results?: ResultChildOutcome[];
}

function readResultRepairData(resultPath: string): ResultRepairData | undefined {
	try {
		const data = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { success?: boolean; state?: string; exitCode?: number; results?: ResultChildOutcome[] };
		const state = data.success ? "complete" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
		return { state, ...(Array.isArray(data.results) ? { results: data.results } : {}) };
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function childState(overallState: ResultRepairData["state"], child: ResultChildOutcome | undefined): "complete" | "failed" | "paused" {
	// Prefer the discriminated outcome when present (α-2 writers): aborted
	// runs are "paused", succeeded runs are "complete", failed runs are "failed".
	if (child?.outcome?.kind === "succeeded") return "complete";
	if (child?.outcome?.kind === "aborted") return "paused";
	if (child?.outcome?.kind === "failed") return "failed";
	if (child?.success === true) return "complete";
	if (child?.success === false) return "failed";
	return overallState;
}

function terminalStatusFromResult(status: AsyncStatus, resultPath: string, now: number): AsyncStatus | undefined {
	const repair = readResultRepairData(resultPath);
	if (!repair) return undefined;
	const steps = (status.steps ?? []).map((step, index) => {
		if (step.status !== "running" && step.status !== "pending") return step;
		const child = repair.results?.[index];
		const state = childState(repair.state, child);
		// Outcome derivation: prefer child.outcome (α-2 writers), then parse legacy fields.
		const childOutcome = child?.outcome ?? (child ? parseLegacySingleResult({
			exitCode: child.exitCode ?? (state === "complete" || state === "paused" ? 0 : 1),
			error: child.error,
			finalOutput: child.finalOutput ?? child.output,
			savedOutputPath: child.savedOutputPath,
			outputSaveError: child.outputSaveError,
		}) : undefined);
		return {
			...step,
			status: state === "complete" ? "complete" as const : state,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? (state === "complete" || state === "paused" ? 0 : 1),
			error: state === "failed" ? step.error ?? child?.error : step.error,
			sessionFile: step.sessionFile ?? child?.sessionFile,
			model: step.model ?? child?.model,
			attemptedModels: step.attemptedModels ?? child?.attemptedModels,
			modelAttempts: step.modelAttempts ?? child?.modelAttempts,
			...(childOutcome ? { outcome: childOutcome } : {}),
		};
	});
	return {
		...status,
		state: repair.state,
		activityState: undefined,
		lastUpdate: now,
		endedAt: status.endedAt ?? now,
		steps,
	};
}

function buildStartedStatus(asyncDir: string, startedRun: StartedRunMetadata, now: number): AsyncStatus {
	const startedAt = startedRun.startedAt ?? now;
	const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
	const chainStepCount = startedRun.chainStepCount;
	const parallelGroups = chainStepCount !== undefined
		? normalizeParallelGroups(startedRun.parallelGroups, agents.length, chainStepCount)
		: [];
	return {
		runId: startedRun.runId || path.basename(asyncDir),
		...(startedRun.sessionId ? { sessionId: startedRun.sessionId } : {}),
		mode: startedRun.mode ?? "single",
		state: "running",
		pid: startedRun.pid,
		startedAt,
		lastUpdate: now,
		currentStep: 0,
		...(chainStepCount !== undefined ? { chainStepCount } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		steps: agents.map((agent) => ({
			agent,
			status: "running" as const,
			startedAt,
		})),
		...(startedRun.sessionFile ? { sessionFile: startedRun.sessionFile } : {}),
	};
}

function buildFailedRepair(status: AsyncStatus, asyncDir: string, now: number, reason?: string): { status: AsyncStatus; result: object; message: string } {
	const runId = status.runId || path.basename(asyncDir);
	const pid = typeof status.pid === "number" ? status.pid : "unknown";
	const message = reason ?? `Async runner process ${pid} exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`;
	const steps = status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" as const }];
	const repairedSteps = steps.map((step) => step.status === "running" || step.status === "pending"
		? {
			...step,
			status: "failed" as const,
			activityState: undefined,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? 1,
			error: step.error ?? message,
		}
		: step);
	const repairedStatus: AsyncStatus = {
		...status,
		state: "failed",
		activityState: undefined,
		lastUpdate: now,
		endedAt: now,
		steps: repairedSteps,
	};
	const resultAgent = repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
	return {
		status: repairedStatus,
		message,
		result: {
			id: runId,
			agent: resultAgent,
			mode: status.mode,
			success: false,
			state: "failed",
			summary: message,
			results: repairedSteps.map((step) => {
				const isComplete = step.status === "complete" || step.status === "completed";
				const childError: RunError = {
					code: "subagent_internal_failure",
					exitCode: 1,
					detail: step.error ?? message,
				};
				const terminal = resolveOutcomeTerminal({
					rawExitCode: isComplete ? 0 : 1,
					overrideError: isComplete ? undefined : childError,
					observedMutationAttempt: false,
					resolvedOutput: { text: isComplete ? "" : message },
				});
				const outcome = buildOutcome({
					terminal,
					output: { text: isComplete ? "" : message },
					usage: emptyUsage(),
				});
				return {
					agent: step.agent,
					output: isComplete ? "" : message,
					error: isComplete ? undefined : step.error ?? message,
					success: isComplete,
					model: step.model,
					attemptedModels: step.attemptedModels,
					modelAttempts: step.modelAttempts,
					sessionFile: step.sessionFile,
					outcome,
				};
			}),
			exitCode: 1,
			timestamp: now,
			durationMs: Math.max(0, now - status.startedAt),
			asyncDir,
			sessionId: status.sessionId,
			sessionFile: status.sessionFile,
		},
	};
}

function writeFailedRepair(asyncDir: string, status: AsyncStatus, resultPath: string, now: number, reason?: string): ReconcileAsyncRunResult {
	const repair = buildFailedRepair(status, asyncDir, now, reason);
	writeAtomicJson(resultPath, repair.result);
	writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
	appendJsonl(path.join(asyncDir, "events.jsonl"), {
		type: "subagent.run.repaired_stale",
		ts: now,
		runId: repair.status.runId,
		pid: status.pid,
		resultPath,
		message: repair.message,
	});
	return { status: repair.status, repaired: true, resultPath, message: repair.message };
}

export function checkPidLiveness(pid: number, kill: KillFn = process.kill): PidLiveness {
	try {
		kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "unknown";
		return "unknown";
	}
}

export function reconcileAsyncRun(asyncDir: string, options: ReconcileAsyncRunOptions = {}): ReconcileAsyncRunResult {
	const now = options.now?.() ?? Date.now();
	const status = readStatusFile(asyncDir);
	const startedStatus = !status && options.startedRun ? buildStartedStatus(asyncDir, options.startedRun, now) : undefined;
	const effectiveStatus = status ?? startedStatus;
	if (!effectiveStatus) return { status: null, repaired: false };

	const runId = effectiveStatus.runId || path.basename(asyncDir);
	const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
	if (fs.existsSync(resultPath)) {
		const terminalStatus = effectiveStatus.state === "running" || effectiveStatus.state === "queued"
			? terminalStatusFromResult(effectiveStatus, resultPath, now)
			: undefined;
		if (terminalStatus) {
			writeAtomicJson(path.join(asyncDir, "status.json"), terminalStatus);
			return { status: terminalStatus, repaired: true, resultPath, message: "Existing async result file was used to repair stale running status." };
		}
		return { status: effectiveStatus, repaired: false, resultPath };
	}

	if (effectiveStatus.state !== "running" || typeof effectiveStatus.pid !== "number") {
		return { status: status ?? null, repaired: false, resultPath };
	}

	if (!status) {
		const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
		if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) {
			return { status: null, repaired: false, resultPath };
		}
	}

	const liveness = checkPidLiveness(effectiveStatus.pid, options.kill);
	if (liveness !== "dead") {
		const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
		const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
		if (now - lastUpdate <= staleAfterMs) return { status: status ?? null, repaired: false, resultPath };
		const message = `Async runner process ${effectiveStatus.pid} still has a live PID, but status has not updated for ${now - lastUpdate}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`;
		return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now, message);
	}

	return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now);
}
