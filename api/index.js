// api/index.js — Vercel serverless function (drop-in for jiostb.lovable.app)
'use strict';

const PLAYLIST_URL = process.env.PLAYLIST_URL
  || 'https://jiostb.lovable.app/api/playlist?view=raw';
const DEFAULT_UA = process.env.DEFAULT_USER_AGENT || '@shoebbro';
const COMPUTE_EXPIRES = (process.env.COMPUTE_EXPIRES || 'true').toLowerCase() !== 'false';
const CACHE_TTL = 60;

function grabAttr(line, key) {
  const m = line.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '="([^"]*)"'));
  return m ? m[1].trim() : '';
}
function parseQsRaw(qs) {
  const out = {};
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    out[(i === -1 ? pair : pair.slice(0, i)).trim()] = (i === -1 ? '' : pair.slice(i + 1));
  }
  return out;
}
function computeExpiresIn(cookie) {
  if (!cookie || !COMPUTE_EXPIRES) return null;
  const m = String(cookie).match(/exp=(\d+)/);
  if (!m) return null;
  return Math.max(0, parseInt(m[1], 10) - Math.floor(Date.now() / 1000));
}

function parseM3u(content) {
  const channels = [];
  let current = null;
  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      current = { id:'', name:'', group:'', logo:'', user_agent:DEFAULT_UA, type:'dash', mpd_url:'', headers:{}, expires_in:null, clearkey:'' };
      current.id    = grabAttr(line, 'tvg-id');
      current.name  = grabAttr(line, 'tvg-name');
      current.logo  = grabAttr(line, 'tvg-logo');
      current.group = grabAttr(line, 'group-title');
      if (!current.name && line.includes(',')) current.name = line.split(',').pop().trim();
    } else if (line.startsWith('#KODIPROP:')) {
      if (!current) continue;
      const p = line.slice(10);
      const i = p.indexOf('=');
      if (i !== -1) {
        const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim();
        if (k === 'inputstream.adaptive.license_key') current.clearkey = v;
        else if (k === 'inputstream.adaptive.manifest_type') {
          if (v.toLowerCase() === 'mpd') current.type = 'dash';
          else if (v.toLowerCase() === 'hls') current.type = 'hls';
        }
      }
    } else if (line.startsWith('#EXTVLCOPT:')) {
      if (!current) continue;
      const o = line.slice(11);
      const i = o.indexOf('=');
      if (i !== -1) {
        const k = o.slice(0, i).trim(), v = o.slice(i + 1).trim();
        if (k === 'http-user-agent') current.user_agent = v;
        else if (k === 'http-referrer') current.headers.referer = v;
        else if (k === 'http-cookie') current.headers.cookie = v;
        else if (k === 'http-extra-headers' && v.includes(':')) {
          const ci = v.indexOf(':');
          current.headers[v.slice(0, ci).trim().toLowerCase()] = v.slice(ci + 1).trim();
        }
      }
    } else if (line.startsWith('#EXTHTTP:')) {
      if (!current) continue;
      try {
        const obj = JSON.parse(line.slice(9));
        for (const [hk, hv] of Object.entries(obj)) current.headers[hk.toLowerCase()] = hv;
      } catch (_) {}
    } else if (line.startsWith('#')) {
      continue;
    } else {
      if (!current) continue;
      let u = line, extra = {};
      const pipe = u.indexOf('|');
      if (pipe !== -1) { extra = parseQsRaw(u.slice(pipe + 1)); u = u.slice(0, pipe); }
      if (u.includes('?')) {
        const [base, qs] = u.split('?', 2);
        const params = parseQsRaw(qs);
        let token = null;
        if ('__hdnea__' in params) { token = `__hdnea__=${params['__hdnea__']}`; delete params['__hdnea__']; }
        else if ('hdntl' in params) { token = `hdntl=${params.hdntl}`; delete params.hdntl; }
        if (token) current.headers.cookie = token;
        const rem = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
        u = rem ? `${base}?${rem}` : base;
      }
      if (extra.cookie && !current.headers.cookie) current.headers.cookie = extra.cookie;
      if (extra.referer && !current.headers.referer) current.headers.referer = extra.referer;
      if (extra.origin && !current.headers.origin) current.headers.origin = extra.origin;
      if (extra['user-agent']) current.user_agent = extra['user-agent'];
      u = u.replace(/\?+$/, '').trim();
      current.mpd_url = u;
      const lower = u.toLowerCase();
      if (lower.includes('.mpd')) current.type = 'dash';
      else if (lower.includes('.m3u8')) current.type = 'hls';
      current.expires_in = computeExpiresIn(current.headers.cookie || '');
      channels.push(current);
      current = null;
    }
  }
  let nextId = 1;
  for (const ch of channels) { if (!ch.id) ch.id = String(nextId); nextId++; }
  return channels.map(ch => ({
    id:ch.id, name:ch.name, group:ch.group, logo:ch.logo,
    user_agent:ch.user_agent, type:ch.type, mpd_url:ch.mpd_url,
    headers:ch.headers, expires_in:ch.expires_in, clearkey:ch.clearkey,
  }));
}

const _state = { raw:'', data:[], loadedAt:0, source:'', lastError:null };
async function refreshIfNeeded() {
  const now = Date.now();
  if (_state.data.length > 0 && (now - _state.loadedAt) < CACHE_TTL * 1000) return;
  try {
    const r = await fetch(PLAYLIST_URL, { headers: { 'User-Agent': DEFAULT_UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    _state.raw = text; _state.data = parseM3u(text);
    _state.source = PLAYLIST_URL; _state.loadedAt = now; _state.lastError = null;
  } catch (e) { _state.lastError = `fetch failed: ${e.message}`; }
}

function project(ch, fieldsCsv) {
  if (!fieldsCsv) return ch;
  const out = {};
  for (const f of fieldsCsv.split(',').map(s => s.trim()).filter(Boolean))
    if (f in ch) out[f] = ch[f];
  return out;
}
function applyFilters(channels, args) {
  let out = channels;
  if (args.group) { const g = args.group.toLowerCase(); out = out.filter(c => String(c.group).toLowerCase() === g); }
  if (args.type)  { const t = args.type.toLowerCase();  out = out.filter(c => c.type.toLowerCase() === t); }
  if (args.q)     { const q = args.q.toLowerCase();     out = out.filter(c => c.name.toLowerCase().includes(q)); }
  return out;
}
function json(res, data, code = 200) {
  res.statusCode = code;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }
  if (req.method !== 'GET') return json(res, { error: 'method not allowed' }, 405);

  await refreshIfNeeded().catch(() => {});

  const args = {};
  const qIdx = req.url.indexOf('?');
  if (qIdx !== -1) {
    for (const pair of req.url.slice(qIdx + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
      const v = decodeURIComponent((eq === -1 ? '' : pair.slice(eq + 1)).replace(/\+/g, ' '));
      args[k] = v;
    }
  }

  let pathStr = args.path || '';
  if (!pathStr) {
    const u = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
    pathStr = u.replace(/^\/api\/?/i, '').replace(/^\//, '');
  }
  const segments = pathStr.split('/').map(decodeURIComponent).filter(Boolean);

  const isRoot = segments.length === 0
    || (segments.length === 1 && (segments[0] === 'channels' || segments[0] === 'playlist'));

  if (isRoot) {
    if (args.view === 'raw') {
      res.statusCode = 200;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'audio/x-mpegurl');
      return res.end(_state.raw || '');
    }
    let channels = applyFilters(_state.data, args);
    if (args.fields) channels = channels.map(c => project(c, args.fields));
    return json(res, channels);
  }
  if (segments.length === 2 && segments[0] === 'channel') {
    const target = segments[1];
    for (const c of _state.data) if (c.id === target) return json(res, c);
    return json(res, { error: `channel ${target} not found` }, 404);
  }
  if (segments.length === 1 && segments[0] === 'groups') {
    const counts = {};
    for (const c of _state.data) { const g = c.group || '(uncategorized)'; counts[g] = (counts[g] || 0) + 1; }
    return json(res, Object.keys(counts).sort().map(g => ({ group: g, count: counts[g] })));
  }
  if (segments.length === 2 && segments[0] === 'group') {
    const name = segments[1].toLowerCase();
    return json(res, _state.data.filter(c => String(c.group).toLowerCase() === name));
  }
  if (segments.length === 1 && segments[0] === 'search') {
    const q = (args.q || '').trim();
    if (!q) return json(res, { error: 'missing ?q=' }, 400);
    const needle = q.toLowerCase();
    return json(res, _state.data.filter(c => c.name.toLowerCase().includes(needle)));
  }
  if (segments.length === 1 && segments[0] === 'health') {
    const groups = Array.from(new Set(_state.data.map(c => c.group).filter(Boolean))).sort();
    return json(res, {
      status: _state.lastError ? 'degraded' : 'ok',
      source: _state.source,
      channels: _state.data.length,
      groups,
      lastError: _state.lastError,
      loadedAt: _state.loadedAt ? new Date(_state.loadedAt).toISOString() : null,
      runtime: 'vercel-nodejs',
    });
  }
  return json(res, { error: 'not found' }, 404);
};
