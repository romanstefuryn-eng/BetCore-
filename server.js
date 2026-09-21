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
    https
      .get(
        urlString,
        {
          headers: {
            'User-Agent': 'BetCore/3.0'
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
              } catch {
                reject(new Error('Odds API повернув не JSON.'));
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
      )
      .on('error', reject);
  });
}


/* =========================================================
   NORMALIZE
   ========================================================= */

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

            price: Number(outcome.price)
          });
        }
      }
    }
  }

  return rows;
}


/* =========================================================
   GROUP MATCHES
   ========================================================= */

function buildMatches(rows) {
  const map = new Map();

  for (const row of rows) {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id,

        league: row.league,
        commence: row.commence,

        home: row.home,
        away: row.away,

        markets: {},

        bookmakerSet: new Set()
      });
    }

    const match = map.get(row.id);

    match.bookmakerSet.add(row.bookmaker);

    if (!match.markets[row.market]) {
      match.markets[row.market] = [];
    }

    match.markets[row.market].push({
      bookmaker: row.bookmaker,
      bookmakerKey: row.bookmakerKey,

      name: row.name,
      point: row.point,

      price: row.price
    });
  }

  return [...map.values()].map(match => {
    const markets = {};

    for (const [marketKey, outcomes] of Object.entries(
      match.markets
    )) {
      const bookmakerMap = new Map();

      /*
       * Групуємо коефіцієнти по букмекерах.
       */

      for (const outcome of outcomes) {
        if (!bookmakerMap.has(outcome.bookmaker)) {
          bookmakerMap.set(outcome.bookmaker, {
            bookmaker: outcome.bookmaker,
            bookmakerKey: outcome.bookmakerKey,

            outcomes: []
          });
        }

        bookmakerMap.get(outcome.bookmaker).outcomes.push({
          name: outcome.name,
          point: outcome.point,

          price: outcome.price
        });
      }

      const bookmakerRows = [...bookmakerMap.values()];


      /*
       * Найкращий коефіцієнт по кожному результату.
       */

      const bestMap = new Map();

      for (const item of outcomes) {
        const key =
          `${item.name}__${item.point ?? ''}`;

        const current = bestMap.get(key);

        if (!current || item.price > current.price) {
          bestMap.set(key, {
            name: item.name,
            point: item.point,

            price: item.price,

            bookmaker: item.bookmaker
          });
        }
      }


      markets[marketKey] = {
        bookmakers: bookmakerRows,

        best: [...bestMap.values()]
      };
    }


    return {
      ...match,

      bookmakerSet: undefined,

      bookmakers: [...match.bookmakerSet],

      markets
    };
  });
}


/* =========================================================
   NO-VIG
   ========================================================= */

function marketNoVigFromBest(bestPrices) {
  const valid = bestPrices.filter(
    x => Number(x.price) > 1
  );

  if (valid.length < 2) {
    return null;
  }

  const overround = valid.reduce(
    (acc, x) => acc + 1 / Number(x.price),
    0
  );

  if (!(overround > 0)) {
    return null;
  }

  return {
    margin: (overround - 1) * 100,

    outcomes: valid.map(x => ({
      name: x.name,

      point: x.point ?? null,

      bookmaker: x.bookmaker,

      price: x.price,

      probability:
        ((1 / x.price) / overround) * 100,

      fairOdds:
        overround / (1 / x.price)
    }))
  };
}


/* =========================================================
   BETCORE ENGINE
   ========================================================= */

function buildEngine(match) {

  /*
   * ВАЖЛИВО:
   *
   * market no-vig = тільки діагностика ринку.
   *
   * Це НЕ Fair Probability BETCORE.
   *
   * Незалежна Fair Probability буде UNKNOWN,
   * поки не підключені:
   *
   * - статистика команд
   * - xG/xGA
   * - склади
   * - травми
   * - форма
   * - League DNA
   * - market movement
   * - інші незалежні фактори
   */

  const h2h = match.markets?.h2h;

  let marketNoVig = null;

  let bestPrices = [];


  if (h2h?.best?.length) {

    bestPrices = h2h.best.map(x => ({
      name: x.name,

      point: x.point ?? null,

      price: Number(x.price),

      bookmaker: x.bookmaker
    }));

    marketNoVig =
      marketNoVigFromBest(bestPrices);
  }


  const bookmakerCount =
    match.bookmakers?.length || 0;

  const marketCount =
    Object.keys(match.markets || {}).length;


  return {

    version: '0.1',

    mode: 'PREMATCH',


    /*
     * Match Quality
     */

    matchQuality: null,

    matchQualityStatus: 'UNKNOWN',


    /*
     * Market Data
     */

    marketData: {

      bookmakerCount,

      marketCount,

      h2hAvailable:
        Boolean(h2h?.best?.length),

      oddsHistory: 'UNKNOWN',

      openingOdds: 'UNKNOWN',

      currentOdds: 'AVAILABLE',

      clv: 'UNKNOWN',

      moneyFlow: 'UNKNOWN',

      sharpMoney: 'UNKNOWN',

      exchangeConfirmation: 'UNKNOWN'
    },


    /*
     * Ринковий no-vig.
     *
     * Це не predictive model.
     */

    marketNoVig,


    /*
     * Незалежна Fair Probability
     */

    fairProbability: null,

    fairOdds: null,

    edge: null,


    /*
     * Confidence
     */

    edgeConfidence: 'D',


    /*
     * Незалежні підтвердження
     */

    confirmations: [],

    independentConfirmations: 0,


    /*
     * Trap Score
     */

    trapScore: null,


    /*
     * NO-BET GATE
     */

    noBetGate: {

      status: 'BLOCKED',

      reasons: [

        'Немає незалежної Fair Probability.',

        'Немає 2 незалежних підтверджень.',

        'Історія руху коефіцієнтів не підтверджена.',

        'Склади/травми/xG не підключені до цього запиту.'
      ]
    },


    /*
     * Фінальний статус
     */

    decision: 'SKIP',


    /*
     * Пояснення
     */

    note:
      'Ринковий no-vig — лише діагностика. BETCORE Edge не вигадується.'
  };
}


/* =========================================================
   DIAGNOSTICS
   ========================================================= */

function diagnostics(events, rows) {

  const bookmakerSet = new Set();

  const marketCounts = {};


  for (
    const event of Array.isArray(events)
      ? events
      : []
  ) {

    for (
      const bookmaker of event.bookmakers || []
    ) {

      bookmakerSet.add(
        bookmaker.key ||
        bookmaker.title ||
        'unknown'
      );


      for (
        const market of bookmaker.markets || []
      ) {

        marketCounts[market.key] =
          (marketCounts[market.key] || 0) + 1;
      }
    }
  }


  return {

    events:
      Array.isArray(events)
        ? events.length
        : 0,

    bookmakers:
      bookmakerSet.size,

    marketCounts,

    rows:
      rows.length
  };
}


/* =========================================================
   ODDS API REQUEST
   ========================================================= */

async function requestOdds(
  sport,
  regions,
  markets
) {

  const endpoint =
    `${ODDS_API_BASE}/sports/` +
    `${encodeURIComponent(sport)}/odds/` +

    `?apiKey=${encodeURIComponent(API_KEY)}` +

    `&regions=${encodeURIComponent(regions)}` +

    `&markets=${encodeURIComponent(markets)}` +

    `&oddsFormat=decimal`;


  return apiGet(endpoint);
}


/* =========================================================
   GET ODDS
   ========================================================= */

async function getOdds(req, res) {

  if (!API_KEY) {

    return send(
      res,

      500,

      'application/json; charset=utf-8',

      JSON.stringify({

        error:
          'Missing ODDS_API_KEY',

        message:
          'Налаштуй ODDS_API_KEY на Render. Не вставляй ключ у frontend.'
      })
    );
  }


  const u =
    new URL(
      req.url,
      `http://${req.headers.host}`
    );


  const sport =
    u.searchParams.get('sport') ||
    'soccer_epl';


  const regions =
    u.searchParams.get('regions') ||
    'eu';


  let markets =
    u.searchParams.get('markets') ||
    'h2h,totals,spreads';


  const requestedMarkets =
    markets
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);


  /*
   * Основний запит
   */

  let result =
    await requestOdds(
      sport,
      regions,
      markets
    );


  let rows =
    normalize(result.data);


  let fallbackUsed = false;


  /*
   * Якщо комбінований запит
   * повернув 0 рядків,
   * пробуємо h2h.
   */

  if (
    rows.length === 0 &&

    !requestedMarkets.includes('h2h') &&

    sport.startsWith('soccer_')
  ) {

    result =
      await requestOdds(
        sport,
        regions,
        'h2h'
      );


    rows =
      normalize(result.data);


    fallbackUsed = true;

    markets = 'h2h';
  }


  /*
   * Діагностика
   */

  const diag =
    diagnostics(
      result.data,
      rows
    );


  /*
   * Групування матчів
   */

  const matches =
    buildMatches(rows).map(
      match => ({

        ...match,

        engine:
          buildEngine(match)
      })
    );


  /*
   * Відповідь frontend
   */

  return send(

    res,

    200,

    'application/json; charset=utf-8',

    JSON.stringify({

      source:
        'The Odds API',

      fetchedAt:
        new Date().toISOString(),


      requested: {

        sport,

        regions,

        markets:
          requestedMarkets
      },


      usedMarkets:
        markets,


      fallbackUsed,


      events:
        diag.events,


      bookmakers:
        diag.bookmakers,


      marketCounts:
        diag.marketCounts,


      /*
       * Всі сирі нормалізовані
       * букмекерські позиції.
       */

      rows,


      /*
       * Згруповані матчі
       * для BetCore v3.
       */

      matches,


      /*
       * Quota Odds API
       */

      quota: {

        remaining:
          result.headers[
            'x-requests-remaining'
          ] ?? null,

        used:
          result.headers[
            'x-requests-used'
          ] ?? null,

        last:
          result.headers[
            'x-requests-last'
          ] ?? null
      }

    }),


    {

      'X-BetCore-Events':
        String(diag.events),

      'X-BetCore-Bookmakers':
        String(diag.bookmakers),

      'X-BetCore-Rows':
        String(diag.rows)
    }
  );
}


/* =========================================================
   REQUEST HANDLER
   ========================================================= */

async function handle(req, res) {

  /*
   * CORS preflight
   */

  if (req.method === 'OPTIONS') {

    return send(
      res,
      204,
      'text/plain; charset=utf-8',
      ''
    );
  }


  /*
   * Odds API
   */

  if (req.url.startsWith('/api/odds')) {

    try {

      return await getOdds(
        req,
        res
      );

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
            'Не вдалося отримати букмекерську лінію.'
        })
      );
    }
  }


  /*
   * Health check
   */

  if (req.url === '/health') {

    return send(

      res,

      200,

      'application/json; charset=utf-8',

      JSON.stringify({

        ok: true,

        service:
          'BetCore',

        version:
          '3.0',

        apiKeyConfigured:
          Boolean(API_KEY)
      })
    );
  }


  /*
   * Якщо Render також віддає index.html
   */

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


  /*
   * 404
   */

  return send(

    res,

    404,

    'text/plain; charset=utf-8',

    'Not found'
  );
}


/* =========================================================
   FRONTEND FALLBACK
   ========================================================= */

const html =
  fs.readFileSync(
    path.join(
      __dirname,
      'index.html'
    ),
    'utf8'
  );


/* =========================================================
   SERVER
   ========================================================= */

const server =
  http.createServer(handle);


server.listen(
  PORT,
  () => {

    console.log(
      `BetCore 3.0 running on port ${PORT}`
    );

    console.log(
      `ODDS_API_KEY configured: ${Boolean(API_KEY)}`
    );
  }
);
