BETCORE v5.6 — MATCH MATCHING 2.0

Changes:
- More tolerant team normalization for provider naming differences.
- Levenshtein + token similarity for team matching.
- Competition/league similarity is included in fuzzy matching.
- One-to-one fixture ↔ Odds API matching.
- Ambiguous candidates are NOT auto-merged.
- Added matchIdentity with API-Football ID, Odds API ID, team names, kickoff difference, score and confidence.
- Added ambiguousFixtureMatches / diagnostics count.
- Version 5.6.

Install:
1. Extract the archive.
2. Upload/replace server.js, index.html and prediction.js in the GitHub main branch.
3. Render auto-deploys from GitHub.
4. Open BetCore and press Оновити.
5. Check coverage: «зіставлено джерела» should be > 0 when the same matches exist in both sources.
