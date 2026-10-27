#!/usr/bin/env bash
# Firestore rules gate — starts the emulator, runs the rules matrix, stops it.
#
#   bash tests/run-rules.sh
#
# Nothing here touches the production project. The emulator is a local JVM that
# answers Firestore calls against firestore.rules on disk, so this is safe to run
# on every commit and costs zero read/write quota.
set -uo pipefail

cd "$(dirname "$0")"

die() { echo "run-rules: $*" >&2; exit 1; }

# --- a JRE is required by the Firestore emulator ---------------------------------
if [ -z "${JAVA_HOME:-}" ]; then
    for candidate in /opt/data/opt/jdk-*/ /usr/lib/jvm/*/; do
        [ -x "${candidate}bin/java" ] && JAVA_HOME="$candidate" && break
    done
fi
[ -n "${JAVA_HOME:-}" ] && export JAVA_HOME
command -v java >/dev/null 2>&1 || [ -x "${JAVA_HOME:-}/bin/java" ] || \
    die "no Java runtime found. Install a JRE 11+ or set JAVA_HOME."
[ -x "${JAVA_HOME:-}/bin/java" ] && export PATH="$JAVA_HOME/bin:$PATH"

# --- node deps -------------------------------------------------------------------
[ -d node_modules/firebase-tools ] || {
    echo "run-rules: installing test dependencies (first run only)…"
    npm install --no-audit --no-fund --loglevel=error || die "npm install failed"
}

export FIRESTORE_EMULATOR_HOST="127.0.0.1:8089"

# --- run -------------------------------------------------------------------------
# `emulators:exec` boots the emulator, waits for the port, runs the command, and
# tears the emulator down regardless of the command's exit code.
npx firebase emulators:exec \
    --only firestore \
    --project demo-tgrules \
    "node rules.test.mjs"
