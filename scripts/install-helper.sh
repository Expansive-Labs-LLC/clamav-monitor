#!/usr/bin/env bash
# Installs the privileged helper and its polkit policy.
# Run once, from the project directory:  npm run install-helper
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_SRC="$HERE/helper/clamav-monitor-helper"
POLICY_SRC="$HERE/helper/io.expansivelabs.clamavmonitor.policy"

[ -f "$HELPER_SRC" ] || { echo "missing $HELPER_SRC" >&2; exit 1; }
[ -f "$POLICY_SRC" ] || { echo "missing $POLICY_SRC" >&2; exit 1; }

echo "==> Installing helper (requires sudo)"
# Root-owned and not group/world writable: pkexec refuses to run a program
# that a non-root user could modify, and rightly so.
# Same path the .deb uses, so dev and packaged installs never diverge.
sudo install -d -o root -g root -m 0755 /usr/lib/clamav-monitor
sudo install -o root -g root -m 0755 "$HELPER_SRC" /usr/lib/clamav-monitor/clamav-monitor-helper

echo "==> Installing polkit policy"
sudo install -o root -g root -m 0644 "$POLICY_SRC" \
  /usr/share/polkit-1/actions/io.expansivelabs.clamavmonitor.policy

echo
echo "Installed:"
echo "  /usr/lib/clamav-monitor/clamav-monitor-helper"
echo "  /usr/share/polkit-1/actions/io.expansivelabs.clamavmonitor.policy"
echo
echo "Optional, removes password prompts for reading logs:"
echo "  sudo usermod -aG clamav $USER   (then log out and back in)"
