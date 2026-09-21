const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ODDS_API_KEY || '';

function send(res, status, type, data) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function getAPI(url) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      let data = '';

      response.on('data', chunk => {
        data += chunk;
      });

      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error('Odds API error: HTTP ' + response.statusCode));
        }
      });
    }).on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {

  if (req.url === '/health') {
    return send(
      res,
      200,
      'application/json',
      JSON.stringify({ ok: true })
    );
  }

  if (req.url.startsWith('/api/odds')) {

    if (!API_KEY) {
      return send(
        res,
        500,
        'application/json',
        JSON.stringify({
          error: 'ODDS_API_KEY is not configured'
        })
      );
    }

    const url = new URL(
      req.url,
      'http://' + req.headers.host
    );

    const sport =
      url.searchParams.get('sport') || 'soccer_epl';

    const markets =
      url.searchParams.get('markets') ||
      'h2h,totals,spreads';

    const regions =
      url.searchParams.get('regions') || 'eu';

    const apiURL =
      'https://api.the-odds-api.com/v4/sports/' +
      encodeURIComponent(sport) +
      '/odds/?apiKey=' +
      encodeURIComponent(API_KEY) +
      '&regions=' +
      encodeURIComponent(regions) +
      '&markets=' +
      encodeURIComponent(markets) +
      '&oddsFormat=decimal';

    try {
      const data = await getAPI(apiURL);

      return send(
        res,
        200,
        'application/json',
        JSON.stringify({
          source: 'The Odds API',
          fetchedAt: new Date().toISOString(),
          events: data.length,
          data: data
        })
      );

    } catch (error) {

      return send(
        res,
        502,
        'application/json',
        JSON.stringify({
          error: error.message
        })
      );
    }
  }

  if (req.url === '/' || req.url === '/index.html') {

    const file = fs.readFileSync(
      path.join(__dirname, 'index.html')
    );

    return send(
      res,
      200,
      'text/html; charset=utf-8',
      file
    );
  }

  send(res, 404, 'text/plain', 'Not found');
});

server.listen(PORT, () => {
  console.log('BetCore started on port ' + PORT);
});
