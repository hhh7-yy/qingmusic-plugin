/* QingMusic external plugin for YouTube & Bilibili
 * -------------------------------------------------
 * This file defines four functions expected by your music.json:
 *   - ytSearchMusic(keyword)  -> Promise<Array<Song>>
 *   - ytMusicDetail(videoId)  -> Promise<{ url, br?, mime? }>
 *   - biliSearchMusic(keyword)-> Promise<Array<Song>>
 *   - biliMusicDetail(bvid)   -> Promise<{ url, br?, mime? }>
 *
 * "Song" minimal fields we return:
 *   { id, name, artist, cover, duration? }
 *
 * NOTE: Depending on your QingMusic build, CORS or referrer restrictions might apply.
 * If Bilibili/YouTube audio URL fails due to CORS or Referer, use the Worker proxy shown below.
 *
 * Use responsibly. Respect platform ToS and local laws.
 */
(function () {
  const PIPED_INSTANCES = [
    'https://piped.video',
    'https://piped.projectsegfau.lt',
    'https://piped.lunar.icu',
    'https://piped.privacydev.net'
  ];

  async function tryJson(url, options, fallbackHosts) {
    const tryOnce = async (u) => {
      const res = await fetch(u, options);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    };
    let lastErr = null;
    if (!fallbackHosts || fallbackHosts.length === 0) {
      return tryOnce(url);
    }
    for (const host of fallbackHosts) {
      const u = url.replace(/^https?:\/\/[^/]+/, host);
      try {
        return await tryOnce(u);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('All instances failed for: ' + url);
  }

  /** ---------------- YouTube via Piped API ---------------- **/
  async function ytSearchMusic(keyword) {
    const q = encodeURIComponent(keyword);
    const url = `${PIPED_INSTANCES[0]}/api/v1/search?q=${q}`;
    const data = await tryJson(url, {}, PIPED_INSTANCES);
    const items = Array.isArray(data) ? data : (data.items || data);
    return items
      .filter(it => (it.type === 'stream' || it.type === 'video') && it.url && it.title)
      .map(it => {
        const vid = (it.url.match(/v=([A-Za-z0-9_\-]+)/) || [])[1] || it.id || it.url;
        const durSec = typeof it.duration === 'number' ? it.duration :
                       (typeof it.duration === 'string' ? parseDuration(it.duration) : undefined);
        return {
          id: vid,
          name: it.title,
          artist: it.uploader || it.uploaderName || 'YouTube',
          cover: it.thumbnail || it.thumbnails?.[0]?.url || '',
          duration: durSec
        };
      });
  }

  async function ytMusicDetail(videoId) {
    const url = `${PIPED_INSTANCES[0]}/api/v1/streams/${encodeURIComponent(videoId)}`;
    const data = await tryJson(url, {}, PIPED_INSTANCES);
    // choose the highest bitrate audio stream available
    const audios = data?.audioStreams || [];
    if (!audios.length) throw new Error('No audio streams');
    const best = audios.reduce((a, b) => (b.bitrate > a.bitrate ? b : a), audios[0]);
    return {
      url: best.url,
      br: best.bitrate,
      mime: best.mimeType || best.codec || ''
    };
  }

  /** ---------------- Bilibili ---------------- **/
  async function biliSearchMusic(keyword) {
    const q = encodeURIComponent(keyword);
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${q}`;
    const data = await tryJson(url, { headers: { 'Referer': 'https://www.bilibili.com' } });
    const list = data?.data?.result || [];
    return list.map(it => ({
      id: it.bvid,
      name: it.title?.replace(/<[^>]+>/g, '') || it.bvid,
      artist: it.author || 'Bilibili',
      cover: it.pic ? (it.pic.startsWith('http') ? it.pic : ('https:' + it.pic)) : '',
      duration: it.duration ? parseBiliDuration(it.duration) : undefined
    }));
  }

  async function biliMusicDetail(bvid) {
    // 1) fetch view info to get cid
    const view = await tryJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { headers: { 'Referer': 'https://www.bilibili.com' } }
    );
    const cid = view?.data?.cid || (view?.data?.pages?.[0]?.cid);
    if (!cid) throw new Error('Cannot get cid for ' + bvid);

    // 2) fetch playurl (DASH) to get audio stream
    // fnval=16 enables DASH; fourk=1 allows higher qualities when available
    const play = await tryJson(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&fourk=1`,
      { headers: { 'Referer': 'https://www.bilibili.com' } }
    );

    const dash = play?.data?.dash;
    const audio = dash?.audio?.[0] || play?.data?.durl?.[0];
    const url = audio?.baseUrl || audio?.url;
    if (!url) throw new Error('No audio url from playurl');
    return {
      url: url,
      br: audio?.bandwidth || undefined,
      mime: audio?.mimeType || ''
    };
  }

  /** ---------------- helpers ---------------- **/
  function parseDuration(s) {
    // accepts formats like "3:45" or "01:02:03"
    if (typeof s !== 'string') return undefined;
    const parts = s.split(':').map(n => parseInt(n, 10));
    if (parts.some(isNaN)) return undefined;
    let sec = 0;
    for (let i = 0; i < parts.length; i++) {
      sec = sec * 60 + parts[i];
    }
    return sec;
  }
  function parseBiliDuration(s) {
    // Bilibili returns "mm:ss" or "hh:mm:ss"
    return parseDuration(s);
  }

  // expose to global
  if (typeof window !== 'undefined') {
    window.ytSearchMusic = ytSearchMusic;
    window.ytMusicDetail = ytMusicDetail;
    window.biliSearchMusic = biliSearchMusic;
    window.biliMusicDetail = biliMusicDetail;
  } else if (typeof global !== 'undefined') {
    global.ytSearchMusic = ytSearchMusic;
    global.ytMusicDetail = ytMusicDetail;
    global.biliSearchMusic = biliSearchMusic;
    global.biliMusicDetail = biliMusicDetail;
  }

  /** ---------------- Optional: Cloudflare Worker proxy (use if direct fetch fails) ----------------
   * Copy-paste this into Cloudflare Workers as index.js, then deploy.
   * Usage: fetch('https://<your-worker>.workers.dev/proxy?url=' + encodeURIComponent(targetURL), { headers: { 'x-ref': 'https://www.bilibili.com' } })
   *
   * addEventListener('fetch', event => {
   *   event.respondWith(handle(event.request));
   * });
   * async function handle(req) {
   *   const u = new URL(req.url);
   *   if (u.pathname === '/proxy') {
   *     const target = u.searchParams.get('url');
   *     const ref = req.headers.get('x-ref') || 'https://www.bilibili.com';
   *     if (!target) return new Response('missing url', { status: 400 });
   *     const r = await fetch(target, { headers: { 'Referer': ref } });
   *     const resp = new Response(r.body, r);
   *     resp.headers.set('Access-Control-Allow-Origin', '*');
   *     return resp;
   *   }
   *   return new Response('ok');
   * }
   * ---------------------------------------------------------------------------------------------- */
})();