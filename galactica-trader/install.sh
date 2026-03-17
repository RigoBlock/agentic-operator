#!/usr/bin/env bash
# Install the Galactica Trader SDK and run WDK integration test.
#
# Usage:
#   ./install.sh
#
# The browser chat at trader.rigoblock.com needs no install.
# This script is for developers who want the TypeScript SDK
# with WDK wallet integration for external agent access.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SKILL_DIR")"

# Install SDK dependencies (includes bare-crypto postinstall patch)
SDK_DIR="${REPO_DIR}/sdk"
if [[ -f "${SDK_DIR}/package.json" ]]; then
  echo "Installing SDK dependencies..."
  cd "${SDK_DIR}"
  npm install --no-fund --no-audit 2>/dev/null
  echo "✓ SDK installed"

  # Run E2E test to verify WDK integration
  echo ""
  echo "Running WDK integration test..."
  npx tsx test/test-secure-wallet.ts
fi

echo ""
echo "Done! Open https://trader.rigoblock.com to use the browser chat."
echo "Or use the SDK for programmatic access — see sdk/README.md"
