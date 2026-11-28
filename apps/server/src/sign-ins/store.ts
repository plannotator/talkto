import { Context, Effect, Layer, Schema } from "effect";
import * as Model from "../platform/model.js";
import { describeFailure } from "../failure-log.js";
import * as Telemetry from "../telemetry.js";

/*
  Signed-in computers in D1 (platform migration 0019). `mcp_client_sessions` is one row per place
  an agent app signed in; `mcp_revocations` is what MCP authentication refuses. No token, IP address
  or email address is stored. Times are epoch milliseconds.
*/

type Value = string | number | null;
const storage = (cause?: unknown) =>
  Telemetry.withCause(
    new Model.Failure({
      code: "storage_unavailable",
      message: "Signed-in computers are temporarily unavailable. Try again.",
    }),
    cause,
  );

/** A recorded sign-in that is not signed out. */
export const Row = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  sid: Schema.NullOr(Schema.String),
  clientName: Schema.NullOr(Schema.String),
  agent: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.Number,
  lastSeenAt: Schema.Number,
});
/** Parsed sign-in row. */
export interface Row extends Schema.Schema.Type<typeof Row> {}

/**
 * A sign-out MCP authentication enforces. A null `sid` refuses every token of the client issued at
 * or before `revokedAt`; a `sid` refuses every token carrying it.
 */
export const Revocation = Schema.Struct({
  clientId: Schema.String,
  sid: Schema.NullOr(Schema.String),
  revokedAt: Schema.Number,
});
/** Parsed revocation. */
export interface Revocation extends Schema.Schema.Type<typeof Revocation> {}

/** One MCP request's facts, recorded at most once per throttle interval per sign-in. */
export interface Seen {
  /** The ID a new row gets; ignored when the sign-in already has one. */
  readonly id: string;
  readonly userId: string;
  readonly clientId: string;
  readonly sid: string | null;
  /** When the token was issued, epoch milliseconds. A signed-out row revives only for a newer one. */
  readonly issuedAt: number;
  readonly agent: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly at: number;
}

type Operation<A> = Effect.Effect<A, Model.Failure>;
/** Storage for signed-in computers. */
export class Store extends Context.Service<
  Store,
  {
    /**
     * Record a request. Writes the row only if it is new, last written `throttle` ms ago or more,
     * or signed out and no longer refused. A person keeps at most `cap` rows.
     */
    readonly record: (seen: Seen, throttle: number, cap: number) => Operation<void>;
    /** The person's revocations still in force at `now`. */
    readonly revocations: (userId: string, now: number) => Operation<ReadonlyArray<Revocation>>;
    /** The person's sign-ins that are not signed out, most recently active first. */
    readonly active: (userId: string) => Operation<ReadonlyArray<Row>>;
    /** One of the person's sign-ins that is not signed out; null for anyone else's. */
    readonly find: (userId: string, id: string) => Operation<Row | null>;
    /** Write or renew a revocation. */
    readonly revoke: (input: {
      readonly userId: string;
      readonly clientId: string;
      readonly sid: string | null;
      readonly at: number;
      readonly expiresAt: number;
    }) => Operation<void>;
    /**
     * Mark sign-ins signed out: one `sid`, or every sign-in of the client when `sid` is null. The
     * client-wide form also drops the client's per-`sid` revocations, which it supersedes.
     */
    readonly signedOut: (input: {
      readonly userId: string;
      readonly clientId: string;
      readonly sid: string | null;
      readonly at: number;
    }) => Operation<void>;
    /** Remember the app name WorkOS gave a client, for when WorkOS cannot be asked. */
    readonly name: (userId: string, clientId: string, name: string) => Operation<void>;
    /** Keep a per-`sid` revocation in force while its sign-in still tries to connect. */
    readonly extend: (
      userId: string,
      clientId: string,
      sid: string,
      expiresAt: number,
      before: number,
    ) => Operation<void>;
    /** Delete up to `limit` rows unseen since `unseenBefore` and revocations expired at `now`. */
    readonly prune: (
      unseenBefore: number,
      now: number,
      limit: number,
    ) => Operation<{ readonly sessions: number; readonly revocations: number }>;
  }
>()("@talkto/sign-ins/Store") {}

const rowColumns =
  "id,client_id AS clientId,sid,client_name AS clientName,agent,city,country,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt";
/** Tokens a revocation refuses: ?2 user, ?3 client, ?4 sid, ?9 token issue time. */
const refused =
  "EXISTS(SELECT 1 FROM mcp_revocations r WHERE r.user_id=?2 AND r.client_id=?3 AND ((r.sid IS NULL AND r.revoked_at>=?9) OR r.sid=?4))";

/**
 * The D1 store. The session and every statement are made inside the attempted operation, so a
 * broken binding is a storage failure (which MCP admission tolerates), never a defect.
 */
export const layer = (database: D1Database) =>
  Layer.sync(Store, () => {
    let session: D1DatabaseSession | undefined;
    const db = () => (session ??= database.withSession("first-primary"));
    const sql =
      (query: string, values: ReadonlyArray<Value> = []) =>
      () =>
        db()
          .prepare(query)
          .bind(...values);
    const run = (statement: () => D1PreparedStatement) =>
      Effect.tryPromise({ try: () => statement().run(), catch: storage });
    const decoded = <A>(schema: Schema.Decoder<A>, result: D1Result) =>
      Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
        Effect.mapError(() => storage()),
      );
    const all = <A>(schema: Schema.Decoder<A>, statement: () => D1PreparedStatement) =>
      Effect.tryPromise({ try: () => statement().all(), catch: storage }).pipe(
        Effect.flatMap((result) => decoded(schema, result)),
      );
    /*
      The sign-out check runs on every MCP request, so it reads the nearest read replica (Sentry
      TALKTO-SERVER-C: the primary's hiccups all hit this read). A fresh session per read, so it
      never shares the primary session's bookmark. A failed replica read is tried once more, at
      once, on the primary, then fails as before: a bad replica is never worse than no replica. The
      fallback only logs, so a flaky replica does not page. Without read replication on the
      database, `first-unconstrained` reads the primary too.
    */
    const replicaFirst = <A>(
      schema: Schema.Decoder<A>,
      query: string,
      values: ReadonlyArray<Value>,
    ) =>
      Effect.tryPromise({
        try: () =>
          database
            .withSession("first-unconstrained")
            .prepare(query)
            .bind(...values)
            .all(),
        catch: (cause) => cause,
      }).pipe(
        Effect.matchEffect({
          onSuccess: (result) => decoded(schema, result),
          onFailure: (cause) =>
            Effect.sync(() =>
              console.warn(
                "sign-ins: the sign-out check failed on a read replica; reading the primary",
                describeFailure(cause),
              ),
            ).pipe(Effect.andThen(all(schema, sql(query, values)))),
        }),
      );
    return Store.of({
      record: (seen, throttle, cap) =>
        run(
          sql(
            `INSERT INTO mcp_client_sessions(id,user_id,client_id,sid,agent,city,country,first_seen_at,last_seen_at)
             SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?8 WHERE NOT ${refused}
              AND ((SELECT COUNT(*) FROM mcp_client_sessions WHERE user_id=?2)<?11
               OR EXISTS(SELECT 1 FROM mcp_client_sessions WHERE user_id=?2 AND client_id=?3 AND COALESCE(sid,'')=COALESCE(?4,'')))
             ON CONFLICT(user_id,client_id,COALESCE(sid,'')) DO UPDATE SET
              last_seen_at=excluded.last_seen_at,
              agent=COALESCE(excluded.agent,mcp_client_sessions.agent),
              city=CASE WHEN excluded.country IS NULL THEN mcp_client_sessions.city ELSE excluded.city END,
              country=COALESCE(excluded.country,mcp_client_sessions.country),
              first_seen_at=CASE WHEN mcp_client_sessions.signed_out_at IS NULL THEN mcp_client_sessions.first_seen_at ELSE excluded.first_seen_at END,
              signed_out_at=NULL
             WHERE mcp_client_sessions.signed_out_at IS NOT NULL OR mcp_client_sessions.last_seen_at<=excluded.last_seen_at-?10`,
            [
              seen.id,
              seen.userId,
              seen.clientId,
              seen.sid,
              seen.agent,
              seen.city,
              seen.country,
              seen.at,
              seen.issuedAt,
              throttle,
              cap,
            ],
          ),
        ).pipe(Effect.asVoid),
      revocations: (userId, now) =>
        replicaFirst(
          Revocation,
          "SELECT client_id AS clientId,sid,revoked_at AS revokedAt FROM mcp_revocations WHERE user_id=? AND expires_at>?",
          [userId, now],
        ),
      active: (userId) =>
        all(
          Row,
          sql(
            `SELECT ${rowColumns} FROM mcp_client_sessions WHERE user_id=? AND signed_out_at IS NULL ORDER BY last_seen_at DESC LIMIT 200`,
            [userId],
          ),
        ),
      find: (userId, id) =>
        all(
          Row,
          sql(
            `SELECT ${rowColumns} FROM mcp_client_sessions WHERE id=? AND user_id=? AND signed_out_at IS NULL`,
            [id, userId],
          ),
        ).pipe(Effect.map((rows) => rows[0] ?? null)),
      revoke: (input) =>
        run(
          sql(
            `INSERT INTO mcp_revocations(user_id,client_id,sid,revoked_at,expires_at) VALUES(?,?,?,?,?)
             ON CONFLICT(user_id,client_id,COALESCE(sid,'')) DO UPDATE SET
              revoked_at=excluded.revoked_at,expires_at=MAX(mcp_revocations.expires_at,excluded.expires_at)`,
            [input.userId, input.clientId, input.sid, input.at, input.expiresAt],
          ),
        ).pipe(Effect.asVoid),
      signedOut: (input) =>
        input.sid === null
          ? Effect.tryPromise({
              try: () =>
                db().batch([
                  sql(
                    "UPDATE mcp_client_sessions SET signed_out_at=? WHERE user_id=? AND client_id=? AND signed_out_at IS NULL",
                    [input.at, input.userId, input.clientId],
                  )(),
                  sql(
                    "DELETE FROM mcp_revocations WHERE user_id=? AND client_id=? AND sid IS NOT NULL",
                    [input.userId, input.clientId],
                  )(),
                ]),
              catch: storage,
            }).pipe(Effect.asVoid)
          : run(
              sql(
                "UPDATE mcp_client_sessions SET signed_out_at=? WHERE user_id=? AND client_id=? AND sid=? AND signed_out_at IS NULL",
                [input.at, input.userId, input.clientId, input.sid],
              ),
            ).pipe(Effect.asVoid),
      name: (userId, clientId, name) =>
        run(
          sql(
            "UPDATE mcp_client_sessions SET client_name=? WHERE user_id=? AND client_id=? AND client_name IS NOT ?",
            [name, userId, clientId, name],
          ),
        ).pipe(Effect.asVoid),
      extend: (userId, clientId, sid, expiresAt, before) =>
        run(
          sql(
            "UPDATE mcp_revocations SET expires_at=? WHERE user_id=? AND client_id=? AND sid=? AND expires_at<?",
            [expiresAt, userId, clientId, sid, before],
          ),
        ).pipe(Effect.asVoid),
      prune: (unseenBefore, now, limit) =>
        Effect.tryPromise({
          try: () =>
            db().batch([
              sql(
                "DELETE FROM mcp_client_sessions WHERE rowid IN (SELECT rowid FROM mcp_client_sessions WHERE last_seen_at<? LIMIT ?)",
                [unseenBefore, limit],
              )(),
              sql(
                "DELETE FROM mcp_revocations WHERE rowid IN (SELECT rowid FROM mcp_revocations WHERE expires_at<=? LIMIT ?)",
                [now, limit],
              )(),
            ]),
          catch: storage,
        }).pipe(
          Effect.map(([sessions, revocations]) => ({
            sessions: sessions?.meta.changes ?? 0,
            revocations: revocations?.meta.changes ?? 0,
          })),
        ),
    });
  });
