// BetCore Prediction Engine v1
// Market-baseline forecast. Deliberately not an independent team/xG model.

function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }

function noVigFromOdds(odds) {
  const valid = (odds || []).filter(x => Number(x.price) > 1);
  if (valid.length < 2) return null;
  const overround = valid.reduce((s, x) => s + 1 / Number(x.price), 0);
  if (!(overround > 0)) return null;
  return valid.map(x => ({
    name: x.name,
    probability: (1 / Number(x.price)) / overround * 100,
    fairOdds: overround / (1 / Number(x.price))
  }));
}

function historicalMarketTrend(historyRows) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  if (rows.length < 3) return { status: 'INSUFFICIENT_HISTORY', samples: rows.length, outcomes: {} };
  const first = noVigFromOdds(rows[0]?.odds || []);
  const last = noVigFromOdds(rows[rows.length - 1]?.odds || []);
  if (!first || !last) return { status: 'INSUFFICIENT_HISTORY', samples: rows.length, outcomes: {} };
  const firstMap = new Map(first.map(x => [x.name, x.probability]));
  const outcomes = {};
  for (const x of last) {
    const f = firstMap.get(x.name);
    if (Number.isFinite(f)) outcomes[x.name] = Number((x.probability - f).toFixed(2));
  }
  return { status: 'AVAILABLE', samples: rows.length, outcomes };
}

function buildForecast(match, historyRows) {
  const h2h = match.markets?.h2h;
  const best = h2h?.best || [];
  const bookmakerCount = match.bookmakers?.length || 0;
  const market = noVigFromOdds(best);
  const trend = historicalMarketTrend(historyRows);

  if (!market || market.length < 2) {
    return {
      status: 'NO_DATA', source: 'MARKET_BASELINE_V1', modelType: 'MARKET_BASELINE', independent: false,
      probabilities: [], fairOdds: [], confidence: 'LOW', confidenceScore: 0, edge: [], trend,
      notes: ['Недостатньо 1X2 коефіцієнтів для прогнозу.']
    };
  }

  // v1 uses the no-vig market as the probability prior. Movement is evidence,
  // but it is not allowed to manufacture an artificial independent edge.
  const probabilities = market.map(x => ({
    name: x.name,
    probability: Number(x.probability.toFixed(2)),
    fairOdds: Number((100 / x.probability).toFixed(2))
  }));

  const evidenceScore =
    Math.min(45, bookmakerCount * 5) +
    (historyRows?.length >= 3 ? 25 : historyRows?.length >= 2 ? 12 : 0) +
    (best.length >= 3 ? 20 : 0) +
    (trend.status === 'AVAILABLE' ? 10 : 0);

  const confidenceScore = Math.round(clamp(evidenceScore, 0, 100));
  const confidence = confidenceScore >= 75 ? 'HIGH' : confidenceScore >= 50 ? 'MEDIUM' : 'LOW';

  const edge = [];
  for (const bookmaker of h2h.bookmakers || []) {
    for (const outcome of bookmaker.outcomes || []) {
      const p = probabilities.find(x => x.name === outcome.name);
      const price = Number(outcome.price);
      if (!p || !(price > 1)) continue;
      edge.push({
        bookmaker: bookmaker.bookmaker,
        bookmakerKey: bookmaker.bookmakerKey,
        outcome: outcome.name,
        price,
        probability: p.probability,
        expectedValuePct: Number(((p.probability / 100 * price - 1) * 100).toFixed(2))
      });
    }
  }
  edge.sort((a, b) => b.expectedValuePct - a.expectedValuePct);

  return {
    status: 'AVAILABLE', source: 'MARKET_BASELINE_V1', modelType: 'MARKET_BASELINE', independent: false,
    probabilities, fairOdds: probabilities.map(x => ({ name: x.name, fairOdds: x.fairOdds })),
    confidence, confidenceScore,
    bestMarketOutcome: probabilities.slice().sort((a, b) => b.probability - a.probability)[0]?.name || null,
    edge: edge.slice(0, 30), trend,
    notes: [
      'Прогноз v1 побудований з no-vig ринку, а не з незалежної моделі команд.',
      'Edge проти окремої БК — розбіжність з market baseline, а не підтверджений betting edge.',
      'Наступний шар: незалежна модель xG/Elo/форми з подальшою калібровкою.'
    ]
  };
}

module.exports = { buildForecast };
