export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    ok: true,
    playlist: '/playlist.m3u',
    source: process.env.SOURCE || 'https://jiostb.lovable.app/api/playlist?view=raw',
    usage: 'Add /playlist.m3u to TiviMate, IPTV Smarters, OTT Navigator, or VLC',
  });
}
