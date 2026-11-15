const API_URL = process.env.API_URL || 'https://jiostb.lovable.app/api/playlist?view=raw';

const esc = (s) => String(s ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();

function buildPlaylist(channels) {
  const lines = ['#EXTM3U', `# STBPLive -> M3U - Generated ${new Date().toISOString()}`, ''];
  for (const ch of channels) {
    const url = ch.mpd_url;
    if (!url) continue;
    const name   = esc(ch.name || 'Unknown');
    const logo   = esc(ch.logo || '');
    const group  = esc(ch.group || 'Uncategorized');
    const ua     = ch.user_agent || '';
    const cookie = ch.headers?.cookie || '';
    const ck     = ch.clearkey || '';
    const type   = (ch.type || 'dash').toLowerCase();

    lines.push(`#EXTINF:-1 tvg-name="${name}" tvg-logo="${logo}" group-title="${group}", ${name}`);

    if (type === 'dash') {
      lines.push('#KODIPROP:inputstream.adaptive.manifest_type=mpd');
      if (ck) {
        lines.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${ck}`);
      }
    } else if (type === 'hls') {
      lines.push('#KODIPROP:inputstream.adaptive.manifest_type=hls');
    }

    if (ua)     lines.push(`#EXTVLCOPT:http-user-agent=${ua}`);
    if (cookie) lines.push(`#EXTVLCOPT:http-cookie=${cookie}`);

    const ext = {};
    if (cookie) ext.Cookie = cookie;
    if (ua)     ext['User-Agent'] = ua;
    for (const [k, v] of Object.entries(ch.headers || {})) {
      if (!['cookie', 'user-agent'].includes(k.toLowerCase())) ext[k] = v;
    }
    if (Object.keys(ext).length) lines.push(`#EXTHTTP:${JSON.stringify(ext)}`);

    lines.push(url, '');
  }
  return lines.join('\n');
}

export default async function handler(req, res) {
  try {
    const apiResponse = await fetch(API_URL, {
      headers: { Accept: 'application/json, text/plain, audio/x-mpegurl, */*' },
    });
    if (!apiResponse.ok) {
      return res.status(502).json({ error: `Source API returned ${apiResponse.status}` });
    }

    const body = (await apiResponse.text()).trim();

    // CASE A: source already returns M3U → pass through
    if (body.startsWith('#EXTM3U')) {
      res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="playlist.m3u"');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(body);
    }

    // CASE B: source returns JSON → convert
    let channels;
    try {
      channels = JSON.parse(body);
    } catch {
      return res.status(502).json({ error: 'Source returned neither M3U nor JSON', preview: body.slice(0, 200) });
    }
    if (!Array.isArray(channels) && Array.isArray(channels.channels)) channels = channels.channels;
    if (!Array.isArray(channels)) {
      return res.status(502).json({ error: 'Source JSON has no channel array' });
    }

    const m3u = buildPlaylist(channels);
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="playlist.m3u"');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(m3u);

  } catch (error) {
    console.error('[playlist] failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to build playlist' });
  }
}
