#!/usr/bin/env bash
# Install the Galactica Trader skill into OpenClaw.
#
# Usage:
#   ./install.sh              # symlink (dev — auto-picks up SKILL.md changes)
#   ./install.sh --copy       # copy (production — standalone)
#
# Or install from ClawHub:
#   clawhub install galactica-trader
#
# After install, open OpenClaw and ask:
#   "Use the galactica-trader skill to show vault info on Arbitrum"

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SKILL_DIR")"
TARGET_DIR="${HOME}/.openclaw/skills/galactica-trader"

# 1. Create skill directory in OpenClaw
mkdir -p "$(dirname "$TARGET_DIR")"

if [[ "${1:-}" == "--copy" ]]; then
  echo "Copying skill to ${TARGET_DIR}..."
  rm -rf "$TARGET_DIR"
  cp -r "$SKILL_DIR" "$TARGET_DIR"
else
  echo "Symlinking skill to ${TARGET_DIR}..."
  rm -rf "$TARGET_DIR"
  ln -s "$SKILL_DIR" "$TARGET_DIR"
fi

echo "✓ Skill installed at ${TARGET_DIR}"

# 2. Install SDK dependencies (includes bare-crypto postinstall patch)
SDK_DIR="${REPO_DIR}/sdk"
if [[ -f "${SDK_DIR}/package.json" ]]; then
  echo ""
  echo "Installing SDK dependencies..."
  cd "${SDK_DIR}"
  npm install --no-fund --no-audit 2>/dev/null
  echo "✓ SDK installed"

  # 3. Run E2E test to verify WDK integration
  echo ""
  echo "Running WDK integration test..."
  npx tsx test/test-secure-wallet.ts
fi

echo ""
echo "Done! Open OpenClaw and try:"
echo '  "Use the galactica-trader skill to set up the XAUT/USDT LP + hedge strategy"'
