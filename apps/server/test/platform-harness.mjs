import { rpc } from "./mcp-wire.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

/**
 * Run `task(0)` … `task(count - 1)`, `width` at a time. Each task is still a whole real request;
 * a loaded machine's wait between round trips is paid once per `width` of them, not once each.
 */
export async function concurrently(count, width, task) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, count) }, async () => {
      while (next < count) await task(next++);
    }),
  );
}

/** Real Worker/D1/DO harness with a controlled external identity provider. */
export async function start(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "talkto-platform-"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = { keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }] };
  // A previous AuthKit hostname still accepted during a domain switch, with its own signing key.
  const alias = await generateKeyPair("RS256");
  const aliasKeys = {
    keys: [{ ...(await exportJWK(alias.publicKey)), kid: "alias", alg: "RS256" }],
  };
  const jwksFetches = [];
  const codes = new Map();
  const refreshTokens = new Map();
  const provider = { refreshStatus: 200, exchanges: 0 };
  const webhookSecret = `whsec_${randomBytes(32).toString("hex")}`;
  const userRecord = (user) => ({
    object: "user",
    id: user,
    email: `${user}@example.com`,
    email_verified: true,
    first_name: user.slice(5),
    last_name: null,
    profile_picture_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_sign_in_at: null,
    external_id: null,
    metadata: {},
  });
  const build = fileURLToPath(
    new URL(
      options.telemetry ? "../dist/telemetry-test" : "../dist/platform-test",
      import.meta.url,
    ),
  );
  const files = await readdir(build);
  const provisioning = {};
  if (!options.provisioningMissing) {
    provisioning.TALKTO_UNPAID_SERVER_LIMIT = String(
      options.unpaidServers ?? (options.trials ? 1 : 10000),
    );
    provisioning.TALKTO_SERVER_CREATIONS_PER_HOUR = String(options.serversPerHour ?? 10000);
    provisioning.TALKTO_ORGANIZATION_CREATIONS_PER_HOUR = String(
      options.organizationsPerHour ?? 10000,
    );
    provisioning.TALKTO_UNPAID_SERVER_DAILY_LIMIT = String(options.unpaidServersPerDay ?? 10000);
  }
  // The free start stays off unless a test opts in, matching every deployment's default.
  const starter = {};
  if (options.starter) {
    starter.TALKTO_STARTER_ADMISSIONS_ENABLED = "true";
    starter.TALKTO_STARTER_CLAIM_SECRET = "test-only-starter-claim-secret-at-least-32-chars";
    if (options.starterDailyLimit !== undefined)
      starter.TALKTO_STARTER_DAILY_LIMIT = String(options.starterDailyLimit);
    if (options.starterCohortLimit !== undefined)
      starter.TALKTO_STARTER_COHORT_LIMIT = String(options.starterCohortLimit);
  }
  // The Free plan is off unless a test opts in, matching production's default.
  if (options.free) starter.TALKTO_FREE_PLAN_ENABLED = "true";
  // Share links are off unless a test opts in, matching every deployment's default.
  if (options.share) starter.TALKTO_SHARE_LINKS_ENABLED = "true";
  // Invitation email budgets are generous unless a test opts into the real defaults ("defaults")
  // or sets its own, matching how provisioning budgets are relaxed above.
  const invitations =
    options.invitations === "defaults"
      ? {}
      : {
          TALKTO_INVITATION_UNPAID_DAILY_LIMIT: "1000",
          TALKTO_INVITATION_UNPAID_TOTAL_DAILY_LIMIT: "100000",
          TALKTO_INVITATION_PAID_DAILY_LIMIT: "10000",
          TALKTO_INVITATION_RECIPIENT_COOLDOWN_MINUTES: "0",
          TALKTO_INVITATION_RECIPIENT_DAILY_LIMIT: "100",
          ...options.invitations,
        };
  const metering = {};
  if (options.shareUnits !== undefined)
    metering.TALKTO_FILE_SHARE_UNITS = String(options.shareUnits);
  // The remote makes the deployment report the files capability; the fixture swaps in the recording fake.
  const fileStore = {};
  if (options.files) {
    fileStore.TALKTO_FILES_REMOTE = "file:///tmp/talkto-test-files.git";
    fileStore.TEST_FAKE_FILES = "true";
  }
  // Real binding and real signing with throwaway keys; only the bucket's bytes are local.
  const transferStore = {};
  const transferBucket = {};
  if (options.transfers) {
    transferStore.TALKTO_R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    transferStore.TALKTO_R2_BUCKET = "talkto-test-transfers";
    transferStore.TALKTO_R2_ACCESS_KEY_ID = "test-access-key";
    transferStore.TALKTO_R2_SECRET_ACCESS_KEY = "test-secret-key";
    if (options.transferObjectBase)
      transferStore.TALKTO_R2_OBJECT_BASE = options.transferObjectBase;
    transferBucket.r2Buckets = { TRANSFERS: "talkto-test-transfers" };
  }
  // A throwaway key per run; hosts are answered by the test's handler, never the real services.
  const wakes = {};
  if (options.wakeKey) wakes.TALKTO_WAKE_KEY = randomBytes(32).toString("base64url");
  if (options.wakeTokens) wakes.TALKTO_WAKE_TOKENS = "on";
  const wakeHosts = new Set([
    "connectors.api.openai.com",
    "api.anthropic.com",
    "api2.cursor.sh",
    "api.town.com",
  ]);
  // A customer's own copy (TALKTO_SELF_HOSTED), when a test asks.
  const selfHost = {};
  if (options.selfHosted) selfHost.TALKTO_SELF_HOSTED = "true";
  // Self-host sign-in with Cloudflare Access: the real verifier and D1 store, against a fake
  // Access team whose certs this test signs with (docs/self-host-cloudflare-access.md).
  const accessTeam = "https://talkto-test.cloudflareaccess.com";
  const accessAud = "a".repeat(64);
  if (options.access) {
    selfHost.TEST_ACCESS = "true";
    selfHost.TALKTO_ACCESS_TEAM_DOMAIN = accessTeam;
    selfHost.TALKTO_ACCESS_AUD = accessAud;
  }
  // Self-host sign-in with Better Auth: the real Better Auth, OAuth server and D1 store
  // (docs/self-host-better-auth.md). The secret is a throwaway per run.
  if (options.betterAuth) {
    selfHost.TEST_BETTER_AUTH = "true";
    selfHost.TALKTO_AUTH_PROVIDER = "better-auth";
    selfHost.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
    selfHost.TALKTO_OWNER_EMAILS = options.owners ?? "owner@example.com";
    // A copy that also has Access's settings, which must be refused.
    if (options.alsoAccess) {
      selfHost.TALKTO_ACCESS_TEAM_DOMAIN = accessTeam;
      selfHost.TALKTO_ACCESS_AUD = accessAud;
    }
  }
  // TalkTo's own email: off unless a test opts in. "fake" records in memory; "resend" runs the real
  // adapter against the test's handler for api.resend.com. Nothing ever leaves the test.
  const email = {};
  if (options.email) {
    email.TALKTO_EMAIL = options.email;
    email.TALKTO_EMAIL_SIGNING_SECRET = "test-only-email-signing-secret-at-least-32-characters";
    email.TALKTO_RESEND_API_KEY = "re_test_only_key";
    email.TALKTO_RESEND_WEBHOOK_SECRET = options.resendWebhookSecret ?? "";
    if (options.emailDailyLimit !== undefined)
      email.TALKTO_EMAIL_DAILY_LIMIT = String(options.emailDailyLimit);
    if (options.emailBatch !== undefined) email.TALKTO_EMAIL_BATCH = String(options.emailBatch);
  }
  // Plan budgets are on in every deployment by default; tests opt in so their numbers stay out
  // of unrelated suites.
  const reads = {
    TEST_RECORD_READS: "true",
    TALKTO_READ_BUDGETS: options.readBudgets ? "on" : "off",
    TALKTO_ADMIN_BUDGETS: options.adminBudgets ? "on" : "off",
    TALKTO_HISTORY_CAPS: options.historyCaps ? "on" : "off",
  };
  if (options.serversPerOrganization !== undefined)
    reads.TALKTO_SERVERS_PER_ORGANIZATION = String(options.serversPerOrganization);
  if (options.serverLimits !== undefined)
    reads.TALKTO_SERVER_LIMITS = JSON.stringify(options.serverLimits);
  if (options.readLimits !== undefined) reads.TALKTO_READ_LIMITS = options.readLimits;
  if (options.participantReadsPerMinute !== undefined)
    reads.TALKTO_PARTICIPANT_READS_PER_MINUTE = String(options.participantReadsPerMinute);
  if (options.storageUnpaidBytes !== undefined)
    reads.TALKTO_STORAGE_UNPAID_BYTES = String(options.storageUnpaidBytes);
  const ratelimits = {};
  if (options.organizationReadsPerMinute !== undefined)
    ratelimits.ORGANIZATION_READS = {
      namespace_id: "1001",
      simple: { limit: options.organizationReadsPerMinute, period: 60 },
    };
  if (options.signalFailuresPerMinute !== undefined)
    ratelimits.SIGNAL_FAILURES = {
      namespace_id: "1003",
      simple: { limit: options.signalFailuresPerMinute, period: 60 },
    };
  const organizationReads = Object.keys(ratelimits).length === 0 ? {} : { ratelimits };
  // A throwaway signal key per run when a test asks; the test may recompute tags with it.
  const signalKey = options.signalKey ? randomBytes(32).toString("base64url") : undefined;
  const signals = signalKey === undefined ? {} : { TALKTO_SIGNAL_KEY: signalKey };
  const runtimeOptions = convertV4MiniflareOptions({
    name: "app",
    modulesRoot: build,
    modules: [
      {
        type: "ESModule",
        path: join(build, options.telemetry ? "telemetry-fixture.js" : "platform-fixture.js"),
      },
      ...files
        .filter((name) => name.endsWith(".sql") || name.endsWith(".md"))
        .map((name) => ({ type: "Text", path: join(build, name) })),
    ],
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_als"],
    resourcePersistencePath: directory,
    durableObjects: {
      SERVERS: { className: "PlatformTestServer", useSQLite: true },
      QUOTAS: { className: "TestQuota", useSQLite: true },
    },
    d1Databases: { PLATFORM: randomUUID() },
    ...transferBucket,
    ...organizationReads,
    bindings: {
      METERED_WORKSPACES: JSON.stringify(options.metering ? "all" : []),
      TALKTO_UNLIMITED_ACCOUNTS: JSON.stringify(options.unlimitedAccounts ?? []),
      ...selfHost,
      ...email,
      TEST_JWKS: JSON.stringify(keys),
      TEST_ALIAS_JWKS: JSON.stringify(aliasKeys),
      WORKOS_MCP_ISSUER_ALIASES: options.mcpIssuerAliases ?? '["https://old-auth.talkto.test"]',
      SENTRY_DSN: options.telemetry ? "https://test@sentry.test/1" : "",
      SENTRY_ENVIRONMENT: "test",
      TEST_TRACE_RATE: options.traceRate === undefined ? "1" : String(options.traceRate),
      TALKTO_SERVICE_ORIGIN: "https://talkto.test",
      WORKOS_COOKIE_PASSWORD: randomBytes(32).toString("hex"),
      WORKOS_REDIRECT_URI: "https://talkto.test/auth/callback",
      TEST_REAL_IDENTITY: String(options.realIdentity ?? false),
      TEST_REMOTE_MCP_JWKS: String(options.mcpJwksResponse !== undefined),
      // No fallback unless a test configures one: an empty object configures none.
      WORKOS_MCP_JWKS: JSON.stringify(options.mcpFallbackKeys?.(keys, aliasKeys) ?? {}),
      STRIPE_BILLING_ENABLED: String(options.stripeHandler !== undefined),
      TALKTO_TRIALS_ENABLED: String(options.trials ?? false),
      WORKOS_CLIENT_ID: "client_test",
      ...starter,
      ...metering,
      ...fileStore,
      ...transferStore,
      ...reads,
      ...provisioning,
      ...invitations,
      ...wakes,
      ...signals,
      TEST_MANUAL_ALARMS: String(options.manualAlarms ?? false),
      TEST_LEGACY_ONBOARDING: String(options.legacyOnboarding ?? false),
      TALKTO_TRIAL_DAILY_LIMIT: String(options.trialDailyLimit ?? 10),
      TALKTO_TRIAL_CLAIM_SECRET: "test-only-stable-claim-secret-at-least-32-characters",
      STRIPE_TRIAL_PAYMENT_CONFIGURATION: "pmc_trial",
      STRIPE_API_KEY: `rk_test_${randomBytes(32).toString("hex")}`,
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      STRIPE_ACCOUNT_ID: "acct_talkto",
      STRIPE_ENVIRONMENT: "test",
      STRIPE_LIVE_MODE: "false",
      STRIPE_SHOP_PRICE: "price_shop",
      STRIPE_STUDIO_PRICE: "price_studio",
      STRIPE_FACTORY_PRICE: "price_factory",
      STRIPE_PORTAL_CONFIGURATION: "bpc_talkto",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "api.stripe.com" && options.stripeHandler)
        return options.stripeHandler(request);
      // Nothing calls GitHub since self-host sales ended; a test may watch for it.
      if (url.hostname === "api.github.com" && options.githubHandler)
        return options.githubHandler(request);
      if (url.hostname === "api.resend.com" && options.resendHandler)
        return options.resendHandler(request);
      if (url.pathname === "/oauth2/jwks") jwksFetches.push(url.hostname);
      if (options.access && url.origin === accessTeam && url.pathname === "/cdn-cgi/access/certs")
        return Response.json(keys);
      if (url.hostname === "auth.talkto.test" && url.pathname === "/oauth2/jwks")
        return options.mcpJwksResponse(keys);
      if (url.hostname === "old-auth.talkto.test" && url.pathname === "/oauth2/jwks")
        return Response.json(aliasKeys);
      if (url.hostname === "sentry.test" && options.telemetry) return options.telemetry(request);
      if (wakeHosts.has(url.hostname) && options.wakeHandler) return options.wakeHandler(request);
      if (url.hostname !== "api.workos.com")
        throw new Error(`Unexpected external host: ${url.hostname}`);
      if (url.pathname === "/sso/jwks/client_test") return Response.json(keys);
      if (url.pathname !== "/user_management/authenticate" && options.providerHandler)
        return options.providerHandler(request);
      if (url.pathname !== "/user_management/authenticate")
        throw new Error(`Unexpected provider path: ${url.pathname}`);
      const input = await request.json();
      let user;
      let expiry = "5m";
      if (input.grant_type === "authorization_code") {
        const code = codes.get(input.code);
        if (
          !code ||
          createHash("sha256")
            .update(input.code_verifier ?? "")
            .digest("base64url") !== code.challenge
        )
          return Response.json(
            { error: "invalid_grant", error_description: "Invalid code" },
            { status: 400 },
          );
        codes.delete(input.code);
        provider.exchanges++;
        user = code.user;
        expiry = code.expiry;
      } else if (input.grant_type === "refresh_token") {
        if (provider.refreshStatus !== 200)
          return Response.json(
            {
              error: provider.refreshStatus === 400 ? "invalid_grant" : "server_error",
              error_description: "Test refresh failure",
            },
            { status: provider.refreshStatus, headers: { "retry-after": "0" } },
          );
        user = refreshTokens.get(input.refresh_token);
        if (!user) return Response.json({ error: "invalid_grant" }, { status: 400 });
      } else throw new Error(`Unexpected grant: ${input.grant_type}`);
      const refreshToken = randomUUID();
      refreshTokens.set(refreshToken, user);
      return Response.json({
        access_token: await token(user, { expiry }),
        refresh_token: refreshToken,
        user: userRecord(user),
        authentication_method: "Password",
      });
    },
  });
  // A copy on Access or Better Auth has no WorkOS settings at all.
  if (options.access || options.betterAuth) {
    const env = runtimeOptions.workers[0].config.env;
    for (const name of Object.keys(env)) if (name.startsWith("WORKOS_")) delete env[name];
  }
  let mf = new Miniflare(runtimeOptions);
  t.after(async () => {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  let db = await mf.getD1Database("PLATFORM");
  const migration = (
    await Promise.all(
      [
        "0001.sql",
        "0002.sql",
        "0003.sql",
        "0004.sql",
        "0005.sql",
        "0006.sql",
        "0007.sql",
        "0008.sql",
        "0009.sql",
        "0010.sql",
        "0011.sql",
        "0012.sql",
        "0013.sql",
        "0014.sql",
        "0015.sql",
        "0016.sql",
        "0017.sql",
        "0018.sql",
        "0019.sql",
        "0020.sql",
        "0021.sql",
        "0022.sql",
        "0023.sql",
        "0024.sql",
      ].map((file) =>
        readFile(new URL(`../src/platform/migrations/${file}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
  await db.batch(
    migration
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((q) => q.trim())
      .filter(Boolean)
      .map((q) => db.prepare(q)),
  );
  const token = (user = "user_alice", options = {}) =>
    new SignJWT({ sid: "session_test", ...options.claims })
      .setProtectedHeader({
        alg: "RS256",
        kid: options.kid ?? (options.aliasKey ? "alias" : "test"),
      })
      .setSubject(user)
      .setIssuer(options.issuer ?? "https://api.workos.com/user_management/client_test")
      .setIssuedAt()
      .setExpirationTime(options.expiry ?? "5m")
      .sign(options.aliasKey ? alias.privateKey : privateKey);
  const raw = (path, init) => mf.dispatchFetch(`https://talkto.test${path}`, init);
  /** A token as Cloudflare Access signs it for this application; `options` can break any part. */
  const accessToken = (email = "alice@example.com", options = {}) => {
    const claims = { type: "app", country: "US", ...options.claims };
    if (email !== null) claims.email = email;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "test" })
      .setSubject(options.subject ?? randomUUID())
      .setIssuer(options.issuer ?? accessTeam)
      .setAudience(options.audience ?? [accessAud])
      .setIssuedAt()
      .setExpirationTime(options.expiry ?? "5m")
      .sign(options.aliasKey ? alias.privateKey : privateKey);
  };
  const browserLogin = async (user = "user_alice", expiry = "5m", invitationToken, returnTo) => {
    const selection = new URLSearchParams();
    if (invitationToken) selection.set("invitation_token", invitationToken);
    if (returnTo) selection.set("return_to", returnTo);
    const login = await raw(`/auth/login?${selection}`, { redirect: "manual" });
    assert.equal(login.status, 303, await login.clone().text());
    const location = new URL(login.headers.get("location"));
    const loginCookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-talkto-login="))
      .split(";")[0];
    const code = randomUUID();
    codes.set(code, { user, expiry, challenge: location.searchParams.get("code_challenge") });
    const callbackPath = `/auth/callback?${new URLSearchParams({ code, state: location.searchParams.get("state") })}`;
    return {
      login,
      location,
      loginCookie,
      callbackPath,
      callback: () => raw(callbackPath, { redirect: "manual", headers: { cookie: loginCookie } }),
    };
  };
  const control = (path, value) =>
    raw(`/__control/${path}`, {
      method: "POST",
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  const call = async (user, method, path, value, status = 200, extraHeaders = {}) => {
    const response = await raw(path, {
      method,
      headers: {
        authorization: `Bearer ${await token(user)}`,
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const text = await response.text();
    assert.ok(response.headers.get("content-type")?.includes("json"), text);
    const result = JSON.parse(text);
    assert.equal(response.status, status, JSON.stringify(result));
    assert.equal(result.meta.instructions.url, "https://talkto.test/instructions");
    return result.data ?? result;
  };
  const account = () =>
    call("user_alice", "POST", "/v1/accounts", { name: "Team", requestKey: randomUUID() });
  const server = (accountId, input = {}) =>
    call("user_alice", "POST", `/v1/accounts/${accountId}/servers`, {
      name: "Development",
      requestKey: randomUUID(),
      ...input,
    });
  const member = (
    organizationId,
    userId = "user_bob",
    status = "active",
    updatedAt = new Date().toISOString(),
  ) => ({
    id: `om_${userId.replace("user_", "")}${organizationId.slice(4)}`,
    userId,
    organizationId,
    status,
    role: "member",
    updatedAt,
  });
  const mcpToken = (organizationId, user = "user_alice", options = {}) =>
    token(user, {
      issuer: "https://auth.talkto.test",
      ...options,
      claims: { aud: "https://talkto.test/mcp", org_id: organizationId, ...options.claims },
    });
  const mcp = async (credential, name, args, error = false) => {
    const response = await raw("/mcp", rpc("tools/call", { name, arguments: args }, credential));
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.result, JSON.stringify(result));
    assert.equal(result.result.isError ?? false, error, JSON.stringify(result));
    const content = result.result.structuredContent;
    assert.deepEqual(
      JSON.parse(result.result.content.find((item) => item.type === "text").text),
      content,
    );
    assert.equal(content.meta.instructions.url, "https://talkto.test/instructions");
    return content;
  };
  return {
    get db() {
      return db;
    },
    /** Better Auth's throwaway secret, for minting account links as `pnpm selfhost:link` does. */
    betterAuthSecret: selfHost.BETTER_AUTH_SECRET,
    // Local offline recovery drill, not Cloudflare PITR. Call only with no requests in flight.
    persistenceCheckpoint: async () => {
      const backup = await mkdtemp(join(tmpdir(), "talkto-recovery-"));
      t.after(() => rm(backup, { recursive: true, force: true }));
      await mf.dispose();
      await cp(directory, backup, { recursive: true });
      mf = new Miniflare(runtimeOptions);
      db = await mf.getD1Database("PLATFORM");
      return async () => {
        await mf.dispose();
        await rm(directory, { recursive: true, force: true });
        await cp(backup, directory, { recursive: true });
        mf = new Miniflare(runtimeOptions);
        db = await mf.getD1Database("PLATFORM");
      };
    },
    raw,
    signalKey,
    scheduled: async () => (await mf.getWorker()).scheduled({ cron: "* * * * *" }),
    control,
    call,
    account,
    server,
    token,
    member,
    mcpToken,
    accessToken,
    jwksFetches,
    mcp,
    browserLogin,
    provider,
    webhookSecret,
  };
}
