// Actionably Alert: watches GitHub Actions runs and streams start/finish events to the browser.
// No dependencies: plain Node 20+.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const API = process.env.GITHUB_API || 'https://api.github.com';
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- settings ----------
const defaults = {
  repos: process.env.REPOS ? process.env.REPOS.split(',').map(s => s.trim()).filter(Boolean) : [],
  token: process.env.GITHUB_TOKEN || '',
  interval: Number(process.env.POLL_SECONDS || 15),
};
let config = { ...defaults };
try { config = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

// ---------- state ----------
// per repo: { runs: Map<id, run>, etag, seeded, error, checkedAt }
const watched = new Map();
const recentEvents = []; // newest first, capped
const clients = new Set();

function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}

function slim(run, repo) {
  return {
    id: run.id,
    repo,
    name: run.name || run.display_title || 'Workflow',
    title: run.display_title || '',
    branch: run.head_branch || '',
    event: run.event || '',
    actor: run.actor?.login || run.triggering_actor?.login || '',
    status: run.status, // queued | in_progress | completed | waiting | requested | pending
    conclusion: run.conclusion, // success | failure | cancelled | skipped | timed_out | ...
    number: run.run_number,
    attempt: run.run_attempt,
    url: run.html_url,
    startedAt: run.run_started_at || run.created_at,
    updatedAt: run.updated_at,
  };
}

function pushEvent(kind, run) {
  const ev = { kind, run, at: new Date().toISOString() };
  recentEvents.unshift(ev);
  recentEvents.length = Math.min(recentEvents.length, 50);
  broadcast('alert', ev);
}

async function pollRepo(repo) {
  const w = watched.get(repo) || { runs: new Map(), etag: null, seeded: false, error: null };
  watched.set(repo, w);
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Actionably-Alert',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (w.etag) headers['If-None-Match'] = w.etag;

  try {
    const r = await fetch(`${API}/repos/${repo}/actions/runs?per_page=30`, { headers });
    w.checkedAt = new Date().toISOString();
    if (r.status === 304) { w.error = null; return; }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      w.error = r.status === 404
        ? 'Repo not found. Check the name, or add a token if it is private.'
        : r.status === 401 ? 'The token was rejected. Paste a fresh one in Settings.'
        : r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0'
          ? 'GitHub rate limit reached. Add a token to check more often.'
          : (body.message || `GitHub said ${r.status}`);
      return;
    }
    w.etag = r.headers.get('etag');
    w.error = null;
    const data = await r.json();
    for (const raw of data.workflow_runs || []) {
      const run = slim(raw, repo);
      const prev = w.runs.get(run.id);
      w.runs.set(run.id, run);
      if (!w.seeded) continue; // first look: learn what's there, don't alert on history
      const restarted = prev && prev.attempt !== run.attempt;
      if (!prev || restarted) {
        if (run.status === 'completed') { pushEvent('started', run); pushEvent('finished', run); }
        else pushEvent('started', run);
      } else if (prev.status !== 'completed' && run.status === 'completed') {
        pushEvent('finished', run);
      } else if (prev.status !== run.status) {
        broadcast('update', run);
      }
    }
    // keep memory small
    if (w.runs.size > 200) {
      const keep = [...w.runs.values()].sort((a, b) => b.id - a.id).slice(0, 100);
      w.runs = new Map(keep.map(x => [x.id, x]));
    }
    w.seeded = true;
  } catch (e) {
    w.error = `Can't reach GitHub (${e.cause?.code || e.message}).`;
  } finally {
    broadcast('state', publicState());
  }
}

function publicState() {
  return {
    repos: config.repos,
    hasToken: Boolean(config.token),
    interval: config.interval,
    status: Object.fromEntries(config.repos.map(repo => {
      const w = watched.get(repo);
      return [repo, { error: w?.error || null, checkedAt: w?.checkedAt || null, ready: Boolean(w?.seeded) }];
    })),
    runs: [...watched.entries()]
      .filter(([repo]) => config.repos.includes(repo))
      .flatMap(([, w]) => [...w.runs.values()])
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 25),
    events: recentEvents,
  };
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  const tick = async () => {
    await Promise.all(config.repos.map(pollRepo));
    timer = setTimeout(tick, Math.max(5, config.interval) * 1000);
  };
  tick();
}

// ---------- http ----------
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
  });
}

function normalizeRepo(s) {
  s = String(s).trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = s.match(/github\.com[/:]([^/]+)\/([^/]+)/);
  if (m) return `${m[1]}/${m[2]}`;
  return /^[\w.-]+\/[\w.-]+$/.test(s) ? s : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(publicState()));
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (Array.isArray(body.repos)) {
        const repos = body.repos.map(normalizeRepo);
        if (repos.some(r => !r)) throw new Error('Use the form owner/repo, or paste the GitHub link.');
        config.repos = [...new Set(repos)];
      }
      if (typeof body.token === 'string') config.token = body.token.trim(); // '' clears it
      if (body.interval) config.interval = Math.min(600, Math.max(5, Number(body.interval) || 15));
      saveConfig();
      for (const k of [...watched.keys()]) if (!config.repos.includes(k)) watched.delete(k);
      schedule();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(publicState()));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.pathname === '/api/test' && req.method === 'POST') {
    broadcast('alert', { kind: 'test', at: new Date().toISOString(), run: { name: 'Test alert', repo: 'Actionably Alert', title: 'Popups are working.' } });
    res.writeHead(204); return res.end();
  }

  // static files
  const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Actionably Alert is running on http://localhost:${PORT}`);
  schedule();
});
