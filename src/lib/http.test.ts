import assert from 'node:assert/strict';
import test from 'node:test';
import type { Response } from 'express';
import { badRequest, forbidden, sendError, unauthorized } from './http.js';

function responseStub() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(payload: unknown) { body = payload; return this; },
  } as unknown as Response;
  return { response, read: () => ({ statusCode, body }) };
}

test('HTTP error helpers preserve status and stable codes', () => {
  assert.deepEqual({ status: unauthorized().status, code: unauthorized().code }, { status: 401, code: 'UNAUTHORIZED' });
  assert.equal(forbidden().status, 403);
  assert.equal(badRequest('Invalid', 'INVALID').code, 'INVALID');
});

test('sendError serializes safe HttpError details', () => {
  const stub = responseStub();
  sendError(stub.response, badRequest('Invalid payload', 'INVALID'));
  assert.deepEqual(stub.read(), { statusCode: 400, body: { error: 'Invalid payload', code: 'INVALID' } });
});

test('sendError hides unexpected internal errors', () => {
  const stub = responseStub();
  const original = console.error;
  console.error = () => undefined;
  try { sendError(stub.response, new Error('database secret')); } finally { console.error = original; }
  assert.deepEqual(stub.read(), { statusCode: 500, body: { error: 'Internal server error' } });
});
