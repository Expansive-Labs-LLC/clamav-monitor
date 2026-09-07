#!/bin/bash
# BECOMES the .deb's postinst -- electron-builder's `afterInstall` REPLACES its
# default script rather than appending to it. Anything the default did must
# therefore be reproduced here; the chrome-sandbox chmod below is the critical
# one, and omitting it stops the app launching at all.
set -e

# No space in this path, deliberately: a space here makes Chromium's zygote
# re-exec fail with execvp("/opt/ClamAV") and the app dies on desktop launch.
APP_DIR=/opt/clamav-monitor
RES="$APP_DIR/resources/helper"

# Electron's setuid sandbox helper. Required because Ubuntu 24.04 sets
# kernel.apparmor_restrict_unprivileged_userns=1, which blocks Chromium's
# unprivileged-user-namespace sandbox; without the setuid bit there is no
# usable sandbox left and the process aborts on startup.
if [ -f "$APP_DIR/chrome-sandbox" ]; then
  chown root:root "$APP_DIR/chrome-sandbox" || true
  chmod 4755 "$APP_DIR/chrome-sandbox" || true
fi

# Remove the pre-1.0 install directory, which contained a space.
rm -rf "/opt/ClamAV Monitor" 2>/dev/null || true

if [ -d "$RES" ]; then
  install -d -o root -g root -m 0755 /usr/lib/clamav-monitor

  # pkexec refuses to run anything a non-root user could modify, so the helper
  # must end up root-owned and not group/world writable.
  install -o root -g root -m 0755 \
    "$RES/clamav-monitor-helper" /usr/lib/clamav-monitor/clamav-monitor-helper

  install -o root -g root -m 0644 \
    "$RES/io.expansivelabs.clamavmonitor.policy" \
    /usr/share/polkit-1/actions/io.expansivelabs.clamavmonitor.policy
fi

# Launchable from a terminal as `clamav-monitor`, not just from the app grid.
ln -sf "$APP_DIR/clamav-monitor" /usr/bin/clamav-monitor

# Make the new launcher and icon show up without a re-login.
update-desktop-database -q /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache -q -f /usr/share/icons/hicolor 2>/dev/null || true

exit 0
