const SOURCE   = process.env.SOURCE   || 'https://jiobkl.ytzinadabaad.workers.dev/';
const CACHE_MS = Number(process.env.CACHE_MS || 30) * 1000;

let cache = { at: 0, body: '' };

function buildM3U(channels) {
  const out = ['#EXTM3U'];
  for (const ch of channels) {
    const url = ch.mpd_url || ch.url || ch.stream_url;
    if (!url) continue;

    const name  = String(ch.name  || 'Unknown').replace(/"/g, "'");
    const group = String(ch.group || 'General').replace(/"/g, "'");
    const logo  = ch.logo || '';
    const id    = ch.id   || '';

    out.push(
      `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}" group-title="${group}",${name}`
    );

    const isDash = ch.type === 'dash' || /\.mpd(\?|$)/i.test(url);
    if (isDash) {
      out.push('#KODIPROP:inputstream=inputstream.adaptive');
      out.push('#KODIPROP:inputstream.adaptive.manifest_type=mpd');
      if (ch.clearkey) {
        out.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
        out.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.clearkey}`);
      }
    }

    const headers = { ...(ch.headers || {}) };
    if (ch.user_agent) headers['User-Agent'] = ch.user_agent;

    for (const [k, v] of Object.entries(headers)) {
      out.push(`#EXTVLCOPT:http-${k.toLowerCase()}=${v}`);
    }
    if (Object.keys(headers).length) {
      out.push(`#EXTHTTP:${JSON.stringify(headers)}`);
    }

    out.push(url, '');
  }
  return out.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (Date.now() - cache.at < CACHE_MS && cache.body) {
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
    return res.status(200).send(cache.body);
  }

  try {
    const upstream = await fetch(SOURCE, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Vercel STB API)',
        'Accept': 'application/json, application/x-mpegurl, text/plain, */*',
      },
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);

    const text = (await upstream.text()).trim();

    // ── Upstream already an M3U → pass through
    if (text.startsWith('#EXTM3U')) {
      cache = { at: Date.now(), body: text };
      res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
      return res.status(200).send(text);
    }

    // ── Upstream JSON → convert
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Upstream returned neither JSON nor M3U. First 120 chars: ${text.slice(0, 120)}`
      );
    }

    const channels = Array.isArray(data)
      ? data
      : (data.channels || data.data || data.items || []);
    if (!channels.length) throw new Error('Upstream JSON had no channels array');

    const body = buildM3U(channels);
    cache = { at: Date.now(), body };

    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
    res.status(200).send(body);
  } catch (err) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(502).send(`#EXTM3U\n#ERROR: ${err.message}`);
  }
}
