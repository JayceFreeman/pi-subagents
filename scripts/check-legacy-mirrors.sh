#!/usr/bin/env bash
# α-3 sunset trigger. Fails (non-zero) while any reader outside
# src/runs/shared/run-outcome.ts still consumes `result.exitCode` or
# `result.error`. When this script first passes green in CI, α-3 is ready
# to delete the legacy mirror helpers entirely.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

matches="$(git grep -nE 'result\.exitCode|result\.error' -- 'src/runs/' \
	| grep -v '^src/runs/shared/run-outcome\.ts:' \
	|| true)"

if [ -n "$matches" ]; then
	echo "Legacy mirror readers still present (α-3 sunset blocked):"
	echo "$matches"
	echo
	echo "Migrate these sites to consume result.outcome before deleting populateLegacyMirrors."
	exit 1
fi

echo "No legacy mirror readers outside src/runs/shared/run-outcome.ts. α-3 sunset is unblocked."
