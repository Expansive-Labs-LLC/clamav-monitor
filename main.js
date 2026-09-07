'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Allowlists.
//
// The renderer never sends a command, only an identifier that must appear in
// one of these tables. Everything reaching execFile() is therefore fixed at
// build time, so a compromised renderer cannot escalate into arbitrary root
// execution -- which matters a lot here, since several actions run via pkexec.
// ---------------------------------------------------------------------------

// Fixed absolute path, matching the polkit policy's exec.path annotation.
// /usr/lib rather than /usr/local/bin because Debian policy reserves
// /usr/local for the administrator -- a .deb must not write there.
const HELPER = '/usr/lib/clamav-monitor/clamav-monitor-helper';

const SERVICES = [
  { id: 'clamd', label: 'Scanner daemon', desc: 'Holds signatures in memory; required by everything else' },
  { id: 'clamav-freshclam', label: 'Signature updater', desc: 'Checks for new definitions hourly' },
  {
    id: 'clamav-clamonacc', label: 'Real-time protection',
    desc: 'Blocks access to infected files as they appear',
    // clamonacc is a *client* of clamd, not a scanner. systemd's own
    // Requires=clamd.service does not keep them honest: if clamd is skipped by
    // an unmet Condition, systemd treats the dependency as satisfied and
    // starts clamonacc anyway, which then sits "active (running)" against a
    // socket that does not exist. Track the dependency here so the dashboard
    // can say so instead of showing a green light over nothing.
    requires: 'clamd',
  },
];

const TIMERS = [
  {
    id: 'clamav-quickscan.timer', label: 'Daily quick scan',
    service: 'clamav-quickscan.service', log: 'scan-quick',
  },
  {
    id: 'clamav-fullscan.timer', label: 'Weekly full scan',
    service: 'clamav-fullscan.service', log: 'scan-full',
  },
];

const LOGS = {
  'clamd': '/var/log/clamav/clamd.log',
  'freshclam': '/var/log/clamav/freshclam.log',
  'clamonacc': '/var/log/clamav/clamonacc.log',
  'scan-quick': '/var/log/clamav/scan-quick.log',
  'scan-full': '/var/log/clamav/scan-full.log',
};

// Privileged actions, each mapped to a fixed helper subcommand.
const ACTIONS = {
  'update-signatures': ['update'],
  'scan-quick': ['scan', 'quick'],
  'scan-full': ['scan', 'full'],
  'scan-system': ['scan', 'system'],
  'grant-access': ['grant-access'],
};

const DB_DIR = '/usr/local/share/clamav';
const CLAMD_CONF = '/usr/local/etc/clamd.conf';

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim(),
        });
      });
  });
}

// pkexec raises a graphical polkit prompt. Exit code 126 means the user
// dismissed or failed authentication -- surfaced as a cancel, not an error,
// so a dismissed prompt doesn't look like a broken app.
async function runPrivileged(helperArgs) {
  // Check first: without the helper, pkexec fails with a bare
  // "Error accessing <path>: No such file or directory", which tells the user
  // nothing about what to actually do.
  try {
    await fs.access(HELPER);
  } catch {
    return {
      ok: false,
      stdout: '',
      stderr: `Privileged helper is not installed at ${HELPER}. ` +
              'Install the .deb package, or run "npm run install-helper" for a dev checkout.',
    };
  }

  const res = await run('pkexec', [HELPER, ...helperArgs], { timeout: 120000 });
  if (!res.ok && res.code === 126) {
    return { ok: false, cancelled: true, stdout: '', stderr: 'Authentication dismissed' };
  }
  if (!res.ok && res.code === 127) {
    return { ok: false, stdout: '', stderr: 'Helper could not be executed (check it is root-owned and mode 0755).' };
  }
  return res;
}

// ---------------------------------------------------------------------------
// Status collection
// ---------------------------------------------------------------------------

async function unitState(unit) {
  // ConditionResult matters as much as ActiveState here. A unit whose
  // Condition* checks fail is *skipped*, not failed: systemd reports it as
  // plain "inactive (dead)" with no error anywhere, and dependent units start
  // as though it were fine. That is a silent-protection-loss failure mode, so
  // it gets its own state rather than being flattened into "Stopped".
  const props = 'ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,Description,' +
                'ConditionResult,ConditionTimestamp';
  const res = await run('systemctl', ['show', unit, `--property=${props}`]);
  const out = {};
  for (const line of res.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  // Only meaningful while the unit is down; a running unit's last condition
  // check is ancient history.
  const skipped = (out.ActiveState || '') !== 'active' &&
                  (out.ConditionResult || '') === 'no';

  return {
    unit,
    active: out.ActiveState || 'unknown',
    sub: out.SubState || '',
    enabled: out.UnitFileState || 'unknown',
    since: out.ActiveEnterTimestamp || '',
    installed: (out.UnitFileState || '') !== '',
    conditionFailed: skipped,
    conditionCheckedAt: skipped ? (out.ConditionTimestamp || '') : '',
  };
}

// A GUI-launched app inherits a reduced PATH that often lacks /usr/local/bin,
// so resolve the binary by absolute path rather than trusting PATH.
async function resolveBinary(name, candidates) {
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch { /* try next */ }
  }
  return name;   // fall back to PATH lookup
}

// freshclam ships daily.cvd on a fresh install, then REPLACES it with
// daily.cld once it applies its first incremental patch. Checking only .cvd
// makes the database look missing roughly a day after install.
async function statDatabase(base) {
  for (const ext of ['cld', 'cvd']) {
    try {
      return await fs.stat(path.join(DB_DIR, `${base}.${ext}`));
    } catch { /* try next extension */ }
  }
  return null;
}

async function databaseInfo() {
  const info = {
    version: null, engine: null, serial: null,
    updated: null, ageHours: null, sizeBytes: 0, error: null,
  };

  // Engine and definition serial come from clamscan itself, independently of
  // the files on disk, so a naming surprise cannot hide the version too.
  const bin = await resolveBinary('clamscan', ['/usr/local/bin/clamscan', '/usr/bin/clamscan']);
  const res = await run(bin, ['--version'], { timeout: 20000 });
  if (res.ok && res.stdout.startsWith('ClamAV')) {
    // "ClamAV 1.5.4/28087/Sun Aug  9 02:24:56 2026"
    const parts = res.stdout.split('/');
    info.version = res.stdout;
    info.engine = parts[0]?.replace('ClamAV', '').trim() || null;
    info.serial = parts[1] || null;
  }

  // daily is the file that actually changes; use it for freshness.
  const daily = await statDatabase('daily');
  if (daily) {
    info.updated = daily.mtime.toISOString();
    info.ageHours = (Date.now() - daily.mtimeMs) / 3_600_000;
  } else {
    info.error = `No signature database in ${DB_DIR}`;
  }

  for (const base of ['daily', 'main', 'bytecode']) {
    const st = await statDatabase(base);
    if (st) info.sizeBytes += st.size;
  }

  return info;
}

// systemd emits these as MICROSECOND epoch integers, and reports `left` as
// the same absolute timestamp rather than a duration -- so the remaining time
// has to be derived here instead of taken at face value. 0 means "never".
function usecToDate(usec) {
  if (!usec || usec <= 0) return null;
  return new Date(usec / 1000);
}

function humanDuration(ms) {
  if (ms <= 0) return 'due now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

// The timer tells you when a scan ran; only the service it triggered tells you
// whether it worked. Without this, a scan that never connected to clamd (which
// still prints "Infected files: 0" into its log) is indistinguishable on the
// dashboard from a scan that came back clean.
// ClamAV's own strings, not the wrapper script's framing, so this survives
// whatever a given setup names its scan units and log banners.
//
// The distinction that matters: clamdscan exits 2 for *any* error, whether it
// scanned nothing at all or scanned everything and skipped a few sockets. A
// quick scan covering /tmp hits the second case on every single run, so
// treating exit 2 as failure produces a permanent false alarm -- the mirror of
// the false-green bug, and no more honest.
async function scanLogSummary(name) {
  const file = LOGS[name];
  if (!file) return null;
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;   // not readable without the clamav group; caller degrades
  }

  // Scoping this to the last run is the whole game. A fixed-size tail spans
  // several runs, and one earlier "Could not connect" is then enough to report
  // a scan that worked fine as one that never happened -- which is exactly the
  // false alarm this function exists to prevent.
  //
  // "SCAN SUMMARY" is clamscan's own end-of-run marker, so the lines after the
  // second-to-last one belong to the run that just finished. (A run that died
  // before writing a summary leaves the previous run's block as the newest;
  // the systemd exit code still drives the verdict in that case.)
  const all = text.split('\n');
  const marks = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].includes('SCAN SUMMARY')) marks.push(i);
  }
  const start = marks.length >= 2 ? marks[marks.length - 2] + 1 : 0;
  const tail = all.slice(start);

  const find = (re) => {
    for (let i = tail.length - 1; i >= 0; i--) {
      const m = tail[i].match(re);
      if (m) return m[1];
    }
    return null;
  };

  const infected = find(/^Infected files:\s*(\d+)/);
  const errors = find(/^Total errors:\s*(\d+)/);
  return {
    completed: tail.some((l) => l.includes('SCAN SUMMARY')),
    unreachable: tail.some((l) => /Could not connect to clamd/.test(l)),
    infected: infected === null ? null : Number(infected),
    errors: errors === null ? null : Number(errors),
  };
}

async function serviceOutcome(unit) {
  const props = 'Result,ExecMainStatus,ActiveState,ExecMainExitTimestamp';
  const res = await run('systemctl', ['show', unit, `--property=${props}`]);
  const out = {};
  for (const line of res.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  const code = Number(out.ExecMainStatus);
  return {
    result: out.Result || 'unknown',
    exitCode: Number.isFinite(code) ? code : null,
    state: out.ActiveState || 'unknown',
  };
}

// Four outcomes a finished scan can have, kept distinct because collapsing
// them is how this dashboard lies. Exit codes are clamscan/clamdscan's:
// 0 clean, 1 detections, 2 "some error occurred".
function classifyScan(outcome, log) {
  // Killed by a signal, timed out, or never exec'd: not a scan result at all.
  if (outcome.result !== 'success' && outcome.result !== 'exit-code') {
    return { severity: 'failed', message: `The scan did not run (${outcome.result}).` };
  }

  if (outcome.exitCode === 1 || (log && log.infected > 0)) {
    const n = log?.infected;
    return {
      severity: 'detections',
      message: n ? `${n} infected file${n === 1 ? '' : 's'} found — open the log.`
                 : 'Detections found — open the log.',
    };
  }

  if (outcome.exitCode === 0) return { severity: 'ok', message: null };

  // Exit 2. Everything below is about telling "scanned nothing" apart from
  // "scanned everything, skipped some unreadable files".
  if (log?.unreachable) {
    return {
      severity: 'failed',
      message: 'Could not reach the scanner daemon, so nothing was scanned — ' +
               'the log still reports "Infected files: 0".',
    };
  }

  if (log?.completed) {
    const n = log.errors;
    return {
      severity: 'errors',
      message: n
        ? `Completed with ${n} error${n === 1 ? '' : 's'} — usually sockets and ` +
          'other special files that cannot be read. Nothing infected.'
        : 'Completed with errors. Nothing infected.',
    };
  }

  // Exit 2 and the log is unreadable (no clamav group) or has no summary:
  // say what is known rather than guessing either way.
  return {
    severity: 'errors',
    message: log === null
      ? 'Exited with errors (code 2). Grant log access on the Logs tab to see why.'
      : 'Exited with errors (code 2) and wrote no summary — check the log.',
  };
}

async function timerInfo() {
  const res = await run('systemctl', ['list-timers', '--all', '--no-pager', '--output=json', 'clamav-*']);
  let parsed = [];
  if (res.ok && res.stdout.startsWith('[')) {
    try { parsed = JSON.parse(res.stdout); } catch { /* fall through to nulls */ }
  }

  return Promise.all(TIMERS.map(async (t) => {
    const row = parsed.find((p) => p.unit === t.id);
    const next = usecToDate(row?.next);
    const last = usecToDate(row?.last);

    // Reported as "{ OnCalendar=*-*-* 12:30:00 ; next_elapse=... }" -- pull out
    // just the expression so the Configure tab shows what is really in effect,
    // including any drop-in override the app itself wrote.
    const [cal, outcome, log] = await Promise.all([
      run('systemctl', ['show', t.id, '-p', 'TimersCalendar', '--value']),
      serviceOutcome(t.service),
      scanLogSummary(t.log),
    ]);
    const m = cal.stdout.match(/OnCalendar=([^;}]+)/);

    // A unit that has never run also reports Result=success, so a failure is
    // only meaningful once the timer has actually fired at least once.
    const ran = Boolean(last);

    // 'activating' is the normal state for a scan in progress: the helper uses
    // `systemctl start --no-block`, so the click returns long before the scan
    // does. Without this the UI has nothing to say between "started" and
    // "finished", and the log still shows the *previous* run's summary at the
    // bottom -- which reads as though nothing happened.
    const running = outcome.state === 'activating' || outcome.state === 'active';

    // A verdict on the last run is only meaningful once one has completed;
    // while a scan is in flight these properties still describe the run before
    // it, so do not paint the current scan with the old outcome.
    const verdict = (ran && !running)
      ? classifyScan(outcome, log)
      : { severity: 'unknown', message: null };

    return {
      ...t,
      next: next ? next.toLocaleString() : null,
      left: next ? humanDuration(next.getTime() - Date.now()) : null,
      last: last ? last.toLocaleString() : null,
      calendar: m ? m[1].trim() : null,
      installed: Boolean(row),
      running,
      lastSeverity: verdict.severity,
      lastMessage: verdict.message,
      lastResult: outcome.result,
      lastExitCode: outcome.exitCode,
      serviceState: outcome.state,
      lastErrors: log?.errors ?? null,
      lastInfected: log?.infected ?? null,
    };
  }));
}

// Can we read the clamav-owned logs without root? True once the user is in
// the clamav group; drives the "Grant access" prompt in the UI.
async function accessInfo() {
  const user = process.env.USER || process.env.LOGNAME || 'unknown';
  let logs = false;
  try {
    const fh = await fs.open(LOGS['clamd'], 'r');
    await fh.close();
    logs = true;
  } catch { /* not readable */ }

  // "Not in the group" and "in the group, but this desktop session started
  // before that happened" are indistinguishable from a failed read alone --
  // yet only the second is fixed by logging out. Supplementary groups are
  // stamped at login and never re-read, so compare the group database against
  // this process's actual credentials.
  let pendingRelogin = false;
  if (!logs) {
    const g = await run('getent', ['group', 'clamav']);
    const fields = g.stdout.split(':');
    const gid = Number(fields[2]);
    const members = (fields[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
    let current = [];
    try { current = process.getgroups(); } catch { /* platform without getgroups */ }
    pendingRelogin = Number.isFinite(gid) && members.includes(user) && !current.includes(gid);
  }

  return { logsReadable: logs, pendingRelogin, user };
}

// A service that is "active" but whose dependency is down is not working, and
// is the most dangerous state this app can render: the user reads a green dot
// as protection. Mark it so the UI can contradict systemd.
function markDegraded(services) {
  for (const svc of services) {
    svc.degraded = false;
    svc.degradedReason = null;
    if (!svc.requires || svc.active !== 'active') continue;

    const dep = services.find((s) => s.id === svc.requires);
    if (!dep || dep.active === 'active') continue;

    svc.degraded = true;
    svc.degradedReason = `${dep.label} is ` +
      `${dep.active === 'failed' ? 'failed' : 'stopped'}, so nothing is being scanned`;
  }
  return services;
}

async function collectStatus() {
  const [services, timers, db, access] = await Promise.all([
    Promise.all(SERVICES.map(async (s) => ({ ...s, ...(await unitState(s.id)) }))),
    timerInfo(),
    databaseInfo(),
    accessInfo(),
  ]);
  return {
    services: markDegraded(services),
    timers,
    db,
    access,
    collectedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

async function readConfig() {
  try {
    const text = await fs.readFile(CLAMD_CONF, 'utf8');
    const onAccessPaths = [];
    let prevention = 'no';
    let maxThreads = null;

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [key, ...rest] = line.split(/\s+/);
      const value = rest.join(' ');
      if (key === 'OnAccessIncludePath') onAccessPaths.push(value);
      else if (key === 'OnAccessPrevention') prevention = value;
      else if (key === 'MaxThreads') maxThreads = value;
    }
    return { ok: true, onAccessPaths, prevention, maxThreads, path: CLAMD_CONF };
  } catch (e) {
    return { ok: false, error: `Cannot read ${CLAMD_CONF}: ${e.code || e.message}` };
  }
}

// Only absolute, existing directories may be handed to the helper. The helper
// re-validates independently -- this check is for fast UI feedback, not
// security, since a compromised renderer could skip it.
async function validateScanPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) {
    return { ok: false, error: 'Path must be absolute' };
  }
  if (/[\n\r]/.test(p)) return { ok: false, error: 'Path contains newlines' };
  try {
    const st = await fs.stat(p);
    if (!st.isDirectory()) return { ok: false, error: 'Not a directory' };
  } catch {
    return { ok: false, error: 'Directory does not exist' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('status:get', collectStatus);
ipcMain.handle('config:get', readConfig);

ipcMain.handle('logs:read', async (_e, name) => {
  const file = LOGS[name];
  if (!file) return { ok: false, error: 'Unknown log' };
  try {
    const text = await fs.readFile(file, 'utf8');
    // An empty file is normal for a scan that has not run yet. Rendering it as
    // a blank pane looks like a failure, so say so explicitly.
    if (text.trim() === '') {
      return { ok: true, empty: true, text: '', file };
    }
    const lines = text.split('\n');
    return { ok: true, text: lines.slice(-500).join('\n'), file };
  } catch (e) {
    if (e.code === 'EACCES') {
      const access = await accessInfo();
      return {
        ok: false,
        needsAccess: true,
        pendingRelogin: access.pendingRelogin,
        error: 'Permission denied',
        file,
      };
    }
    if (e.code === 'ENOENT') return { ok: true, empty: true, text: '', file };
    return { ok: false, error: e.message, file };
  }
});

// Fallback for when the user is not yet in the clamav group: read the log via
// the helper instead of making them log out and back in first.
ipcMain.handle('logs:readElevated', async (_e, name) => {
  if (!LOGS[name]) return { ok: false, error: 'Unknown log' };
  const res = await runPrivileged(['read-log', name]);
  if (!res.ok) return res;
  return {
    ok: true,
    empty: res.stdout.trim() === '',
    text: res.stdout,
    file: LOGS[name],
    elevated: true,
  };
});

ipcMain.handle('action:run', async (_e, id) => {
  const args = ACTIONS[id];
  if (!args) return { ok: false, error: 'Unknown action' };
  return runPrivileged(args);
});

ipcMain.handle('service:control', async (_e, { unit, verb }) => {
  const known = [...SERVICES.map((s) => s.id), ...TIMERS.map((t) => t.id)];
  if (!known.includes(unit)) return { ok: false, error: 'Unknown unit' };
  if (!['start', 'stop', 'restart'].includes(verb)) return { ok: false, error: 'Unknown verb' };
  return runPrivileged(['service', verb, unit]);
});

ipcMain.handle('config:setPrevention', async (_e, value) => {
  if (value !== 'yes' && value !== 'no') return { ok: false, error: 'Invalid value' };
  return runPrivileged(['set-prevention', value]);
});

ipcMain.handle('config:addPath', async (_e, p) => {
  const v = await validateScanPath(p);
  if (!v.ok) return { ok: false, error: v.error };
  return runPrivileged(['add-path', p]);
});

ipcMain.handle('config:removePath', async (_e, p) => {
  if (typeof p !== 'string' || !p.startsWith('/')) return { ok: false, error: 'Invalid path' };
  return runPrivileged(['remove-path', p]);
});

ipcMain.handle('config:setSchedule', async (_e, { which, calendar }) => {
  if (!['quick', 'full'].includes(which)) return { ok: false, error: 'Unknown timer' };
  // systemd OnCalendar grammar: keep to a conservative charset and let
  // systemd-analyze (in the helper) be the real validator.
  if (typeof calendar !== 'string' || !/^[A-Za-z0-9 :,\-*/.]{3,64}$/.test(calendar)) {
    return { ok: false, error: 'Invalid calendar expression' };
  }
  return runPrivileged(['set-timer', which, calendar]);
});

ipcMain.handle('helper:present', async () => {
  try {
    await fs.access(HELPER);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Helper not installed' };
  }
});

ipcMain.handle('open:external', async (_e, target) => {
  // Only ever open local log files, never arbitrary URLs.
  if (!Object.values(LOGS).includes(target)) return { ok: false };
  await shell.showItemInFolder(target);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    title: 'ClamAV Monitor',
    backgroundColor: '#12141a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// `electron . --selftest` prints everything the dashboard would show and
// exits. Verifies the data pipeline without needing a display, and is the
// fastest way to see what the app sees when something looks wrong.
async function selfTest() {
  const [status, config, helper] = await Promise.all([
    collectStatus(),
    readConfig(),
    fs.access(HELPER).then(() => true).catch(() => false),
  ]);
  console.log(JSON.stringify({ helperInstalled: helper, status, config }, null, 2));
  app.exit(0);
}

app.whenReady().then(() => {
  if (process.argv.includes('--selftest')) return selfTest();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Refuse navigation and popups outright: this app renders only local files.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
