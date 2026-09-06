import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ApiError } from "./envelope.js";

/**
 * SUPABASE AUTH — verifying the token, not merely reading it. ADR-030.
 *
 * A JWT is base64, not a secret. Anyone can mint one claiming
 * `sub: <someone else's uuid>`; only the SIGNATURE distinguishes a real session
 * from a forged one. Decoding without verifying is the single most common auth
 * bug in this shape of application, and it fails open: everything works
 * perfectly, including for the attacker.
 *
 * So the signature is checked against Supabase's published keys, and the claims
 * are only trusted afterwards. `asUser()` then hands the verified `sub` to
 * Postgres, where RLS decides what it can reach — two independent layers, and
 * neither is asked to trust the other's word.
 */

export interface Session {
  userId: string;
  email: string | null;
}

export interface AuthConfig {
  /** e.g. https://<ref>.supabase.co */
  supabaseUrl: string;
  /**
   * The legacy shared secret, for projects still issuing HS256 tokens.
   * Optional: asymmetric (JWKS) verification is preferred and needs no secret
   * in the API at all, which is the better property.
   */
  jwtSecret?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Authenticator {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly secret: Uint8Array | null;

  constructor(private readonly cfg: AuthConfig) {
    // The key set is fetched lazily and cached by `jose`, with its own rotation
    // handling. Fetching it per request would put an outbound call on the hot
    // path of every single API call.
    this.jwks = createRemoteJWKSet(new URL(`${cfg.supabaseUrl}/auth/v1/.well-known/jwks.json`));
    this.secret =
      cfg.jwtSecret === undefined ? null : new TextEncoder().encode(cfg.jwtSecret);
  }

  /**
   * The verified session, or an `UNAUTHENTICATED` error.
   *
   * Every failure returns the SAME message. Distinguishing "expired" from
   * "malformed" from "wrong signature" tells an attacker which part of a forged
   * token to fix next, and tells a legitimate user nothing they can act on that
   * "sign in again" does not.
   */
  async verify(authorization: string | undefined): Promise<Session> {
    const token = authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : null;
    if (token === null || token.length === 0) {
      throw new ApiError("UNAUTHENTICATED", "Please sign in.");
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.jwks, {
        issuer: `${this.cfg.supabaseUrl}/auth/v1`,
      });
      payload = verified.payload;
    } catch (asymmetricFailure) {
      if (this.secret === null) {
        throw new ApiError("UNAUTHENTICATED", "Please sign in.", {
          detail: asymmetricFailure instanceof Error ? asymmetricFailure.message : "jwks verify failed",
        });
      }
      try {
        const verified = await jwtVerify(token, this.secret, {
          issuer: `${this.cfg.supabaseUrl}/auth/v1`,
        });
        payload = verified.payload;
      } catch (symmetricFailure) {
        throw new ApiError("UNAUTHENTICATED", "Please sign in.", {
          detail: symmetricFailure instanceof Error ? symmetricFailure.message : "verify failed",
        });
      }
    }

    const sub = payload["sub"];
    if (typeof sub !== "string" || !UUID.test(sub)) {
      // A verified token with an unusable subject is not a user error; it means
      // something upstream changed shape. Fail closed and say so in `detail`.
      throw new ApiError("UNAUTHENTICATED", "Please sign in.", { detail: "token has no uuid sub" });
    }

    const email = payload["email"];
    return { userId: sub, email: typeof email === "string" ? email : null };
  }
}
