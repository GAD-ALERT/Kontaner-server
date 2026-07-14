import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';

test('health endpoint returns service status and security headers', async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await response.json() as { ok: boolean; service: string };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'kontaner-backend');
  assert.ok(response.headers.get('x-request-id'));
  assert.ok(response.headers.get('x-content-type-options'));
});

test('unknown routes return the standard not-found envelope', async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/missing`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Not found', code: 'NOT_FOUND' });
});
