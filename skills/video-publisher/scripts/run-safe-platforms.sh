#!/usr/bin/env bash
# Forward every argument unchanged to the maintained publisher. It owns platform
# parsing, the locked SHA-256 duplicate guard, recovery and verified local ledger
# writes.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${script_dir}/v2/publisher.mjs" "$@"
