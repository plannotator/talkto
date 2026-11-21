import { Clock, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { Cookies } from "effect/unstable/http";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { oauthProvider, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createLocalJWKSet, errors } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { run } from "@talkto/telemetry/effect";
import * as P from "@talkto/api/platform";
import * as G from "@talkto/api/guests";
import * as M from "@talkto/api/models";
import * as Model from "./platform/model.js";
import * as Platform from "./platform/service.js";
import type * as LocalIdentity from "./platform/local-identity.js";
import * as GuestsModel from "./guests/model.js";
import * as GuestsD1 from "./guests/d1.js";
import * as Browser from "./browser-auth.js";
import * as McpAuth from "./mcp-auth.js";
import * as Pages from "./better-auth-pages.js";
import * as Claim from "./better-auth-claim.js";
import * as Password from "./better-auth-password.js";
import * as Responses from "./responses.js";

/**
 * Self-host sign-in with Better Auth (docs/self-host-better-auth.md). People sign in with an email
 * and a password on this copy's own pages; agents sign in through this copy's own OAuth 2.1 server,
 * which Better Auth's OAuth provider plugin runs. Every record stays in the copy's D1 database:
 * Better Auth's in the `ba_` tables of migration 0024, people and organizations in the `local_`
 * tables that Cloudflare Access mode also uses. Refused unless the copy is self-hosted.
 */

/** Where Better Auth's own endpoints live. Only the OAuth ones are reachable from outside. */
export const basePath = "/auth/api";
/**
 * Better Auth's browser cookies. `__Host-` makes the browser keep them only when Secure, for this
 * host alone and for every path, so no subdomain can set or read them. HttpOnly, SameSite=Lax.
 */
const cookieNames = {
  session_token: "__Host-talkto.session_token",
  session_data: "__Host-talkto.session_data",
  account_data: "__Host-talkto.account_data",
  dont_remember: "__Host-talkto.dont_remember",
} as const;
export const sessionCookie = cookieNames.session_token;
/** How long an MCP access token lives. TALKTO_MCP_TOKEN_MAX_LIFETIME_SECONDS must be at least this. */
const accessTokenSeconds = 3600;
/** The largest client registration accepted, in bytes. */
const registrationBytes = 16 * 1024;
/** Unused dynamically registered clients are deleted after this long. */
const unusedClientMs = 24 * 60 * 60 * 1000;
/** ASCII only, so lowercasing can never fold two different addresses into one person. */
const asciiEmail = /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+\.[\x21-\x3f\x41-\x7e]+$/;
const Email = Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(asciiEmail));

const Raw = Schema.Struct({
  TALKTO_SELF_HOSTED: Schema.Literal("true"),
  TALKTO_AUTH_PROVIDER: Schema.Literal("better-auth"),
  BETTER_AUTH_SECRET: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(1024)),
  TALKTO_OWNER_EMAILS: Schema.String.check(Schema.isMaxLength(2600)),
});
const Owners = Schema.Array(Email).check(Schema.isMinLength(1), Schema.isMaxLength(10));

/** Parsed settings: the secret that signs and encrypts Better Auth's records, and the owners. */
export interface Settings {
  readonly secret: Redacted.Redacted<string>;
  /** Lowercased owners' addresses: their invitations are the ones that can create accounts. */
  readonly owners: ReadonlySet<string>;
}

const unconfigured = () =>
  new Model.Failure({
    code: "identity_unavailable",
    message:
      "Better Auth sign-in is misconfigured. On a self-hosted copy, set TALKTO_AUTH_PROVIDER to better-auth, TALKTO_OWNER_EMAILS to the owners' addresses, and the BETTER_AUTH_SECRET secret (at least 32 random characters).",
  });
const unauthenticated = (message = "Sign in to TalkTo.") =>
  new Model.Failure({ code: "unauthenticated", message });
const unavailable = () =>
  new Model.Failure({
    code: "identity_unavailable",
    message: "Sign-in is temporarily unavailable.",
  });

/** Read the settings. Better Auth is for self-hosted copies only, so talkto.sh can never use it. */
export const settings = Effect.fn("BetterAuth.settings")(function* (env: Env) {
  const raw = yield* Schema.decodeUnknownEffect(Raw)(env).pipe(Effect.mapError(unconfigured));
  const owners = yield* Schema.decodeUnknownEffect(Owners)(
    raw.TALKTO_OWNER_EMAILS.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  ).pipe(Effect.mapError(unconfigured));
  return {
    secret: Redacted.make(raw.BETTER_AUTH_SECRET),
    owners: new Set(owners.map((value) => value.toLowerCase())),
  } satisfies Settings;
});

/**
 * The only Better Auth endpoints a request from outside can reach, with their methods. Signing in,
 * signing up and consent go through TalkTo's own pages, which call Better Auth themselves.
 */
const publicEndpoints: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  [`${basePath}/oauth2/authorize`, ["GET"]],
  [`${basePath}/oauth2/token`, ["POST"]],
  [`${basePath}/oauth2/register`, ["POST"]],
  [`${basePath}/oauth2/revoke`, ["POST"]],
  [`${basePath}/oauth2/introspect`, ["POST"]],
  [`${basePath}/oauth2/userinfo`, ["GET", "POST"]],
  [`${basePath}/jwks`, ["GET"]],
  ["/.well-known/oauth-authorization-server", ["GET", "HEAD"]],
  ["/.well-known/openid-configuration", ["GET", "HEAD"]],
]);

const tables = {
  oauthClient: { modelName: "ba_oauth_client" },
  oauthResource: { modelName: "ba_oauth_resource" },
  oauthClientResource: { modelName: "ba_oauth_client_resource" },
  oauthRefreshToken: { modelName: "ba_oauth_refresh_token" },
  oauthAccessToken: { modelName: "ba_oauth_access_token" },
  oauthConsent: { modelName: "ba_oauth_consent" },
  oauthClientAssertion: { modelName: "ba_oauth_client_assertion" },
} as const;

/** What account creation needs from the rest of TalkTo. */
interface Admission {
  /**
   * The TalkTo ID a new account for this address gets, or null when the codes it presents do not
   * allow one. An address is never proven by itself here: only an account link reuses an existing
   * person's ID, and an invitation counts only when an owner sent it to a new address.
   */
  readonly admit: (email: string, codes: Codes) => Promise<P.UserId | null>;
  /** Record a new account's person, and accept the one organization invitation it presented. */
  readonly created: (email: string, id: P.UserId, name: string, codes: Codes) => Promise<void>;
}

/** The codes a sign-up form may carry. */
const Codes = Schema.Struct({
  invitation: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  claim: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(600))),
});
type Codes = typeof Codes.Type;
const decodeCodes = Schema.decodeUnknownOption(Codes);
const noCodes: Codes = {};
/**
 * One answer for every refused account, whether the address already has one or the link does not
 * fit it, so the page never tells a stranger which addresses have accounts here.
 */
const refusedSignUp =
  "This account could not be created. Open the link you were sent, with the address it was sent to. If you already have an account here, sign in instead.";
const passwords = Password.make();
const randomUserId = () => P.UserId.make(`user_${crypto.randomUUID().replaceAll("-", "")}`);

const instance = (database: D1Database, settings: Settings, origin: string, admission: Admission) =>
  betterAuth({
    appName: "TalkTo",
    baseURL: origin,
    basePath,
    secret: Redacted.value(settings.secret),
    database,
    telemetry: { enabled: false },
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      password: passwords,
      // No email leaves this copy: an account link or an owner's invitation vouches for an address.
      requireEmailVerification: false,
    },
    user: { modelName: "ba_user" },
    session: {
      modelName: "ba_session",
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    account: { modelName: "ba_account" },
    verification: { modelName: "ba_verification" },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "ba_rate_limit",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/oauth2/register": { window: 60, max: 10 },
        "/oauth2/token": { window: 60, max: 60 },
      },
    },
    advanced: {
      // The names carry `__Host-` themselves; Better Auth's own prefix would make them `__Secure-`.
      useSecureCookies: false,
      defaultCookieAttributes: { secure: true, path: "/" },
      cookies: {
        session_token: { name: cookieNames.session_token },
        session_data: { name: cookieNames.session_data },
        account_data: { name: cookieNames.account_data },
        dont_remember: { name: cookieNames.dont_remember },
      },
      // Cloudflare sets this header itself; a client cannot choose its own rate-limit key.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    disabledPaths: ["/token"],
    databaseHooks: {
      user: {
        create: {
          // The one door to a new account, whichever endpoint asked: the code it presents
          // (see Admission.admit).
          before: async (user, context) => {
            const email = user.email.toLowerCase();
            if (!asciiEmail.test(email) || email.length > 254)
              throw new APIError("BAD_REQUEST", {
                message: "Use an email address written in plain ASCII letters, digits and symbols.",
              });
            const id = await admission.admit(
              email,
              Option.getOrElse(decodeCodes(context?.body), () => noCodes),
            );
            if (id === null) throw new APIError("FORBIDDEN", { message: refusedSignUp });
            return { data: { ...user, id, email, emailVerified: true } };
          },
          after: async (user, context) => {
            const id = Schema.decodeUnknownOption(P.UserId)(user.id);
            if (Option.isSome(id))
              await admission.created(
                user.email,
                id.value,
                user.name,
                Option.getOrElse(decodeCodes(context?.body), () => noCodes),
              );
          },
        },
      },
    },
    plugins: [
      // Access tokens are RS256 JWTs for `<origin>/mcp`, verified in-process by mcp-auth.ts. The
      // plugin's own session-token route stays off so no other token shares the signing key.
      jwt({
        disableSettingJwtHeader: true,
        jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
        jwt: { issuer: origin },
        schema: { jwks: { modelName: "ba_jwks" } },
      }),
      oauthProvider({
        loginPage: "/auth/sign-in",
        consentPage: "/auth/consent",
        scopes: ["openid", "profile", "email", "offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: accessTokenSeconds,
        // MCP clients register themselves (RFC 7591) with no prior relationship. Each one still
        // needs a signed-in person's consent before it gets a token.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
        resources: [`${origin}/mcp`],
        clientRegistrationDefaultResources: [`${origin}/mcp`],
        // A retried refresh within this window gets the same rotated answer, as MCP clients need.
        refreshTokenReuseInterval: 30,
        schema: tables,
      }),
    ],
  });
type Instance = ReturnType<typeof instance>;

const ReturnPath = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^\/(?:app(?:\/[A-Za-z0-9/_-]*)?|onboarding)(?:\?[^\\\r\n#]*)?$/),
);
const SignInForm = Schema.Struct({
  email: Schema.String.check(Schema.isMaxLength(254)),
  password: Schema.String.check(Schema.isMaxLength(256)),
  return_to: Schema.optionalKey(Schema.String),
  oauth_query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
});
const SignUpForm = Schema.Struct({
  ...SignInForm.fields,
  name: Schema.String.check(Schema.isMaxLength(120)),
  invitation: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  claim: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(600))),
});
const ConsentForm = Schema.Struct({
  accept: Schema.Literals(["yes", "no"]),
  oauth_query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
});
const Continuation = Schema.Struct({
  redirect: Schema.optionalKey(Schema.Boolean),
  url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
});
const ErrorBody = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
});
const ClientRow = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  disabled: Schema.NullOr(Schema.Number),
});
const ConsentRow = Schema.Struct({
  id: Schema.String,
  clientId: Model.McpClient.fields.clientId,
  name: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

/**
 * A request body of at most `limit` bytes, or null for a larger one, whatever Content-Length
 * claimed. It stops reading, and cancels the rest, as soon as the limit is passed.
 */
const capped = async (request: Request, limit: number) => {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    size += read.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(read.value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
};

/** The `return_to` page, or the dashboard when it is missing or not one of this site's pages. */
const returnPath = (value: string | null | undefined) =>
  Option.getOrElse(Schema.decodeUnknownOption(ReturnPath)(value), () => "/app");
/** A server invitation's code, when the page to return to is its join page. */
const joinCode = (returnTo: string) =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(G.InvitationId)(/^\/app\/join\/([^/?]+)/.exec(returnTo)?.[1]),
  );

/** What TalkTo's pages send Better Auth to sign in or create an account. */
interface Credentials {
  readonly email: string;
  readonly password: string;
  name?: string;
  /** The invitation code that lets this address create an account. */
  invitation?: string;
  /** An account link's code, made with the secret. */
  claim?: string;
  /** The signed request of the agent's sign-in this continues. */
  oauth_query?: string;
}
/** What the consent page sends Better Auth. */
interface ConsentCall {
  readonly accept: boolean;
  readonly oauth_query: string;
}
/** Every body TalkTo sends Better Auth; signing out sends none. */
type CallBody = Credentials | ConsentCall | Readonly<Record<never, never>>;

/** Everything the hosted Worker needs from Better Auth mode. */
export interface BetterAuth {
  readonly browser: Browser.Authentication;
  /** The website session behind a dashboard or API request. */
  readonly verify: (
    request: Request,
  ) => Effect.Effect<
    { readonly actor: Model.Actor; readonly website: boolean; readonly setCookies: string[] },
    Model.Failure
  >;
  readonly mcp: McpAuth.Authentication;
  readonly identity: Platform.Identity["Service"];
  /** The minute cron's cleanup of expired sessions, tokens and never-used client registrations. */
  readonly maintain: Effect.Effect<void, Model.Failure>;
  /**
   * Better Auth's start-up, which it begins when built. Await it in the request that built this,
   * before keeping it for the isolate: on Workers, a promise whose I/O began in one request never
   * settles when awaited from another, so a request that answered without touching Better Auth
   * (a 404, a missing cookie) would leave every later request hanging.
   */
  readonly ready: Effect.Effect<void, Model.Failure>;
}

/** Build Better Auth mode for one isolate. */
export const make = (
  env: Env,
  configured: Settings,
  origin: string,
  store: ReturnType<typeof LocalIdentity.make>,
): BetterAuth => {
  const db = env.PLATFORM.withSession("first-primary");
  const sql = (query: string, values: ReadonlyArray<string | number | null> = []) =>
    db.prepare(query).bind(...values);
  const query = <S extends Schema.Top>(
    schema: S,
    statement: string,
    values: ReadonlyArray<string | number | null> = [],
  ) =>
    Effect.tryPromise({ try: () => sql(statement, values).all(), catch: unavailable }).pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
          Effect.mapError(unavailable),
        ),
      ),
    );
  const now = Clock.currentTimeMillis.pipe(
    Effect.map((ms) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)))),
  );

  /** Whether an owner's open invitation was sent to this address with this code. */
  const ownerInvited = Effect.fn("BetterAuth.ownerInvited")(function* (
    code: string,
    email: string,
  ) {
    const at = yield* now;
    const inviterOf = (inviter: string) =>
      query(Schema.Struct({ email: Schema.String }), `SELECT email FROM local_users WHERE id=?`, [
        inviter,
      ]).pipe(Effect.map((rows) => configured.owners.has(rows[0]?.email ?? "")));
    const organization = Schema.decodeUnknownOption(P.InvitationId)(code);
    if (Option.isSome(organization)) {
      const found = (yield* query(
        Schema.Struct({ email: Schema.String, inviter_id: Schema.String }),
        `SELECT email, inviter_id FROM local_invitations WHERE id=? AND state='pending' AND expires_at>?`,
        [organization.value, at],
      ))[0];
      return found !== undefined && found.email === email && (yield* inviterOf(found.inviter_id));
    }
    const server = Schema.decodeUnknownOption(G.InvitationId)(code);
    if (Option.isNone(server)) return false;
    const found = yield* GuestsModel.Store.use((guests) => guests.find(server.value)).pipe(
      Effect.provide(GuestsD1.layer(env.PLATFORM)),
    );
    return (
      found !== null &&
      found.state === "pending" &&
      found.expiresAt > at &&
      found.live === 1 &&
      GuestsModel.emailKey(found.email) === email &&
      (yield* inviterOf(found.inviterId))
    );
  });
  /** Spend an account link's nonce; false when it was already used. */
  const spend = Effect.fn("BetterAuth.spend")(function* (claim: Claim.Claim) {
    const at = yield* now;
    const result = yield* Effect.tryPromise({
      try: () =>
        sql(
          `INSERT INTO ba_verification(id,identifier,value,expiresAt,createdAt,updatedAt)
           VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
          [
            `claim_${claim.nonce}`,
            "talkto-account-link",
            claim.email,
            new Date(claim.expiresAt * 1000).toISOString(),
            at,
            at,
          ],
        ).run(),
      catch: unavailable,
    });
    return result.meta.changes === 1;
  });
  const admit = Effect.fn("BetterAuth.admit")(function* (email: string, codes: Codes) {
    const existing = yield* store.signIns.existing(email);
    if (codes.claim !== undefined) {
      const code = codes.claim;
      const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const claim = yield* Effect.promise(() =>
        Claim.read(code, email, Redacted.value(configured.secret), seconds),
      );
      if (claim === null || !(yield* spend(claim))) return null;
      // The one way to become an existing person: a link made with the secret.
      return existing ?? randomUserId();
    }
    // An invitation creates a new person only. A missing account for a known address (after a
    // password reset, or a switch from Cloudflare Access) needs an account link instead.
    if (codes.invitation === undefined || existing !== null) return null;
    return (yield* ownerInvited(codes.invitation, email)) ? randomUserId() : null;
  });
  const created = Effect.fn("BetterAuth.created")(function* (
    email: string,
    id: P.UserId,
    name: string,
    codes: Codes,
  ) {
    const known = yield* store.signIns.record(email, { id, name });
    // The presented organization invitation, and no other invitation sent to this address.
    const invitation = Schema.decodeUnknownOption(P.InvitationId)(codes.invitation);
    if (known === id && Option.isSome(invitation))
      yield* store.signIns.acceptInvitation(id, email, invitation.value);
  });
  const auth: Instance = instance(env.PLATFORM, configured, origin, {
    admit: (email, codes) => run(admit(email, codes)),
    created: (email, id, name, codes) => run(created(email, id, name, codes)),
  });

  /** Call one of Better Auth's endpoints from this Worker, as the browser that asked. */
  const call = (path: string, request: Request, body: CallBody) => {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json",
      origin,
    });
    for (const name of ["cookie", "cf-connecting-ip", "user-agent"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return Effect.tryPromise({
      try: () =>
        auth.handler(
          new Request(`${origin}${basePath}${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          }),
        ),
      catch: unavailable,
    });
  };
  const errorOf = Effect.fn("BetterAuth.errorOf")(function* (response: Response) {
    const text = yield* Effect.promise(() => response.text());
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))(text);
    return Option.isSome(parsed) ? parsed.value : { code: undefined, message: undefined };
  });
  const continuation = Effect.fn("BetterAuth.continuation")(function* (response: Response) {
    const text = yield* Effect.promise(() => response.text());
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Continuation))(text);
    if (Option.isNone(parsed) || parsed.value.redirect !== true || parsed.value.url === undefined)
      return null;
    return new URL(parsed.value.url, origin).href;
  });
  const redirect = (location: string, cookies: ReadonlyArray<string> = []) => {
    const headers = new Headers({
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    for (const value of cookies) headers.append("set-cookie", value);
    return new Response(null, { status: 303, headers });
  };
  const form = Effect.fn("BetterAuth.form")(function* (request: Request) {
    const text = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: () => unauthenticated("The form could not be read. Reload the page."),
    });
    if (text.length > 32768) return yield* unauthenticated("The form is too large.");
    return Object.fromEntries(new URLSearchParams(text));
  });
  const signedIn = Effect.fn("BetterAuth.signedIn")(function* (request: Request) {
    const found = yield* Effect.tryPromise({
      try: () => auth.api.getSession({ headers: request.headers, returnHeaders: true }),
      catch: unavailable,
    });
    return { session: found.response, setCookies: found.headers.getSetCookie() };
  });
  const verified = (oauthQuery: string) =>
    Effect.tryPromise({
      try: () => verifyOAuthQueryParams(oauthQuery, Redacted.value(configured.secret)),
      catch: unavailable,
    });
  /**
   * Client registration, with its body read once and capped: client metadata is small, and an
   * open endpoint must not make Better Auth parse and store megabytes.
   */
  const register = Effect.fn("BetterAuth.register")(function* (request: Request) {
    const tooLarge = () =>
      Response.json(
        {
          error: "invalid_client_metadata",
          error_description: `Client metadata must be at most ${registrationBytes} bytes.`,
        },
        { status: 413, headers: { "cache-control": "no-store" } },
      );
    const body = yield* Effect.tryPromise({
      try: () => capped(request, registrationBytes),
      catch: unavailable,
    });
    if (body === null) return tooLarge();
    return yield* Effect.tryPromise({
      try: () =>
        auth.handler(new Request(request.url, { method: "POST", headers: request.headers, body })),
      catch: unavailable,
    });
  });
  /**
   * The authorize endpoint's answer, without its error redirects. Better Auth sends an invalid
   * request back to the client's registered address with an `error`, before anyone signs in;
   * since anyone can register any address, that made TalkTo an open redirector. Such errors are
   * shown on a TalkTo page instead. Redirects to the sign-in and consent pages, and to the client
   * with a code, pass.
   */
  const authorized = Effect.fn("BetterAuth.authorized")(function* (response: Response) {
    const located = response.headers.get("location");
    const text = located === null ? yield* Effect.promise(() => response.text()) : "";
    const target =
      located !== null
        ? located
        : (Option.getOrUndefined(
            Schema.decodeUnknownOption(Schema.fromJsonString(Continuation))(text),
          )?.url ?? null);
    const destination = target === null ? null : URL.parse(target, origin);
    // An implicit-flow error comes back in the fragment instead of the query.
    const error =
      destination?.searchParams.get("error") ??
      new URLSearchParams(destination?.hash.slice(1) ?? "").get("error");
    if (error !== null)
      return Pages.message(
        "This sign-in cannot start",
        `The agent app sent a sign-in request TalkTo cannot accept (${error.slice(0, 60)}). Start again from the app, or update it.`,
        400,
      );
    return located !== null ? response : new Response(text, response);
  });
  /** The organization an open invitation to this address joins, or null. */
  const invitedTo = Effect.fn("BetterAuth.invitedTo")(function* (
    email: string,
    invitation: P.InvitationId,
  ) {
    const at = yield* now;
    const found = yield* query(
      Schema.Struct({ name: Schema.String }),
      `SELECT o.name FROM local_invitations i JOIN local_organizations o ON o.id=i.organization_id
       WHERE i.id=? AND i.email=? AND i.state='pending' AND i.expires_at>?`,
      [invitation, email.toLowerCase(), at],
    );
    return found[0]?.name ?? null;
  });
  const misfit = () =>
    Pages.message(
      "This invitation does not fit this account",
      "It may have been cancelled, have expired, or have been sent to another address. Ask whoever invited you for a new link.",
      400,
    );
  /** Accept one organization invitation for a signed-in account, if it was sent to its address. */
  const accepted = Effect.fn("BetterAuth.accepted")(function* (
    user: { readonly id: string; readonly email: string },
    invitation: P.InvitationId,
  ) {
    const id = Schema.decodeUnknownOption(P.UserId)(user.id);
    if (Option.isNone(id)) return false;
    return yield* store.signIns.acceptInvitation(id.value, user.email, invitation);
  });
  const expired = () =>
    Pages.message("This sign-in link expired", "Start signing in again from your agent app.", 400);
  /** The signed OAuth request a page was opened with, or null outside an agent's sign-in. */
  const oauthQueryOf = (url: URL) => {
    if (!url.searchParams.has("sig")) return null;
    // The page's own parameters are not part of the signed request.
    const signed = new URLSearchParams(url.searchParams);
    for (const name of ["create", "account", "invitation", "claim", "return_to"])
      signed.delete(name);
    return signed.toString();
  };

  const route = Effect.fn("BetterAuth.route")(function* (request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const meta = Responses.metadata(origin);
    const allowed = publicEndpoints.get(path);
    if (allowed !== undefined) {
      if (!allowed.includes(request.method))
        return new Response(null, { status: 405, headers: { allow: allowed.join(", ") } });
      if (path === `${basePath}/oauth2/register`) return yield* register(request);
      const answered = yield* Effect.tryPromise({
        try: () => auth.handler(request),
        catch: unavailable,
      });
      return path === `${basePath}/oauth2/authorize` ? yield* authorized(answered) : answered;
    }
    if (path.startsWith(`${basePath}/`) || path === "/auth/callback")
      return Responses.failure(404, "not_found", "This sign-in path does not exist.", meta);
    if (path === "/auth/login" && request.method === "GET") {
      const returnTo = returnPath(url.searchParams.get("return_to"));
      const current = yield* signedIn(request);
      if (current.session !== null) return redirect(`${origin}${returnTo}`, current.setCookies);
      return redirect(`${origin}/auth/sign-in?${new URLSearchParams({ return_to: returnTo })}`);
    }
    if (path === "/auth/logout" && request.method === "POST") {
      yield* Browser.checkOrigin(request, origin);
      const ended = yield* call("/sign-out", request, {});
      const cookies = ended.headers.getSetCookie();
      // Without a session there is nothing to end; clear the cookie all the same.
      if (cookies.length === 0)
        cookies.push(`${sessionCookie}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
      return redirect(`${origin}/`, cookies);
    }
    if (path === "/auth/sign-in" && request.method === "GET") {
      const returnTo = returnPath(url.searchParams.get("return_to"));
      const oauthQuery = oauthQueryOf(url);
      const invitation = url.searchParams.get("invitation") ?? joinCode(returnTo) ?? null;
      const claim = url.searchParams.get("claim");
      if (oauthQuery === null) {
        const current = yield* signedIn(request);
        if (current.session !== null) {
          // Someone who already has an account opens an organization invitation's link. A GET
          // only asks: any site can make a browser open this address with its cookie, so joining
          // waits for the person to press Join, a POST from this site.
          const organization = Schema.decodeUnknownOption(P.InvitationId)(invitation);
          if (Option.isNone(organization))
            return redirect(`${origin}${returnTo}`, current.setCookies);
          const name = yield* invitedTo(current.session.user.email, organization.value);
          if (name === null) return misfit();
          return Pages.join({
            organization: name,
            email: current.session.user.email,
            invitation: organization.value,
            returnTo,
          });
        }
      } else if (!(yield* verified(oauthQuery))) return expired();
      return Pages.signIn({
        returnTo,
        oauthQuery,
        invitation,
        claim,
        email: claim === null ? "" : (Claim.addressOf(claim) ?? ""),
        name: "",
        error: null,
        mode:
          !url.searchParams.has("account") &&
          (invitation !== null || claim !== null || url.searchParams.has("create"))
            ? "sign-up"
            : "sign-in",
        status: 200,
      });
    }
    if ((path === "/auth/sign-in" || path === "/auth/sign-up") && request.method === "POST") {
      yield* Browser.checkOrigin(request, origin);
      const fields = yield* form(request);
      const signUp = path === "/auth/sign-up";
      const parsed = signUp
        ? Schema.decodeUnknownOption(SignUpForm)(fields)
        : Schema.decodeUnknownOption(SignInForm)(fields);
      const returnTo = returnPath(fields["return_to"]);
      const oauthQuery = fields["oauth_query"] || null;
      const invitation = fields["invitation"] || null;
      const claim = fields["claim"] || null;
      const again = (message: string, status: number) =>
        Pages.signIn({
          returnTo,
          oauthQuery,
          invitation,
          claim,
          email: fields["email"] ?? "",
          name: fields["name"] ?? "",
          error: message,
          mode: signUp ? "sign-up" : "sign-in",
          status,
        });
      if (Option.isNone(parsed)) return again("Fill in every field.", 400);
      const email = parsed.value.email.trim().toLowerCase();
      if (!asciiEmail.test(email))
        return again("Enter an email address in plain ASCII, like name@example.com.", 400);
      const body: Credentials = { email, password: parsed.value.password };
      if (oauthQuery !== null) body.oauth_query = oauthQuery;
      if (signUp) {
        const name = (fields["name"] ?? "").trim();
        if (name.length === 0) return again("Enter your name.", 400);
        body.name = name;
        if (invitation !== null) body.invitation = invitation;
        if (claim !== null) body.claim = claim;
      }
      const response = yield* call(signUp ? "/sign-up/email" : "/sign-in/email", request, body);
      if (response.status === 429)
        return again("Too many attempts. Wait a minute, then try again.", 429);
      if (!response.ok) {
        const error = yield* errorOf(response);
        if (response.status >= 500)
          return again("Sign-in is temporarily unavailable. Try again.", 503);
        if (!signUp && response.status === 401)
          return again("The email or password is wrong.", 401);
        // An existing account and a refused one look the same (see refusedSignUp).
        if (
          signUp &&
          (response.status === 403 ||
            error.code === "USER_ALREADY_EXISTS" ||
            error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")
        )
          return again(refusedSignUp, 403);
        // Better Auth refuses a signed agent request that expired or was changed.
        if (oauthQuery !== null && response.status === 400) return expired();
        if (!signUp) return again("Signing in did not work. Try again.", response.status);
        if (error.code === "PASSWORD_TOO_SHORT")
          return again("Use a password of at least 10 characters.", 400);
        if (error.code === "PASSWORD_TOO_LONG")
          return again("Use a password of at most 128 characters.", 400);
        return again(error.message ?? "The account could not be created.", 400);
      }
      const cookies = response.headers.getSetCookie();
      // Signing in from an organization invitation's link joins that organization, and only it.
      const organization = Schema.decodeUnknownOption(P.InvitationId)(invitation);
      if (!signUp && Option.isSome(organization)) {
        const id = yield* store.signIns.existing(email);
        if (id !== null) yield* store.signIns.acceptInvitation(id, email, organization.value);
      }
      const next = oauthQuery === null ? null : yield* continuation(response);
      return redirect(next ?? `${origin}${returnTo}`, cookies);
    }
    if (path === "/auth/join" && request.method === "POST") {
      yield* Browser.checkOrigin(request, origin);
      const fields = yield* form(request);
      const organization = Schema.decodeUnknownOption(P.InvitationId)(fields["invitation"]);
      const current = yield* signedIn(request);
      if (current.session === null)
        return redirect(
          `${origin}/auth/sign-in?${new URLSearchParams({ invitation: fields["invitation"] ?? "", account: "1" })}`,
        );
      if (
        Option.isNone(organization) ||
        !(yield* accepted(current.session.user, organization.value))
      )
        return misfit();
      return redirect(`${origin}${returnPath(fields["return_to"])}`, current.setCookies);
    }
    if (path === "/auth/consent" && request.method === "GET") {
      const oauthQuery = oauthQueryOf(url);
      if (oauthQuery === null || !(yield* verified(oauthQuery))) return expired();
      const current = yield* signedIn(request);
      if (current.session === null) return redirect(`${origin}/auth/sign-in?${oauthQuery}`);
      const clientId = url.searchParams.get("client_id") ?? "";
      const client = (yield* query(
        ClientRow,
        `SELECT name, disabled FROM ba_oauth_client WHERE clientId=?`,
        [clientId],
      ))[0];
      if (client === undefined || client.disabled === 1)
        return Pages.message(
          "This app is not registered",
          "Start signing in again from your agent app.",
          400,
        );
      return Pages.consent({
        app: client.name ?? "",
        email: current.session.user.email,
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        oauthQuery,
      });
    }
    if (path === "/auth/consent" && request.method === "POST") {
      yield* Browser.checkOrigin(request, origin);
      const parsed = Schema.decodeUnknownOption(ConsentForm)(yield* form(request));
      if (Option.isNone(parsed))
        return Pages.message(
          "Something was missing",
          "Start signing in again from your agent app.",
          400,
        );
      const response = yield* call("/oauth2/consent", request, {
        accept: parsed.value.accept === "yes",
        oauth_query: parsed.value.oauth_query,
      });
      if (response.status === 401)
        return redirect(`${origin}/auth/sign-in?${parsed.value.oauth_query}`);
      const next = response.ok ? yield* continuation(response) : null;
      if (next === null)
        return Pages.message(
          "This sign-in could not finish",
          "Start signing in again from your agent app.",
          400,
        );
      return redirect(next);
    }
    return new Response(null, {
      status: 405,
      headers: { allow: path === "/auth/logout" || path === "/auth/join" ? "POST" : "GET, POST" },
    });
  });

  const verify = Effect.fn("BetterAuth.verify")(function* (request: Request) {
    if (new URL(request.url).host !== new URL(origin).host) return yield* unauthenticated();
    const cookies = Cookies.parseHeader(request.headers.get("cookie") ?? "");
    if (cookies[sessionCookie] === undefined) return yield* unauthenticated("Sign in to TalkTo.");
    // A browser request that changes something must come from this site.
    yield* Browser.checkOrigin(request, origin);
    const current = yield* signedIn(request);
    if (current.session === null)
      return yield* unauthenticated("Your TalkTo sign-in ended. Sign in again.");
    const id = yield* Schema.decodeUnknownEffect(P.UserId)(current.session.user.id).pipe(
      Effect.mapError(() => unauthenticated()),
    );
    // Records the visit. It accepts no invitation: in this mode only a presented code does.
    const known = yield* store.signIns.record(current.session.user.email, {
      id,
      name: current.session.user.name,
    });
    if (known !== id)
      return yield* unauthenticated(
        "This sign-in does not match TalkTo's records for its address. Ask the owner to check it.",
      );
    return { actor: Model.actor(id), website: true, setCookies: current.setCookies };
  });

  // The copy's own signing keys, read in-process: no request leaves the Worker to verify a token.
  let keySet: { readonly at: number; readonly keys: JWTVerifyGetKey } | undefined;
  const loadKeys = async () => {
    const jwks = await auth.api.getJwks();
    keySet = { at: Date.now(), keys: createLocalJWKSet(jwks) };
    return keySet.keys;
  };
  const keys: JWTVerifyGetKey = async (header, token) => {
    const current = keySet?.keys ?? (await loadKeys());
    try {
      return await current(header, token);
    } catch (error) {
      // A key made since the last read: read again, at most every 30 seconds.
      if (error instanceof errors.JWKSNoMatchingKey && Date.now() - (keySet?.at ?? 0) > 30_000)
        return (await loadKeys())(header, token);
      throw error;
    }
  };

  const identity = Platform.Identity.of({
    ...store.identity,
    // Deleting an account also ends its password, browser sessions and agents' tokens.
    deleteUser: Effect.fn("BetterAuth.deleteUser")(function* (id) {
      yield* store.identity.deleteUser(id);
      yield* Effect.tryPromise({
        try: () =>
          db.batch([
            sql(`DELETE FROM ba_oauth_access_token WHERE userId=?`, [id]),
            sql(`DELETE FROM ba_oauth_refresh_token WHERE userId=?`, [id]),
            sql(`DELETE FROM ba_oauth_consent WHERE userId=?`, [id]),
            sql(`DELETE FROM ba_session WHERE userId=?`, [id]),
            sql(`DELETE FROM ba_account WHERE userId=?`, [id]),
            sql(`DELETE FROM ba_user WHERE id=?`, [id]),
          ]),
        catch: unavailable,
      });
    }),
    // An agent app the person consented to, named as it registered itself.
    authorizedApplications: Effect.fn("BetterAuth.authorizedApplications")(function* (userId) {
      const rows = yield* query(
        ConsentRow,
        `SELECT c.id, c.clientId, o.name, c.createdAt FROM ba_oauth_consent c
         JOIN ba_oauth_client o ON o.clientId=c.clientId WHERE c.userId=? ORDER BY c.createdAt LIMIT 200`,
        [userId],
      );
      return rows.flatMap((row) => {
        const created = Schema.decodeUnknownOption(M.Timestamp)(row.createdAt);
        return Option.toArray(
          Schema.decodeUnknownOption(Model.AuthorizedApplication)({
            // The sign-ins API names provider authorizations this way, whatever the provider.
            id: `authorized_connect_app_${row.id}`,
            applicationId: row.clientId,
            clientId: row.clientId,
            name: (row.name ?? "").slice(0, 200),
            createdAt: Option.getOrNull(created),
          }),
        );
      });
    }),
    // Signing an app out ends its consent and every token it holds for this person.
    revokeAuthorizedApplication: Effect.fn("BetterAuth.revokeAuthorizedApplication")(
      function* (userId, clientId) {
        yield* Effect.tryPromise({
          try: () =>
            db.batch([
              sql(`DELETE FROM ba_oauth_access_token WHERE userId=? AND clientId=?`, [
                userId,
                clientId,
              ]),
              sql(`DELETE FROM ba_oauth_refresh_token WHERE userId=? AND clientId=?`, [
                userId,
                clientId,
              ]),
              sql(`DELETE FROM ba_oauth_consent WHERE userId=? AND clientId=?`, [userId, clientId]),
            ]),
          catch: unavailable,
        });
      },
    ),
  });

  const maintain = Effect.gen(function* () {
    const at = yield* now;
    const ms = yield* Clock.currentTimeMillis;
    const before = DateTime.formatIso(DateTime.makeUnsafe(ms - unusedClientMs));
    yield* Effect.tryPromise({
      try: () =>
        db.batch([
          sql(`DELETE FROM ba_session WHERE expiresAt<?`, [at]),
          sql(`DELETE FROM ba_verification WHERE expiresAt<?`, [at]),
          sql(`DELETE FROM ba_oauth_access_token WHERE expiresAt<?`, [at]),
          sql(`DELETE FROM ba_oauth_refresh_token WHERE expiresAt<?`, [at]),
          sql(`DELETE FROM ba_oauth_client_assertion WHERE expiresAt<?`, [at]),
          sql(`DELETE FROM ba_rate_limit WHERE lastRequest<?`, [ms - unusedClientMs]),
          // A registration nobody consented to within a day: anyone can register, so these go.
          sql(
            `DELETE FROM ba_oauth_client WHERE userId IS NULL AND createdAt<? AND NOT EXISTS
             (SELECT 1 FROM ba_oauth_consent c WHERE c.clientId=ba_oauth_client.clientId)
             AND NOT EXISTS (SELECT 1 FROM ba_oauth_refresh_token r WHERE r.clientId=ba_oauth_client.clientId)`,
            [before],
          ),
        ]),
      catch: unavailable,
    });
  });

  return {
    browser: {
      route,
      // Never used: the hosted Worker reads Better Auth's session through `verify`.
      session: () => Effect.fail(unauthenticated()),
    },
    verify,
    mcp: {
      issuer: origin,
      verify: McpAuth.verifier(origin, [], `${origin}/mcp`, new Map(), () => keys),
    },
    identity,
    maintain,
    ready: Effect.tryPromise({ try: () => auth.$context, catch: unavailable }).pipe(Effect.asVoid),
  };
};
