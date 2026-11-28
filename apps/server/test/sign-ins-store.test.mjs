import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { load } from "./sources.mjs";

/*
  Where the sign-ins store reads (Sentry TALKTO-SERVER-C): the sign-out check MCP runs on every
  request reads a D1 read replica and falls back once to the primary; everything else, the
  website's own list and every write, stays on the primary so it always reads its own writes.
*/

const Store = await load("../src/sign-ins/store.ts");

const signOut = { clientId: "client_01CLAUDECODE", sid: "app_consent_laptop", revokedAt: 5 };
const outage = () =>
  Object.assign(new Error("D1_ERROR: PRIVATE_REPLICA_DETAIL"), { retryable: true });

/**
 * A D1 binding that records which session mode each statement ran on. `fails(mode)` makes a
 * statement on that mode reject; every read answers `rows`.
 */
const fake = ({ fails = () => false, rows = [signOut] } = {}) => {
  const ran = [];
  const sessions = [];
  const session = (mode) => {
    const statement = (query) => ({
      bind: () => ({
        all: async () => {
          ran.push({ mode, query });
          if (fails(mode)) throw outage();
          return { results: rows, success: true, meta: {} };
        },
        run: async () => {
          ran.push({ mode, query });
          if (fails(mode)) throw outage();
          return { results: [], success: true, meta: { changes: 1 } };
        },
      }),
    });
    return {
      prepare: statement,
      batch: async (statements) => Promise.all(statements.map((s) => s.run())),
    };
  };
  const database = {
    withSession: (mode) => {
      sessions.push(mode);
      return session(mode);
    },
  };
  return { database, ran, sessions };
};

const use = (database, f) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* Store.Store);
    }).pipe(Effect.provide(Store.layer(database)), Effect.result),
  );

/** Capture console.warn while `run` runs. */
const warnings = async (run) => {
  const seen = [];
  const warn = console.warn;
  console.warn = (...args) => seen.push(args);
  try {
    return { result: await run(), seen };
  } finally {
    console.warn = warn;
  }
};

test("the sign-out check reads a replica, on a fresh session each time", async () => {
  const d1 = fake();
  const { result, seen } = await warnings(() =>
    use(d1.database, (store) =>
      Effect.all([store.revocations("user_alice", 1), store.revocations("user_alice", 2)]),
    ),
  );
  assert.equal(result._tag, "Success");
  assert.deepEqual(result.success, [[signOut], [signOut]]);
  assert.deepEqual(
    d1.ran.map((r) => r.mode),
    ["first-unconstrained", "first-unconstrained"],
  );
  assert.deepEqual(d1.sessions, ["first-unconstrained", "first-unconstrained"]);
  assert.equal(seen.length, 0);
});

test("a failed replica read is tried once on the primary, which answers", async () => {
  const d1 = fake({ fails: (mode) => mode === "first-unconstrained" });
  const { result, seen } = await warnings(() =>
    use(d1.database, (store) => store.revocations("user_alice", 1)),
  );
  assert.equal(result._tag, "Success");
  assert.deepEqual(result.success, [signOut]);
  assert.deepEqual(
    d1.ran.map((r) => r.mode),
    ["first-unconstrained", "first-primary"],
  );
  assert.equal(seen.length, 1);
  const [message, fields] = seen[0];
  assert.match(message, /read replica; reading the primary/);
  assert.equal(fields.retryable, true);
  assert.doesNotMatch(JSON.stringify(seen), /PRIVATE_REPLICA_DETAIL|user_alice/);
});

test("when the replica and the primary both fail, it is today's storage failure", async () => {
  const d1 = fake({ fails: () => true });
  const { result } = await warnings(() =>
    use(d1.database, (store) => store.revocations("user_alice", 1)),
  );
  assert.equal(result._tag, "Failure");
  assert.equal(result.failure.code, "storage_unavailable");
  assert.equal(d1.ran.length, 2);
});

test("every other operation reads and writes the primary only", async () => {
  const d1 = fake({ rows: [] });
  const at = 10;
  const seen = {
    id: "row_1",
    userId: "user_alice",
    clientId: signOut.clientId,
    sid: signOut.sid,
    issuedAt: 1,
    agent: null,
    city: null,
    country: null,
    at,
  };
  const result = await use(d1.database, (store) =>
    Effect.all([
      store.record(seen, 60_000, 50),
      store.active("user_alice"),
      store.find("user_alice", "row_1"),
      store.revoke({
        userId: "user_alice",
        clientId: signOut.clientId,
        sid: null,
        at,
        expiresAt: at + 1,
      }),
      store.signedOut({ userId: "user_alice", clientId: signOut.clientId, sid: null, at }),
      store.signedOut({ userId: "user_alice", clientId: signOut.clientId, sid: signOut.sid, at }),
      store.name("user_alice", signOut.clientId, "Claude Code"),
      store.extend("user_alice", signOut.clientId, signOut.sid, at + 2, at + 1),
      store.prune(at, at, 100),
    ]),
  );
  assert.equal(result._tag, "Success");
  assert.ok(d1.ran.length >= 9);
  assert.deepEqual([...new Set(d1.ran.map((r) => r.mode))], ["first-primary"]);
  assert.deepEqual(d1.sessions, ["first-primary"]);
});
