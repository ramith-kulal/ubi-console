/**
 * confirm-token.js — stateless HMAC confirm tokens.
 *
 * Used to bind a two-step "preview then commit" flow together without any
 * server-side session store. The token commits to an exact payload string, so a
 * token minted for one action cannot authorise a different one: the deployer
 * binds it to the uploaded artifact's sha256, and the query console binds it to
 * the normalized SQL text.
 *
 * Serialized form: `<expiryMs>.<hexDigest>`
 */

import crypto from 'node:crypto';

export const DEFAULT_TTL_MS = 120 * 1000; // 120s

function getSecret() {
  const raw = process.env.CONFIRM_HMAC_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      'CONFIRM_HMAC_SECRET missing or shorter than 32 chars — set it in .env.local'
    );
  }
  return raw;
}

function digest(payload, username, expiryMs) {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`${payload}|${username}|${expiryMs}`)
    .digest('hex');
}

/** Mint a token for `payload`, valid for `ttlMs`. */
export function createConfirmToken(payload, username, ttlMs = DEFAULT_TTL_MS) {
  const expiryMs = Date.now() + ttlMs;
  return `${expiryMs}.${digest(payload, username, expiryMs)}`;
}

/**
 * Verify a token against the payload it must be bound to.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function verifyConfirmToken(token, payload, username) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'Malformed confirm token' };
  }

  const separator = token.indexOf('.');
  const expiryPart = token.slice(0, separator);
  const providedHex = token.slice(separator + 1);

  const expiryMs = Number(expiryPart);
  if (!Number.isInteger(expiryMs) || expiryMs <= 0) {
    return { ok: false, reason: 'Malformed confirm token' };
  }

  const expectedHex = digest(payload, username, expiryMs);

  // Compare before checking expiry so both failure paths cost the same, and so
  // a forged token never gets a distinguishable "expired" hint.
  const expected = Buffer.from(expectedHex, 'hex');
  let provided;
  try {
    provided = Buffer.from(providedHex, 'hex');
  } catch {
    return { ok: false, reason: 'Malformed confirm token' };
  }
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    // Either the secret differs, the user differs, or the payload differs —
    // i.e. a token minted for another query/artifact. All are "invalid".
    return { ok: false, reason: 'Confirm token does not match this request' };
  }

  if (Date.now() > expiryMs) {
    return { ok: false, reason: 'Confirm token expired — re-run the preview' };
  }

  return { ok: true };
}

/**
 * The exact string a deploy confirm token commits to.
 *
 * Binding all three of target/staged-upload/digest means a token minted for
 * "this zip, to bankers-dashboard" cannot be replayed to push the same bytes to
 * etb-ntb-frontend, nor to commit a different staged file.
 */
export function deployConfirmPayload({ targetKey, stagingId, sha256 }) {
  return `deploy|${targetKey}|${stagingId}|${sha256}`;
}

/** The payload a rollback confirm token commits to. */
export function rollbackConfirmPayload({ targetKey, releaseId }) {
  return `rollback|${targetKey}|${releaseId}`;
}
