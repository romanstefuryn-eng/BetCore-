BetCore v5.7.4 — Odds API diagnostic

Ця версія не змінює логіку BETCORE. Додано діагностику The Odds API.

Після деплою відкрий:
/api/diagnostics/odds?horizon=7d&home=Leuven&away=AS%20Roma

Endpoint показує:
- скільки soccer-спортів бачить The Odds API;
- які жіночі/Champions League soccer-ключі доступні;
- скільки подій повертає /events;
- чи знаходить Leuven / AS Roma;
- який sport key використано для прямого /odds-запиту;
- HTTP status, кількість подій і quota.

ODDS_API_KEY у чат не вставляти.
