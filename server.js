const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE =
  process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4';

function send(res, status, type, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers':
      'x-requests-remaining, x-requests-used, x-requests-last',
    ...extraHeaders
  });

  res.end(body);
}

function apiGet(urlString) {
  return new Promise((resolve, reject) => {
    https.get(
      urlString,
      {
        headers: {
          'User-Agent': 'BetCore/1.1'
        }
      },
      r => {
        let data = '';

        r.on('data', chunk => {
          data += chunk;
        });

        r.on('end', () => {
          if (r.statusCode >= 200 && r.statusCode < 300) {
            try {
              resolve({
                status: r.statusCode,
                data: JSON.parse(data),
                headers: r.headers
              });
            } catch (e) {
              reject(new Error('API returned non-JSON data'));
            }
          } else {
            reject(
              new Error(
                `Odds API HTTP ${r.statusCode}: ${data.slice(0, 500)}`
              )
            );
          }
        });
      }
    ).on('error', reject);
  });
}

function normalize(events) {
  const rows = [];

  for (const event of Array.isArray(events) ? events : []) {
    for (const bookmaker of event.bookmakers || []) {
      for (const market of bookmaker.markets || []) {
        for (const outcome of market.outcomes || []) {
          rows.push({
            id: event.id,
            sport: event.sport_key,
            league: event.sport_title,
            commence: event.commence_time,
            home: event.home_team,
            away: event.away_team,
            bookmaker: bookmaker.title,
            bookmakerKey: bookmaker.key,
            market: market.key,
            name: outcome.name,
            point: outcome.point ?? null,
            price: outcome.price
          });
        }
      }
    }
  }

  return rows;
}

function diagnostics(events, rows) {
  const bookmakerSet = new Set();
  const marketCounts = {};

  for (const event of Array.isArray(events) ? events : []) {
    for (const bookmaker of event.bookmakers || []) {
      bookmakerSet.add(
        bookmaker.key || bookmaker.title || 'unknown'
      );

      for (const market of bookmaker.markets || []) {
        marketCounts[market.key] =
          (marketCounts[market.key] || 0) + 1;
      }
    }
  }

  return {
    events: Array.isArray(events) ? events.length : 0,
    bookmakers: bookmakerSet.size,
    marketCounts,
    rows: rows.length
  };
}

async function requestOdds(sport, regions, markets) {
  const endpoint =
    `${ODDS_API_BASE}/sports/${encodeURIComponent(sport)}/odds/` +
    `?apiKey=${encodeURIComponent(API_KEY)}` +
    `&regions=${encodeURIComponent(regions)}` +
    `&markets=${encodeURIComponent(markets)}` +
    `&oddsFormat=decimal`;

  return apiGet(endpoint);
}

async function getOdds(req, res) {
  if (!API_KEY) {
    return send(
      res,
      500,
      'application/json; charset=utf-8',
      JSON.stringify({
        error: 'Missing ODDS_API_KEY',
        message:
          'Set ODDS_API_KEY on the server. Never put the key in frontend code.'
      })
    );
  }

  const u = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  const sport =
    u.searchParams.get('sport') || 'soccer_epl';

  const regions =
    u.searchParams.get('regions') || 'eu';

  let markets =
    u.searchParams.get('markets') || 'h2h';

  const requestedMarkets = markets
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  let result = await requestOdds(
    sport,
    regions,
    markets
  );

  let rows = normalize(result.data);
  let fallbackUsed = false;

  /*
   * Для футболу h2h використовуємо як резервний
   * ринок, якщо комбінований запит нічого не повернув.
   */
  if (
    rows.length === 0 &&
    !requestedMarkets.includes('h2h') &&
    sport.startsWith('soccer_')
  ) {
    result = await requestOdds(
      sport,
      regions,
      'h2h'
    );

    rows = normalize(result.data);
    fallbackUsed = true;
    markets = 'h2h';
  }

  const diag = diagnostics(
    result.data,
    rows
  );

  return send(
    res,
    200,
    'application/json; charset=utf-8',
    JSON.stringify({
      source: 'The Odds API',
      fetchedAt: new Date().toISOString(),

      requested: {
        sport,
        regions,
        markets: requestedMarkets
      },

      usedMarkets: markets,
      fallbackUsed,

      events: diag.events,
      bookmakers: diag.bookmakers,
      marketCounts: diag.marketCounts,
      rows: rows,

      quota: {
        remaining:
          result.headers['x-requests-remaining'] ?? null,

        used:
          result.headers['x-requests-used'] ?? null,

        last:
          result.headers['x-requests-last'] ?? null
      }
    }),
    {
      'X-BetCore-Events': String(diag.events),
      'X-BetCore-Bookmakers': String(diag.bookmakers),
      'X-BetCore-Rows': String(diag.rows)
    }
  );
}

async function handle(req, res) {

  if (req.method === 'OPTIONS') {
    return send(
      res,
      204,
      'text/plain; charset=utf-8',
      ''
    );
  }

  if (req.url.startsWith('/api/odds')) {
    try {
      return await getOdds(req, res);
    } catch (e) {
      console.error(
        'BetCore API error:',
        e
      );

      return send(
        res,
        502,
        'application/json; charset=utf-8',
        JSON.stringify({
          error:
            e.message ||
            'Odds API request failed'
        })
      );
    }
  }

  if (req.url === '/health') {
    return send(
      res,
      200,
      'application/json; charset=utf-8',
      JSON.stringify({
        ok: true,
        service: 'BetCore',
        apiKeyConfigured:
          Boolean(API_KEY)
      })
    );
  }

  if (
    req.url === '/' ||
    req.url === '/index.html'
  ) {
    return send(
      res,
      200,
      'text/html; charset=utf-8',
      html
    );
  }

  return send(
    res,
    404,
    'text/plain; charset=utf-8',
    'Not found'
  );
}

const html = fs.readFileSync(
  path.join(__dirname, 'index.html'),
  'utf8'
);

const server =
  http.createServer(handle);

server.listen(PORT, () => {
  console.log(
    `BetCore running on port ${PORT}`
  );

  console.log(
    `ODDS_API_KEY configured: ${Boolean(API_KEY)}`
  );
});
