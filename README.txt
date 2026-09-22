BETCORE 5.4 — API-Football fixture universe

Files:
- server.js — BetCore 5.4 with API-Football fixture source
- index.html — existing BetCore UI
- prediction.js — existing Prediction v1 MARKET BASELINE

Required Render environment variables:
- ODDS_API_KEY = existing The Odds API key
- API_FOOTBALL_KEY = your API-Football key
- BETCORE_FIXTURE_SOURCE = api-football

Optional:
- API_FOOTBALL_BASE = https://v3.football.api-sports.io

The API-Football key is read only on the server. Do not put it in frontend code or GitHub.

The Odds API remains the bookmaker-odds source. API-Football is used as the football fixture universe.
