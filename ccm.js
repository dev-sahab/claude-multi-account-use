#!/usr/bin/env node
'use strict';
/*
 * ccm - multi-account wrapper for the official Claude Code (CLI + VS Code extension).
 * Zero dependencies. Needs Node 16+. Works on macOS / Linux / Windows.
 *
 *   ccm add <name> [dir]     register an account (first one defaults to ~/.claude)
 *   ccm signin <name>        open claude once for that account, then /login (one time only)
 *   ccm remove <name> [--purge]  unregister an account (--purge also deletes its folder/login)
 *   ccm use <name>           switch manually (clears its "limited" mark)
 *   ccm status               accounts, current, limit marks
 *   ccm auto on|off          auto-switch when a limit is hit (default on)
 *   ccm limit [name]         manually mark account as limited
 *   ccm clear [name|all]     clear limit marks
 *   ccm check "text"         test a text against the limit patterns
 *   ccm doctor               check that sessions/skills/settings are stored once (in the first account)
 *   ccm link [--dry-run]     fix it: move what other accounts saved into the first account and link it
 *   ccm log [n]              show the last n log lines (default 30)
 *   ccm restart on|off       VS Code: stop claude after a limit so the extension restarts it on the next account (experimental)
 *   ccm setup                install shims + print the VS Code setting
 *   ccm version              print version
 *   ccm [run] [claude args]  run claude (terminal mode, auto-resume on next account)
 *   ccm wrap <claude> ...    used by the VS Code extension (claudeProcessWrapper)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const VERSION = '1.2.0';
const HOME = os.homedir();
const ROOT = path.join(HOME, '.claude-multi');
const CFG = path.join(ROOT, 'config.json');
const ST = path.join(ROOT, 'state.json');
const LOG = path.join(ROOT, 'ccm.log');
const DEFAULT_DIR = path.join(HOME, '.claude');
// Shared between accounts = stored once, in the FIRST account's folder; the other accounts get links to it.
const SHARED_DIRS = ['projects', 'commands', 'agents', 'skills', 'plugins', 'plans', 'todos', 'file-history', 'session-env', 'ide', 'output-styles'];
const SHARED_FILES = ['settings.json', 'CLAUDE.md', 'history.jsonl'];
// Never shared: they identify the account (login, user id) or are caches. Listed only so `ccm doctor` can ignore them.
const PER_ACCOUNT = ['.credentials.json', '.claude.json', 'statsig', 'telemetry', 'shell-snapshots', 'cache', 'debug', 'backups'];
const IS_WIN = process.platform === 'win32';

const DEFAULTS = {
  accounts: [],
  auto: true,
  restartOnLimit: false, // VS Code: stop the claude process after a limit so the extension restarts it on the next account (experimental)
  cooldownMinutes: 300, // used when the reset time can't be parsed
  // Regexes (case-insensitive), always merged with any "patterns" you add in config.json.
  // Written so they do not match their own source text.
  patterns: [
    '(hit|reached|exceeded)\\s+(your|the)\\s+.{0,30}\\blimit',
    '\\blimit\\s+(reached|exceeded)',
  ],
};

const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const wr = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o, null, 2));
  fs.renameSync(t, f);
};
const cfg = () => {
  const c = Object.assign({}, DEFAULTS, rd(CFG) || {});
  c.patterns = Array.from(new Set([].concat(DEFAULTS.patterns, (rd(CFG) || {}).patterns || [])));
  return c;
};
const rawCfg = () => Object.assign({ accounts: [] }, rd(CFG) || {}); // what is stored on disk
const state = () => Object.assign({ current: null, limited: {} }, rd(ST) || {});
const log = (m) => {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    try { if (fs.statSync(LOG).size > 1e6) fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').slice(-200000)); } catch {}
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);
  } catch {}
};
const die = (m) => { console.error('ccm: ' + m); process.exit(1); };
const ex = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, HOME));
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// The default ~/.claude account must run WITHOUT CLAUDE_CONFIG_DIR, otherwise the
// stored login (e.g. macOS Keychain entry) may not be found.
function envFor(acc) {
  const e = Object.assign({}, process.env);
  if (sameDir(acc.dir, DEFAULT_DIR)) delete e.CLAUDE_CONFIG_DIR;
  else e.CLAUDE_CONFIG_DIR = acc.dir;
  return e;
}

// ---------- account selection ----------
function pick(c, s, exclude = []) {
  const accs = c.accounts;
  if (!accs.length) die('no accounts yet. Run: ccm add <name> [dir]');
  const now = Date.now();
  const free = (a) => !(s.limited[a.name] > now) && !exclude.includes(a.name);
  const cur = accs.find((a) => a.name === s.current) || accs[0];
  if (free(cur)) { if (s.current !== cur.name) { s.current = cur.name; wr(ST, s); } return cur; }
  if (!c.auto) return cur;
  const i = accs.indexOf(cur);
  for (let k = 1; k <= accs.length; k++) {
    const a = accs[(i + k) % accs.length];
    if (free(a)) { s.current = a.name; wr(ST, s); log(`switch ${cur.name} -> ${a.name}`); return a; }
  }
  // everybody is limited: take the one that resets first
  return accs.slice().sort((a, b) => (s.limited[a.name] || 0) - (s.limited[b.name] || 0))[0];
}

function parseReset(text, c) {
  let m = /limit reached\|(\d{10,13})/i.exec(text);
  if (m) { let t = +m[1]; if (t < 1e12) t *= 1000; return t; }
  m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (m) {
    const h = (+m[1] % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    const d = new Date(); d.setHours(h, +(m[2] || 0), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return Date.now() + c.cooldownMinutes * 60000;
}

function markLimited(name, text) {
  const c = cfg(), s = state();
  s.limited[name] = parseReset(text || '', c);
  wr(ST, s);
  log(`LIMIT ${name} until ${new Date(s.limited[name]).toISOString()} | ${String(text).slice(0, 600)}`);
}

const regexes = (c) => c.patterns.map((p) => new RegExp(p, 'i'));
// Only short lines are tested, so file contents / tool results that merely mention
// the phrase don't trigger a false positive.
// For JSON lines only the human-readable text of a "result" or "assistant" message is
// tested; control requests, tool results, gate lists etc. are ignored. Plain text
// lines (stderr) are tested as is.
function limitText(line) {
  let o;
  try { o = JSON.parse(line); } catch { return line; }
  if (!o || typeof o !== 'object') return line;
  let t = null;
  if (o.type === 'result') t = typeof o.result === 'string' ? o.result : null;
  else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content))
    t = o.message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
  // Limit notices are short. Long answers that merely talk about limits are ignored.
  return t && t.length < 400 ? t : null;
}
const isLimitLine = (res, line) => {
  if (line.length >= 4000) return false;
  const t = limitText(line);
  return !!t && res.some((r) => r.test(t));
};

function nearMiss(line) {
  if (line.length >= 4000) return;
  const t = limitText(line);
  if (t && /limit|quota|resets?\b/i.test(t)) log('NEAR-MISS (not matched) ' + t.replace(/\s+/g, ' ').slice(0, 300));
  else if (!t && /rate_limit_event/.test(line) && /reject|exceed|block|reached/i.test(line)) log('RATE-EVENT ' + line.slice(0, 300));
}

function makeScanner(c, onHit) {
  const res = regexes(c);
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (isLimitLine(res, line)) onHit(line); else nearMiss(line);
    }
    if (buf.length > 1e6) buf = '';
  };
}

// ---------- VS Code extension mode ----------
function wrap(argv) {
  const [cmd, ...args] = argv;
  if (!cmd) die('wrap: missing claude executable');
  const c = cfg(), s = state();
  const acc = pick(c, s);
  log(`wrap start account=${acc.name} cmd=${cmd}`);
  try { if (c.accounts.length > 1) { const n0 = pending(syncLinks(c, { merge: false })).length; if (n0) log(`WARN ${n0} shared item(s) not linked to the first account; run: ccm doctor`); } } catch {}
  const child = spawn(cmd, args, {
    env: envFor(acc),
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: IS_WIN && /\.(cmd|bat)$/i.test(cmd),
  });
  let killed = false;
  const hit = (line) => {
    markLimited(acc.name, line);
    const st = state();
    const other = c.accounts.some((a) => a.name !== acc.name && !(st.limited[a.name] > Date.now()));
    if (c.restartOnLimit && c.auto && other && !killed) {
      killed = true;
      log(`restartOnLimit: stopping claude (${acc.name}) so the next start uses another account`);
      setTimeout(() => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => process.exit(143), 500); }, 1500);
    }
  };
  const so = makeScanner(c, hit), se = makeScanner(c, hit);
  child.stdout.on('data', (d) => { process.stdout.write(d); so(d); });
  child.stderr.on('data', (d) => { process.stderr.write(d); se(d); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig); } catch {} });
  child.on('error', (e) => { log('spawn error ' + e.message); console.error(e.message); process.exit(127); });
  child.on('close', (code) => process.exit(code == null ? 1 : code));
}

// ---------- terminal mode ----------
function limitInTranscript(acc, since, c) {
  const root = path.join(acc.dir, 'projects');
  const enc = path.join(root, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  let dirs;
  try { dirs = fs.existsSync(enc) ? [enc] : fs.readdirSync(root).map((d) => path.join(root, d)); } catch { return null; }
  let best = null;
  for (const d of dirs) {
    let files; try { files = fs.readdirSync(d); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(d, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs >= since && (!best || st.mtimeMs > best.m)) best = { fp, m: st.mtimeMs };
    }
  }
  if (!best) return null;
  try {
    const fd = fs.openSync(best.fp, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 65536);
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, size - len);
    fs.closeSync(fd);
    const res = regexes(c);
    return b.toString('utf8').trim().split('\n').slice(-6).find((l) => isLimitLine(res, l)) || null;
  } catch { return null; }
}

function run(args) {
  process.on('SIGINT', () => {}); // Ctrl+C belongs to claude, not to this wrapper
  const c = cfg();
  const tried = [];
  let claudeArgs = args;
  for (;;) {
    const acc = pick(c, state(), []);
    console.error(`[ccm] account: ${acc.name}`);
    try { if (c.accounts.length > 1) { const n0 = pending(syncLinks(c, { merge: false })).length; if (n0) console.error(`[ccm] warning: ${n0} shared item(s) are not linked to "${c.accounts[0].name}": sessions may be saved in the wrong account. Run: ccm doctor`); } } catch {}
    const t0 = Date.now() - 2000;
    const r = spawnSync('claude', claudeArgs, { env: envFor(acc), stdio: 'inherit', shell: IS_WIN });
    if (r.error) die(r.error.message + ' (is `claude` installed and on PATH?)');
    const line = limitInTranscript(acc, t0, c);
    if (!line) process.exit(r.status == null ? 0 : r.status);
    markLimited(acc.name, line);
    tried.push(acc.name);
    const next = c.auto ? pick(c, state(), tried) : null;
    const stillLimited = next && state().limited[next.name] > Date.now();
    if (!next || tried.includes(next.name) || stillLimited) {
      console.error('[ccm] limit hit and no other account is free. `ccm status` shows reset times.');
      process.exit(r.status == null ? 0 : r.status);
    }
    console.error(`[ccm] ${acc.name} hit its limit -> resuming this conversation on "${next.name}" in 3s (Ctrl+C to cancel)`);
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3000)'], { stdio: 'ignore' });
    claudeArgs = ['--continue'];
  }
}

// ---------- management commands ----------
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const kindOf = (p) => { try { return fs.statSync(p).isDirectory() ? 'dir' : 'file'; } catch { return null; } }; // follows links
const realEq = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; } };
const sharedItems = (c) => SHARED_DIRS.map((n) => [n, 'dir']).concat(SHARED_FILES.map((n) => [n, 'file']), (c.shareExtra || []).map((n) => [n, null]));

function moveAny(from, to) {
  try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
}
// Move everything from src into dst. Same name + same content: dropped. Same name + different content: kept as <name>.from-<tag>.
function mergeDir(src, dst, tag) {
  fs.mkdirSync(dst, { recursive: true });
  for (const n of fs.readdirSync(src)) {
    const s = path.join(src, n), d = path.join(dst, n);
    if (!exists(d)) { moveAny(s, d); continue; }
    const ss = fs.lstatSync(s), ds = fs.lstatSync(d);
    if (ss.isDirectory() && ds.isDirectory()) { mergeDir(s, d, tag); try { fs.rmdirSync(s); } catch {} continue; }
    if (ss.isFile() && ds.isFile() && ss.size === ds.size && fs.readFileSync(s).equals(fs.readFileSync(d))) { fs.unlinkSync(s); continue; }
    moveAny(s, d + '.from-' + tag);
  }
}
function mkLink(from, dst, kind) {
  fs.symlinkSync(from, dst, IS_WIN ? (kind === 'dir' ? 'junction' : 'file') : undefined);
}

// Makes every other account use the first account's copy of the shared items.
//   o.merge: also move content that already sits in an account's own folder into the first account, then link.
//   o.dry:   change nothing, only report.
// Returns [{acc, item, state, msg}]; state is 'ok' | 'done' | 'todo' | 'skip'.
function syncLinks(c, o = {}) {
  const main = c.accounts[0], out = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (!o.dry) fs.mkdirSync(main.dir, { recursive: true });
  for (const a of c.accounts.slice(1)) {
    if (!o.dry) fs.mkdirSync(a.dir, { recursive: true });
    for (const [n, k0] of sharedItems(c)) {
      const from = path.join(main.dir, n), dst = path.join(a.dir, n);
      const add = (state, msg) => out.push({ acc: a.name, item: n, state, msg });
      try {
        if (isLink(dst)) {
          if (exists(from) && !realEq(dst, from)) add('todo', 'is a link to somewhere else');
          else add('ok', 'linked');
          continue;
        }
        const k = k0 || kindOf(from) || kindOf(dst);
        if (!exists(dst)) {
          if (!exists(from) && (k !== 'dir' || o.dry)) continue; // nothing anywhere yet
          if (o.dry) { add('todo', 'would link'); continue; }
          if (!exists(from)) fs.mkdirSync(from, { recursive: true });
          mkLink(from, dst, k); add('done', 'linked');
          continue;
        }
        // a real file/folder sits in the account's own folder
        if (k === 'dir') {
          const empty = fs.readdirSync(dst).length === 0;
          if (!empty && !o.merge) { add('todo', 'has its own content (sessions/files would be saved in the wrong place)'); continue; }
          if (o.dry) { add('todo', 'would merge into main and link'); continue; }
          if (!empty) mergeDir(dst, from, a.name);
          fs.rmSync(dst, { recursive: true, force: true });
          if (!exists(from)) fs.mkdirSync(from, { recursive: true });
          mkLink(from, dst, 'dir'); add('done', empty ? 'linked' : 'merged into main and linked');
        } else {
          if (!o.merge) { add('todo', 'is a separate copy (not shared)'); continue; }
          if (o.dry) { add('todo', 'would share'); continue; }
          if (!exists(from)) { moveAny(dst, from); }
          else if (fs.readFileSync(from).equals(fs.readFileSync(dst))) fs.unlinkSync(dst);
          else { moveAny(dst, dst + '.bak-' + stamp); add('done', `kept main's copy, your old copy saved as ${n}.bak-${stamp}`); }
          mkLink(from, dst, 'file');
          if (!out.length || out[out.length - 1].item !== n || out[out.length - 1].acc !== a.name) add('done', 'linked');
        }
      } catch (e) {
        if (e.code === 'EEXIST') continue; // another ccm process linked it a moment ago
        add('skip', 'failed: ' + e.message + (IS_WIN && k0 === 'file' ? ' (on Windows, file links need Developer Mode or admin; folders still work)' : ''));
      }
    }
  }
  return out;
}

const pending = (rows) => rows.filter((r) => r.state === 'todo' || r.state === 'skip');
function printRows(rows, onlyProblems, out = console.error) {
  for (const r of rows) {
    if (onlyProblems && (r.state === 'ok')) continue;
    const mark = { ok: '  ok ', done: '  +  ', todo: '  !  ', skip: '  x  ' }[r.state];
    out(`${mark}${r.acc}/${r.item}: ${r.msg}`);
  }
}
function link(c) { // used by `ccm add`: only creates missing links, never moves anything
  printRows(syncLinks(c, { merge: false }), true);
}
const unlinkedWarning = (c) => (c.accounts.length > 1 ? pending(syncLinks(c, { dry: true })).length : 0);

function doctor() {
  const c = cfg();
  if (c.accounts.length < 2) { console.log('Only one account registered: nothing to share.'); return; }
  console.log(`Shared source (first account): ${c.accounts[0].name} -> ${c.accounts[0].dir}\n`);
  const rows = syncLinks(c, { dry: true });
  printRows(rows, false, console.log);
  const known = new Set([].concat(SHARED_DIRS, SHARED_FILES, PER_ACCOUNT, c.shareExtra || []));
  for (const a of c.accounts.slice(1)) {
    let names = []; try { names = fs.readdirSync(a.dir); } catch {}
    const other = names.filter((n) => !known.has(n) && !isLink(path.join(a.dir, n)) && !/\.bak-|\.from-/.test(n));
    if (other.length) console.log(`\nIn "${a.name}" there are other entries that are NOT shared: ${other.join(', ')}\n  If sessions/notes you care about are in there, add the names to "shareExtra" in ${CFG} and run: ccm link`);
  }
  const n = pending(rows).length;
  console.log(n ? `\n${n} item(s) need attention. Close VS Code Claude panels and Claude terminals, then run:  ccm link` : '\nAll good: every account stores sessions and skills in the first account.');
}

async function linkCmd(args) {
  const c = cfg();
  if (c.accounts.length < 2) die('only one account registered');
  const dry = args.includes('--dry-run');
  if (!dry && !args.includes('--yes')) {
    console.error('This moves sessions/files that were saved in the other accounts\' own folders into the first account (' + c.accounts[0].name + ') and links them.\nClose VS Code Claude panels and any running Claude terminals first. Nothing is deleted; clashes are kept as *.from-<account>.');
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
    const ans = await new Promise((r) => rl.question('Continue? [y/N] ', r)); rl.close();
    if (!/^y/i.test(ans)) die('cancelled');
  }
  const rows = syncLinks(c, { merge: true, dry });
  printRows(rows, false);
  console.error(dry ? '\n(dry run: nothing changed)' : '\nDone. Run `ccm doctor` to double-check.');
}

function add(name, dir) {
  if (!name) die('usage: ccm add <name> [dir]');
  const c = rawCfg();
  if (c.accounts.find((a) => a.name === name)) die(`"${name}" already exists`);
  const d = dir ? ex(dir) : (c.accounts.length === 0 ? DEFAULT_DIR : path.join(HOME, '.claude-' + name));
  fs.mkdirSync(d, { recursive: true });
  c.accounts.push({ name, dir: d });
  wr(CFG, c);
  link(c);
  console.log(`added "${name}" -> ${d}\nnext: ccm signin ${name}   (then type /login, finish, /exit)`);
}

function signin(name) {
  const c = cfg();
  const a = c.accounts.find((x) => x.name === name);
  if (!a) die(`unknown account "${name}"`);
  console.error(`Opening claude for "${name}". Type /login, complete it, then /exit.`);
  spawnSync('claude', [], { env: envFor(a), stdio: 'inherit', shell: IS_WIN });
}

function remove(name, purge) {
  const c = rawCfg(), s = state();
  const i = c.accounts.findIndex((a) => a.name === name);
  if (i < 0) die(`unknown account "${name}"`);
  if (i === 0 && c.accounts.length > 1) die(`"${name}" is the first account and holds the shared history; remove the others first, or ask for help moving it`);
  const a = c.accounts[i];
  c.accounts.splice(i, 1);
  delete s.limited[name];
  if (s.current === name) s.current = null;
  wr(CFG, c); wr(ST, s);
  if (purge) {
    if (sameDir(a.dir, DEFAULT_DIR) || !path.resolve(a.dir).startsWith(HOME + path.sep)) die('refusing to delete ' + a.dir);
    for (const [n] of sharedItems(rawCfg())) { // drop links first so the shared data is never touched
      const l = path.join(a.dir, n);
      try { if (fs.lstatSync(l).isSymbolicLink()) { try { fs.unlinkSync(l); } catch { fs.rmdirSync(l); } } } catch {}
    }
    fs.rmSync(a.dir, { recursive: true, force: true });
    console.log(`deleted ${a.dir}`);
  } else console.log(`unregistered "${name}" (folder kept: ${a.dir})`);
  status();
}

function status() {
  const c = cfg(), s = state(), now = Date.now();
  console.log(`auto-switch: ${c.auto ? 'on' : 'off'}   restartOnLimit: ${c.restartOnLimit ? 'on' : 'off'}`);
  for (const a of c.accounts) {
    const lim = s.limited[a.name] > now ? `LIMITED until ${new Date(s.limited[a.name]).toLocaleString()}` : 'ok';
    console.log(`${a.name === s.current ? '*' : ' '} ${a.name.padEnd(12)} ${lim.padEnd(40)} ${a.dir}`);
  }
  const n = unlinkedWarning(c);
  if (n) console.log(`\n! ${n} shared item(s) are not linked to "${c.accounts[0].name}" (sessions or skills may be saved in the wrong account). Run: ccm doctor`);
}

function setup() {
  fs.mkdirSync(path.join(ROOT, 'bin'), { recursive: true });
  const dst = path.join(ROOT, 'ccm.js');
  if (!sameDir(__filename, dst)) fs.copyFileSync(__filename, dst);
  const node = process.execPath;
  let wrapPath, ccmPath;
  if (IS_WIN) {
    ccmPath = path.join(ROOT, 'bin', 'ccm.cmd');
    wrapPath = path.join(ROOT, 'bin', 'ccm-wrap.cmd');
    fs.writeFileSync(ccmPath, `@echo off\r\n"${node}" "${dst}" %*\r\n`);
    fs.writeFileSync(wrapPath, `@echo off\r\n"${node}" "${dst}" wrap %*\r\n`);
  } else {
    ccmPath = path.join(ROOT, 'bin', 'ccm');
    wrapPath = path.join(ROOT, 'bin', 'ccm-wrap');
    fs.writeFileSync(ccmPath, `#!/bin/sh\nexec "${node}" "${dst}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(wrapPath, `#!/bin/sh\nexec "${node}" "${dst}" wrap "$@"\n`, { mode: 0o755 });
    fs.chmodSync(ccmPath, 0o755); fs.chmodSync(wrapPath, 0o755);
  }
  console.log(`Installed to ${ROOT}\n`);
  console.log('1) Add this folder to your PATH so you can type "ccm":\n   ' + path.join(ROOT, 'bin'));
  console.log('\n2) VS Code settings.json (User):\n   "claudeCode.claudeProcessWrapper": ' + JSON.stringify(wrapPath));
  console.log('\n   Then run "Developer: Reload Window".');
}

// ---------- main ----------
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'add': add(rest[0], rest[1]); break;
  case 'signin': signin(rest[0]); break;
  case 'remove': remove(rest[0], rest.includes('--purge')); break;
  case 'status': case 'list': status(); break;
  case 'use': {
    const c = cfg(), s = state();
    if (!c.accounts.find((a) => a.name === rest[0])) die(`unknown account "${rest[0]}"`);
    s.current = rest[0]; delete s.limited[rest[0]]; wr(ST, s); status(); break;
  }
  case 'auto': { const c = rawCfg(); c.auto = rest[0] !== 'off'; wr(CFG, c); status(); break; }
  case 'restart': { const c = rawCfg(); c.restartOnLimit = rest[0] === 'on'; wr(CFG, c); console.log('restartOnLimit: ' + c.restartOnLimit); break; }
  case 'log': {
    let t = ''; try { t = fs.readFileSync(LOG, 'utf8'); } catch { console.log('no log yet: ' + LOG); break; }
    console.log(t.trim().split('\n').slice(-(+rest[0] || 30)).join('\n')); break;
  }
  case 'limit': { const s = state(); markLimited(rest[0] || s.current || cfg().accounts[0].name, ''); status(); break; }
  case 'clear': {
    const s = state();
    if (!rest[0] || rest[0] === 'all') s.limited = {}; else delete s.limited[rest[0]];
    wr(ST, s); status(); break;
  }
  case 'check': {
    const c = cfg(); const t = rest.join(' ');
    console.log(isLimitLine(regexes(c), t) ? 'MATCH (would mark limited)' : 'no match'); break;
  }
  case 'doctor': doctor(); break;
  case 'link': linkCmd(rest).catch((e) => die(e.message)); break;
  case 'setup': setup(); break;
  case 'version': console.log(VERSION); break;
  case 'wrap': wrap(rest); break;
  case 'run': run(rest); break;
  default: run(process.argv.slice(2));
}
