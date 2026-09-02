/**
 * Supabase authentication for the API, see milestone D3-D §28-§30.
 *
 * Trust boundary: the frontend's auth state is NOT authorization. Every
 * request that needs a user identity presents the Supabase access token in
 * the Authorization header; this module verifies it server-side against the
 * Supabase JWKS and resolves the local profile row.
 *
 * When SUPABASE_URL is not configured (local development), the server runs
 * in anonymous-only mode and authenticated endpoints reject with 401.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Sql } from "@aegix/database";
import type { AppConfig } from "@aegix/config";

export interface AuthUser {
  id: string;
  email: string | null;
  isAnonymous: boolean;
  /** Login wallet when authenticated via wallet session (D6-P). */
  wallet?: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksFetchedAt = 0;

function getJwks(supabaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const now = Date.now();
  if (!jwks || now - jwksFetchedAt > JWKS_CACHE_TTL_MS) {
    const url = new URL("/auth/v1/.well-known/jwks.json", supabaseUrl);
    jwks = createRemoteJWKSet(url);
    jwksFetchedAt = now;
  }
  return jwks;
}

export interface AuthContext {
  /** Resolves the verified user for a request, or null when anonymous. */
  resolveUser(req: FastifyRequest): Promise<AuthUser | null>;
  /** Ensures a profile row exists for the auth user, creating it if needed. */
  ensureProfile(authUser: AuthUser, sql: Sql): Promise<{ id: string }>;
}

export function createAuth(config: AppConfig): AuthContext {
  const supabaseUrl = config.SUPABASE_URL;
  const jwtSecret = config.SUPABASE_JWT_SECRET;

  return {
    async resolveUser(req) {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) return null;
      const token = header.slice("Bearer ".length).trim();
      if (!token) return null;

      if (!supabaseUrl) {
        // Local dev without Supabase: no token can be verified.
        return null;
      }

      try {
        let payload: { sub?: string; email?: string | null; is_anonymous?: boolean };
        if (jwtSecret) {
          // HS256 fallback using the JWT secret (self-hosted/development).
          const { payload: p } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
            issuer: `${supabaseUrl}/auth/v1`
          });
          payload = p as typeof payload;
        } else {
          const { payload: p } = await jwtVerify(token, getJwks(supabaseUrl), {
            issuer: `${supabaseUrl}/auth/v1`
          });
          payload = p as typeof payload;
        }
        if (!payload.sub) return null;
        const claims = payload as Record<string, unknown>;
        return {
          id: payload.sub,
          email: payload.email ?? null,
          isAnonymous: claims.is_anonymous === true || claims.role === "anon"
        };
      } catch {
        // Invalid/expired token: treat as anonymous (endpoints will 401 where required).
        return null;
      }
    },

    async ensureProfile(authUser, sql) {
      const [row] = await sql<Array<{ id: string }>>`
        insert into profiles (id, display_name)
        values (${authUser.id}, ${authUser.email})
        on conflict (id) do update set updated_at = now()
        returning id
      `;
      if (!row) throw new Error("profile upsert returned no row");
      return row;
    }
  };
}

/** Requires an authenticated user, otherwise replies 401. */
export async function requireUser(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<AuthUser | null> {
  if (req.user) return req.user;
  await reply.code(401).send({ code: "UNAUTHENTICATED", message: "Authentication required", requestId: req.id });
  return null;
}
