import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError, requestJson } from '../src/services/httpClient.ts';

test('requestJson sends JSON and the authenticated session token', async () => {
  let seenHeaders: Headers | null = null;
  const result = await requestJson<{ ok: boolean }>('/api/auth/me', { method: 'GET' }, {
    token: 'session-token',
    fetchImpl: async (_input, init) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(seenHeaders?.get('Authorization'), 'Bearer session-token');
  assert.equal(seenHeaders?.get('Content-Type'), 'application/json');
});

test('requestJson preserves HTTP status and Retry-After for API errors', async () => {
  await assert.rejects(
    () => requestJson('/api/auth/consume', { method: 'POST', body: '{}' }, {
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: 'تم تجاوز الحد مؤقتاً.' },
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '45' },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.message, 'تم تجاوز الحد مؤقتاً.');
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryAfter, '45');
      return true;
    },
  );
});

test('requestJson rejects invalid JSON from a successful API response', async () => {
  await assert.rejects(
    () => requestJson('/api/auth/me', {}, {
      fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /استجابة الخادم غير صالحة/);
      return true;
    },
  );
});

test('requestJson exposes a stable timeout error without retrying the request', async () => {
  let calls = 0;
  await assert.rejects(
    () => requestJson('/api/auth/login', { method: 'POST', body: '{}' }, {
      timeoutMs: 5,
      fetchImpl: async () => {
        calls += 1;
        return await new Promise<Response>(() => {});
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.statusCode, 408);
      return true;
    },
  );
  assert.equal(calls, 1);
});
