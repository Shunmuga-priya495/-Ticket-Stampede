'use strict';

// Tiny, dependency-free HTTP helpers. We intentionally do not pull in
// express/fastify/etc: the whole point of this service is three routes,
// and Node's built-in http module is plenty.

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Simple router: routes[METHOD][path] = async (req, res, parsedUrl) => {}
function makeRouter(routes) {
  return async function handler(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const methodRoutes = routes[req.method];
    const route = methodRoutes && methodRoutes[parsedUrl.pathname];
    if (!route) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    try {
      await route(req, res, parsedUrl);
    } catch (e) {
      sendJson(res, 500, { error: 'internal_error', message: e.message });
    }
  };
}

module.exports = { readJsonBody, sendJson, makeRouter };
