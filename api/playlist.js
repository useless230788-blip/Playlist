// api/playlist.js

// Your source JSON API endpoint
const API_URL = 'https://jiostb.lovable.app/api/playlist?view=raw';

// Helper to escape special characters for M3U attributes
const esc = (s) => String(s ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();

// The main serverless function handler
export default async function handler(req, res) {
  try {
    // 1. Fetch the JSON data from your source API
    const apiResponse = await fetch(API_URL, {
      headers: { 'Accept': 'application/json' }
    });

    if (!apiResponse.ok) {
      throw new Error(`API responded with status ${apiResponse.status}`);
    }

    let channels = await apiResponse.json();

    // Handle possible wrapper object (e.g., { channels: [...] })
    if (!Array.isArray(channels) && Array.isArray(channels.channels)) {
      channels = channels.channels;
    }

    if (!Array.isArray(channels)) {
      throw new Error('API did not return a valid channel array.');
    }

    // 2. Build the M3U playlist string
    const lines = [
      '#EXTM3U',
      `# STBPLive -> M3U - Generated ${new Date().toISOString()}`,
      ''
    ];

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

      // Add clearkey and manifest type for DASH streams
      if (type === 'dash') {
        lines.push('#KODIPROP:inputstream.adaptive.manifest_type=mpd');
        if (ck) {
          lines.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
          lines.push(`#KODIPROP:inputstream.adaptive.license_key=${ck}`);
        }
      } else if (type === 'hls') {
        lines.push('#KODIPROP:inputstream.adaptive.manifest_type=hls');
      }

      // Add VLC-style headers
      if (ua) lines.push(`#EXTVLCOPT:http-user-agent=${ua}`);
      if (cookie) lines.push(`#EXTVLCOPT:http-cookie=${cookie}`);

      // Add generic HTTP headers as JSON for broader player compatibility
      const ext = {};
      if (cookie) ext.Cookie = cookie;
      if (ua) ext['User-Agent'] = ua;
      // Include any other extra headers from the source API
      if (ch.headers && typeof ch.headers === 'object') {
        for (const [key, value] of Object.entries(ch.headers)) {
          const lowerKey = key.toLowerCase();
          if (lowerKey !== 'cookie' && lowerKey !== 'user-agent') {
            ext[key] = value;
          }
        }
      }
      if (Object.keys(ext).length > 0) {
        lines.push(`#EXTHTTP:${JSON.stringify(ext)}`);
      }

      lines.push(url);
      lines.push('');
    }

    const playlist = lines.join('\n');

    // 3. Send the response with the correct headers
    // Vercel defaults to text/plain, so we must set the M3U content type explicitly.
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="playlist.m3u"');
    res.setHeader('Access-Control-Allow-Origin', '*'); // Optional: allows use from web players
    res.setHeader('Cache-Control', 'no-store'); // Ensures players get fresh cookies

    // Send the generated playlist
    res.status(200).send(playlist);

  } catch (error) {
    console.error('Playlist generation failed:', error);
    res.status(500).json({ error: error.message || 'Failed to generate playlist' });
  }
          }
