import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { asUser, type DbPool } from "@darkforest/db";
import type { Authenticator, Session } from "./auth.js";
import { ApiError, fail, ok, toApiError } from "./envelope.js";
import { runTurn, type TurnDeps } from "./turn.js";

/**
 * The HTTP surface. V1-T12, T13, T14, T15.
 *
 * Small on purpose. V0.1 is one world, one character, one conversation, and
 * every endpoint that is not on the path from "a stranger arrives" to "the
 * character remembers" is a later V.
 */

export interface AppDeps extends TurnDeps {
  pool: DbPool;
  auth: Authenticator;
  isProduction: boolean;
}

const CreateWorld = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(""),
});

const CreateCharacter = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(80).default(""),
  persona: z.string().trim().max(1200).default(""),
  speechStyle: z.string().trim().max(400).default(""),
});

const PostTurn = z.object({
  characterId: z.string().uuid(),
  message: z.string().trim().min(1).max(2000),
});

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  /*
   * One error path for everything.
   *
   * Hono's `onError` catches whatever a handler throws, so no route needs a
   * try/catch and none can accidentally return a bare 500 with a stack trace.
   * `toApiError` is the only place an unrecognised throw becomes a response,
   * which is why it is the only place that has to be careful.
   */
  app.onError((err, c) => {
    const apiError = toApiError(err);
    const requestId = c.get("requestId") ?? "req_unknown";
    if (apiError.status >= 500) {
      // Never the message body, never the prompt (CLAUDE.md § 5, docs/12 § 7).
      console.error(`[${requestId}] ${apiError.code}: ${apiError.options.detail ?? ""}`);
    }
    return c.json(fail(apiError, requestId, deps.isProduction), apiError.status as 500);
  });

  app.notFound((c) =>
    c.json(
      fail(new ApiError("NOT_FOUND", "No such endpoint."), c.get("requestId") ?? "req_unknown", deps.isProduction),
      404,
    ),
  );

  app.use("*", async (c, next) => {
    c.set("requestId", `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
    await next();
  });

  // Liveness. Deliberately does NOT touch the database: a health check that
  // fails when the database is slow turns a degradation into an outage.
  app.get("/health", (c) => c.json(ok({ status: "ok" }, c.get("requestId") ?? "")));

  /** Everything below requires a verified session. */
  const authed = async (c: { req: { header: (k: string) => string | undefined } }): Promise<Session> =>
    deps.auth.verify(c.req.header("authorization"));

  app.get("/me", async (c) => {
    const session = await authed(c);
    const profile = await asUser(deps.pool, session.userId, async (db) => {
      const { rows } = await db.query<{ handle: string; display_name: string }>(
        "select handle, display_name from profiles where id = $1",
        [session.userId],
      );
      return rows[0] ?? null;
    });
    if (profile === null) {
      // The trigger creates this row with the auth user. Its absence means the
      // account is half-made, which is a server problem, not a sign-in problem.
      throw new ApiError("INTERNAL", "Your account is not ready yet.", {
        detail: "no profile row for a verified user",
      });
    }
    return c.json(
      ok({ handle: profile.handle, displayName: profile.display_name }, c.get("requestId") ?? ""),
    );
  });

  app.post("/worlds", async (c) => {
    const session = await authed(c);
    const body = CreateWorld.parse(await c.req.json());

    const world = await asUser(deps.pool, session.userId, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        "insert into worlds (owner_id, name, description) values ($1,$2,$3) returning id",
        [session.userId, body.name, body.description],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new ApiError("INTERNAL", "The world could not be created.");
      // The clock is created WITH the world, in the same transaction. Every
      // sequence allocation locks this row, so a world without one cannot take
      // a turn — and `next_turn_seq` raises rather than racing silently.
      await db.query("insert into world_state (world_id) values ($1)", [id]);
      return { id, name: body.name };
    });

    return c.json(ok(world, c.get("requestId") ?? ""), 201);
  });

  app.get("/worlds", async (c) => {
    const session = await authed(c);
    const worlds = await asUser(deps.pool, session.userId, async (db) => {
      const { rows } = await db.query<{ id: string; name: string; last_played_at: Date | null }>(
        `select id, name, last_played_at from worlds
          where deleted_at is null order by last_played_at desc nulls last, created_at desc`,
        [],
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        lastPlayedAt: r.last_played_at?.toISOString() ?? null,
      }));
    });
    return c.json(ok(worlds, c.get("requestId") ?? ""));
  });

  app.post("/worlds/:worldId/characters", async (c) => {
    const session = await authed(c);
    const worldId = c.req.param("worldId");
    const body = CreateCharacter.parse(await c.req.json());

    const character = await asUser(deps.pool, session.userId, async (db) => {
      /*
       * No ownership check here, and that is the point of ADR-030: RLS's `with
       * check` rejects an insert into a world this user does not own. An
       * ownership check in application code would be a second implementation of
       * the same rule, and the one that gets forgotten on the next endpoint.
       */
      const { rows } = await db.query<{ id: string }>(
        `insert into characters (world_id, name, role, persona, speech_style)
         values ($1,$2,$3,$4,$5) returning id`,
        [worldId, body.name, body.role, body.persona, body.speechStyle],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new ApiError("NOT_FOUND", "That world could not be found.");
      return { id, name: body.name };
    });

    return c.json(ok(character, c.get("requestId") ?? ""), 201);
  });

  app.get("/worlds/:worldId/characters", async (c) => {
    const session = await authed(c);
    const worldId = c.req.param("worldId");
    const characters = await asUser(deps.pool, session.userId, async (db) => {
      const { rows } = await db.query<{ id: string; name: string; role: string }>(
        `select id, name, role from characters
          where world_id = $1 and deleted_at is null order by created_at asc`,
        [worldId],
      );
      return rows;
    });
    return c.json(ok(characters, c.get("requestId") ?? ""));
  });

  /** The transcript. What the player sees when they come back tomorrow. */
  app.get("/worlds/:worldId/turns", async (c) => {
    const session = await authed(c);
    const worldId = c.req.param("worldId");
    const turns = await asUser(deps.pool, session.userId, async (db) => {
      const { rows } = await db.query<{
        seq: number;
        speaker: string;
        content: string;
        created_at: Date;
      }>(
        `select seq, speaker, content, created_at from turns
          where world_id = $1 order by seq asc limit 200`,
        [worldId],
      );
      return rows.map((r) => ({
        seq: r.seq,
        speaker: r.speaker,
        content: r.content,
        at: r.created_at.toISOString(),
      }));
    });
    return c.json(ok(turns, c.get("requestId") ?? ""));
  });

  app.post("/worlds/:worldId/turns", async (c) => {
    const session = await authed(c);
    const worldId = c.req.param("worldId");
    const body = PostTurn.parse(await c.req.json());

    const result = await runTurn(deps, {
      userId: session.userId,
      worldId,
      characterId: body.characterId,
      message: body.message,
    });

    // Marks the world as played, so "come back tomorrow" has something to sort
    // by. Separate from the turn's own transaction on purpose: failing to
    // update a timestamp must not undo a turn that actually happened.
    await asUser(deps.pool, session.userId, async (db) => {
      await db.query("update worlds set last_played_at = now() where id = $1", [worldId]);
    });

    return c.json(ok(result, c.get("requestId") ?? ""));
  });

  return app;
}

declare module "hono" {
  interface ContextVariableMap {
    /*
     * `| undefined` is not pedantry. `onError` can run for a request that never
     * reached the middleware which sets this, so declaring it always-present
     * would be a type that lies and a fallback the linter then deletes.
     */
    requestId: string | undefined;
  }
}
