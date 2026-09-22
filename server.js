const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { buildForecast } = require('./prediction');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4';
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || '';
const API_FOOTBALL_BASE = process.env.API_FOOTBALL_BASE || 'https://v3.football.api-sports.io';

const MAX_ODDS_SPORTS = Number(process.env.BETCORE_MAX_ODDS_SPORTS || 16);
const MAX_MATCHES = Number(process.env.BETCORE_MAX_MATCHES || 300);
const CACHE_MS = Number(process.env.BETCORE_CACHE_MS || 90000);
const HISTORY_FILE = path.join(__dirname, 'betcore_odds_history.json');

const cache = new Map();
let sportsCache = { at: 0, data: [] };
let history = loadHistory();

function send(res, status, type, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'x-requests-remaining, x-requests-used, x-requests-last',
    ...extraHeaders
  });
  res.end(body);
}

function apiGet(urlString) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlString, { headers: { 'User-Agent': 'BetCore/4.9' } }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          try {
            resolve({ status: r.statusCode, data: JSON.parse(data), headers: r.headers });
          } catch {
            reject(new Error('Odds API повернув не JSON.'));
          }
        } else {
          reject(new Error(`Odds API HTTP ${r.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Odds API timeout')));
  });
}


const SOFASCORE_BASE = process.env.BETCORE_SOFASCORE_BASE || 'https://api.sofascore.com/api/v1';
const SOFASCORE_BASES = [SOFASCORE_BASE, 'https://www.sofascore.com/api/v1'].filter((v, i, a) => v && a.indexOf(v) === i);
const FIXTURE_SOURCE = process.env.BETCORE_FIXTURE_SOURCE || 'auto';
const FIXTURE_CACHE_MS = Number(process.env.BETCORE_FIXTURE_CACHE_MS || 120000);
let fixtureCache = { key: '', at: 0, data: [], errors: [] };

function apiGetWithHeaders(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlString, {
      headers: {
        'User-Agent': 'BetCore/5.6',
        'Accept': 'application/json',
        ...headers
      }
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          try {
            resolve({ status: r.statusCode, data: JSON.parse(data), headers: r.headers });
          } catch {
            reject(new Error('Fixture API повернув не JSON.'));
          }
        } else {
          reject(new Error(`Fixture API HTTP ${r.statusCode}: ${data.slice(0, 400)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Fixture API timeout')));
  });
}

function kyivDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function horizonDays(mode) {
  return mode === '24h' ? 1 : mode === '3d' ? 3 : 7;
}

function fixtureStatusAllowed(event) {
  const apiFootballStatus = String(event?.fixture?.status?.short || '').toUpperCase();
  if (apiFootballStatus) {
    return !['FT', 'AET', 'PEN', 'CANC', 'PST', 'SUSP', 'ABD'].includes(apiFootballStatus);
  }
  const type = String(event?.status?.type || '').toLowerCase();
  const code = String(event?.status?.code || '').toLowerCase();
  return !['finished', 'inprogress', 'canceled', 'cancelled', 'postponed', 'suspended'].includes(type) &&
    !['finished', 'canceled', 'cancelled', 'postponed'].includes(code);
}

function apiFootballGet(urlString) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlString, { headers: {
      'User-Agent': 'BetCore/5.6',
      'Accept': 'application/json',
      'x-apisports-key': API_FOOTBALL_KEY
    }}, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          try { resolve({ status: r.statusCode, data: JSON.parse(data), headers: r.headers }); }
          catch { reject(new Error('API-Football повернув не JSON.')); }
        } else reject(new Error(`API-Football HTTP ${r.statusCode}: ${data.slice(0, 500)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('API-Football timeout')));
  });
}

async function fetchApiFootballDay(date) {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY не налаштований');
  const endpoint = `${API_FOOTBALL_BASE}/fixtures?date=${encodeURIComponent(date)}&timezone=Europe%2FKyiv`;
  const r = await apiFootballGet(endpoint);
  const response = Array.isArray(r.data?.response) ? r.data.response : [];
  return response.map(x => ({ ...x, fixtureSource: 'API-Football' }));
}

async function fetchSofaDay(date) {
  let lastError = null;
  for (const base of SOFASCORE_BASES) {
    const urls = [
      `${base}/sport/football/scheduled-events/${date}/inverse`,
      `${base}/sport/football/scheduled-events/${date}`
    ];
    for (const url of urls) {
      try {
        const r = await apiGetWithHeaders(url, {
          Referer: 'https://www.sofascore.com/',
          Origin: 'https://www.sofascore.com',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9'
        });
        const events = Array.isArray(r.data?.events) ? r.data.events : [];
        if (events.length) return events;
      } catch (e) {
        lastError = new Error(`${base}: ${e.message}`);
      }
    }
  }
  throw lastError || new Error(`SofaScore: no events for ${date}`);
}

async function getFixtureUniverse(mode) {
  if (FIXTURE_SOURCE === 'oddsapi') return { events: [], errors: [], source: 'oddsapi' };

  const source = FIXTURE_SOURCE === 'api-football' ||
    (FIXTURE_SOURCE === 'auto' && Boolean(API_FOOTBALL_KEY))
    ? 'api-football'
    : 'sofascore';

  const key = `${source}:${mode}:${kyivDate(0)}`;
  if (fixtureCache.key === key && Date.now() - fixtureCache.at < FIXTURE_CACHE_MS) {
    return { events: fixtureCache.data, errors: fixtureCache.errors, source };
  }

  const days = horizonDays(mode);
  const events = [];
  const errors = [];
  for (let i = 0; i < days; i++) {
    const date = kyivDate(i);
    try {
      const dayEvents = source === 'api-football' ? await fetchApiFootballDay(date) : await fetchSofaDay(date);
      if (source === 'api-football') events.push(...dayEvents);
      else events.push(...dayEvents.map(e => ({ ...e, fixtureSource: 'SofaScore' })));
    } catch (e) {
      errors.push({ stage: 'fixtures', date, source: source === 'api-football' ? 'API-Football' : 'SofaScore', error: e.message });
    }
  }
  fixtureCache = { key, at: Date.now(), data: events, errors };
  return { events, errors, source };
}

function normalizeTeamName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(football|futebol|fc|fk|sc|cf|afc|club|women|woman|ladies|w|u19|u20|u21|u23|u18|u17|ii|b|reserves?|reserve|ec|esporte|esportivo|clube)\b/g, ' ')
    .replace(/\b(deportivo|deportes)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamTokens(name) {
  return normalizeTeamName(name).split(' ').filter(Boolean);
}

function levenshteinSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aa = [...a], bb = [...b];
  const prev = new Array(bb.length + 1);
  const curr = new Array(bb.length + 1);
  for (let j = 0; j <= bb.length; j++) prev[j] = j;
  for (let i = 1; i <= aa.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= bb.length; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= bb.length; j++) prev[j] = curr[j];
  }
  return 1 - prev[bb.length] / Math.max(aa.length, bb.length);
}

function tokenSimilarity(a, b) {
  const aa = new Set(teamTokens(a));
  const bb = new Set(teamTokens(b));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const x of aa) if (bb.has(x)) common++;
  const union = new Set([...aa, ...bb]).size;
  return union ? common / union : 0;
}

function teamSimilarity(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const token = tokenSimilarity(a, b);
  const edit = levenshteinSimilarity(na, nb);
  const containment = na.includes(nb) || nb.includes(na) ? 0.88 : 0;
  return Math.min(1, Math.max(token, edit * 0.92, containment));
}

function leagueSimilarity(a, b) {
  const na = String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nb = String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!na || !nb) return 0.5;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  return levenshteinSimilarity(na, nb);
}

function scoreFixtureOddsMatch(fixture, odds) {
  const homeScore = teamSimilarity(fixture.home, odds.home);
  const awayScore = teamSimilarity(fixture.away, odds.away);
  const leagueScore = leagueSimilarity(fixture.league, odds.league);
  const ft = new Date(fixture.commence).getTime();
  const ot = new Date(odds.commence).getTime();
  if (!Number.isFinite(ft) || !Number.isFinite(ot)) return null;

  const diffMin = Math.abs(ft - ot) / 60000;
  const exactHome = normalizeTeamName(fixture.home) === normalizeTeamName(odds.home);
  const exactAway = normalizeTeamName(fixture.away) === normalizeTeamName(odds.away);

  // Exact team pair is the strongest cross-source identity signal.
  if (exactHome && exactAway && diffMin <= 1440) {
    const score = 0.90 + Math.max(0, 1 - diffMin / 1440) * 0.10;
    return { score, homeScore, awayScore, leagueScore, diffMin, confidence: diffMin <= 90 ? 'EXACT' : 'EXACT_TEAMS' };
  }

  // Fuzzy team names + compatible competition + kickoff proximity.
  if (homeScore >= 0.80 && awayScore >= 0.80 && diffMin <= 180) {
    const timeScore = Math.max(0, 1 - diffMin / 180);
    const score = homeScore * 0.40 + awayScore * 0.40 + leagueScore * 0.08 + timeScore * 0.12;
    if (score >= 0.80) {
      return { score, homeScore, awayScore, leagueScore, diffMin, confidence: score >= 0.93 ? 'HIGH' : 'MEDIUM' };
    }
  }

  // Short kickoff window for provider abbreviations.
  if (homeScore >= 0.74 && awayScore >= 0.74 && diffMin <= 45) {
    const timeScore = Math.max(0, 1 - diffMin / 45);
    const score = homeScore * 0.39 + awayScore * 0.39 + leagueScore * 0.06 + timeScore * 0.16;
    if (score >= 0.74) {
      return { score, homeScore, awayScore, leagueScore, diffMin, confidence: score >= 0.90 ? 'HIGH' : 'MEDIUM' };
    }
  }

  return null;
}

function mergeOddsIntoFixtures(fixtures, oddsMatches) {
  const usedOdds = new Set();
  const merged = [];

  for (const fixture of fixtures) {
    const candidates = [];
    for (const odds of oddsMatches) {
      if (usedOdds.has(odds.id)) continue;
      const scored = scoreFixtureOddsMatch(fixture, odds);
      if (scored) candidates.push({ odds, scored });
    }

    candidates.sort((a, b) => b.scored.score - a.scored.score);
    const best = candidates[0];
    const second = candidates[1];
    const ambiguous = best && second && (best.scored.score - second.scored.score) < 0.035;

    if (best && !ambiguous) {
      usedOdds.add(best.odds.id);
      const fixtureMatch = {
        confidence: best.scored.confidence,
        score: Number(best.scored.score.toFixed(3)),
        homeScore: Number(best.scored.homeScore.toFixed(3)),
        awayScore: Number(best.scored.awayScore.toFixed(3)),
        leagueScore: Number(best.scored.leagueScore.toFixed(3)),
        kickoffDiffMin: Number(best.scored.diffMin.toFixed(1)),
        fixtureId: fixture.fixtureMeta?.fixtureId || fixture.fixtureMeta?.eventId || fixture.id,
        oddsEventId: best.odds.id
      };

      merged.push({
        ...fixture,
        ...best.odds,
        fixtureSource: `${fixture.fixtureSource || 'Fixture source'} + The Odds API`,
        fixtureMatch,
        matchIdentity: {
          apiFootballId: fixture.fixtureMeta?.fixtureId || null,
          sofaScoreId: fixture.fixtureMeta?.eventId || null,
          oddsApiId: best.odds.id,
          fixtureHome: fixture.home,
          fixtureAway: fixture.away,
          oddsHome: best.odds.home,
          oddsAway: best.odds.away,
          kickoffDiffMin: fixtureMatch.kickoffDiffMin,
          score: fixtureMatch.score,
          confidence: fixtureMatch.confidence
        }
      });
    } else {
      merged.push({
        ...fixture,
        fixtureMatch: ambiguous ? {
          confidence: 'AMBIGUOUS',
          score: Number(best.scored.score.toFixed(3)),
          runnerUpScore: Number(second.scored.score.toFixed(3)),
          kickoffDiffMin: Number(best.scored.diffMin.toFixed(1))
        } : null
      });
    }
  }

  for (const odds of oddsMatches) {
    if (!usedOdds.has(odds.id)) {
      merged.push({ ...odds, fixtureSource: 'The Odds API', fixtureMatch: null });
    }
  }

  const seen = new Set();
  return merged.filter(m => {
    const key = `${normalizeTeamName(m.home)}|${normalizeTeamName(m.away)}|${Math.round(new Date(m.commence).getTime() / 600000)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) {
    console.warn('History save skipped:', e.message);
  }
}

function cacheGet(key) {
  const item = cache.get(key);
  if (!item || Date.now() - item.at > CACHE_MS) return null;
  return item.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
}

function sportPriority(s) {
  const key = String(s.sport_key || '').toLowerCase();
  const title = String(s.title || '').toLowerCase();
  const names = [
    'premier league','champions league','europa league','conference league',
    'la liga','serie a','bundesliga','ligue 1','eredivisie','primeira liga',
    'championship','scottish premiership','super lig','belgian pro league',
    'ukrainian premier league'
  ];
  const index = names.findIndex(x => title.includes(x));
  if (index >= 0) return index;
  if (key.includes('soccer')) return 100;
  return 999;
}

async function getSports() {
  if (Date.now() - sportsCache.at < 5 * 60 * 1000 && sportsCache.data.length) {
    return sportsCache.data;
  }

  const url = `${ODDS_API_BASE}/sports?all=true&apiKey=${encodeURIComponent(API_KEY)}`;
  const result = await apiGet(url);

  // The Odds API can return the sport identifier as "key".
  // Normalize it to "sport_key" so the rest of BetCore uses one field.
  const data = Array.isArray(result.data)
    ? result.data.map(s => ({
        ...s,
        sport_key: s.sport_key || s.key || ''
      }))
    : [];

  sportsCache = { at: Date.now(), data };
  return data;
}

function isSoccer(s) {
  const key = String(s.sport_key || s.key || '').toLowerCase();
  const group = String(s.group || '').toLowerCase();

  return (
    (key.startsWith('soccer_') || group.includes('soccer')) &&
    !s.has_outrights
  );
}

function selectSoccerSports(allSports) {
  return allSports.filter(isSoccer).sort((a, b) => {
    const p = sportPriority(a) - sportPriority(b);
    if (p) return p;
    return String(a.title).localeCompare(String(b.title));
  });
}

function apiTimestamp(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function horizonWindow(mode) {
  const hours = mode === '24h' ? 24 : mode === '3d' ? 72 : 168;
  const from = apiTimestamp(Date.now() - 5 * 60 * 1000);
  const to = apiTimestamp(Date.now() + hours * 3600 * 1000);
  return { from, to };
}

function horizonEnd(mode) {
  const ms = mode === '24h' ? 24 * 3600e3 : mode === '3d' ? 3 * 86400e3 : 7 * 86400e3;
  return Date.now() + ms;
}

function filterFuture(matches, mode) {
  const now = Date.now();
  const end = horizonEnd(mode);
  return matches.filter(m => {
    const t = new Date(m.commence).getTime();
    return Number.isFinite(t) && t >= now && t <= end;
  }).sort((a, b) => new Date(a.commence) - new Date(b.commence));
}

async function requestEvents(sport, from, to) {
  const endpoint =
    `${ODDS_API_BASE}/sports/${encodeURIComponent(sport)}/events` +
    `?apiKey=${encodeURIComponent(API_KEY)}` +
    `&dateFormat=iso` +
    `&commenceTimeFrom=${encodeURIComponent(from)}` +
    `&commenceTimeTo=${encodeURIComponent(to)}`;
  return apiGet(endpoint);
}

async function requestOdds(sport, regions, markets, from, to) {
  const endpoint =
    `${ODDS_API_BASE}/sports/${encodeURIComponent(sport)}/odds` +
    `?apiKey=${encodeURIComponent(API_KEY)}` +
    `&regions=${encodeURIComponent(regions)}` +
    `&markets=${encodeURIComponent(markets)}` +
    `&oddsFormat=decimal` +
    `&commenceTimeFrom=${encodeURIComponent(from)}` +
    `&commenceTimeTo=${encodeURIComponent(to)}`;
  return apiGet(endpoint);
}

function normalizeEvents(events, sportInfo) {
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    for (const bookmaker of event.bookmakers || []) {
      for (const market of bookmaker.markets || []) {
        for (const outcome of market.outcomes || []) {
          out.push({
            id: event.id,
            sport: event.sport_key,
            league: event.sport_title || sportInfo?.title || event.sport_key,
            sportKey: event.sport_key,
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
  return out;
}

function groupMatches(rows) {
  const map = new Map();

  for (const row of rows) {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id,
        sport: row.sport,
        sportKey: row.sportKey,
        league: row.league,
        commence: row.commence,
        home: row.home,
        away: row.away,
        bookmakers: new Map(),
        markets: new Map()
      });
    }

    const match = map.get(row.id);

    if (!match.bookmakers.has(row.bookmakerKey)) {
      match.bookmakers.set(row.bookmakerKey, row.bookmaker);
    }

    if (!match.markets.has(row.market)) {
      match.markets.set(row.market, new Map());
    }

    const bookmakerMarket = match.markets.get(row.market);

    if (!bookmakerMarket.has(row.bookmakerKey)) {
      bookmakerMarket.set(row.bookmakerKey, {
        bookmaker: row.bookmaker,
        bookmakerKey: row.bookmakerKey,
        outcomes: []
      });
    }

    bookmakerMarket.get(row.bookmakerKey).outcomes.push({
      name: row.name,
      point: row.point,
      price: row.price
    });
  }

  return [...map.values()].map(m => {
    const markets = {};

    for (const [marketKey, bookmakerMap] of m.markets) {
      const bookmakers = [...bookmakerMap.values()];
      const all = bookmakers.flatMap(x =>
        x.outcomes.map(o => ({
          ...o,
          bookmaker: x.bookmaker,
          bookmakerKey: x.bookmakerKey
        }))
      );

      const bestMap = new Map();

      for (const item of all) {
        const key = `${item.name}__${item.point ?? ''}`;
        if (!bestMap.has(key) || item.price > bestMap.get(key).price) {
          bestMap.set(key, item);
        }
      }

      markets[marketKey] = {
        bookmakers,
        best: [...bestMap.values()]
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
      bookmakers: [...m.bookmakers.values()],
      markets
    };
  });
}

function getBookmakerOutcome(bookmaker, name) {
  return (bookmaker?.outcomes || []).find(o => o.name === name) || null;
}

function analyzeMovement(match, historyRows) {
  const current = match.markets?.h2h?.bookmakers || [];
  const rows = Array.isArray(historyRows) ? historyRows : [];

  if (!current.length || rows.length < 1) {
    return {
      status: 'INSUFFICIENT_HISTORY',
      samples: rows.length,
      bookmakersCompared: 0,
      changedBookmakers: 0,
      up: 0,
      down: 0,
      flat: 0,
      consensus: 'UNKNOWN',
      syncCount: 0,
      syncDirection: 'UNKNOWN',
      outcomes: [],
      details: [],
      trend: { status: 'INSUFFICIENT_HISTORY', samples: rows.length }
    };
  }

  // The latest history row is the snapshot represented by `current`.
  // Compare it with the immediately preceding stored snapshot.
  const previous = rows.length > 1 ? rows[rows.length - 2]?.bookmakers || [] : [];
  const outcomeMap = new Map();
  const details = [];

  for (const cb of current) {
    const pb = previous.find(x =>
      x.bookmakerKey === cb.bookmakerKey || x.bookmaker === cb.bookmaker
    );
    if (!pb) continue;

    for (const co of cb.outcomes || []) {
      const po = getBookmakerOutcome(pb, co.name);
      if (!po || !Number.isFinite(Number(co.price)) || !Number.isFinite(Number(po.price))) continue;

      const key = co.name;
      const from = Number(po.price);
      const to = Number(co.price);
      const delta = Number((to - from).toFixed(3));

      if (!outcomeMap.has(key)) {
        outcomeMap.set(key, {
          name: key,
          up: 0,
          down: 0,
          flat: 0,
          changedBookmakers: new Set(),
          upBookmakers: new Set(),
          downBookmakers: new Set(),
          details: []
        });
      }

      const item = outcomeMap.get(key);
      if (Math.abs(delta) < 0.005) {
        item.flat++;
        continue;
      }

      const direction = delta < 0 ? 'DOWN' : 'UP';
      if (direction === 'DOWN') {
        item.down++;
        item.downBookmakers.add(cb.bookmakerKey || cb.bookmaker);
      } else {
        item.up++;
        item.upBookmakers.add(cb.bookmakerKey || cb.bookmaker);
      }
      item.changedBookmakers.add(cb.bookmakerKey || cb.bookmaker);

      const detail = {
        bookmaker: cb.bookmaker,
        bookmakerKey: cb.bookmakerKey,
        outcome: key,
        from,
        to,
        delta,
        direction
      };
      item.details.push(detail);
      details.push(detail);
    }
  }

  function buildTrend(outcomeName) {
    if (rows.length < 2) {
      return { status: 'INSUFFICIENT_HISTORY', samples: rows.length };
    }

    const series = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      for (const b of row.bookmakers || []) {
        const key = b.bookmakerKey || b.bookmaker;
        const o = getBookmakerOutcome(b, outcomeName);
        if (!o || !Number.isFinite(Number(o.price))) continue;
        if (!series.has(key)) series.set(key, []);
        series.get(key).push({
          index: i,
          at: row.at,
          price: Number(o.price),
          bookmaker: b.bookmaker,
          bookmakerKey: b.bookmakerKey
        });
      }
    }

    let up = 0, down = 0, flat = 0, changeEvents = 0;
    const movers = [];
    const firstMoves = [];

    for (const points of series.values()) {
      if (points.length < 2) continue;
      const first = points[0];
      const last = points[points.length - 1];
      const net = Number((last.price - first.price).toFixed(3));
      if (Math.abs(net) < 0.005) flat++;
      else if (net > 0) up++;
      else down++;

      for (let j = 1; j < points.length; j++) {
        const d = points[j].price - points[j - 1].price;
        if (Math.abs(d) < 0.005) continue;
        changeEvents++;
        const direction = d > 0 ? 'UP' : 'DOWN';
        movers.push({
          bookmaker: points[j].bookmaker,
          bookmakerKey: points[j].bookmakerKey,
          at: points[j].at,
          direction,
          from: points[j - 1].price,
          to: points[j].price
        });
        firstMoves.push({ ...movers[movers.length - 1] });
        break;
      }
    }

    const nonFlat = up + down;
    const netDirection = nonFlat === 0 ? 'FLAT' : down > up ? 'DOWN' : up > down ? 'UP' : 'MIXED';
    const consistency = changeEvents
      ? Math.round((Math.max(up, down) / Math.max(1, nonFlat)) * 100)
      : 0;

    firstMoves.sort((a, b) => new Date(a.at) - new Date(b.at));
    const firstMove = firstMoves[0] || null;

    const latestAt = rows[rows.length - 1]?.at || null;
    const firstAt = rows[0]?.at || null;
    const durationMinutes = firstAt && latestAt
      ? Math.max(0, Math.round((new Date(latestAt) - new Date(firstAt)) / 60000))
      : 0;

    return {
      status: rows.length >= 3 ? 'AVAILABLE' : 'SHORT_HISTORY',
      samples: rows.length,
      bookmakersTracked: series.size,
      netDirection,
      up,
      down,
      flat,
      changeEvents,
      consistency,
      firstMove,
      durationMinutes
    };
  }

  const outcomes = [...outcomeMap.values()].map(item => {
    const total = item.up + item.down;
    const consensus = total === 0 ? 'FLAT' : item.down > item.up ? 'DOWN' : item.up > item.down ? 'UP' : 'MIXED';
    const downCount = item.downBookmakers.size;
    const upCount = item.upBookmakers.size;
    const syncCount = Math.max(downCount, upCount);
    const syncDirection = downCount === upCount
      ? (syncCount ? 'MIXED' : 'UNKNOWN')
      : downCount > upCount ? 'DOWN' : 'UP';
    return {
      name: item.name,
      status: item.details.length ? 'AVAILABLE' : 'FLAT',
      changedBookmakers: item.changedBookmakers.size,
      up: item.up,
      down: item.down,
      flat: item.flat,
      consensus,
      syncCount,
      syncDirection,
      trend: buildTrend(item.name),
      details: item.details.slice(0, 60)
    };
  });

  const changedBookmakers = new Set(details.map(x => x.bookmakerKey || x.bookmaker)).size;
  const up = details.filter(x => x.direction === 'UP').length;
  const down = details.filter(x => x.direction === 'DOWN').length;
  const flat = Math.max(0, current.reduce((sum, b) => sum + (b.outcomes || []).length, 0) - details.length);
  const total = up + down;
  const consensus = total === 0 ? 'FLAT' : down > up ? 'DOWN' : up > down ? 'UP' : 'MIXED';

  const downBooks = new Set(details.filter(x => x.direction === 'DOWN').map(x => x.bookmakerKey || x.bookmaker)).size;
  const upBooks = new Set(details.filter(x => x.direction === 'UP').map(x => x.bookmakerKey || x.bookmaker)).size;
  const syncCount = Math.max(downBooks, upBooks);
  const syncDirection = downBooks === upBooks
    ? (syncCount ? 'MIXED' : 'UNKNOWN')
    : downBooks > upBooks ? 'DOWN' : 'UP';

  const trendByOutcome = outcomes.map(o => o.trend).filter(t => t && t.status !== 'INSUFFICIENT_HISTORY');
  return {
    status: details.length ? 'AVAILABLE' : 'FLAT',
    samples: rows.length,
    bookmakersCompared: new Set(current.map(x => x.bookmakerKey || x.bookmaker)).size,
    changedBookmakers,
    up,
    down,
    flat,
    consensus,
    syncCount,
    syncDirection,
    outcomes,
    trend: {
      status: rows.length >= 3 ? 'AVAILABLE' : 'SHORT_HISTORY',
      samples: rows.length,
      trackedOutcomes: trendByOutcome.length
    },
    details: details.slice(0, 60)
  };
}
function noVig(best) {
  const valid = (best || []).filter(x => Number(x.price) > 1);
  if (valid.length < 2) return null;

  const overround = valid.reduce((sum, x) => sum + 1 / x.price, 0);
  if (!(overround > 0)) return null;

  return {
    margin: (overround - 1) * 100,
    outcomes: valid.map(x => ({
      name: x.name,
      point: x.point,
      price: x.price,
      bookmaker: x.bookmaker,
      probability: (1 / x.price) / overround * 100,
      fairOdds: overround / (1 / x.price)
    }))
  };
}

function leagueClass(league) {
  const s = String(league || '').toLowerCase();

  if (/premier league|champions league|europa league|conference league|la liga|serie a|bundesliga|ligue 1/.test(s)) {
    return 'A';
  }

  if (/championship|eredivisie|primeira|super lig|belgian|scottish|mls|brasileir|liga mx|argentina/.test(s)) {
    return 'B';
  }

  if (/women|u21|u23|u19|youth|reserve|friendly|friendlies/.test(s)) {
    return 'C';
  }

  return 'B';
}

function buildEngine(match, historyRows) {
  const forecast = buildForecast(match, historyRows);
  const h2h = match.markets?.h2h;
  const nv = noVig(h2h?.best || []);
  const bookmakerCount = match.bookmakers.length;
  const league = leagueClass(match.league);
  const hist = historyRows || [];
  const movement = analyzeMovement(match, hist.length > 1 ? hist.slice(0, -1) : []);

  let quality = 0;
  quality += league === 'A' ? 20 : league === 'B' ? 16 : 10;
  quality += Math.min(15, bookmakerCount * 3);
  quality += Math.min(15, hist.length ? 15 : 0);
  quality += h2h?.best?.length >= 3 ? 10 : 5;
  quality = Math.round(Math.min(100, quality));

  const reasons = [];

  if (quality < 60) {
    reasons.push('Match Quality нижче 60: незалежні статистичні шари не підключені.');
  }

  if (!hist.length) {
    reasons.push('Історія коефіцієнтів ще не накопичена для цього матчу.');
  }

  reasons.push('Fair Probability BETCORE не вигадується: немає незалежної моделі команд/xG.');
  reasons.push('Money Flow = UNKNOWN: The Odds API не дає відсотки ставок/грошей у цьому запиті.');
  reasons.push('Lineup = UNKNOWN: підтверджені склади не підключені.');
  if (movement.status === 'AVAILABLE') reasons.push('Рух КФ: ' + movement.consensus + '; синхронно рухаються ' + movement.syncCount + ' БК. Це рух лінії, а не доказ грошового потоку.');

  let trapScore = null;

  if (nv) {
    const probs = nv.outcomes.map(x => x.probability).sort((a, b) => b - a);
    const concentration = probs[0] || 0;
    const marginPenalty = Math.min(20, Math.max(0, nv.margin * 2));

    trapScore = Math.round(
      Math.min(
        100,
        Math.max(
          0,
          (concentration - 45) * 0.5 + marginPenalty
        )
      )
    );
  }

  return {
    version: '5.6',
    mode: 'PREMATCH',
    leagueClass: league,
    matchQuality: quality,
    matchQualityLabel:
      quality >= 80 ? 'EXCELLENT' :
      quality >= 70 ? 'GOOD' :
      quality >= 60 ? 'ACCEPTABLE' :
      'WEAK',
    forecast,
    fairProbability: forecast.independent ? forecast.probabilities : null,
    fairOdds: forecast.independent ? forecast.fairOdds : null,
    edge: null,
    edgeConfidence: 'D',
    selection: {
      status: 'SKIP',
      minimumAcceptableOdds: 'UNKNOWN',
      edgeThresholdPct: league === 'A' ? 3 : 5,
      independentFairProbability: 'UNKNOWN',
      independentConfirmationsRequired: 2,
      independentConfirmations: 0
    },
    marketNoVig: nv,
    confirmations: [],
    independentConfirmations: 0,
    trapScore,
    trapLabel:
      trapScore == null ? 'UNKNOWN' :
      trapScore >= 70 ? 'HIGH RISK' :
      trapScore >= 50 ? 'WARNING' :
      trapScore >= 30 ? 'WATCH' :
      'NORMAL',
    data: {
      moneyFlow: 'UNKNOWN',
      sharpMoney: 'UNKNOWN',
      lineups: 'UNKNOWN',
      xg: 'UNKNOWN',
      teamStats: 'UNKNOWN',
      oddsHistory: hist.length ? 'AVAILABLE' : 'UNKNOWN',
      oddsMovement: movement.status,
      marketDirection: movement.consensus,
      synchronizedBookmakers: movement.syncCount,
      synchronizedDirection: movement.syncDirection
    },
    movement,
    noBetGate: {
      status: 'BLOCKED',
      reasons
    },
    decision: 'SKIP',
    note: 'Forecast v1 = market baseline. Незалежна Fair Probability поки заблокована до появи окремих командних даних.'
  };
}

function snapshot(matches) {
  const now = new Date().toISOString();

  for (const match of matches) {
    if (!history[match.id]) history[match.id] = [];

    const h2h = match.markets?.h2h;
    if (!h2h?.best?.length) continue;

    history[match.id].push({
      at: now,
      odds: h2h.best.map(x => ({
        name: x.name,
        point: x.point ?? null,
        price: x.price,
        bookmaker: x.bookmaker
      })),
      bookmakers: (h2h.bookmakers || []).map(b => ({
        bookmaker: b.bookmaker,
        bookmakerKey: b.bookmakerKey,
        outcomes: (b.outcomes || []).map(o => ({
          name: o.name,
          point: o.point ?? null,
          price: o.price
        }))
      }))
    });

    if (history[match.id].length > 120) {
      history[match.id] = history[match.id].slice(-120);
    }
  }

  saveHistory();
}

async function getOdds(req, res) {
  if (!API_KEY) {
    return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({
      error: 'Missing ODDS_API_KEY',
      message: 'Налаштуй ODDS_API_KEY на Render. Ключ не вставляється у frontend.'
    }));
  }

  const u = new URL(req.url, `http://${req.headers.host}`);

  const regions = u.searchParams.get('regions') || 'eu';
  const markets = u.searchParams.get('markets') || 'h2h';
  const horizon = u.searchParams.get('horizon') || '7d';
  const scope = u.searchParams.get('scope') || 'all';
  const sport = u.searchParams.get('sport') || '';

  const key = `odds:${scope}:${sport}:${regions}:${markets}:${horizon}`;
  const cached = cacheGet(key);

  if (cached) {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...cached, cached: true }));
  }

  let sports;

  try {
    sports = await getSports();
  } catch (e) {
    return send(res, 502, 'application/json; charset=utf-8', JSON.stringify({
      error: e.message,
      stage: 'sports'
    }));
  }

  const allSoccer = selectSoccerSports(sports);

  let targets =
    scope === 'sport' && sport
      ? allSoccer.filter(s => (s.sport_key || s.key) === sport)
      : allSoccer;

  const { from, to } = horizonWindow(horizon);

  const errors = [];
  const discovered = [];
  const discoveryConcurrency = 4;

  for (let i = 0; i < targets.length; i += discoveryConcurrency) {
    const batch = targets.slice(i, i + discoveryConcurrency);

    const results = await Promise.all(
      batch.map(async s => {
        try {
          const r = await requestEvents(s.sport_key || s.key, from, to);
          return { s, r };
        } catch (e) {
          errors.push({
            stage: 'events',
            sport: s.sport_key || s.key,
            title: s.title,
            error: e.message
          });
          return null;
        }
      })
    );

    for (const x of results) {
      if (!x) continue;

      for (const event of x.r.data || []) {
        discovered.push({
          ...event,
          sport_title: x.s.title,
          sport_group: x.s.group
        });
      }
    }
  }

  let futureEvents = discovered.filter(event => {
    const t = new Date(event.commence_time).getTime();
    return Number.isFinite(t) &&
      t >= Date.now() - 60 * 1000 &&
      t <= new Date(to).getTime();
  });

  const rows = [];
  let remaining = null;
  let used = null;

  let bySport = new Map();

  for (const event of futureEvents) {
    if (!bySport.has(event.sport_key)) bySport.set(event.sport_key, []);
    bySport.get(event.sport_key).push(event);
  }

  let activeTargets = targets.filter(s => bySport.has(s.sport_key || s.key));

  activeTargets.sort((a, b) => {
    const ca = bySport.get(a.sport_key || a.key).length;
    const cb = bySport.get(b.sport_key || b.key).length;
    if (cb !== ca) return cb - ca;
    return sportPriority(a) - sportPriority(b);
  });

  let fallbackUsed = false;

  if (futureEvents.length === 0) {
    fallbackUsed = true;

    const fallbackTargets = targets.slice(0, MAX_ODDS_SPORTS);
    const fallbackConcurrency = 4;

    for (let i = 0; i < fallbackTargets.length; i += fallbackConcurrency) {
      const batch = fallbackTargets.slice(i, i + fallbackConcurrency);

      const results = await Promise.all(
        batch.map(async s => {
          try {
            const r = await requestOdds(
              s.sport_key || s.key,
              regions,
              markets,
              from,
              to
            );
            return { s, r };
          } catch (e) {
            errors.push({
              stage: 'fallback-odds',
              sport: s.sport_key || s.key,
              title: s.title,
              error: e.message
            });
            return null;
          }
        })
      );

      for (const x of results) {
        if (!x) continue;

        remaining = x.r.headers['x-requests-remaining'] ?? remaining;
        used = x.r.headers['x-requests-used'] ?? used;

        const events = x.r.data || [];

        for (const event of events) {
          if (!discovered.some(d => d.id === event.id)) {
            discovered.push({
              ...event,
              sport_title: x.s.title,
              sport_group: x.s.group
            });
          }
        }

        rows.push(...normalizeEvents(events, x.s));
      }

      if (remaining !== null && Number(remaining) <= 2) break;
    }

    futureEvents = discovered.filter(event => {
      const t = new Date(event.commence_time).getTime();
      return Number.isFinite(t) &&
        t >= Date.now() - 60 * 1000 &&
        t <= new Date(to).getTime();
    });

    bySport = new Map();

    for (const event of futureEvents) {
      if (!bySport.has(event.sport_key)) bySport.set(event.sport_key, []);
      bySport.get(event.sport_key).push(event);
    }

    activeTargets = targets.filter(s => bySport.has(s.sport_key || s.key));
  }

  const oddsTargets = activeTargets.length
    ? activeTargets.slice(0, MAX_ODDS_SPORTS)
    : [];

  const oddsConcurrency = 2;

  for (let i = 0; i < oddsTargets.length; i += oddsConcurrency) {
    const batch = oddsTargets.slice(i, i + oddsConcurrency);

    const results = await Promise.all(
      batch.map(async s => {
        try {
          const r = await requestOdds(
            s.sport_key || s.key,
            regions,
            markets,
            from,
            to
          );
          return { s, r };
        } catch (e) {
          errors.push({
            stage: 'odds',
            sport: s.sport_key || s.key,
            title: s.title,
            error: e.message
          });
          return null;
        }
      })
    );

    for (const x of results) {
      if (!x) continue;

      remaining = x.r.headers['x-requests-remaining'] ?? remaining;
      used = x.r.headers['x-requests-used'] ?? used;

      rows.push(...normalizeEvents(x.r.data, x.s));
    }

    if (
      remaining !== null &&
      Number(remaining) <= 2 &&
      i + oddsConcurrency < oddsTargets.length
    ) {
      break;
    }
  }

  const oddsMatches = groupMatches(rows);
  const oddsById = new Map(oddsMatches.map(m => [m.id, m]));

  const oddsEventMatches = futureEvents.map(event => ({
    id: event.id,
    sport: event.sport_key,
    sportKey: event.sport_key,
    league: event.sport_title || event.sport_key,
    commence: event.commence_time,
    home: event.home_team,
    away: event.away_team,
    bookmakers: [],
    markets: {},
    fixtureSource: 'The Odds API'
  }));

  const oddsUniverse = oddsEventMatches.map(match => {
    const odds = oddsById.get(match.id);
    return odds ? { ...match, ...odds, fixtureSource: 'The Odds API' } : match;
  });

  const fixtureResult = await getFixtureUniverse(horizon);
  const fixtureMatches = fixtureResult.events
    .filter(fixtureStatusAllowed)
    .map(e => {
      if (fixtureResult.source === 'api-football' && e.fixture) {
        return {
          id: `api_football_${e.fixture.id}`,
          sport: 'football',
          sportKey: 'api_football',
          league: e.league?.name || e.league?.country || 'Football',
          commence: e.fixture.date,
          home: e.teams?.home?.name,
          away: e.teams?.away?.name,
          bookmakers: [], markets: {}, fixtureSource: 'API-Football',
          fixtureMeta: { leagueId: e.league?.id || null, season: e.league?.season || null, round: e.league?.round || null, fixtureId: e.fixture.id }
        };
      }
      return {
        id: `sofa_${e.id}`, sport: 'football', sportKey: 'sofascore_football',
        league: e.tournament?.name || e.tournament?.uniqueTournament?.name || e.tournament?.category?.name || 'Football',
        commence: new Date(Number(e.startTimestamp) * 1000).toISOString(),
        home: e.homeTeam?.name || e.homeTeam?.shortName, away: e.awayTeam?.name || e.awayTeam?.shortName,
        bookmakers: [], markets: {}, fixtureSource: 'SofaScore',
        fixtureMeta: { tournamentId: e.tournament?.uniqueTournament?.id || e.tournament?.id || null, eventId: e.id }
      };
    }).filter(x => x.home && x.away);

  const merged = mergeOddsIntoFixtures(fixtureMatches, oddsUniverse);
  const futureMerged = filterFuture(merged, horizon);
  const capped = futureMerged.length > MAX_MATCHES;
  const matches1 = futureMerged.slice(0, MAX_MATCHES);

  snapshot(matches1);

  const matches = matches1.map(match => ({
    ...match,
    engine: buildEngine(match, history[match.id])
  }));

  const withOdds = matches.filter(
    m => Object.keys(m.markets || {}).length > 0
  ).length;

  const sportsReturned = new Set(rows.map(x => x.sportKey)).size;

  const payload = {
    source: 'The Odds API',
    version: '5.6',
    fetchedAt: new Date().toISOString(),
    cached: false,

    requested: {
      scope,
      sport: sport || null,
      regions,
      markets,
      horizon,
      from,
      to
    },

    coverage: {
      footballSportsAvailable: allSoccer.length,
      sportsDiscovered: activeTargets.length,
      sportsWithOdds: oddsTargets.length,
      sportsReturned,
      eventsDiscovered: futureEvents.length,
      fixtureSource: fixtureResult.source,
      fixtureEventsRaw: fixtureResult.events?.length || 0,
      fixtureEventsAllowed: fixtureMatches.length,
      oddsUniverseEvents: oddsUniverse.length,
      mergedEvents: merged.length,
      futureEvents: futureMerged.length,
      cappedByMaxMatches: capped,
      matches: matches.length,
      matchesWithOdds: withOdds,
      fixtureOnlyMatches: matches.filter(m => !(m.markets?.h2h?.best?.length)).length,
      matchedFixtureOdds: matches.filter(m => m.fixtureSource === 'API-Football + The Odds API' || m.fixtureSource === 'SofaScore + The Odds API').length,
      ambiguousFixtureMatches: matches.filter(m => m.fixtureMatch?.confidence === 'AMBIGUOUS').length,
      sofaOnlyMatches: matches.filter(m => m.fixtureSource === 'SofaScore').length,
      apiFootballOnlyMatches: matches.filter(m => m.fixtureSource === 'API-Football').length,
      oddsOnlyMatches: matches.filter(m => m.fixtureSource === 'The Odds API').length,
      errors: errors.length + (fixtureResult.errors?.length || 0)
    },

    diagnostics: {
      version: '5.6',
      eventsMethod: 'API-Football/SofaScore fixture universe + The Odds API market merge',
      fallbackUsed,
      fixtureSource: fixtureResult.source,
      fixtureErrors: fixtureResult.errors || [],
      coverageSummary: {
        fixtureRaw: fixtureResult.events?.length || 0,
        fixtureAllowed: fixtureMatches.length,
        futureUniverse: futureMerged.length,
        returned: matches.length,
        withOdds,
        withoutOdds: matches.length - withOdds,
        matchedAcrossSources: matches.filter(m => m.fixtureSource === 'API-Football + The Odds API' || m.fixtureSource === 'SofaScore + The Odds API').length,
        ambiguous: matches.filter(m => m.fixtureMatch?.confidence === 'AMBIGUOUS').length,
        cappedByMaxMatches: capped
      },
      message: matches.length
        ? `Знайдено ${matches.length} прематчів; коефіцієнти є для ${withOdds}.`
        : 'Матчів у вибраному горизонті не знайдено.'
    },

    errors: errors.concat(fixtureResult.errors || []).slice(0, 40),
    matches,

    quota: {
      remaining,
      used
    }
  };

  cacheSet(key, payload);

  return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload));
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, 'text/plain; charset=utf-8', '');
  }

  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (u.pathname === '/api/debug') {
      if (!API_KEY) {
        return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({
          ok: false,
          error: 'Missing ODDS_API_KEY'
        }));
      }

      try {
        const url = `${ODDS_API_BASE}/sports?all=true&apiKey=${encodeURIComponent(API_KEY)}`;
        const result = await apiGet(url);
        const raw = Array.isArray(result.data) ? result.data : [];

        const normalized = raw.map(s => ({
          ...s,
          sport_key: s.sport_key || s.key || ''
        }));

        const soccer = normalized.filter(isSoccer);

        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
          ok: true,
          version: '5.6',
          status: result.status,
          rawSportsCount: raw.length,
          soccerSportsCount: soccer.length,
          firstSports: normalized.slice(0, 20).map(s => ({
            key: s.sport_key,
            title: s.title,
            active: s.active,
            hasOutrights: s.has_outrights,
            group: s.group
          })),
          soccerKeys: soccer.slice(0, 30).map(s => s.sport_key),
          quota: {
            remaining: result.headers['x-requests-remaining'] ?? null,
            used: result.headers['x-requests-used'] ?? null
          }
        }));
      } catch (e) {
        return send(res, 502, 'application/json; charset=utf-8', JSON.stringify({
          ok: false,
          version: '5.6',
          error: e.message
        }));
      }
    }

    if (u.pathname === '/api/odds') {
      return await getOdds(req, res);
    }

    if (u.pathname === '/api/sports') {
      if (!API_KEY) {
        return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({
          error: 'Missing ODDS_API_KEY'
        }));
      }

      const sports = await getSports();

      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
        sports: sports
          .filter(isSoccer)
          .sort((a, b) => sportPriority(a) - sportPriority(b))
      }));
    }

    if (u.pathname === '/api/history') {
      const id = u.searchParams.get('id');

      if (!id) {
        return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({
          error: 'id required'
        }));
      }

      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
        id,
        history: history[id] || []
      }));
    }

    if (u.pathname === '/health') {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
        ok: true,
        service: 'BetCore',
        version: '5.6',
        apiKeyConfigured: Boolean(API_KEY),
        fixtureSource: FIXTURE_SOURCE,
        apiFootballKeyConfigured: Boolean(API_FOOTBALL_KEY),
        historyMatches: Object.keys(history).length
      }));
    }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', html);
    }

    return send(res, 404, 'text/plain; charset=utf-8', 'Not found');

  } catch (e) {
    console.error(e);

    return send(res, 502, 'application/json; charset=utf-8', JSON.stringify({
      error: e.message || 'Server error'
    }));
  }
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

http.createServer(handle).listen(
  PORT,
  () => console.log(`BetCore 5.6 running on ${PORT}`)
);
