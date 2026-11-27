const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_SOURCE =
  process.env.PROVIDER_SOURCE ||
  'https://github.com/vegatv0127/vegatv-providers';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const commonHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const kvMap = new Map();
const kvStore = {
  async get(k) { return kvMap.get(k); },
  async set(k, v) { kvMap.set(k, v); },
  async delete(k) { kvMap.delete(k); },
};

const CryptoShim = {
  CryptoDigestAlgorithm: { MD5: 'md5', SHA1: 'sha1', SHA256: 'sha256', SHA384: 'sha384', SHA512: 'sha512' },
  CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
  async digestStringAsync(algorithm, data, options = {}) {
    const algo = String(algorithm || 'sha256').toLowerCase().replace('-', '');
    const enc = String(options.encoding || 'hex').toLowerCase() === 'base64' ? 'base64' : 'hex';
    return crypto.createHash(algo).update(String(data)).digest(enc);
  },
  getRandomBytes(n) { return new Uint8Array(crypto.randomBytes(n)); },
  async getRandomBytesAsync(n) { return new Uint8Array(crypto.randomBytes(n)); },
  randomUUID() { return crypto.randomUUID(); },
};

function normalizeSourceUrl(input) {
  const raw = String(input || DEFAULT_SOURCE).trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[parts.length - 1] === 'manifest.json') parts.pop();
    if (host === 'github.com' && parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/, '');
      const branch = parts[2] === 'tree' && parts.length > 3 ? parts.slice(3).join('/') : 'main';
      return `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${branch}`;
    }
    if (host === 'raw.githubusercontent.com' && parts.length >= 2) {
      return `${u.origin}/${parts.join('/')}`;
    }
    return `${u.origin}${parts.length ? '/' + parts.join('/') : ''}`;
  } catch {
    return 'https://raw.githubusercontent.com/vegatv0127/vegatv-providers/refs/heads/main';
  }
}

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function fetchCached(url, type = 'text') {
  const hit = cache.get(url);
  if (hit && Date.now() < hit.expires) return hit.data;
  const res = await axios.get(url, {
    headers: commonHeaders,
    timeout: 15000,
    responseType: type === 'json' ? 'json' : 'text',
  });
  cache.set(url, { data: res.data, expires: Date.now() + CACHE_TTL });
  return res.data;
}

function makeContext(baseRawUrl) {
  const axiosInstance = axios.create({ timeout: 20000, headers: commonHeaders });
  return {
    axios: axiosInstance,
    cheerio,
    commonHeaders,
    Crypto: CryptoShim,
    kvStore,
    async getBaseUrl(providerValue) {
      try {
        const urls = await fetchCached(`${baseRawUrl}/urls.json`, 'json');
        return urls?.[providerValue]?.url || '';
      } catch {
        return '';
      }
    },
  };
}

function runProviderCode(code, filename) {
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: id => {
      if (id === 'axios') return axios;
      if (id === 'cheerio') return cheerio;
      if (id === 'crypto') return crypto;
      throw new Error(`Unsupported require in provider module: ${id}`);
    },
    console,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    URL,
    URLSearchParams,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  sandbox.providerGlobal = sandbox;

  const script = new vm.Script(code, { filename });
  script.runInNewContext(sandbox, { timeout: 15000 });
  return mod.exports;
}

async function loadModule(baseRawUrl, provider, file) {
  const manifest = await fetchCached(`${baseRawUrl}/manifest.json`, 'json');
  const entry = Array.isArray(manifest) ? manifest.find(p => p.value === provider) : null;
  const folder = entry?.path ? entry.path.replace(/^\/+|\/+$/g, '') : `dist/${provider}`;
  const url = `${baseRawUrl}/${folder}/${file}.js`;
  const code = await fetchCached(url, 'text');
  return runProviderCode(code, `${provider}/${file}.js`);
}

app.get('/api/providers', async (req, res) => {
  try {
    const baseRawUrl = normalizeSourceUrl(req.query.source);
    const manifest = await fetchCached(`${baseRawUrl}/manifest.json`, 'json');
    const list = (Array.isArray(manifest) ? manifest : []).filter(p => !p.disabled);
    res.json({ source: baseRawUrl, providers: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog', async (req, res) => {
  try {
    const { provider, source } = req.query;
    const baseRawUrl = normalizeSourceUrl(source);
    const mod = await loadModule(baseRawUrl, provider, 'catalog');
    const ctx = makeContext(baseRawUrl);
    const catalog = typeof mod.catalog === 'function' ? await mod.catalog({ providerContext: ctx }) : mod.catalog || [];
    const genres = typeof mod.genres === 'function' ? await mod.genres({ providerContext: ctx }) : mod.genres || [];
    res.json({ catalog, genres });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts', async (req, res) => {
  try {
    const { provider, filter = '', page = '1', q = '', source } = req.query;
    const baseRawUrl = normalizeSourceUrl(source);
    const mod = await loadModule(baseRawUrl, provider, 'posts');
    const ctx = makeContext(baseRawUrl);
    const ac = new AbortController();
    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    const posts =
      q && String(q).trim() && typeof mod.getSearchPosts === 'function'
        ? await mod.getSearchPosts({ searchQuery: String(q).trim(), page: pageNum, providerValue: provider, signal: ac.signal, providerContext: ctx })
        : await mod.getPosts({ filter: String(filter), page: pageNum, providerValue: provider, signal: ac.signal, providerContext: ctx });
    res.json({ posts: Array.isArray(posts) ? posts : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta', async (req, res) => {
  try {
    const { provider, link, source } = req.query;
    const baseRawUrl = normalizeSourceUrl(source);
    const mod = await loadModule(baseRawUrl, provider, 'meta');
    const ctx = makeContext(baseRawUrl);
    const meta = await mod.getMeta({ link: String(link), provider: { value: provider }, providerContext: ctx });
    res.json({ meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/episodes', async (req, res) => {
  try {
    const { provider, url, source } = req.query;
    const baseRawUrl = normalizeSourceUrl(source);
    const mod = await loadModule(baseRawUrl, provider, 'episodes');
    const ctx = makeContext(baseRawUrl);
    const episodes = await mod.getEpisodes({ url: String(url), providerContext: ctx });
    res.json({ episodes: Array.isArray(episodes) ? episodes : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/streams', async (req, res) => {
  try {
    const { provider, link, type = 'movie', source } = req.query;
    const baseRawUrl = normalizeSourceUrl(source);
    const mod = await loadModule(baseRawUrl, provider, 'stream');
    const ctx = makeContext(baseRawUrl);
    const ac = new AbortController();
    const streams = await mod.getStream({ link: String(link), type: String(type), signal: ac.signal, providerContext: ctx, isDownload: false });
    res.json({ streams: Array.isArray(streams) ? streams : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/img', async (req, res) => {
  try {
    const target = String(req.query.url || '');
    if (!/^https?:\/\//i.test(target)) return res.status(400).end();
    const upstream = await axios.get(target, {
      responseType: 'stream',
      timeout: 12000,
      headers: { 'User-Agent': commonHeaders['User-Agent'], Referer: new URL(target).origin + '/' },
    });
    if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    upstream.data.pipe(res);
  } catch {
    res.status(404).end();
  }
});

app.get('/api/proxy', async (req, res) => {
  try {
    const targetUrl = String(req.query.url || '');
    if (!/^https?:\/\//i.test(targetUrl)) return res.status(400).send('Invalid URL');

    let customHeaders = {};
    if (req.query.h) {
      try { customHeaders = JSON.parse(Buffer.from(String(req.query.h), 'base64url').toString('utf8')); } catch {}
    }

    const reqHeaders = { 'User-Agent': commonHeaders['User-Agent'], ...customHeaders };
    if (req.headers.range) reqHeaders.Range = req.headers.range;

    const rewriteM3u8 = (text, baseUrl) => {
      const hParam = req.query.h ? `&h=${encodeURIComponent(req.query.h)}` : '';
      return String(text).split(/\r?\n/).map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => {
            const abs = new URL(uri, baseUrl).href;
            return `URI="/api/proxy?url=${encodeURIComponent(abs)}${hParam}"`;
          });
        }
        const abs = new URL(t, baseUrl).href;
        return `/api/proxy?url=${encodeURIComponent(abs)}${hParam}`;
      }).join('\n');
    };

    if (/\.m3u8(\?|$)/i.test(targetUrl)) {
      const upstream = await axios.get(targetUrl, { headers: reqHeaders, responseType: 'text', timeout: 20000 });
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewriteM3u8(upstream.data, targetUrl));
    }

    const upstream = await axios.get(targetUrl, {
      headers: reqHeaders,
      responseType: 'stream',
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400,
    });

    const ct = upstream.headers['content-type'] || '';
    if (ct.includes('mpegurl')) {
      const chunks = [];
      for await (const c of upstream.data) chunks.push(c);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewriteM3u8(Buffer.concat(chunks).toString('utf8'), targetUrl));
    }

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    upstream.data.pipe(res);
    res.on('close', () => upstream.data.destroy?.());
  } catch (err) {
    res.status(502).send(err.message);
  }
});

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Denzkie TV Web running at http://localhost:${PORT}`);
});