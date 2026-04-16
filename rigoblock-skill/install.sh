#!/usr/bin/env bash
# Install the Rigoblock DeFi SDK.
#
# Usage:
#   ./install.sh
#
# The browser chat at trader.rigoblock.com needs no install.
# This script is for developers who want the TypeScript SDK
# for programmatic external agent access.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SKILL_DIR")"

# Install SDK dependencies
SDK_DIR="${REPO_DIR}/sdk"
if [[ -f "${SDK_DIR}/package.json" ]]; then
  echo "Installing SDK dependencies..."
  cd "${SDK_DIR}"
  npm install --no-fund --no-audit 2>/dev/null
  echo "✓ SDK installed"
fi

echo ""
echo "Done! Open https://trader.rigoblock.com to use the browser chat."
echo "Or use the SDK for programmatic access — see sdk/README.md"
