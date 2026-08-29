import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Extracts the raw token from an Authorization header.
 * Only the Bearer scheme is accepted.
 */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader);
  if (!match) {
    return undefined;
  }

  return match[1];
}

/**
 * Compares tokens in constant time by hashing both to fixed-length digests first.
 * Avoids leaking token length via early return on Buffer length mismatch.
 */
export function tokensEqual(expected: string, provided: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

export function isAuthorized(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  const provided = extractBearerToken(authorizationHeader);
  if (provided === undefined) {
    return false;
  }

  return tokensEqual(expectedToken, provided);
}
