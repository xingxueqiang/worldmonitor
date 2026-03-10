#!/usr/bin/env node
/**
 * WorldMonitor RSS Relay Server
 * Simplified version for Railway deployment
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 3004;
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET || '';
const RELAY_AUTH_HEADER = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
const ALLOW_UNAUTHENTICATED_RELAY = process.env.ALLOW_UNAUTHENTICATED_RELAY === 'true';
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Rate limiting
const rateLimitBuckets = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 1200;

function checkRateLimit(key) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    return false;
  }
  bucket.count++;
  return true;
}

// Authentication
function checkAuth(req) {
  if (ALLOW_UNAUTHENTICATED_RELAY) return true;
  if (!RELAY_SHARED_SECRET) return !IS_PRODUCTION;
  const authHeader = req.headers[RELAY_AUTH_HEADER];
  return authHeader === RELAY_SHARED_SECRET;
}

// CORS headers
function corsHeaders(req) {
  const origin = req.headers.origin || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-relay-key',
    'Access-Control-Max-Age': '86400',
  };
}

// Fetch with timeout
function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, timeoutMs);

    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.request(url, options, (res) => {
      clearTimeout(timeout);
      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          text: () => Promise.resolve(Buffer.concat(data).toString()),
          arrayBuffer: () => Promise.resolve(Buffer.concat(data)),
        });
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    req.end();
  });
}

// RSS Proxy endpoint
async function handleRSS(req, res, url) {
  const feedUrl = new URL(url, 'http://localhost').searchParams.get('url');
  if (!feedUrl) {
    res.writeHead(400, corsHeaders(req));
    res.end(JSON.stringify({ error: 'Missing url parameter' }));
    return;
  }

  try {
    const response = await fetchWithTimeout(feedUrl, {
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      }
    }, 15000);

    const text = await response.text();
    res.writeHead(200, {
      ...corsHeaders(req),
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=120',
    });
    res.end(text);
  } catch (error) {
    console.error(`[Relay] RSS fetch error: ${error.message}`);
    res.writeHead(502, corsHeaders(req));
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Yahoo Finance proxy
async function handleYahoo(req, res, url) {
  const symbol = new URL(url, 'http://localhost').searchParams.get('symbol');
  if (!symbol) {
    res.writeHead(400, corsHeaders(req));
    res.end(JSON.stringify({ error: 'Missing symbol parameter' }));
    return;
  }

  try {
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
    const response = await fetchWithTimeout(yahooUrl, {
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/json',
      }
    }, 15000);

    const text = await response.text();
    res.writeHead(200, {
      ...corsHeaders(req),
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    });
    res.end(text);
  } catch (error) {
    console.error(`[Relay] Yahoo fetch error: ${error.message}`);
    res.writeHead(502, corsHeaders(req));
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Health check
function handleHealth(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    ...corsHeaders(req),
  });
  res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
}

// Main server
const server = http.createServer(async (req, res) => {
  const url = req.url;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  // Health check (no auth required)
  if (url === '/health' || url === '/') {
    handleHealth(req, res);
    return;
  }

  // Rate limiting
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rateLimitKey = `${url}:${clientIp}`;
  if (!checkRateLimit(rateLimitKey)) {
    res.writeHead(429, corsHeaders(req));
    res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
    return;
  }

  // Authentication check
  if (!checkAuth(req)) {
    res.writeHead(401, corsHeaders(req));
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // Route handling
  try {
    if (url.startsWith('/rss')) {
      await handleRSS(req, res, url);
    } else if (url.startsWith('/yahoo')) {
      await handleYahoo(req, res, url);
    } else {
      res.writeHead(404, corsHeaders(req));
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (error) {
    console.error(`[Relay] Error: ${error.message}`);
    res.writeHead(500, corsHeaders(req));
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`[Relay] Server listening on port ${PORT}`);
  console.log(`[Relay] Production mode: ${IS_PRODUCTION}`);
  console.log(`[Relay] Auth required: ${!ALLOW_UNAUTHENTICATED_RELAY && RELAY_SHARED_SECRET}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Relay] SIGTERM received, shutting down...');
  server.close(() => {
    console.log('[Relay] Server closed');
    process.exit(0);
  });
});
