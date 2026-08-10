/**
 * confirm-token.test.js — a confirm token must authorise exactly one action.
 * If a token minted for artifact A validates artifact B, the whole two-step
 * "preview then commit" guarantee is decorative.
 */

process.env.CONFIRM_HMAC_SECRET =
  process.env.CONFIRM_HMAC_SECRET || 'test-secret-value-at-least-32-chars-long!!';

import { describe, it, expect } from './harness.js';
import { createConfirmToken, verifyConfirmToken } from '../lib/confirm-token.js';

describe('confirm tokens', () => {
  it('validates a token for its own payload and user', () => {
    const token = createConfirmToken('sha256:abc123', 'ramith');
    expect(verifyConfirmToken(token, 'sha256:abc123', 'ramith').ok).toBeTruthy();
  });

  it('rejects a token used for a different payload', () => {
    const token = createConfirmToken('sha256:AAAA', 'ramith');
    const result = verifyConfirmToken(token, 'sha256:BBBB', 'ramith');
    expect(result.ok).toBeFalsy();
    expect(result.reason).toContain('does not match');
  });

  it('rejects a token issued to a different user', () => {
    const token = createConfirmToken('sha256:abc123', 'ramith');
    expect(verifyConfirmToken(token, 'sha256:abc123', 'someone-else').ok).toBeFalsy();
  });

  it('rejects an expired token', () => {
    const token = createConfirmToken('sha256:abc123', 'ramith', -1000); // already expired
    const result = verifyConfirmToken(token, 'sha256:abc123', 'ramith');
    expect(result.ok).toBeFalsy();
    expect(result.reason).toContain('expired');
  });

  it('rejects a tampered digest', () => {
    const token = createConfirmToken('sha256:abc123', 'ramith');
    const [expiry, digest] = token.split('.');
    const flipped = digest.startsWith('a') ? `b${digest.slice(1)}` : `a${digest.slice(1)}`;
    expect(verifyConfirmToken(`${expiry}.${flipped}`, 'sha256:abc123', 'ramith').ok).toBeFalsy();
  });

  it('rejects a tampered expiry (extending the TTL invalidates the digest)', () => {
    const token = createConfirmToken('sha256:abc123', 'ramith');
    const digest = token.split('.')[1];
    const farFuture = Date.now() + 10 * 60 * 1000;
    expect(verifyConfirmToken(`${farFuture}.${digest}`, 'sha256:abc123', 'ramith').ok).toBeFalsy();
  });

  it('rejects malformed tokens without throwing', () => {
    for (const bad of ['', 'nonsense', '123', 'abc.def', '.', 'null.null']) {
      expect(verifyConfirmToken(bad, 'sha256:abc123', 'ramith').ok).toBeFalsy();
    }
  });

  it('rejects a non-string token', () => {
    expect(verifyConfirmToken(undefined, 'p', 'u').ok).toBeFalsy();
    expect(verifyConfirmToken(null, 'p', 'u').ok).toBeFalsy();
    expect(verifyConfirmToken(12345, 'p', 'u').ok).toBeFalsy();
  });
});
