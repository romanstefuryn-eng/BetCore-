BetCore v5.7 — SofaScore fallback

Що змінено:
- У режимі BETCORE_FIXTURE_SOURCE=auto спочатку використовується API-Football.
- Якщо API-Football повертає 0 матчів за весь вибраний горизонт, автоматично запускається SofaScore.
- У payload diagnostics відображається fallbackUsed та фактичне джерело fixture universe.
- Match Matching 2.0, History Engine та Selection Engine залишені без зміни.

Render:
- ODDS_API_KEY: залишити як є.
- API_FOOTBALL_KEY: залишити як є.
- BETCORE_FIXTURE_SOURCE: auto (рекомендовано).

Після деплою перевірити основний /api/odds.
Очікувана ознака для цього кейсу: fixtureSource може бути SofaScore + The Odds API, а matchedFixtureOdds має збільшитися.


v5.7.1 FIX: legacy BETCORE_FIXTURE_SOURCE=oddsapi is treated as auto, so cross-source fixture matching cannot be disabled accidentally. Effective chain: API-Football -> SofaScore fallback -> The Odds API merge.
