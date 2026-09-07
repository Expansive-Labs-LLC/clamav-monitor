'use strict';

const api = window.clamav;
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let currentConfig = null;
let refreshTimer = null;

// Set while a privileged operation is in flight. The 10s auto-refresh rebuilds
// the service rows from scratch, which would otherwise tear out the very button
// being clicked -- wiping its "working" state while the polkit prompt is still
// on screen, so the click appeared to do nothing.
let busy = false;

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

let bannerTimer = null;
function banner(message, kind = 'info', sticky = false) {
  const b = $('#banner');
  b.textContent = message;
  b.className = `banner ${kind}`;
  clearTimeout(bannerTimer);
  if (!sticky) bannerTimer = setTimeout(() => b.classList.add('hidden'), 6000);
}

// ---------------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------------

function serviceCard(svc) {
  const card = el('div', 'card');
  card.append(el('h3', null, svc.label));
  card.append(el('p', 'sub', svc.desc));

  const line = el('div', 'status-line');
  let dot = 'idle';
  let text = svc.active;

  if (!svc.installed) {
    dot = 'idle';
    text = 'Not installed';
  } else if (svc.degraded) {
    // Deliberately red rather than amber, and never "Running". systemd says
    // this unit is active; it is also doing nothing, and a green dot over an
    // unprotected machine is the worst thing this dashboard could show.
    dot = 'bad';
    text = 'Not protecting';
  } else if (svc.active === 'active') {
    dot = 'ok';
    text = 'Running';
  } else if (svc.active === 'failed') {
    dot = 'bad';
    text = 'Failed';
  } else if (svc.conditionFailed) {
    dot = 'bad';
    text = 'Blocked by start condition';
  } else {
    dot = 'warn';
    text = 'Stopped';
  }

  line.append(el('span', `dot ${dot}`));
  line.append(el('span', 'status-text', text));
  if (svc.installed && svc.enabled !== 'enabled') {
    line.append(el('span', 'sub', '· not enabled at boot'));
  }
  card.append(line);
  if (svc.degraded && svc.degradedReason) {
    card.append(el('p', 'error', svc.degradedReason));
  }
  if (svc.conditionFailed) {
    // "Enabled but never starts, and systemd calls that success" is baffling
    // without being told where to look.
    card.append(el('p', 'error',
      `A Condition* check in the unit file failed, so systemd skipped it ` +
      `without reporting an error. Run: systemctl status ${svc.unit}`));
  }
  return card;
}

function renderServices(services) {
  const host = $('#services');
  host.replaceChildren(...services.map(serviceCard));
}

function fmtAge(hours) {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return `${Math.round(hours * 60)} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function renderDatabase(db) {
  const host = $('#database');
  host.replaceChildren();

  if (db.error) {
    host.append(el('p', 'error', db.error));
    return;
  }

  const meta = el('div', 'meta');
  const add = (k, v) => {
    const d = el('div');
    d.append(el('div', 'k', k));
    d.append(el('div', 'v', v));
    meta.append(d);
  };

  add('Definitions', db.serial ? `#${db.serial}` : '—');
  add('Engine', db.engine || '—');
  add('Last updated', fmtAge(db.ageHours));
  add('Size', db.sizeBytes ? `${(db.sizeBytes / 1048576).toFixed(0)} MB` : '—');
  host.append(meta);

  // Threshold is 48h, not 24h: this timestamp is the database file's mtime,
  // which only moves when ClamAV actually publishes a new build. A quiet day
  // upstream is normal and must not be reported as a broken updater.
  if (db.ageHours !== null && db.ageHours > 48) {
    host.append(el('p', 'error',
      `Definitions are ${Math.round(db.ageHours / 24)} days old — check that the ` +
      'signature updater is running.'));
  }
}

function renderTimers(timers) {
  const host = $('#timers');
  host.replaceChildren(...timers.map((t) => {
    const card = el('div', 'card');
    card.append(el('h3', null, t.label));
    if (t.next) {
      card.append(el('p', 'sub', `Next: ${t.next}`));
      if (t.left) card.append(el('p', 'sub', `In ${t.left}`));
    } else {
      card.append(el('p', 'sub', 'Not scheduled'));
    }
    card.append(el('p', 'sub', t.last && t.last !== 'n/a' ? `Last run: ${t.last}` : 'Never run yet'));
    if (t.running) {
      const line = el('div', 'status-line');
      line.append(el('span', 'dot ok'));
      line.append(el('span', 'status-text', 'Scanning now'));
      card.append(line);
      card.append(el('p', 'sub',
        'The log fills in as it goes, and the summary is written at the end.'));
    }
    if (t.lastFailed) {
      const detail = t.lastExitCode !== null && t.lastExitCode !== undefined
        ? ` (exit ${t.lastExitCode})`
        : '';
      card.append(el('p', 'error',
        `Last run failed${detail} — check the scan log; its summary can still ` +
        'read "Infected files: 0" even though nothing was scanned.'));
    }
    return card;
  }));
}

function renderServiceControls(services) {
  const host = $('#service-controls');
  host.replaceChildren();

  services.forEach((svc) => {
    const row = el('div', 'svc-row');
    const left = el('div');
    left.append(el('strong', null, svc.label));
    left.append(el('p', 'sub', svc.installed ? `${svc.unit} — ${svc.active}` : 'not installed'));
    row.append(left);

    const running = svc.active === 'active';
    const btns = el('div', 'row gap');

    ['start', 'stop', 'restart'].forEach((verb) => {
      const b = el('button', 'btn ghost small', verb);

      // Greying out the impossible action is itself the clearest feedback:
      // clicking "start" on an already-running service used to succeed
      // silently and look like nothing happened.
      const pointless = (verb === 'start' && running) || (verb === 'stop' && !running);
      b.disabled = !svc.installed || pointless;
      if (pointless) b.title = running ? 'Already running' : 'Not running';

      b.addEventListener('click', async () => {
        busy = true;
        const original = b.textContent;
        b.disabled = true;
        b.textContent = '…';
        banner(`${verb === 'stop' ? 'Stopping' : verb === 'start' ? 'Starting' : 'Restarting'} ${svc.label}…`, 'info', true);

        const res = await api.controlService(svc.unit, verb);

        busy = false;
        b.disabled = false;
        b.textContent = original;

        if (res.cancelled) banner('Cancelled — nothing changed.', 'info');
        else if (res.ok) banner(`${svc.label}: ${verb} succeeded.`, 'good');
        else banner(`${verb} failed: ${res.stderr || res.error}`, 'bad', true);

        refresh();   // repaint state (and the enabled/disabled buttons)
      });
      btns.append(b);
    });
    row.append(btns);
    host.append(row);
  });
}

// ---------------------------------------------------------------------------
// Configure tab
// ---------------------------------------------------------------------------

function renderPaths(paths) {
  const list = $('#path-list');
  list.replaceChildren();

  if (!paths.length) {
    const li = el('li', 'empty', 'No folders are being watched in real time.');
    list.append(li);
    return;
  }

  paths.forEach((p) => {
    const li = el('li');
    li.append(el('span', null, p));
    const rm = el('button', 'btn ghost small', 'Remove');
    rm.addEventListener('click', async () => {
      rm.disabled = true;
      const res = await api.removePath(p);
      if (res.cancelled) { banner('Cancelled.', 'info'); rm.disabled = false; return; }
      if (res.ok) { banner(`Stopped watching ${p}`, 'good'); loadConfig(); }
      else { banner(`Failed: ${res.stderr || res.error}`, 'bad', true); rm.disabled = false; }
    });
    li.append(rm);
    list.append(li);
  });
}

async function loadConfig() {
  const cfg = await api.getConfig();
  currentConfig = cfg;

  if (!cfg.ok) {
    banner(cfg.error, 'bad', true);
    renderPaths([]);
    return;
  }
  renderPaths(cfg.onAccessPaths);
  $('#prevention-toggle').checked = cfg.prevention === 'yes';
}

// ---------------------------------------------------------------------------
// Logs tab
// ---------------------------------------------------------------------------

async function loadLog(elevated = false) {
  const name = $('#log-select').value;
  const onlyDetections = $('#only-detections').checked;
  const view = $('#log-view');
  view.replaceChildren(document.createTextNode('Loading…'));

  const res = elevated ? await api.readLogElevated(name) : await api.readLog(name);

  if (!res.ok) {
    view.replaceChildren();
    if (res.needsAccess) {
      // Already in the group: offering "grant access" again would do nothing
      // and imply the previous attempt failed. Say what is actually pending.
      view.append(document.createTextNode(res.pendingRelogin
        ? 'Permission denied — but you have already been added to the clamav group.\n\n' +
          'This desktop session started before that change. Supplementary groups are ' +
          'stamped at login and never re-read, so the app cannot see the new group ' +
          'until you log out and back in. Closing and reopening the app will not help.\n\n' +
          'Log out and back in, or read the log now with a password:\n\n'
        : 'Permission denied.\n\n' +
          'Log files are owned by the clamav group. Add yourself to it for permanent ' +
          'access — that takes effect after a full log out and back in — or read the ' +
          'log now with a password:\n\n'));

      const row = el('div', 'row gap');

      // Works immediately, no re-login: reads through the privileged helper.
      const now = el('button', 'btn', 'View now (asks for password)');
      now.addEventListener('click', () => loadLog(true));
      row.append(now);

      if (!res.pendingRelogin) {
        const grant = el('button', 'btn ghost', 'Grant permanent access');
        grant.addEventListener('click', async () => {
          const r = await api.runAction('grant-access');
          if (r.cancelled) banner('Cancelled.', 'info');
          else if (r.ok) banner('Added to clamav group — log out and back in to apply.', 'good', true);
          else banner(`Failed: ${r.stderr || r.error}`, 'bad', true);
        });
        row.append(grant);
      }

      view.append(row);
    } else if (res.cancelled) {
      view.append(document.createTextNode('Cancelled.'));
    } else {
      view.append(document.createTextNode(res.error || res.stderr || 'Could not read log.'));
    }
    return;
  }

  if (res.empty) {
    const label = $('#log-select').selectedOptions[0]?.textContent ?? 'This log';
    view.replaceChildren(document.createTextNode(
      `${label}: nothing logged yet.\n\n` +
      (name.startsWith('scan-')
        ? 'This fills in after the scan runs. Check "Scheduled scans" on the ' +
          'Dashboard for the next run, or start one now with the scan buttons.'
        : 'The service has not written anything to this log yet.')));
    return;
  }

  let lines = res.text.split('\n');
  if (onlyDetections) {
    lines = lines.filter((l) => / FOUND$/.test(l) || /Infected files: [1-9]/.test(l));
    if (!lines.length) lines = ['No detections in this log.'];
  }

  // Build with DOM nodes rather than innerHTML: log content is untrusted
  // (it contains attacker-chosen filenames and signature names).
  const frag = document.createDocumentFragment();
  lines.forEach((line) => {
    if (/ FOUND$/.test(line)) frag.append(el('span', 'found', line + '\n'));
    else if (/Infected files: 0\b/.test(line)) frag.append(el('span', 'okline', line + '\n'));
    else frag.append(document.createTextNode(line + '\n'));
  });
  view.replaceChildren(frag);
  view.scrollTop = view.scrollHeight;
}

// ---------------------------------------------------------------------------
// Schedule fields
// ---------------------------------------------------------------------------

// Save stays disabled until the field differs from the schedule currently in
// effect, so the button itself shows whether there is anything to save.
function syncScheduleButton(which) {
  const input = $(`#sched-${which}`);
  const btn = document.querySelector(`[data-schedule="${which}"]`);
  if (!input || !btn) return;
  const value = input.value.trim();
  btn.disabled = value === '' || value === (input.dataset.saved ?? '');
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function refresh(force = false) {
  // Skip the periodic tick while an operation is running so its controls and
  // progress text survive; explicit calls after an operation pass force.
  if (busy && !force) return;

  const status = await api.getStatus();

  renderServices(status.services);
  renderDatabase(status.db);
  renderTimers(status.timers);
  renderServiceControls(status.services);

  $('#engine-line').textContent = status.db.version
    ? status.db.version
    : 'ClamAV not detected';

  $('#refresh-note').textContent =
    `Updated ${new Date(status.collectedAt).toLocaleTimeString()}`;

  // Show the schedule actually in effect (including any override this app
  // wrote), but never clobber what the user is mid-way through typing.
  const fill = (which, unitId) => {
    const t = status.timers.find((x) => x.id === unitId);
    const input = $(`#sched-${which}`);
    if (!t?.calendar) return;

    // Only overwrite the field when it still matches what was last saved --
    // otherwise a refresh landing mid-edit would discard the typing.
    const edited = input.value.trim() !== (input.dataset.saved ?? '');
    input.dataset.saved = t.calendar;
    if (!edited) input.value = t.calendar;
    syncScheduleButton(which);
  };
  fill('quick', 'clamav-quickscan.timer');
  fill('full', 'clamav-fullscan.timer');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'logs') loadLog();
      if (tab.dataset.tab === 'configure') loadConfig();
    });
  });
}

function wireActions() {
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.action;
      if (id === 'scan-system' &&
          !confirm('Scan every local filesystem (~2 TB)? This can run for several hours.')) {
        return;
      }
      const original = btn.textContent;
      busy = true;
      btn.disabled = true;
      btn.textContent = 'Working…';
      banner('Waiting for authorisation…', 'info', true);

      const res = await api.runAction(id);

      busy = false;
      btn.disabled = false;
      btn.textContent = original;

      if (res.cancelled) banner('Cancelled.', 'info');
      else if (res.ok) {
        banner(id === 'update-signatures'
          ? 'Signature update finished.'
          : 'Scan started — follow progress under Logs.', 'good');
        refresh();
      } else {
        banner(`Failed: ${res.stderr || res.error || 'unknown error'}`, 'bad', true);
      }
    });
  });

  // Wrapped: a bare handler would pass the MouseEvent as `force`.
  $('#btn-refresh').addEventListener('click', () => refresh(true));

  $('#prevention-toggle').addEventListener('change', async (e) => {
    const want = e.target.checked ? 'yes' : 'no';
    const res = await api.setPrevention(want);
    if (res.cancelled || !res.ok) {
      e.target.checked = !e.target.checked; // roll back the visual state
      banner(res.cancelled ? 'Cancelled.' : `Failed: ${res.stderr || res.error}`,
             res.cancelled ? 'info' : 'bad', !res.cancelled);
    } else {
      banner(`Real-time blocking ${want === 'yes' ? 'enabled' : 'disabled'}.`, 'good');
      loadConfig();
    }
  });

  $('#btn-add-path').addEventListener('click', async () => {
    const input = $('#path-input');
    const p = input.value.trim();
    const err = $('#path-error');
    err.classList.add('hidden');

    if (!p) return;
    const res = await api.addPath(p);
    if (res.cancelled) { banner('Cancelled.', 'info'); return; }
    if (!res.ok) {
      err.textContent = res.stderr || res.error;
      err.classList.remove('hidden');
      return;
    }
    input.value = '';
    banner(`Now watching ${p}`, 'good');
    loadConfig();
  });

  document.querySelectorAll('[data-schedule]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const which = btn.dataset.schedule;
      const input = $(`#sched-${which}`);
      const value = input.value.trim();
      const err = $('#sched-error');
      err.classList.add('hidden');

      busy = true;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '…';

      const res = await api.setSchedule(which, value);

      busy = false;
      btn.textContent = original;

      if (res.cancelled) {
        banner('Cancelled — schedule unchanged.', 'info');
        syncScheduleButton(which);
        return;
      }
      if (!res.ok) {
        err.textContent = res.stderr || res.error;
        err.classList.remove('hidden');
        syncScheduleButton(which);
        return;
      }

      // Saved: this value is now the one in effect, so the button greys out
      // again until the field is edited.
      input.dataset.saved = value;
      syncScheduleButton(which);
      banner('Schedule updated.', 'good');
      refresh();
    });
  });

  ['quick', 'full'].forEach((which) => {
    $(`#sched-${which}`).addEventListener('input', () => syncScheduleButton(which));
  });

  // Wrapped: a bare handler passes the Event as `elevated`, which is truthy
  // and would trigger a password prompt on every dropdown change.
  $('#log-select').addEventListener('change', () => loadLog());
  $('#only-detections').addEventListener('change', () => loadLog());
  $('#btn-log-refresh').addEventListener('click', () => loadLog());
}

async function init() {
  wireTabs();
  wireActions();

  const helper = await api.helperPresent();
  if (!helper.ok) {
    banner('Privileged helper not installed — configuration and scans are unavailable. ' +
           'Run: npm run install-helper', 'bad', true);
  }

  await refresh();
  await loadConfig();
  refreshTimer = setInterval(refresh, 10000);
}

window.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', () => clearInterval(refreshTimer));
