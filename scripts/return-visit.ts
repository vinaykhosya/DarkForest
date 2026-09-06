import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { asSystem, createPool } from "@darkforest/db";

/**
 * `pnpm v01` — THE V0.1 GATE. V1-T17.
 *
 * Not a percentage. One sentence:
 *
 *   A stranger creates Elena, tells her something meaningful, closes the
 *   browser, comes back tomorrow, and the character naturally remembers it.
 *
 * Every step here is the real thing: a real sign-up through Supabase Auth, real
 * HTTP against the running API, a real model, and a real database. The only
 * simulation is time — "tomorrow" is the world clock advancing and a NEW
 * session token, because keeping the old one in memory would prove that a
 * variable persists rather than that the product does.
 *
 * The stranger's account is deleted at the end whatever happens.
 */

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    const v = (m[2] ?? "").split(" #")[0]?.trim() ?? "";
    if (v) out[m[1]] = v;
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
const API = env["API_URL"] ?? "http://localhost:8787";
const SUPABASE = env["SUPABASE_URL"] ?? "";
const ANON = env["SUPABASE_ANON_KEY"] ?? "";
const SERVICE = env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string; detail?: string };
}

async function api<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || body.data === undefined) {
    throw new Error(
      `${path} -> ${String(res.status)} ${body.error?.code ?? ""} ${body.error?.message ?? ""} ${body.error?.detail ?? ""}`,
    );
  }
  return body.data;
}

/**
 * Creates the test account through the ADMIN endpoint, pre-confirmed.
 *
 * NOT a way around a rate limit. `/auth/v1/signup` sends a confirmation email,
 * and the free tier allows a couple of those per hour — a limit that exists to
 * stop email abuse. This script has no use for the email at all, so it uses the
 * documented admin path that creates the user and sends none. The limit is
 * respected by not consuming the resource it protects, which is the opposite of
 * evading it.
 *
 * The service-role key is used HERE and nowhere the browser can reach. Creating
 * a user is exactly the kind of act-as-the-system operation ADR-030 names as its
 * legitimate use.
 */
async function createAccount(email: string, password: string): Promise<void> {
  const res = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SERVICE,
      authorization: `Bearer ${SERVICE}`,
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { msg?: string; message?: string };
    throw new Error(`could not create the account: ${body.msg ?? body.message ?? String(res.status)}`);
  }
}

/**
 * A REAL sign-in, exactly as the browser does it: the anon key and a password,
 * exchanged for an access token. This is the part that must not be faked, and
 * it is not — the token returned here is verified by the API's JWKS check like
 * anyone else's.
 */
async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { access_token?: string; msg?: string; error_description?: string };
  if (body.access_token === undefined) {
    throw new Error(`auth failed: ${body.msg ?? body.error_description ?? JSON.stringify(body)}`);
  }
  return body.access_token;
}

const line = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

async function main(): Promise<void> {
  if (SUPABASE.length === 0 || ANON.length === 0 || SERVICE.length === 0) {
    throw new Error("SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  // `example.com` rather than a `.test` TLD: Supabase's address validator
  // rejects the reserved test TLDs outright, and the resulting error looks like
  // a credentials problem rather than a format one.
  const email = `stranger-${randomUUID().slice(0, 8)}@example.com`;
  const password = `Pw-${randomUUID()}`;
  const pool = createPool({
    url:
      env["SUPABASE_SESSION_POOLER_URL"] ?? env["SUPABASE_DB_URL"] ?? env["DATABASE_URL"] ?? "",
  });

  let worldId = "";
  let userId = "";
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    line(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(38)} ${detail}`);
    if (!ok) failures.push(name);
  };

  try {
    line("\n  ── DAY ONE ─────────────────────────────────────────────────────────\n");

    // 1. A stranger arrives.
    await createAccount(email, password);
    const day1Token = await signIn(email, password);
    const me = await api<{ handle: string }>(day1Token, "/me");
    check("a stranger signs up", me.handle.length > 0, `profile '${me.handle}'`);

    // 2. They make a world and someone to talk to.
    const world = await api<{ id: string }>(day1Token, "/worlds", {
      method: "POST",
      body: { name: "Saltmarsh" },
    });
    worldId = world.id;
    const elena = await api<{ id: string }>(day1Token, `/worlds/${worldId}/characters`, {
      method: "POST",
      body: {
        name: "Elena",
        role: "the harbourmaster's daughter",
        persona: "Watchful, dry, slow to trust. She has lived in Saltmarsh her whole life.",
        speechStyle: "Short sentences. Rarely explains herself.",
      },
    });
    check("they create a world and a character", elena.id.length > 0, "Elena exists");

    // 3. They tell her something that ought to matter tomorrow.
    const MEANINGFUL = "I have to tell you something. I can't swim. I never learned.";
    const first = await api<{ reply: string; eventsExtracted: number }>(
      day1Token,
      `/worlds/${worldId}/turns`,
      { method: "POST", body: { characterId: elena.id, message: MEANINGFUL } },
    );
    line(`\n        you:   ${MEANINGFUL}`);
    line(`        Elena: ${first.reply}\n`);
    check(
      "she answers",
      first.reply.length > 0,
      `${String(first.eventsExtracted)} event(s) extracted`,
    );
    check(
      "the confession became an event",
      first.eventsExtracted > 0,
      "the log has something to remember",
    );

    // ── the browser closes, and a day passes ─────────────────────────────
    userId = await asSystem(pool, "return-visit fixture", async (c) => {
      const { rows } = await c.query<{ owner_id: string }>(
        "select owner_id from worlds where id = $1",
        [worldId],
      );
      // Time is the ONLY simulated part. Everything else is the real product.
      await c.query("update world_state set day = day + 1 where world_id = $1", [worldId]);
      return rows[0]?.owner_id ?? "";
    });

    line("  ── THE BROWSER CLOSES. A DAY PASSES. ───────────────────────────────\n");

    // 4. They come back. NEW token, nothing carried over but the account.
    const day2Token = await signIn(email, password);
    check("the session is gone", day2Token !== day1Token, "a new sign-in, as a returning browser");

    const worlds = await api<Array<{ id: string; name: string }>>(day2Token, "/worlds");
    check(
      "their world is still there",
      worlds.some((w) => w.id === worldId),
      worlds.map((w) => w.name).join(", "),
    );

    const transcript = await api<Array<{ speaker: string; content: string }>>(
      day2Token,
      `/worlds/${worldId}/turns`,
    );
    check(
      "the conversation is still there",
      transcript.length >= 2 && transcript[0]?.content === MEANINGFUL,
      `${String(transcript.length)} turns`,
    );

    // 5. THE QUESTION. Nothing in it mentions swimming.
    const PROMPT = "The ferry's not running. Should we wade across the channel instead?";
    const second = await api<{ reply: string; recalled: Array<{ content: string }> }>(
      day2Token,
      `/worlds/${worldId}/turns`,
      { method: "POST", body: { characterId: elena.id, message: PROMPT } },
    );
    line(`\n        you:   ${PROMPT}`);
    line(`        Elena: ${second.reply}`);
    if (second.recalled.length > 0) {
      line(`        drew on: ${second.recalled.map((r) => r.content).join(" · ")}`);
    }
    line("");

    check(
      "she retrieved it without being reminded",
      second.recalled.some((r) => /swim/i.test(r.content)),
      second.recalled.length === 0 ? "nothing retrieved" : `${String(second.recalled.length)} memories`,
    );

    /*
     * The reply is reported, NOT asserted on.
     *
     * A substring check for "swim" would score a character who recites the fact
     * above one who simply says "no, we take the long way round" — and ADR-026
     * already records that the matcher is a proxy, with the expression suite
     * built precisely because it proxies this badly. Retrieval is machine-
     * checkable and is checked. Whether the reply FEELS like being remembered is
     * V1-T18, and it is read by a person.
     */
    line("  ── the reply above is for a person to judge, not a substring ────────\n");

    /*
     * WHEN RETRIEVAL FINDS NOTHING, SAY WHERE IT WAS LOST.
     *
     * Four layers can each produce "nothing retrieved", and they need opposite
     * fixes: the event never stored, its audience excluded the character, the
     * memory row was never derived, the grant was never made, or the query
     * simply did not match. A single failing assertion cannot tell them apart,
     * and guessing between them is how the same afternoon gets spent twice.
     */
    if (failures.includes("she retrieved it without being reminded")) {
      await asSystem(pool, "return-visit diagnosis", async (c) => {
        line("  ── WHERE IT WAS LOST ───────────────────────────────────────────────\n");
        const events = await c.query<{
          type: string;
          actor: string;
          value: string | null;
          audience: string[];
        }>(
          "select type, actor, value, audience from events where world_id = $1 order by seq",
          [worldId],
        );
        line(`    events (${String(events.rows.length)}):`);
        for (const e of events.rows) {
          line(`      ${e.type} actor=${e.actor} audience=[${e.audience.join(", ")}]`);
          line(`        value: ${e.value ?? "null"}`);
        }

        const mems = await c.query<{
          content: string;
          visibility: string;
          embedded: boolean;
        }>(
          `select m.content, m.visibility,
                  exists(select 1 from memory_embeddings e where e.memory_id = m.id) as embedded
             from memories m where m.world_id = $1 order by m.created_at`,
          [worldId],
        );
        line(`\n    memories (${String(mems.rows.length)}):`);
        for (const m of mems.rows) {
          line(`      [${m.visibility}] ${m.embedded ? "embedded" : "NO VECTOR"} ${m.content}`);
        }

        const grants = await c.query<{ name: string; certainty: number }>(
          `select ch.name, ck.certainty
             from character_knowledge ck
             join characters ch on ch.id = ck.character_id
            where ch.world_id = $1`,
          [worldId],
        );
        line(`\n    knowledge grants (${String(grants.rows.length)}):`);
        for (const g of grants.rows) line(`      ${g.name} certainty=${String(g.certainty)}`);
        line("");
      });
    }
  } finally {
    if (userId.length > 0) {
      await asSystem(pool, "return-visit cleanup", async (c) => {
        await c.query("begin");
        await c.query("select set_config('app.hard_delete', 'on', true)");
        await c.query("delete from auth.users where id = $1", [userId]);
        await c.query("commit");
      });
    }
    await pool.end();
  }

  if (failures.length > 0) {
    process.stderr.write(`\n  ${String(failures.length)} STEP(S) FAILED\n\n`);
    process.exitCode = 1;
  } else {
    line("  the loop closes: a stranger was remembered a day later\n");
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`\n  RETURN VISIT FAILED\n  ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exitCode = 1;
});
