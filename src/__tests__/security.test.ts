import { validateLocalRequest } from '../web/security.js';
import { describe, expect, it } from 'vitest';

describe('HTTP request security', () => {
  it.each([
    ['127.0.0.1:24100', undefined],
    ['localhost:24100', undefined],
    ['127.0.0.1:24100', 'http://127.0.0.1:24100'],
    ['localhost:24100', 'http://localhost:24100'],
  ])('allows loopback host %s with origin %s', (host, origin) => {
    expect(validateLocalRequest(host, origin)).toEqual({ allowed: true });
  });

  it.each([
    [undefined, undefined, 400],
    ['example.com:24100', undefined, 403],
    ['127.0.0.1:24100', 'https://127.0.0.1:24100', 403],
    ['127.0.0.1:24100', 'http://localhost:24100', 403],
    ['127.0.0.1:24100', 'https://example.com', 403],
    ['127.0.0.1:24100', 'null', 403],
  ])('rejects host %s with origin %s', (host, origin, statusCode) => {
    const result = validateLocalRequest(host, origin);

    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(statusCode);
  });
});
