import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcrypt';

test('bcrypt hashes and verifies passwords after the native dependency upgrade', async () => {
  const password = 'correct horse battery staple';
  const hash = await bcrypt.hash(password, 4);
  assert.equal(await bcrypt.compare(password, hash), true);
  assert.equal(await bcrypt.compare('wrong password', hash), false);
});
