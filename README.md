# ClamAV Monitor

[![CI](https://github.com/Expansive-Labs-LLC/clamav-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/Expansive-Labs-LLC/clamav-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A desktop UI for ClamAV on Linux. See at a glance whether protection is
actually running, whether signatures are current, and what the last scan found —
then change any of it without editing config files or remembering
`systemctl` incantations.

> **Scope:** Linux/systemd only today. ClamAV Monitor manages an existing
> ClamAV installation; it does not install ClamAV itself. See
> [Requirements](#requirements).

## Screens

**Dashboard** — service state, signature age and definition serial, next
scheduled scans, and one-click update / quick scan / full scan / whole-system
scan. Service state is reported against what a component actually *does*, not
just what systemd says about it: real-time protection reads **Not protecting**
when clamd is down (it is a clamd client, so it scans nothing without it), a
unit skipped by an unmet `Condition*` check is called out rather than shown as
merely stopped, and a scheduled scan that exited non-zero is flagged even
though its log summary still says `Infected files: 0`.

**Configure** — toggle real-time blocking, add or remove watched folders, edit
scan schedules (validated by `systemd-analyze calendar` before saving), and
start/stop/restart services.

**Logs** — scan and daemon logs with detections highlighted, plus a
"detections only" filter.

Status auto-refreshes every 10 seconds.

## Requirements

- Linux with systemd, and a polkit authentication agent (standard on GNOME/KDE)
- ClamAV installed, with these units present:
  `clamd`, `clamav-freshclam`, `clamav-clamonacc`,
  `clamav-quickscan.timer`, `clamav-fullscan.timer`

The app reads `/usr/local/etc/clamd.conf`, matching an install of the upstream
clamav.net build under `/usr/local`. If you installed ClamAV from your
distribution's repositories the binaries and config live under `/usr`, and the
paths at the top of `main.js` need adjusting.

## Install

Download the `.deb` from [Releases](https://github.com/Expansive-Labs-LLC/clamav-monitor/releases):

```bash
sudo apt install ./clamav-monitor_*_amd64.deb
```

This installs the app to `/opt/clamav-monitor`, adds a launcher entry and
icons, symlinks `/usr/bin/clamav-monitor`, and places the privileged helper and
its polkit policy. Launch it from your applications menu or run
`clamav-monitor`.

> The install path is deliberately hyphenated. A space in it makes Chromium's
> zygote re-exec split the path (`execvp("/opt/ClamAV")`) and the app dies on
> every desktop launch while still working from a terminal — CI asserts that no
> packaged path contains a space.

<details>
<summary>apt prints "Download is performed unsandboxed as root…"</summary>

Harmless — note the `N:` (notice) prefix. Ubuntu defaults home directories to
`0750`, and the `_apt` user cannot traverse them to reach the file, so apt
performs the local copy as root instead of dropping privileges. The package
still installs correctly. To avoid it, install from a path `_apt` can read:

```bash
cp clamav-monitor_*_amd64.deb /tmp/ && sudo apt install /tmp/clamav-monitor_*_amd64.deb
```

Do not `chmod 755` your home directory to silence it.
</details>

<details>
<summary>Dashboard says the scanner daemon is "Blocked by start condition"</summary>

systemd skipped the unit because a `Condition*` check in it failed. A skipped
unit is reported as plain `inactive (dead)` with no error logged anywhere, and
units that `Requires=` it still start — so protection can stop without anything
appearing to be wrong.

The common cause on an upstream install is a hand-written `clamd.service`
carrying:

```ini
ConditionPathExists=/usr/local/share/clamav/daily.cvd
```

freshclam ships `daily.cvd` on a fresh install, then **replaces** it with
`daily.cld` the first time it applies an incremental patch. The condition is
then permanently unmet and clamd never starts again, while freshclam keeps
updating signatures — so the dashboard shows current definitions the whole
time. Fix it with a drop-in that matches either extension:

```bash
sudo systemctl edit clamd.service
```

```ini
[Unit]
ConditionPathExists=
ConditionPathExistsGlob=/usr/local/share/clamav/daily.c?d
```

```bash
sudo systemctl daemon-reload
sudo systemctl start clamd
sudo systemctl restart clamav-clamonacc
```

Restart `clamav-clamonacc` too: it is a client of clamd, and with the daemon
gone it stays `active (running)` while scanning nothing. The dashboard reports
that state as **Not protecting**.
</details>

Optional, and removes password prompts when viewing logs:

```bash
sudo usermod -aG clamav "$USER"   # then log out and back in
```

The Logs tab also offers this as a **Grant access** button.

## Development

```bash
npm install
npm run install-helper   # installs the privileged helper; needs sudo
npm start
```

| Script | Purpose |
| --- | --- |
| `npm start` | Run from source |
| `npm run selftest` | Print what the dashboard sees, as JSON, without a display |
| `npm run lint` | Syntax-check JS, shell, and JSON |
| `npm run dist` | Build the `.deb` into `dist/` |
| `npm run icon` | Regenerate the icon set (needs Python + Pillow) |

`npm run selftest` is the fastest way to diagnose "why is it showing that" —
it runs the entire status-collection path and dumps the result.

## How privilege works

Reading status needs no privileges. Everything that *changes* something goes
through one script — `/usr/lib/clamav-monitor/clamav-monitor-helper` — invoked
via `pkexec`, which raises the desktop's normal authentication prompt.

The renderer can never send a command, only an identifier that must match an
allowlist fixed at build time in `main.js`. The helper independently
re-validates every argument and refuses to touch any unit outside its own
allowlist, so the GUI cannot be used as a general-purpose root shell. The
polkit policy uses `auth_admin_keep`, so a burst of changes authenticates once
rather than per click.

Renderer hardening: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, CSP restricted to `'self'`, navigation and `window.open`
denied, and log output rendered as DOM text nodes rather than HTML — log lines
contain attacker-chosen filenames and signature names.

## Releases

`main` is released automatically by
[semantic-release](https://semantic-release.gitbook.io/) using
[Conventional Commits](https://www.conventionalcommits.org/):

| Commit prefix | Release |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` / `BREAKING CHANGE:` | major |

CI builds the `.deb` on every PR and additionally installs and removes it, so a
broken postinst fails the build rather than a user's machine.

### A note on `npm audit`

`npm audit` reports advisories under `node_modules/npm/node_modules/*`. Those
come from the npm CLI bundled inside `@semantic-release/npm`, are development
only, and are never part of the shipped `.deb`. Nothing in the packaged
application depends on them.

## Contributing

Issues and pull requests are welcome. Please use Conventional Commit messages
and make sure `npm run lint && npm run dist` passes.

## License

[MIT](LICENSE) © Expansive Labs
