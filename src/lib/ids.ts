import { randomBytes } from 'node:crypto';

/**
 * Short, URL-safe, unique-enough ids.
 * Kept human-scannable by prefixing with a short domain tag ("usr", "asset", …)
 * — the frontend already uses similar-looking ids.
 */
export function newId(prefix: string, bytes = 6): string {
  return `${prefix}-${randomBytes(bytes).toString('hex')}`;
}
