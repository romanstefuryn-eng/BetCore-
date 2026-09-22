const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE =
  process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4';

const MAX_ODDS_SPORTS = Number(
  process.env.BETCORE_MAX_ODDS_SPORTS || 16
);

const MAX_MATCHES = Number(
  process.env.BETCORE_MAX_MATCHES || 300
);

const CACHE_MS = Number(
  process.env.BETCORE_CACHE_MS || 90000
);

const HISTORY_FILE = path.join(
  __dirname,
  'betcore_odds_history.json'
);

const cache = new Map();

let sportsCache = {
  at: 0,
  data: []
};

let history = loadHistory();


/* =========================================================
   HTTP
========================================================= */

function send(
  res,
  status,
  type,
  body,
  extraHeaders = {}
) {
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


/* =========================================================
   ODDS API
========================================================= */

function apiGet(urlString) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      urlString,
      {
        headers: {
          'User-Agent': 'BetCore/4.2'
        }
      },
      r => {
        let data = '';

        r.on('data', c => {
          data += c;
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
              reject(
                new Error(
                  'Odds API повернув не JSON.'
                )
              );
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
    );

    req.on('error', reject);

    req.setTimeout(
      20000,
      () => req.destroy(
        new Error('Odds API timeout')
      )
    );
  });
}


/* =========================================================
   HISTORY
========================================================= */

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return {};
    }

    return (
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          'utf8'
        )
      ) || {}
    );
  } catch {
    return {};
  }
}


function saveHistory() {
  try {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(history)
    );
  } catch (e) {
    console.warn(
      'History save skipped:',
      e.message
    );
  }
}


/* =========================================================
   CACHE
========================================================= */

function cacheGet(key) {
  const item = cache.get(key);

  if (
    !item ||
    Date.now() - item.at > CACHE_MS
  ) {
    return null;
  }

  return item.value;
}


function cacheSet(key, value) {
  cache.set(key, {
    at: Date.now(),
    value
  });
}


/* =========================================================
   SPORTS
========================================================= */

function sportPriority(s) {
  const key = String(
    s.sport_key || ''
  );

  const title = String(
    s.title || ''
  ).toLowerCase();

  const names = [
    'premier league',
    'champions league',
    'europa league',
    'conference league',
    'la liga',
    'serie a',
    'bundesliga',
    'ligue 1',
    'eredivisie',
    'primeira liga',
    'championship',
    'scottish premiership',
    'super lig',
    'belgian pro league',
    'ukrainian premier league'
  ];

  const index = names.findIndex(
    x => title.includes(x)
  );

  if (index >= 0) {
    return index;
  }

  if (key.includes('soccer')) {
    return 100;
  }

  return 999;
}


async function getSports() {
  if (
    Date.now() - sportsCache.at <
      5 * 60 * 1000 &&
    sportsCache.data.length
  ) {
    return sportsCache.data;
  }

  const url =
    `${ODDS_API_BASE}/sports` +
    `?apiKey=${encodeURIComponent(API_KEY)}`;

  const result = await apiGet(url);

  const data = Array.isArray(result.data)
    ? result.data
    : [];

  sportsCache = {
    at: Date.now(),
    data
  };

  return data;
}


function isSoccer(s) {
  return (
    String(
      s.sport_key || ''
    ).startsWith('soccer_') &&
    s.active !== false &&
    !s.has_outrights
  );
}


function selectSoccerSports(
  allSports
) {
  return allSports
    .filter(isSoccer)
    .sort((a, b) => {
      const p =
        sportPriority(a) -
        sportPriority(b);

      if (p) {
        return p;
      }

      return String(a.title)
        .localeCompare(
          String(b.title)
        );
    });
}


/* =========================================================
   HORIZON
========================================================= */

function horizonWindow(mode) {
  const hours =
    mode === '24h'
      ? 24
      : mode === '3d'
        ? 72
        : 168;

  const from = new Date(
    Date.now() -
      5 * 60 * 1000
  ).toISOString();

  const to = new Date(
    Date.now() +
      hours * 3600 * 1000
  ).toISOString();

  return {
    from,
    to
  };
}


function horizonEnd(mode) {
  const ms =
    mode === '24h'
      ? 24 * 3600e3
      : mode === '3d'
        ? 3 * 86400e3
        : 7 * 86400e3;

  return Date.now() + ms;
}


function filterFuture(
  matches,
  mode
) {
  const now = Date.now();
  const end = horizonEnd(mode);

  return matches
    .filter(m => {
      const t =
        new Date(
          m.commence
        ).getTime();

      return (
        Number.isFinite(t) &&
        t >= now &&
        t <= end
      );
    })
    .sort(
      (a, b) =>
        new Date(a.commence) -
        new Date(b.commence)
    );
}


/* =========================================================
   EVENTS
========================================================= */

async function requestEvents(
  sport,
  from,
  to
) {
  const endpoint =
    `${ODDS_API_BASE}/sports/` +
    `${encodeURIComponent(sport)}/events` +
    `?apiKey=${encodeURIComponent(API_KEY)}` +
    `&dateFormat=iso` +
    `&commenceTimeFrom=${encodeURIComponent(from)}` +
    `&commenceTimeTo=${encodeURIComponent(to)}`;

  return apiGet(endpoint);
}


/* =========================================================
   ODDS
========================================================= */

async function requestOdds(
  sport,
  regions,
  markets,
  from,
  to
) {
  const endpoint =
    `${ODDS_API_BASE}/sports/` +
    `${encodeURIComponent(sport)}/odds` +
    `?apiKey=${encodeURIComponent(API_KEY)}` +
    `&regions=${encodeURIComponent(regions)}` +
    `&markets=${encodeURIComponent(markets)}` +
    `&oddsFormat=decimal` +
    `&commenceTimeFrom=${encodeURIComponent(from)}` +
    `&commenceTimeTo=${encodeURIComponent(to)}`;

  return apiGet(endpoint);
}


/* =========================================================
   NORMALIZE ODDS
========================================================= */

function normalizeEvents(
  events,
  sportInfo
) {
  const out = [];

  for (
    const event of
    Array.isArray(events)
      ? events
      : []
  ) {
    const bookmakers =
      event.bookmakers || [];

    for (
      const bookmaker
      of bookmakers
    ) {
      for (
        const market
        of bookmaker.markets || []
      ) {
        for (
          const outcome
          of market.outcomes || []
        ) {
          out.push({
            id: event.id,
            sport: event.sport_key,
            league:
              event.sport_title ||
              sportInfo?.title ||
              event.sport_key,

            sportKey:
              event.sport_key,

            commence:
              event.commence_time,

            home:
              event.home_team,

            away:
              event.away_team,

            bookmaker:
              bookmaker.title,

            bookmakerKey:
              bookmaker.key,

            market:
              market.key,

            name:
              outcome.name,

            point:
              outcome.point ??
              null,

            price:
              Number(
                outcome.price
              )
          });
        }
      }
    }
  }

  return out;
}


/* =========================================================
   GROUP MATCHES
========================================================= */

function groupMatches(rows) {
  const map = new Map();

  for (
    const row of rows
  ) {
    if (!map.has(row.id)) {
      map.set(
        row.id,
        {
          id: row.id,
          sport: row.sport,
          sportKey: row.sportKey,
          league: row.league,
          commence: row.commence,
          home: row.home,
          away: row.away,
          bookmakers: new Map(),
          markets: new Map()
        }
      );
    }

    const match =
      map.get(row.id);

    if (
      !match.bookmakers.has(
        row.bookmakerKey
      )
    ) {
      match.bookmakers.set(
        row.bookmakerKey,
        row.bookmaker
      );
    }

    if (
      !match.markets.has(
        row.market
      )
    ) {
      match.markets.set(
        row.market,
        new Map()
      );
    }

    const bookmakerMarket =
      match.markets.get(
        row.market
      );

    if (
      !bookmakerMarket.has(
        row.bookmakerKey
      )
    ) {
      bookmakerMarket.set(
        row.bookmakerKey,
        {
          bookmaker:
            row.bookmaker,

          bookmakerKey:
            row.bookmakerKey,

          outcomes: []
        }
      );
    }

    bookmakerMarket
      .get(row.bookmakerKey)
      .outcomes
      .push({
        name: row.name,
        point: row.point,
        price: row.price
      });
  }

  return [
    ...map.values()
  ].map(m => {
    const markets = {};

    for (
      const [
        marketKey,
        bookmakerMap
      ] of m.markets
    ) {
      const bookmakers = [
        ...bookmakerMap.values()
      ];

      const all =
        bookmakers.flatMap(
          x =>
            x.outcomes.map(
              o => ({
                ...o,
                bookmaker:
                  x.bookmaker,
                bookmakerKey:
                  x.bookmakerKey
              })
            )
        );

      const bestMap =
        new Map();

      for (
        const item of all
      ) {
        const key =
          `${item.name}__${item.point ?? ''}`;

        if (
          !bestMap.has(key) ||
          item.price >
            bestMap.get(key).price
        ) {
          bestMap.set(
            key,
            item
          );
        }
      }

      markets[marketKey] = {
        bookmakers,
        best: [
          ...bestMap.values()
        ]
      };
    }

    return {
      id: m.id,
      sport: m.sport,
      sportKey: m.sportKey,
      league: m.league,
      commence: m.commence,
      home: m.home,
      away: m.away,
      bookmakers: [
        ...m.bookmakers.values()
      ],
      markets
    };
  });
}


/* =========================================================
   NO-VIG
========================================================= */

function noVig(best) {
  const valid =
    (best || [])
      .filter(
        x =>
          Number(x.price) > 1
      );

  if (
    valid.length < 2
  ) {
    return null;
  }

  const overround =
    valid.reduce(
      (sum, x) =>
        sum + 1 / x.price,
      0
    );

  if (
    !(overround > 0)
  ) {
    return null;
  }

  return {
    margin:
      (overround - 1) *
      100,

    outcomes:
      valid.map(x => ({
        name: x.name,
        point:
          x.point ?? null,

        price:
          x.price,

        bookmaker:
          x.bookmaker,

        probability:
          (1 / x.price) /
          overround *
          100,

        fairOdds:
          overround /
          (1 / x.price)
      }))
  };
}


/* =========================================================
   LEAGUE CLASS
========================================================= */

function leagueClass(
  league
) {
  const s =
    String(
      league || ''
    ).toLowerCase();

  if (
    /premier league|champions league|europa league|conference league|la liga|serie a|bundesliga|ligue 1/
      .test(s)
  ) {
    return 'A';
  }

  if (
    /championship|eredivisie|primeira|super lig|belgian|scottish|mls|brasileir|liga mx|argentina/
      .test(s)
  ) {
    return 'B';
  }

  if (
    /women|u21|u23|u19|youth|reserve|friendly|friendlies/
      .test(s)
  ) {
    return 'C';
  }

  return 'B';
}


/* =========================================================
   BETCORE ENGINE
========================================================= */

function buildEngine(
  match,
  historyRows
) {
  const h2h =
    match.markets?.h2h;

  const nv =
    noVig(
      h2h?.best || []
    );

  const bookmakerCount =
    match.bookmakers.length;

  const league =
    leagueClass(
      match.league
    );

  const hist =
    historyRows || [];

  let quality = 0;

  quality +=
    league === 'A'
      ? 20
      : league === 'B'
        ? 16
        : 10;

  quality += Math.min(
    15,
    bookmakerCount * 3
  );

  quality += Math.min(
    15,
    hist.length
      ? 15
      : 0
  );

  // Team statistics are not connected yet.
  quality += 0;

  // Confirmed lineups are not connected yet.
  quality += 0;

  // xG/xGA are not connected yet.
  quality += 0;

  quality +=
    h2h?.best?.length >= 3
      ? 10
      : 5;

  quality =
    Math.round(
      Math.min(
        100,
        quality
      )
    );

  const reasons = [];

  if (
    quality < 60
  ) {
    reasons.push(
      'Match Quality нижче 60: незалежні статистичні шари не підключені.'
    );
  }

  if (
    !hist.length
  ) {
    reasons.push(
      'Історія коефіцієнтів ще не накопичена для цього матчу.'
    );
  }

  reasons.push(
    'Fair Probability BETCORE не вигадується: немає незалежної моделі команд/xG.'
  );

  reasons.push(
    'Money Flow = UNKNOWN: The Odds API не дає відсотки ставок/грошей у цьому запиті.'
  );

  reasons.push(
    'Lineup = UNKNOWN: підтверджені склади не підключені.'
  );

  let trapScore = null;

  if (nv) {
    const probs =
      nv.outcomes
        .map(
          x =>
            x.probability
        )
        .sort(
          (a, b) =>
            b - a
        );

    const concentration =
      probs[0] || 0;

    const marginPenalty =
      Math.min(
        20,
        Math.max(
          0,
          nv.margin * 2
        )
      );

    trapScore =
      Math.round(
        Math.min(
          100,
          Math.max(
            0,
            (concentration - 45) *
              0.5 +
              marginPenalty
          )
        )
      );
  }

  return {
    version: '4.2',

    mode:
      'PREMATCH',

    leagueClass:
      league,

    matchQuality:
      quality,

    matchQualityLabel:
      quality >= 80
        ? 'EXCELLENT'
        : quality >= 70
          ? 'GOOD'
          : quality >= 60
            ? 'ACCEPTABLE'
            : 'WEAK',

    fairProbability:
      null,

    fairOdds:
      null,

    edge:
      null,

    edgeConfidence:
      'D',

    marketNoVig:
      nv,

    confirmations:
      [],

    independentConfirmations:
      0,

    trapScore,

    trapLabel:
      trapScore == null
        ? 'UNKNOWN'
        : trapScore >= 70
          ? 'HIGH RISK'
          : trapScore >= 50
            ? 'WARNING'
            : trapScore >= 30
              ? 'WATCH'
              : 'NORMAL',

    data: {
      moneyFlow:
        'UNKNOWN',

      sharpMoney:
        'UNKNOWN',

      lineups:
        'UNKNOWN',

      xg:
        'UNKNOWN',

      teamStats:
        'UNKNOWN',

      oddsHistory:
        hist.length
          ? 'AVAILABLE'
          : 'UNKNOWN'
    },

    noBetGate: {
      status:
        'BLOCKED',

      reasons
    },

    decision:
      'SKIP',

    note:
      'Ринковий no-vig — діагностика. Незалежна Fair Probability ще не підключена.'
  };
}


/* =========================================================
   HISTORY SNAPSHOT
========================================================= */

function snapshot(
  matches
) {
  const now =
    new Date()
      .toISOString();

  for (
    const match of matches
  ) {
    if (
      !history[match.id]
    ) {
      history[match.id] = [];
    }

    const h2h =
      match.markets?.h2h;

    if (
      !h2h?.best?.length
    ) {
      continue;
    }

    history[
      match.id
    ].push({
      at: now,

      odds:
        h2h.best.map(
          x => ({
            name:
              x.name,

            point:
              x.point ??
              null,

            price:
              x.price,

            bookmaker:
              x.bookmaker
          })
        )
    });

    if (
      history[
        match.id
      ].length > 120
    ) {
      history[
        match.id
      ] =
        history[
          match.id
        ].slice(-120);
    }
  }

  saveHistory();
}


/* =========================================================
   MAIN ODDS SCANNER
========================================================= */

async function getOdds(
  req,
  res
) {
  if (!API_KEY) {
    return send(
      res,
      500,
      'application/json; charset=utf-8',
      JSON.stringify({
        error:
          'Missing ODDS_API_KEY',

        message:
          'Налаштуй ODDS_API_KEY на Render. Ключ не вставляється у frontend.'
      })
    );
  }

  const u =
    new URL(
      req.url,
      `http://${req.headers.host}`
    );

  const regions =
    u.searchParams.get(
      'regions'
    ) || 'eu';

  const markets =
    u.searchParams.get(
      'markets'
    ) || 'h2h';

  const horizon =
    u.searchParams.get(
      'horizon'
    ) || '7d';

  const scope =
    u.searchParams.get(
      'scope'
    ) || 'all';

  const sport =
    u.searchParams.get(
      'sport'
    ) || '';

  const key =
    `odds:${scope}:${sport}:${regions}:${markets}:${horizon}`;

  const cached =
    cacheGet(key);

  if (cached) {
    return send(
      res,
      200,
      'application/json; charset=utf-8',
      JSON.stringify({
        ...cached,
        cached: true
      })
    );
  }


  /* -------------------------------------------------------
     1. GET SPORTS
  ------------------------------------------------------- */

  let sports;

  try {
    sports =
      await getSports();
  } catch (e) {
    return send(
      res,
      502,
      'application/json; charset=utf-8',
      JSON.stringify({
        error:
          e.message,

        stage:
          'sports'
      })
    );
  }

  const allSoccer =
    selectSoccerSports(
      sports
    );

  let targets =
    scope === 'sport' &&
    sport
      ? allSoccer.filter(
          s =>
            s.sport_key ===
            sport
        )
      : allSoccer;


  /* -------------------------------------------------------
     2. TIME WINDOW
  ------------------------------------------------------- */

  const {
    from,
    to
  } =
    horizonWindow(
      horizon
    );


  /* -------------------------------------------------------
     3. DISCOVER EVENTS
  ------------------------------------------------------- */

  const errors
