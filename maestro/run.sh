#!/bin/bash
# Run Maestro E2E tests for War Room
# Usage: ./maestro/run.sh [flow-file]
# Examples:
#   ./maestro/run.sh                              # Run all flows
#   ./maestro/run.sh maestro/flows/01-app-loads.yaml  # Run single flow

set -e

# Java — try system, then user-local, then /opt (Docker)
if ! command -v java &>/dev/null; then
  for jdk in "$HOME/.local/jdk" /opt/jdk; do
    if [ -x "$jdk/bin/java" ]; then
      export JAVA_HOME="$jdk"
      export PATH="$jdk/bin:$PATH"
      break
    fi
  done
fi

# Maestro — add to PATH if not already there
if ! command -v maestro &>/dev/null; then
  export PATH="$HOME/.maestro/bin:$PATH"
fi

export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true

cd "$(dirname "$0")/.."

FLOW="${1:-maestro/flows/}"

echo "Running Maestro E2E tests: $FLOW"

# Use Xvfb for headless execution if no display is available
if [ -z "$DISPLAY" ] && command -v xvfb-run &>/dev/null; then
  xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
    maestro -p web test "$FLOW"
else
  maestro -p web test "$FLOW"
fi
