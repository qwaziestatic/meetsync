import assert from 'node:assert/strict';

const calls = [];
let tokenCalls = 0;

globalThis.chrome = {
  identity: {
    async getAuthToken() {
      tokenCalls += 1;
      return { token: tokenCalls === 1 ? 'stale-token' : 'fresh-token', grantedScopes: [] };
    },
    async removeCachedAuthToken({ token }) {
      calls.push(['remove', token]);
    },
  },
  storage: {
    local: { async get() { return {}; } },
  },
};

const { fetchWithAuth } = await import('../src/background/auth.js');

globalThis.fetch = async (_input, init) => {
  calls.push(['fetch', init.headers.Authorization]);
  return { status: calls.filter(([kind]) => kind === 'fetch').length === 1 ? 401 : 200, ok: calls.length > 0 };
};

const response = await fetchWithAuth('https://www.googleapis.com/test');
assert.equal(response.status, 200);
assert.deepEqual(calls, [
  ['fetch', 'Bearer stale-token'],
  ['remove', 'stale-token'],
  ['fetch', 'Bearer fresh-token'],
]);
console.log('PASS authorization header and one-shot 401 recovery');
