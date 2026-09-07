#!/bin/bash
# Appended to the .deb's postrm by electron-builder.
# Removes only the files postinst created outside the package payload; dpkg
# handles everything under /opt itself.
set -e

case "$1" in
  remove|purge)
    rm -f /usr/lib/clamav-monitor/clamav-monitor-helper
    rm -f /usr/share/polkit-1/actions/io.expansivelabs.clamavmonitor.policy
    rm -f /usr/bin/clamav-monitor
    rmdir --ignore-fail-on-non-empty /usr/lib/clamav-monitor 2>/dev/null || true

    update-desktop-database -q /usr/share/applications 2>/dev/null || true
    gtk-update-icon-cache -q -f /usr/share/icons/hicolor 2>/dev/null || true
    ;;
esac

exit 0
