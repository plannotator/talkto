import { rpc, packet } from "./mcp-wire.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

test("membership pages synchronize in one D1 batch, including filtered pages and bounded continuation", async (t) => {
  const traces = new Map();
  const pending = new Map();
  const x = await start(t, {
    traceRate: 1,
    manualAlarms: true,
    telemetry: async (request) => {
      const lines = (await request.text()).trim().split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2) {
        if (JSON.parse(lines[i]).type !== "transaction") continue;
        const event = JSON.parse(lines[i + 1]);
        traces.set(event.contexts.trace.trace_id, event);
        pending.get(event.contexts.trace.trace_id)?.resolve(event);
      }
      return Response.json({});
    },
  });
  const list = async (path, batches) => {
    const traceId = randomUUID().replaceAll("-", "");
    const received = Promise.withResolvers();
    pending.set(traceId, received);
    const result = await x.call("user_bob", "GET", path, undefined, 200, {
      "sentry-trace": `${traceId}-1234567890abcdef-1`,
    });
    const event = traces.get(traceId) ?? (await received.promise);
    pending.delete(traceId);
    assert.equal(
      event.spans.filter((span) => span.data?.["db.operation.name"] === "batch").length,
      batches,
      "measure the real D1 SDK boundary, not a mocked service call",
    );
    assert.ok(event.spans.some((span) => span.op === "db.query"));
    return result;
  };
  assert.deepEqual((await list("/v1/accounts", 0)).items, []);
  const at = new Date().toISOString();
  const accounts = Array.from({ length: 101 }, (_, i) => ({
    id: randomUUID(),
    organizationId: `org_page${String(i).padStart(3, "0")}`,
    name: i === 100 ? "Target" : "Other",
  }));
  await x.db.batch(
    accounts.map((account) =>
      x.db
        .prepare(
          "INSERT INTO accounts(id,organization_id,name,created_by,request_key,created_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(account.id, account.organizationId, account.name, "user_alice", account.id, at),
    ),
  );
  for (const account of accounts) await x.control("member", x.member(account.organizationId));
  const first = await list("/v1/accounts?query=Target&limit=100", 1);
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  assert.equal(
    (await x.db.prepare("SELECT COUNT(*) AS count FROM memberships").first()).count,
    100,
  );
  const next = await list(`/v1/accounts?after=${first.nextCursor}`, 1);
  assert.deepEqual(
    next.items.map((account) => account.id),
    [accounts[100].id],
  );
  assert.equal(next.nextCursor, null);
  assert.equal(
    (await x.db.prepare("SELECT COUNT(*) AS count FROM memberships").first()).count,
    101,
  );
  await x.call("user_alice", "GET", `/v1/accounts?after=${first.nextCursor}`, undefined, 400);
  await x.call(
    "user_bob",
    "GET",
    `/v1/accounts?after=${first.nextCursor}&query=Other`,
    undefined,
    400,
  );
});

test("membership page failure rolls back all observations and revocations before safe retry", async (t) => {
  const x = await start(t, { manualAlarms: true });
  const fixtures = [];
  for (let i = 0; i < 3; i++) {
    const account = await x.account();
    const member = x.member(account.organizationId);
    await x.control("member", member);
    const server = await x.server(account.id);
    await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
    fixtures.push({ account, member, server });
  }
  fixtures.sort((a, b) => a.member.id.localeCompare(b.member.id));
  await x.control("sync");
  const snapshot = async () => ({
    members: (
      await x.db.prepare("SELECT * FROM memberships WHERE user_id='user_bob' ORDER BY id").all()
    ).results,
    grants: (
      await x.db
        .prepare("SELECT * FROM server_access WHERE user_id='user_bob' ORDER BY server_id")
        .all()
    ).results,
  });
  const before = await snapshot();
  const departedAt = new Date(Date.now() + 1000).toISOString();
  for (const [i, fixture] of fixtures.entries())
    await x.control("member", {
      ...fixture.member,
      status: ["inactive", "deleted", "active"][i],
      role: "updated",
      updatedAt: departedAt,
    });
  // The last provider item fails after the preceding items would have changed both tables.
  await x.db
    .prepare(`CREATE TRIGGER fail_membership_page BEFORE UPDATE ON memberships
    WHEN NEW.id='${fixtures[2].member.id}' BEGIN SELECT RAISE(ABORT,'fixture membership failure'); END`)
    .run();
  const failed = await x.call("user_bob", "GET", "/v1/accounts?query=NoMatch", undefined, 503);
  assert.equal(failed.error.code, "storage_unavailable");
  assert.deepEqual(await snapshot(), before);
  await x.db.prepare("DROP TRIGGER fail_membership_page").run();
  assert.deepEqual((await x.call("user_bob", "GET", "/v1/accounts?query=NoMatch")).items, []);
  const applied = await snapshot();
  assert.deepEqual(
    applied.members.map((member) => member.status),
    ["inactive", "deleted", "active"],
  );
  for (const [i, fixture] of fixtures.entries()) {
    const grant = applied.grants.find((value) => value.server_id === fixture.server.id);
    assert.equal(grant.revision, i < 2 ? 2 : 1);
    assert.equal(grant.applied_revision, 1);
    assert.equal(grant.revoked_at, i < 2 ? departedAt : null);
  }
  await x.call("user_bob", "GET", "/v1/accounts");
  assert.deepEqual(
    await snapshot(),
    applied,
    "replaying a page does not increment revisions again",
  );
  // Only the existing event consumer delivers the pending revocations to authoritative servers.
  await x.control("sync");
  for (const [i, fixture] of fixtures.entries()) {
    await x.call(
      "user_bob",
      "GET",
      `/v1/servers/${fixture.server.id}`,
      undefined,
      i < 2 ? 404 : 200,
    );
    const result = await x.mcp(
      await x.mcpToken(fixture.account.organizationId, "user_bob"),
      "get_context",
      { serverId: fixture.server.id },
      i < 2,
    );
    if (i < 2) assert.equal(result.error.code, "server_unavailable");
  }
  for (const observedAt of [
    fixtures[0].member.updatedAt,
    departedAt,
    new Date(Date.now() + 2000).toISOString(),
  ]) {
    for (const fixture of fixtures.slice(0, 2))
      await x.control("member", { ...fixture.member, updatedAt: observedAt });
    await x.call("user_bob", "GET", "/v1/accounts");
    const state = await snapshot();
    for (const fixture of fixtures.slice(0, 2)) {
      const member = state.members.find((value) => value.id === fixture.member.id);
      assert.equal(
        member.status,
        observedAt > departedAt
          ? "active"
          : applied.members.find((value) => value.id === fixture.member.id).status,
      );
      const grant = state.grants.find((value) => value.server_id === fixture.server.id);
      assert.equal(grant.revision, 2);
      assert.equal(grant.applied_revision, 2);
      assert.equal(grant.revoked_at, departedAt);
      await x.call("user_bob", "GET", `/v1/servers/${fixture.server.id}`, undefined, 404);
    }
  }
  const retained = fixtures[2];
  const stable = await snapshot();
  await x.control("member", { ...retained.member, status: "inactive" });
  await x.call("user_bob", "GET", "/v1/accounts");
  assert.deepEqual(
    await snapshot(),
    stable,
    "a departure before grant creation cannot revoke the newer grant",
  );
  await x.call("user_bob", "GET", `/v1/servers/${retained.server.id}`);
  await x.control("member", { ...retained.member, status: "inactive", updatedAt: departedAt });
  await x.call("user_bob", "GET", "/v1/accounts");
  await x.control("member", { ...retained.member, updatedAt: departedAt });
  await x.call("user_bob", "GET", "/v1/accounts");
  const equalTime = await snapshot();
  assert.equal(
    equalTime.members.find((member) => member.id === retained.member.id).status,
    "inactive",
  );
  assert.equal(
    equalTime.grants.find((grant) => grant.server_id === retained.server.id).revision,
    2,
  );
});

test("organization directory counts match visible management servers without exposing private servers", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const empty = await x.call("user_alice", "POST", "/v1/accounts", {
    name: "Empty organization",
    requestKey: randomUUID(),
  });
  await x.control("member", x.member(account.organizationId));
  const owned = await x.server(account.id);
  await x.call("user_bob", "POST", `/v1/accounts/${account.id}/servers`, {
    name: "Private colleague server",
    requestKey: randomUUID(),
  });
  const count = async (user, expected) => {
    const listed = await x.call(user, "GET", "/v1/accounts");
    assert.equal(listed.items.find((item) => item.id === account.id)?.serverCount, expected);
    const managed = await x.call(user, "GET", `/v1/accounts/${account.id}/servers`);
    assert.equal(managed.items.length, expected);
  };
  const listed = await x.call("user_alice", "GET", "/v1/accounts");
  assert.equal(listed.items.find((item) => item.id === empty.id).serverCount, 0);
  assert.equal((await x.call("user_charlie", "GET", "/v1/accounts")).items.length, 0);
  await count("user_alice", 1);
  await count("user_bob", 1);
  await x.call("user_alice", "PUT", `/v1/servers/${owned.id}/access/user_bob`);
  await count("user_bob", 2);
  // Pending access is not usable; only a confirmed grant contributes to another member's count.
  await x.db
    .prepare("UPDATE server_access SET applied_revision=0 WHERE server_id=? AND user_id=?")
    .bind(owned.id, "user_bob")
    .run();
  await count("user_bob", 1);
  await x.call("user_alice", "DELETE", `/v1/servers/${owned.id}/access/user_bob`);
  await count("user_bob", 1);
  await x.call("user_alice", "DELETE", `/v1/servers/${owned.id}/access/user_alice`);
  await count("user_alice", 1);
  const response = await x.call("user_bob", "GET", "/v1/accounts");
  assert.deepEqual(
    response.items.map((item) => item.id),
    [account.id],
  );
  await x.control("member", x.member(account.organizationId, "user_bob", "inactive"));
  assert.equal((await x.call("user_bob", "GET", "/v1/accounts")).items.length, 0);
});

test("bookmarked accounts enforce membership; login returns only to internal app routes", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const context = await x.call("user_alice", "GET", `/v1/accounts/${account.id}`);
  assert.equal(context.id, account.id);
  assert.equal(context.permissions.manageMembers, true);
  await x.call("user_bob", "GET", `/v1/accounts/${account.id}`, undefined, 404);
  for (const path of [
    "https://example.com",
    "//example.com",
    "/auth/callback",
    "/app\\evil",
    "/app/../auth",
  ]) {
    assert.equal(
      (await x.raw(`/auth/login?return_to=${encodeURIComponent(path)}`, { redirect: "manual" }))
        .status,
      401,
    );
  }
  const destination = `/app/accounts/${account.id}/servers?query=release`;
  const flow = await x.browserLogin("user_alice", "5m", undefined, destination);
  const response = await flow.callback();
  assert.equal(response.headers.get("location"), `https://talkto.test${destination}`);
});

test("website login binds PKCE state, protects cookie mutations, and keeps MCP authentication separate", async (t) => {
  const x = await start(t);
  const flow = await x.browserLogin("user_alice", "5m", "test-invitation-token");
  assert.equal(flow.location.searchParams.get("invitation_token"), "test-invitation-token");
  assert.equal(flow.location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(flow.location.searchParams.get("state"));
  assert.match(flow.login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(flow.login.headers.get("set-cookie"), /Secure/);
  assert.match(flow.login.headers.get("set-cookie"), /SameSite=Lax/);
  assert.equal((await x.raw(flow.callbackPath, { redirect: "manual" })).status, 401);
  assert.equal(
    (
      await x.raw(flow.callbackPath.replace(/state=[^&]+/, "state=wrong"), {
        headers: { cookie: flow.loginCookie },
        redirect: "manual",
      })
    ).status,
    401,
  );
  assert.equal(x.provider.exchanges, 0);
  const callback = await flow.callback();
  assert.equal(callback.status, 303, await callback.clone().text());
  assert.equal(callback.headers.get("location"), "https://talkto.test/app");
  const session = callback.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-talkto-session="));
  assert.ok(session);
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=Lax/);
  const cookie = session.split(";")[0];
  const me = await x.raw("/v1/me", { headers: { cookie } });
  assert.equal(me.status, 200, await me.clone().text());
  const user = await me.json();
  assert.equal(user.data.user.email, "user_alice@example.com");
  assert.equal(user.data.connection.mcpUrl, "https://talkto.test/mcp");
  assert.doesNotMatch(JSON.stringify(user), /accessToken|refreshToken|sealedSession/);
  assert.equal(
    (await flow.callback()).status,
    401,
    "A code cannot be replayed with the original cookie",
  );
  const body = JSON.stringify({ name: "Browser account", requestKey: "browser" });
  for (const origin of [undefined, "https://evil.test"]) {
    const headers = { cookie, "content-type": "application/json" };
    if (origin) headers.origin = origin;
    assert.equal((await x.raw("/v1/accounts", { method: "POST", headers, body })).status, 403);
  }
  const created = await x.raw("/v1/accounts", {
    method: "POST",
    headers: { cookie, origin: "https://talkto.test", "content-type": "application/json" },
    body,
  });
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal((await created.json()).data.permissions.manageMembers, true);
  const wrongBearer = await x.raw("/v1/me", {
    headers: { cookie, authorization: "Bearer invalid" },
  });
  assert.equal(wrongBearer.status, 401);
  assert.equal(wrongBearer.headers.get("set-cookie"), null);
  const mcp = await x.raw("/mcp", {
    ...rpc("tools/call", { name: "get_context", arguments: {} }),
    headers: { cookie, "content-type": "application/json" },
  });
  assert.equal(mcp.status, 401);
  assert.equal((await x.raw("/auth/logout", { headers: { cookie } })).status, 405);
  assert.equal(
    (
      await x.raw("/auth/logout", {
        method: "POST",
        headers: { cookie, origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  const logout = await x.raw("/auth/logout", {
    method: "POST",
    headers: { cookie, origin: "https://talkto.test" },
    redirect: "manual",
  });
  assert.equal(logout.status, 303, await logout.clone().text());
  assert.equal(
    new URL(logout.headers.get("location")).searchParams.get("session_id"),
    "session_test",
  );
  assert.ok(
    logout.headers
      .getSetCookie()
      .some((c) => c.startsWith("__Host-talkto-session=;") && c.includes("Max-Age=0")),
  );
  assert.equal((await x.raw("/v1/me")).status, 401);
});

test("website sessions refresh through the WorkOS SDK and survive transient provider failures", async (t) => {
  const x = await start(t);
  const flow = await x.browserLogin("user_alice", "-1m");
  const callback = await flow.callback();
  assert.equal(callback.status, 303, await callback.clone().text());
  const cookie = callback.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-talkto-session="))
    .split(";")[0];
  x.provider.refreshStatus = 503;
  const unavailable = await x.raw("/v1/me", { headers: { cookie } });
  assert.equal(unavailable.status, 503, await unavailable.clone().text());
  assert.equal(unavailable.headers.get("set-cookie"), null);
  x.provider.refreshStatus = 200;
  const refreshed = await x.raw("/v1/me", { headers: { cookie } });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const rotated = refreshed.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-talkto-session="))
    .split(";")[0];
  assert.notEqual(rotated, cookie);
  assert.equal((await x.raw("/v1/me", { headers: { cookie: rotated } })).status, 200);
  x.provider.refreshStatus = 400;
  const ended = await x.raw("/v1/me", { headers: { cookie } });
  assert.equal(ended.status, 401);
  assert.match(ended.headers.get("set-cookie"), /Max-Age=0/);
  const malformed = await x.raw("/v1/me", {
    headers: { cookie: "__Host-talkto-session=not-a-session" },
  });
  assert.equal(malformed.status, 401);
});

test("human setup joins a colleague without granting server access and supplies management context", async (t) => {
  const x = await start(t);
  const me = await x.call("user_alice", "GET", "/v1/me");
  assert.equal(me.user.id, "user_alice");
  assert.equal(me.permissions.createAccount, true);
  assert.deepEqual((await x.call("user_alice", "GET", "/v1/accounts")).items, []);
  const account = await x.account();
  assert.equal(account.createdBy, "user_alice");
  assert.deepEqual(account.permissions, {
    createServer: true,
    manageMembers: true,
    manageBilling: true,
    rename: true,
  });
  const root = `/v1/accounts/${account.id}`;
  const personal = await x.server(account.id, { name: "Personal" });
  const shared = await x.server(account.id, { name: "Shared" });
  const invitation = await x.call("user_alice", "POST", `${root}/invitations`, {
    email: "user_bob@example.com",
  });
  assert.equal(invitation.state, "pending");
  assert.doesNotMatch(JSON.stringify(invitation), /token|acceptInvitationUrl/);
  assert.deepEqual((await x.call("user_bob", "GET", "/v1/accounts")).items, []);
  assert.equal(
    (await x.control("accept-invitation", { id: invitation.id, userId: "user_bob" })).status,
    200,
  );
  const bobAccount = (await x.call("user_bob", "GET", "/v1/accounts")).items[0];
  assert.equal(bobAccount.id, account.id);
  assert.deepEqual(bobAccount.permissions, {
    createServer: true,
    manageMembers: false,
    manageBilling: false,
    rename: false,
  });
  const members = (await x.call("user_alice", "GET", `${root}/members`)).items;
  assert.equal(members.find((m) => m.userId === "user_bob").user.email, "user_bob@example.com");
  assert.equal(members.find((m) => m.userId === "user_bob").permissions.remove, true);
  assert.equal(members.find((m) => m.userId === "user_alice").permissions.remove, false);
  assert.deepEqual((await x.call("user_bob", "GET", "/v1/servers")).items, []);
  const bobToken = await x.mcpToken(account.organizationId, "user_bob");
  assert.deepEqual((await x.mcp(bobToken, "get_context", {})).data.items, []);
  await x.call("user_alice", "PUT", `/v1/servers/${shared.id}/access/user_bob`);
  const visible = await x.mcp(bobToken, "get_context", {});
  assert.deepEqual(
    visible.data.items.map((s) => s.id),
    [shared.id],
  );
  const joined = await x.mcp(bobToken, "register_participant", {
    serverId: shared.id,
    name: "Colleague",
    agentType: "codex",
    requestKey: "colleague",
  });
  assert.equal(joined.data.item.name, "Colleague");
  const bobServers = await x.call("user_bob", "GET", `${root}/servers`);
  assert.deepEqual(
    bobServers.items.map((s) => s.id),
    [shared.id],
  );
  assert.deepEqual(bobServers.items[0].permissions, {
    readMessages: true,
    manageAccess: false,
    resume: false,
  });
  await x.call("user_alice", "DELETE", `/v1/servers/${personal.id}/access/user_alice`);
  const owned = (await x.call("user_alice", "GET", `${root}/servers`)).items.find(
    (s) => s.id === personal.id,
  );
  assert.deepEqual(owned.permissions, { readMessages: false, manageAccess: true, resume: false });
  const resumed = await x.call("user_alice", "POST", `${root}/servers/${personal.id}/resume`);
  assert.equal(resumed.permissions.readMessages, false);
  await x.call("user_alice", "GET", `/v1/servers/${personal.id}`, undefined, 404);
  const bobPrivate = await x.call("user_bob", "POST", `${root}/servers`, {
    name: "Bob private",
    requestKey: "bob-private",
  });
  assert.ok(
    !(await x.call("user_alice", "GET", `${root}/servers`)).items.some(
      (s) => s.id === bobPrivate.id,
    ),
  );
  await x.call(
    "user_alice",
    "PUT",
    `/v1/servers/${bobPrivate.id}/access/user_alice`,
    undefined,
    404,
  );
  await x.call("user_alice", "DELETE", `/v1/servers/${shared.id}/access/user_bob`);
  const denied = await x.mcp(bobToken, "get_context", { serverId: shared.id }, true);
  assert.equal(denied.error.code, "server_unavailable");
});

test("invitation management enforces account ownership, scoping, and explicit email actions", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const other = await x.account();
  const root = `/v1/accounts/${account.id}`;
  await x.control("member", x.member(account.organizationId));
  const input = { email: "invitee@example.com" };
  await x.call("user_bob", "POST", `${root}/invitations`, input, 404);
  await x.call("user_bob", "GET", `${root}/invitations`, undefined, 404);
  const invite = await x.call("user_alice", "POST", `${root}/invitations`, input);
  await x.call("user_alice", "POST", `${root}/invitations`, input, 400);
  const path = `${root}/invitations/${invite.id}`;
  await x.call(
    "user_alice",
    "DELETE",
    `/v1/accounts/${other.id}/invitations/${invite.id}`,
    undefined,
    404,
  );
  await x.call("user_bob", "POST", `${path}/resend`, undefined, 404);
  await x.call("user_alice", "POST", `${path}/resend`);
  assert.deepEqual(await (await x.control("invitation-deliveries")).json(), { sent: 1, resent: 1 });
  for (let i = 0; i < 2; i++)
    assert.equal((await x.call("user_alice", "DELETE", path)).state, "revoked");
  await x.call("user_alice", "POST", `${path}/resend`, undefined, 400);
  assert.equal(
    (await x.call("user_alice", "GET", `${root}/invitations`)).items[0].state,
    "revoked",
  );
});

test("Shop's 4-person limit counts members and pending invitations, never agents", async (t) => {
  const id = randomUUID();
  const x = await start(t, { unlimitedAccounts: [id] });
  const account = await x.account();
  const root = `/v1/accounts/${account.id}`;
  const invite = (email, status) =>
    x.call("user_alice", "POST", `${root}/invitations`, { email }, status);
  // Agents are participants inside servers, not organization members.
  const server = await x.server(account.id);
  for (const name of ["One", "Two", "Three", "Four"])
    await x.call("user_alice", "POST", `/v1/servers/${server.id}/participants`, {
      name,
      agentType: "codex",
      requestKey: name,
    });
  await x.control("member", x.member(account.organizationId));
  await invite("third@example.com");
  const fourth = await invite("fourth@example.com");
  // Without a paid period the organization gets Shop's limit: owner, Bob and two invitations.
  const refused = await invite("fifth@example.com", 409);
  assert.equal(refused.error.code, "people_limit_reached");
  assert.match(refused.error.message, /up to 4 people.*Studio/);
  assert.equal(
    (await x.call("user_alice", "GET", `${root}/invitations`)).items.length,
    2,
    "A refused invitation sends no email",
  );
  // A canceled invitation frees its place.
  await x.call("user_alice", "DELETE", `${root}/invitations/${fourth.id}`);
  await invite("fifth@example.com");

  const period = (end) =>
    x.db.batch([
      x.db
        .prepare(
          "INSERT INTO workspace_billing(account_id,provider_scope) VALUES(?,'test') ON CONFLICT DO NOTHING",
        )
        .bind(account.id),
      x.db
        .prepare(
          "INSERT INTO billing_periods(account_id,subscription_id,invoice_id,line_id,plan,plan_version,start,end,allowance) VALUES(?,'sub','in','line','studio','test',?,?,250000) ON CONFLICT DO UPDATE SET end=excluded.end",
        )
        .bind(account.id, new Date(Date.now() - 86400000).toISOString(), end),
    ]);
  await period(new Date(Date.now() + 86400000).toISOString());
  await invite("sixth@example.com");
  await invite("seventh@example.com");
  // When Studio ends, everyone stays, but nobody new can be invited past Shop's limit.
  await period(new Date(Date.now() - 1000).toISOString());
  assert.equal((await invite("eighth@example.com", 409)).error.code, "people_limit_reached");
  assert.equal((await x.call("user_alice", "GET", `${root}/members`)).items.length, 2);

  // A trial of Studio has Studio's limit (unlimited) until the trial ends.
  const trial = await x.account();
  const trialRoot = `/v1/accounts/${trial.id}`;
  const trialEnd = (end) =>
    x.db.batch([
      x.db
        .prepare(
          "INSERT INTO workspace_billing(account_id,provider_scope) VALUES(?,'test') ON CONFLICT DO NOTHING",
        )
        .bind(trial.id),
      x.db
        .prepare(
          "INSERT INTO billing_operations(id,account_id,request_key,plan,created_at,status,offer) VALUES('op_trial',?,'trial','studio',0,'complete','trial') ON CONFLICT DO NOTHING",
        )
        .bind(trial.id),
      x.db
        .prepare(
          "INSERT INTO billing_trials(account_id,provider_scope,owner_id,email_key,operation_id,claimed_at,status,start,end) VALUES(?,'test','user_alice','trial-key','op_trial',0,'active',?,?) ON CONFLICT DO UPDATE SET end=excluded.end",
        )
        .bind(trial.id, new Date(Date.now() - 86400000).toISOString(), end),
    ]);
  await trialEnd(new Date(Date.now() + 86400000).toISOString());
  for (const email of ["t1@example.com", "t2@example.com", "t3@example.com", "t4@example.com"])
    await x.call("user_alice", "POST", `${trialRoot}/invitations`, { email });
  await trialEnd(new Date(Date.now() - 1000).toISOString());
  const afterTrial = await x.call(
    "user_alice",
    "POST",
    `${trialRoot}/invitations`,
    { email: "t5@example.com" },
    409,
  );
  assert.equal(afterTrial.error.code, "people_limit_reached");

  // Operator-granted organizations have no people limit.
  const granted = await x.account();
  await x.db.prepare("UPDATE accounts SET id=? WHERE id=?").bind(id, granted.id).run();
  for (const email of [
    "a@example.com",
    "b@example.com",
    "c@example.com",
    "d@example.com",
    "e@example.com",
  ])
    await x.call("user_alice", "POST", `/v1/accounts/${id}/invitations`, { email });
});

test("real WorkOS SDK projects provider records and never retries ambiguous invitation emails", async (t) => {
  let sendCount = 0,
    resendCount = 0,
    emailUnavailable = false;
  const invitation = {
    object: "invitation",
    id: "invitation_test",
    email: "invitee@example.com",
    state: "pending",
    organization_id: "org_test",
    inviter_user_id: "user_alice",
    accepted_user_id: null,
    accepted_at: null,
    revoked_at: null,
    role_slug: "member",
    token: "must-not-escape",
    accept_invitation_url: "https://auth.test/invite?token=must-not-escape",
    created_at: "2026-09-09T06:02:26.523Z",
    updated_at: "2026-09-09T06:02:26.523Z",
    expires_at: "2026-09-16T06:02:26.578Z",
  };
  const member = {
    object: "organization_membership",
    id: "om_alice",
    organization_id: "org_test",
    user_id: "user_alice",
    status: "active",
    role: { slug: "member" },
    created_at: invitation.created_at,
    updated_at: invitation.updated_at,
  };
  const list = (data) =>
    Response.json({ object: "list", data, list_metadata: { before: null, after: null } });
  const x = await start(t, {
    realIdentity: true,
    providerHandler: async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/user_management/organization_memberships") {
        if (url.searchParams.get("user_id") === "user_bob")
          return list(
            url.searchParams.get("statuses")?.includes("inactive")
              ? [{ ...member, id: "om_bob", user_id: "user_bob", status: "inactive" }]
              : [],
          );
        return list([member]);
      }
      if (path === "/user_management/users/user_deleted")
        return Response.json({ message: "User not found" }, { status: 404 });
      if (path === "/user_management/users/user_alice")
        return Response.json({
          object: "user",
          id: "user_alice",
          email: "alice@example.com",
          email_verified: true,
          first_name: "Alice",
          last_name: null,
          profile_picture_url: null,
          last_sign_in_at: null,
          created_at: invitation.created_at,
          updated_at: invitation.updated_at,
          metadata: {},
        });
      if (path === "/user_management/invitations" && request.method === "POST") {
        sendCount++;
        if (emailUnavailable)
          return Response.json({ message: "Provider unavailable" }, { status: 503 });
        if (sendCount > 1)
          return Response.json(
            {
              code: "email_already_invited_to_organization",
              message: "Email already invited to organization.",
            },
            { status: 400 },
          );
        const input = await request.json();
        assert.equal(input.organization_id, "org_test");
        assert.equal(input.inviter_user_id, "user_alice");
        return Response.json(invitation);
      }
      if (path === "/user_management/invitations") {
        if (url.searchParams.has("email")) {
          assert.equal(url.searchParams.get("organization_id"), "org_test");
          if (url.searchParams.get("email") !== invitation.email) return list([]);
        }
        return list([invitation]);
      }
      if (path === "/user_management/invitations/invitation_test") return Response.json(invitation);
      if (path === "/user_management/invitations/invitation_test/resend") {
        resendCount++;
        if (emailUnavailable)
          return Response.json({ message: "Provider unavailable" }, { status: 503 });
        return Response.json(invitation);
      }
      if (path === "/user_management/invitations/invitation_test/revoke")
        return Response.json({ ...invitation, state: "revoked" });
      throw new Error(`Unexpected provider operation ${request.method} ${path}`);
    },
  });
  const accountId = randomUUID();
  await x.db
    .prepare(
      "INSERT INTO accounts(id,organization_id,name,created_by,request_key,created_at) VALUES(?,?,'SDK team','user_alice','sdk',?)",
    )
    .bind(accountId, "org_test", invitation.created_at)
    .run();
  const root = `/v1/accounts/${accountId}`;
  assert.equal((await x.call("user_alice", "GET", "/v1/me")).user.firstName, "Alice");
  assert.equal(
    (await x.call("user_alice", "GET", `${root}/members`)).items[0].user.email,
    "alice@example.com",
  );
  assert.equal(
    (await x.call("user_alice", "GET", `${root}/members?query=Alice&limit=1`)).items[0].user
      .firstName,
    "Alice",
  );
  assert.equal(
    (await x.call("user_alice", "GET", "/v1/accounts?query=SDK&limit=1")).items[0].id,
    accountId,
  );
  const ownedServer = await x.server(accountId);
  await x.db
    .prepare(
      "INSERT INTO memberships(id,organization_id,user_id,status,role,updated_at) VALUES('om_deleted','org_test','user_deleted','deleted','member',?)",
    )
    .bind(invitation.updated_at)
    .run();
  await x.db
    .prepare(
      "INSERT INTO server_access(server_id,user_id,id,membership_id,principal_key,created_at,revoked_at,revision,applied_revision) VALUES(?,'user_deleted',?,'om_deleted','workos:user_deleted',?,?,1,1)",
    )
    .bind(ownedServer.id, randomUUID(), invitation.created_at, invitation.updated_at)
    .run();
  const access = await x.call("user_alice", "GET", `/v1/servers/${ownedServer.id}/access`);
  assert.equal(access.items.find((grant) => grant.userId === "user_alice").user.firstName, "Alice");
  assert.equal(access.items.find((grant) => grant.userId === "user_deleted").user, null);
  const sent = await x.call("user_alice", "POST", `${root}/invitations`, {
    email: invitation.email,
  });
  assert.equal(sent.id, invitation.id);
  assert.equal(sent.createdAt, invitation.created_at);
  assert.doesNotMatch(JSON.stringify(sent), /must-not-escape/);
  await x.call("user_alice", "POST", `${root}/invitations`, { email: invitation.email }, 400);
  assert.equal(sendCount, 2);
  assert.equal(
    (await x.call("user_alice", "GET", `${root}/invitations`)).items[0].id,
    invitation.id,
  );
  await x.call("user_alice", "POST", `${root}/invitations/${invitation.id}/resend`);
  emailUnavailable = true;
  const failure = await x.call(
    "user_alice",
    "POST",
    `${root}/invitations/${invitation.id}/resend`,
    undefined,
    503,
  );
  assert.match(failure.error.message, /do not automatically resend/);
  assert.equal(
    resendCount,
    2,
    "Exactly one outbound request per explicit resend, including provider failure",
  );
  await x.call(
    "user_alice",
    "POST",
    `${root}/invitations`,
    { email: "unavailable@example.com" },
    503,
  );
  assert.equal(sendCount, 3);
  assert.equal(
    (await x.call("user_alice", "DELETE", `${root}/invitations/${invitation.id}`)).state,
    "revoked",
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await x.call("user_alice", "DELETE", `${root}/members/user_bob`)).status,
      "removed",
    );
  // Onboarding's new identity ports use the installed SDK's actual serialization.
  const setupPath = "/v1/onboarding";
  let setup = await x.call("user_alice", "GET", setupPath);
  const setupCommand = async (value, status = 200) =>
    x.call(
      "user_alice",
      "POST",
      setupPath,
      { command: { ...value, revision: setup.revision } },
      status,
    );
  setup = await setupCommand({ kind: "use_server", accountId, serverId: ownedServer.id });
  setup = await setupCommand({ kind: "step", step: "share" });
  await setupCommand({ kind: "invite", email: invitation.email }, 503);
  setup = await x.call("user_alice", "GET", setupPath);
  setup = await setupCommand({ kind: "check_invitation" });
  assert.equal(setup.run.invitation.id, invitation.id);
  invitation.state = "accepted";
  invitation.accepted_user_id = "user_alice";
  const observed = await x.call("user_alice", "GET", `${setupPath}/progress?runId=${setup.run.id}`);
  assert.equal(observed.invitee.id, "user_alice");
  assert.doesNotMatch(JSON.stringify(observed), /must-not-escape/);
});

test("member removal persists revocations, survives failed delivery, and never restores grants on rejoining", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const root = `/v1/accounts/${account.id}`;
  const membership = x.member(account.organizationId);
  await x.control("member", membership);
  const servers = [await x.server(account.id), await x.server(account.id)];
  for (const server of servers)
    await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  await x.call("user_bob", "DELETE", `${root}/members/user_alice`, undefined, 404);
  await x.call("user_alice", "DELETE", `${root}/members/user_alice`, undefined, 400);
  await x.control(`fail?server=${servers[0].id}`);
  await x.call("user_alice", "DELETE", `${root}/members/user_bob`, undefined, 503);
  assert.deepEqual((await x.call("user_bob", "GET", "/v1/servers")).items, []);
  await x.control("sync");
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await x.call("user_alice", "DELETE", `${root}/members/user_bob`)).status,
      "removed",
    );
  const credential = await x.mcpToken(account.organizationId, "user_bob");
  for (const server of servers)
    assert.equal(
      (await x.mcp(credential, "get_context", { serverId: server.id }, true)).error.code,
      "server_unavailable",
    );
  await x.control("member", {
    ...membership,
    updatedAt: new Date(Date.now() + 1000).toISOString(),
  });
  await x.call("user_bob", "GET", "/v1/accounts");
  assert.deepEqual((await x.call("user_bob", "GET", "/v1/servers")).items, []);
});

test("ownership, independent agent registration, explicit sharing, revocation and regrant", async (t) => {
  const x = await start(t);
  const account = await x.account();
  await x.control("member", x.member(account.organizationId));
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  assert.equal((await x.call("user_alice", "GET", "/v1/servers")).items.length, 1);
  assert.equal((await x.call("user_bob", "GET", "/v1/servers")).items.length, 0);
  await x.call("user_bob", "GET", root, undefined, 404);
  await x.call("user_bob", "PUT", `${root}/access/user_bob`, undefined, 404);
  await x.call("user_alice", "PUT", `${root}/access/user_outside`, undefined, 404);
  const grant = await x.call("user_alice", "PUT", `${root}/access/user_bob`);
  assert.equal(grant.revision, grant.appliedRevision);
  const state = await x.call("user_bob", "GET", root);
  const a = (
    await x.call("user_bob", "POST", `${root}/participants`, {
      name: "Alpha",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).item;
  const b = (
    await x.call("user_bob", "POST", `${root}/participants`, {
      name: "Beta",
      agentType: "claude",
      requestKey: randomUUID(),
    })
  ).item;
  assert.notEqual(a.id, b.id);
  await x.call(
    "user_bob",
    "POST",
    `${root}/conversations/${state.generalConversationId}/messages`,
    { participantId: a.id, body: "Shared context", requestKey: randomUUID() },
  );
  assert.equal(
    (
      await x.call(
        "user_alice",
        "GET",
        `${root}/conversations/${state.generalConversationId}/messages`,
      )
    ).items[0].body,
    "Shared context",
  );
  const revoked = await x.call("user_alice", "DELETE", `${root}/access/user_bob`);
  assert.ok(revoked.revokedAt);
  await x.call("user_bob", "GET", root, undefined, 404);
  assert.equal((await x.call("user_bob", "GET", "/v1/servers")).items.length, 0);
  await x.control(`apply?server=${server.id}`, { ...grant, principalKey: "workos:user_bob" });
  await x.call("user_bob", "GET", root, undefined, 404);
  const renewed = await x.call("user_alice", "PUT", `${root}/access/user_bob`);
  assert.notEqual(renewed.id, grant.id);
  await x.call("user_bob", "GET", root);
  const retry = await x.call("user_alice", "PUT", `${root}/access/user_bob`);
  assert.equal(retry.id, renewed.id);
});

test("no D1 or identity provider on ordinary messaging; forged authority is stripped", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  await x.control("database-down?value=true");
  const state = await x.call("user_alice", "GET", root);
  const participant = (
    await x.call("user_alice", "POST", `${root}/participants`, {
      name: "Agent",
      agentType: "codex",
      requestKey: randomUUID(),
    })
  ).item;
  await x.call(
    "user_alice",
    "POST",
    `${root}/conversations/${state.generalConversationId}/messages`,
    { participantId: participant.id, body: "Works without platform", requestKey: randomUUID() },
  );
  await x.call("user_alice", "GET", `${root}/messages/search?query=platform`);
  await x.call("user_bob", "GET", root, undefined, 404, {
    "x-talkto-principal": "workos:user_alice",
    "x-talkto-access": JSON.stringify({
      serverId: server.id,
      principalKey: "workos:user_alice",
      grantId: randomUUID(),
    }),
  });
  await x.call("user_alice", "GET", `/v1/servers/${randomUUID()}`, undefined, 404);
});

test("idempotent provisioning and durable retry of failed access delivery", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const input = { requestKey: "server-creation" };
  const server = await x.server(account.id, input);
  assert.equal((await x.server(account.id, input)).id, server.id);
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/servers`,
    { name: "Changed", requestKey: input.requestKey },
    409,
  );
  const grants = () =>
    x.db
      .prepare("SELECT COUNT(*) AS n FROM server_access")
      .first()
      .then((row) => row.n);
  assert.equal(await grants(), 1, "a replay and a changed name add no access grant");
  // A deleted server's request key never makes a server again.
  const gone = await x.server(account.id, { name: "Gone", requestKey: "deleted-server" });
  await x.call("user_alice", "POST", `/v1/accounts/${account.id}/servers/${gone.id}/delete`, {
    confirmation: "Gone",
  });
  await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/servers`,
    { name: "Gone", requestKey: "deleted-server" },
    404,
  );
  await x.control("member", x.member(account.organizationId));
  await x.control(`fail?server=${server.id}`);
  await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`, undefined, 503);
  await x.call("user_bob", "GET", `/v1/servers/${server.id}`, undefined, 404);
  await x.control("sync");
  await x.call("user_bob", "GET", `/v1/servers/${server.id}`);
  await x.control(`fail?server=${server.id}`);
  await x.call("user_alice", "DELETE", `/v1/servers/${server.id}/access/user_bob`, undefined, 503);
  await x.control("sync");
  await x.call("user_bob", "GET", `/v1/servers/${server.id}`, undefined, 404);
});

test("membership departure revokes across servers and stale identity events cannot restore access", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const active = x.member(account.organizationId);
  await x.control("member", active);
  const first = await x.server(account.id);
  const second = await x.server(account.id);
  for (const server of [first, second])
    await x.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  await x.control("sync");
  const inactive = {
    ...active,
    status: "inactive",
    updatedAt: new Date(Date.now() + 1000).toISOString(),
  };
  await x.control("member", inactive);
  await x.control("sync");
  for (const server of [first, second])
    await x.call("user_bob", "GET", `/v1/servers/${server.id}`, undefined, 404);
  await x.control("member", active);
  await x.control("sync");
  await x.call("user_alice", "PUT", `/v1/servers/${first.id}/access/user_bob`, undefined, 404);
  assert.equal((await x.call("user_bob", "GET", "/v1/servers")).items.length, 0);
});

test("interrupted server provisioning resumes from its durable reservation", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const id = randomUUID();
  const generalId = randomUUID();
  const input = { name: "Interrupted", requestKey: "resume-provision" };
  await x.db
    .prepare(
      "INSERT INTO servers(id,account_id,name,created_by,request_key,general_id,created_at,status) VALUES(?,?,?,?,?,?,?,'provisioning')",
    )
    .bind(
      id,
      account.id,
      input.name,
      "user_alice",
      input.requestKey,
      generalId,
      new Date().toISOString(),
    )
    .run();
  await x.control(`fail-provision?server=${id}`);
  await x.call("user_alice", "POST", `/v1/accounts/${account.id}/servers`, input, 503);
  assert.equal((await x.call("user_alice", "GET", "/v1/servers")).items.length, 0);
  await x.call("user_alice", "GET", `/v1/servers/${id}`, undefined, 404);
  const managed = await x.call("user_alice", "GET", `/v1/accounts/${account.id}/servers`);
  assert.equal(managed.items[0].id, id);
  assert.equal(managed.items[0].status, "provisioning");
  const organizations = await x.call("user_alice", "GET", "/v1/accounts");
  assert.equal(organizations.items.find((item) => item.id === account.id).serverCount, 1);
  const detail = await x.call("user_alice", "GET", `/v1/accounts/${account.id}/servers/${id}`);
  assert.equal(detail.status, "provisioning");
  assert.equal(detail.permissions.readMessages, false);
  assert.equal(detail.permissions.resume, true);
  assert.deepEqual(managed.items[0].permissions, {
    readMessages: false,
    manageAccess: true,
    resume: true,
  });
  await x.control("member", x.member(account.organizationId));
  await x.call(
    "user_bob",
    "POST",
    `/v1/accounts/${account.id}/servers/${id}/resume`,
    undefined,
    404,
  );
  const recovered = await x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${account.id}/servers/${id}/resume`,
  );
  assert.equal(recovered.status, "ready");
  assert.deepEqual(recovered.permissions, {
    readMessages: true,
    manageAccess: true,
    resume: false,
  });
  const resumed = await x.call("user_alice", "POST", `/v1/accounts/${account.id}/servers`, input);
  assert.equal(resumed.id, id);
  assert.equal(
    (await x.call("user_alice", "GET", `/v1/servers/${id}`)).generalConversationId,
    generalId,
  );
  assert.equal((await x.call("user_alice", "GET", `/v1/servers/${id}/channels`)).items.length, 1);
});

test("JWT verification rejects invalid issuer, audience, expiry and signatures; OpenAPI describes both layers", async (t) => {
  const x = await start(t);
  for (const token of [
    await x.token("user_alice", { issuer: "https://elsewhere.test" }),
    await x.token("user_alice", { issuer: "https://api.workos.com/user_management/client_other" }),
    await x.token("user_alice", { claims: { aud: "other-app" } }),
    await x.token("user_alice", { expiry: "-1m" }),
    "not-a-jwt",
  ]) {
    const response = await x.raw("/v1/accounts", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
  }
  const doc = await (await x.raw("/openapi.json")).json();
  assert.ok(doc.paths["/v1/accounts"].post);
  assert.ok(doc.paths["/v1/servers/{serverId}/participants"].post);
  assert.ok(doc.paths["/v1/servers/{serverId}/access/{userId}"].delete);
});

test("MCP authentication discovery, catalog, instructions and protocol compatibility", async (t) => {
  const x = await start(t);
  const resource = await x.raw("/.well-known/oauth-protected-resource/mcp");
  assert.equal(resource.status, 200);
  assert.deepEqual(await resource.json(), {
    resource: "https://talkto.test/mcp",
    authorization_servers: ["https://auth.talkto.test"],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "offline_access"],
    resource_documentation: "https://talkto.test/instructions",
  });
  const challenge =
    'Bearer resource_metadata="https://talkto.test/.well-known/oauth-protected-resource/mcp", scope="openid offline_access"';
  const unauthorized = await x.raw("/mcp", rpc("server/discover"));
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("www-authenticate"), challenge);
  assert.equal(unauthorized.headers.get("link"), '<https://talkto.test/instructions>; rel="help"');
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");
  for (const authorization of ["Basic dGVzdDp0ZXN0", "Bearer"]) {
    const request = rpc("server/discover");
    request.headers.authorization = authorization;
    const response = await x.raw("/mcp", request);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), challenge);
  }
  const credential = await x.mcpToken();
  for (const invalidCredential of [
    await x.token(),
    await x.mcpToken(undefined, "user_alice", { claims: { aud: "other" } }),
    await x.mcpToken(undefined, "user_alice", { expiry: "-1m" }),
    `${(await x.mcpToken()).split(".").slice(0, 2).join(".")}.invalid-signature`,
    "broken",
  ]) {
    const request = rpc("server/discover", {}, invalidCredential);
    request.headers.origin = "https://talkto.test";
    const rejected = await x.raw("/mcp", request);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get("www-authenticate"), `${challenge}, error="invalid_token"`);
    assert.equal(rejected.headers.get("access-control-allow-origin"), "https://talkto.test");
    assert.equal(
      rejected.headers.get("access-control-expose-headers"),
      "WWW-Authenticate, Link, MCP-Protocol-Version",
    );
  }
  const discovery = await x.raw("/mcp", rpc("server/discover", {}, credential));
  const discoverBody = await discovery.json();
  assert.equal(discovery.status, 200, JSON.stringify(discoverBody));
  assert.equal(discovery.headers.get("www-authenticate"), null);
  assert.ok(JSON.stringify(discoverBody.result).includes("TalkTo"), JSON.stringify(discoverBody));
  const listed = await x.raw("/mcp", rpc("tools/list", {}, credential));
  const catalog = await listed.json();
  assert.deepEqual(
    catalog.result.tools.map((tool) => tool.name),
    [
      "get_context",
      "get_updates",
      "register_participant",
      "rename_participant",
      "read_messages",
      "send_message",
      "confirm_message",
      "create_channel",
      "set_channel_archived",
      "create_signal",
      "revoke_signal",
      "send_feedback",
      "create_agent_invite",
      "list_agent_invites",
      "revoke_agent_invite",
    ],
  );
  const feedbackTool = catalog.result.tools.find((tool) => tool.name === "send_feedback");
  assert.equal(feedbackTool.inputSchema.anyOf, undefined);
  assert.deepEqual(feedbackTool.inputSchema.required.toSorted(), ["kind", "message", "requestKey"]);
  assert.equal(feedbackTool.annotations?.readOnlyHint ?? false, false);
  assert.ok(
    catalog.result.tools.every((tool) => tool.inputSchema.type === "object" && tool.outputSchema),
  );
  const guide = await x.raw(
    "/mcp",
    rpc("resources/read", { uri: "talkto://instructions" }, credential),
  );
  const publishedGuide = await (await x.raw("/instructions")).text();
  assert.ok(publishedGuide.includes("codex mcp add talkto --url https://talkto.test/mcp"));
  assert.ok(publishedGuide.includes('"url": "https://talkto.test/mcp"'));
  assert.ok(!publishedGuide.includes("YOUR-TALKTO-HOST"));
  assert.equal((await guide.json()).result.contents[0].text, publishedGuide);
  const empty = await x.mcp(credential, "get_context", { includeInstructions: true });
  assert.equal(empty.data.items.length, 0);
  assert.match(empty.meta.instructions.text, /owner/);
  assert.equal(empty.meta.instructionSheet, publishedGuide);
  const invalid = await x.mcp(credential, "send_message", { body: "missing arguments" }, true);
  assert.equal(invalid.error.code, "invalid_input");
  const forbiddenOrigin = rpc("server/discover", {}, credential);
  forbiddenOrigin.headers.origin = "https://attacker.test";
  assert.equal((await x.raw("/mcp", forbiddenOrigin)).status, 403);
  const preflight = await x.raw("/mcp", {
    method: "OPTIONS",
    headers: { origin: "https://talkto.test", "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://talkto.test");
  assert.equal(preflight.headers.get("vary"), "Origin");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, GET, OPTIONS");
  assert.equal(
    preflight.headers.get("access-control-allow-headers"),
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  );
  assert.equal(
    preflight.headers.get("access-control-expose-headers"),
    "WWW-Authenticate, Link, MCP-Protocol-Version",
  );
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  const legacy = await x.raw(
    "/mcp",
    rpc(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "Legacy test", version: "1" },
      },
      credential,
      "2025-11-25",
    ),
  );
  const initialized = await packet(legacy);
  assert.equal(legacy.status, 200, JSON.stringify(initialized));
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  const legacyCall = await x.raw(
    "/mcp",
    rpc("tools/call", { name: "get_context", arguments: {} }, credential, "2025-11-25"),
  );
  assert.ok((await packet(legacyCall)).result.structuredContent);
  const brokenHeaders = rpc("tools/call", { name: "get_context", arguments: {} }, credential);
  brokenHeaders.headers["Mcp-Name"] = "send_message";
  assert.equal((await x.raw("/mcp", brokenHeaders)).status, 400);
});

test("MCP identity-provider outages remain retryable without a sign-in challenge", async (t) => {
  for (const mcpJwksResponse of [
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 429 }),
    () => new Response("Invalid JSON"),
    () => Response.json({ keys: null }),
  ]) {
    const x = await start(t, { mcpJwksResponse });
    const response = await x.raw("/mcp", rpc("server/discover", {}, await x.mcpToken()));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).error.code, "identity_unavailable");
  }
});

test("MCP tokens verify with the issuer's configured fallback keys when its key set is unreachable", async (t) => {
  for (const [mcpFallbackKeys, status] of [
    [
      (keys, aliasKeys) => ({
        "https://auth.talkto.test": keys,
        "https://old-auth.talkto.test": aliasKeys,
      }),
      200,
    ],
    // A fallback holding another key rejects the token instead of signing anyone in.
    [
      (_keys, aliasKeys) => ({
        "https://auth.talkto.test": { keys: [{ ...aliasKeys.keys[0], kid: "test" }] },
      }),
      401,
    ],
  ]) {
    const x = await start(t, {
      mcpFallbackKeys,
      mcpJwksResponse: () => {
        throw new Error("unreachable from this colo");
      },
    });
    const response = await x.raw("/mcp", rpc("server/discover", {}, await x.mcpToken()));
    assert.equal(response.status, status, await response.text());
    assert.ok(x.jwksFetches.includes("auth.talkto.test"), "the live key set is tried first");
  }
});

test("MCP tokens from an AuthKit issuer alias verify with that issuer's own keys during a domain switch", async (t) => {
  const x = await start(t, { mcpJwksResponse: (keys) => Response.json(keys) });
  const resource = await (await x.raw("/.well-known/oauth-protected-resource/mcp")).json();
  assert.deepEqual(resource.authorization_servers, ["https://auth.talkto.test"], "never the alias");
  const discover = (credential) => x.raw("/mcp", rpc("server/discover", {}, credential));
  const old = "https://old-auth.talkto.test";
  for (const credential of [
    await x.mcpToken(),
    await x.mcpToken(undefined, "user_alice", { issuer: old, aliasKey: true }),
  ]) {
    const response = await discover(credential);
    assert.equal(response.status, 200, await response.text());
  }
  for (const credential of [
    // An issuer outside the allowed set, signed by either trusted key.
    await x.mcpToken(undefined, "user_alice", { issuer: "https://evil.talkto.test" }),
    await x.mcpToken(undefined, "user_alice", {
      issuer: "https://evil.talkto.test",
      aliasKey: true,
    }),
    // A primary-signed token claiming the alias issuer, under either key ID, and the reverse.
    await x.mcpToken(undefined, "user_alice", { issuer: old }),
    await x.mcpToken(undefined, "user_alice", { issuer: old, kid: "alias" }),
    await x.mcpToken(undefined, "user_alice", { aliasKey: true }),
    await x.mcpToken(undefined, "user_alice", { aliasKey: true, kid: "test" }),
    // No issuer at all.
    await x.mcpToken(undefined, "user_alice", { issuer: "" }),
  ]) {
    const response = await discover(credential);
    assert.equal(response.status, 401, await response.text());
    assert.match(response.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  }
  assert.ok(x.jwksFetches.includes("auth.talkto.test"));
  assert.ok(x.jwksFetches.includes("old-auth.talkto.test"));
  assert.ok(
    !x.jwksFetches.includes("evil.talkto.test"),
    "an unlisted issuer's keys are never fetched",
  );
});

test("an invalid MCP issuer alias list accepts only the primary issuer", async (t) => {
  for (const mcpIssuerAliases of [
    "not json",
    '"https://old-auth.talkto.test"',
    '["https://old-auth.talkto.test/path"]',
    '["http://old-auth.talkto.test"]',
  ]) {
    const x = await start(t, { mcpIssuerAliases });
    const discover = (credential) => x.raw("/mcp", rpc("server/discover", {}, credential));
    assert.equal((await discover(await x.mcpToken())).status, 200);
    const old = await x.mcpToken(undefined, "user_alice", {
      issuer: "https://old-auth.talkto.test",
      aliasKey: true,
    });
    assert.equal((await discover(old)).status, 401);
  }
});

test("MCP agents share authorization, retain separate identities and exchange full contextual messages", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const register = (name) =>
    x.mcp(credential, "register_participant", {
      serverId: server.id,
      requestKey: randomUUID(),
      name,
      agentType: "codex",
      joinedNote: "Testing MCP ergonomics",
    });
  const alpha = await register("McpAlpha");
  const beta = await register("McpBeta");
  const gamma = await register("McpGamma");
  assert.notEqual(alpha.data.item.id, beta.data.item.id);
  assert.equal(alpha.data.context.general.conversation.name, "General");
  const send = (participant, target, body, requestKey = randomUUID(), error = false) =>
    x.mcp(
      credential,
      "send_message",
      { serverId: server.id, participantId: participant.data.item.id, target, body, requestKey },
      error,
    );
  const general = { kind: "conversation", conversationId: alpha.data.generalConversationId };
  await send(alpha, general, "Alpha checking in.");
  await send(beta, general, "Beta checking in.");
  const key = randomUUID();
  const long = "Shared context: " + "🧠".repeat(300);
  const direct = await send(alpha, { kind: "direct", recipientId: beta.data.item.id }, long, key);
  const replay = await send(alpha, { kind: "direct", recipientId: beta.data.item.id }, long, key);
  assert.equal(direct.data.item.id, replay.data.item.id);
  assert.equal(replay.data.created, false);
  const changed = await send(
    alpha,
    { kind: "direct", recipientId: gamma.data.item.id },
    "different",
    key,
    true,
  );
  assert.equal(changed.error.code, "idempotency_conflict");
  let overview = await x.mcp(credential, "get_context", {
    serverId: server.id,
    participant: { name: "mcpalpha" },
  });
  assert.equal(overview.data.self.id, alpha.data.item.id);
  assert.equal(
    overview.data.directChats.items.length,
    1,
    "conflicting retry must not leave an empty direct chat",
  );
  assert.equal(overview.data.directChats.items[0].latestMessage.truncated, true);
  const expand = overview.meta.nextActions.find((a) => a.arguments.mode === "around");
  assert.ok(expand);
  const expanded = await x.mcp(credential, expand.tool, expand.arguments);
  assert.equal(expanded.data.anchor.id, direct.data.item.id);
  assert.equal(expanded.data.anchor.body, long);
  assert.deepEqual(expanded.data.before, []);
  assert.deepEqual(expanded.data.after, []);
  const reply = await send(
    beta,
    { kind: "direct", recipientId: alpha.data.item.id },
    "Received your context.",
  );
  assert.equal(reply.data.item.conversationId, direct.data.item.conversationId);
  const history = await x.mcp(credential, "read_messages", {
    serverId: server.id,
    mode: "history",
    conversationId: direct.data.item.conversationId,
  });
  assert.equal(history.data.items[0].body, long);
  assert.equal(history.included.participants.length, 2);
  const around = await x.mcp(credential, "read_messages", {
    serverId: server.id,
    mode: "around",
    messageId: direct.data.item.id,
    before: 0,
    after: 0,
  });
  assert.equal(around.data.anchor.body, long);
  const searched = await x.mcp(credential, "read_messages", {
    serverId: server.id,
    mode: "search",
    query: "context",
  });
  assert.equal(searched.data.items.length, 2);
  const outsider = await send(
    gamma,
    { kind: "conversation", conversationId: direct.data.item.conversationId },
    "Cannot send as a third participant",
    randomUUID(),
    true,
  );
  assert.equal(outsider.error.code, "not_conversation_participant");
  overview = await x.mcp(credential, "get_context", {
    serverId: server.id,
    participant: { id: gamma.data.item.id },
    directChats: "all",
  });
  assert.equal(overview.data.directChats.items.length, 1);
  assert.ok(!overview.meta.nextActions.some((a) => a.arguments.mode === "around"));
  const created = await x.mcp(credential, "create_channel", {
    serverId: server.id,
    participantId: alpha.data.item.id,
    requestKey: randomUUID(),
    name: "Planning",
  });
  const archived = await x.mcp(credential, "set_channel_archived", {
    serverId: server.id,
    participantId: beta.data.item.id,
    conversationId: created.data.item.id,
    archived: true,
    expectedRevision: 0,
  });
  assert.equal(archived.data.revision, 1);
  const empty = await x.mcp(credential, "read_messages", {
    serverId: server.id,
    mode: "history",
    conversationId: created.data.item.id,
  });
  assert.equal(empty.included.conversations[0].revision, 1);
  assert.equal(empty.data.items.length, 0);
  const tooLong = await send(alpha, general, "🧠".repeat(4097), randomUUID(), true);
  assert.equal(tooLong.error.code, "invalid_input");
});

test("MCP preview actions stay bounded and preserve directory navigation", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const register = (name) =>
    x.mcp(credential, "register_participant", {
      serverId: server.id,
      name,
      agentType: "codex",
      requestKey: randomUUID(),
    });
  const alpha = await register("Alpha");
  const sent = [];
  for (let i = 0; i < 6; i++) {
    const channel = await x.mcp(credential, "create_channel", {
      serverId: server.id,
      participantId: alpha.data.item.id,
      name: `Preview${i}`,
      requestKey: randomUUID(),
    });
    if (i === 0) continue;
    const message = await x.mcp(credential, "send_message", {
      serverId: server.id,
      participantId: alpha.data.item.id,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: channel.data.item.id },
      body: i === 1 ? "Short message" : `Full message ${i}: ` + "🧠".repeat(300),
    });
    sent.push(message.data.item);
  }
  const general = await x.mcp(credential, "send_message", {
    serverId: server.id,
    participantId: alpha.data.item.id,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: alpha.data.generalConversationId },
    body: "General in full: " + "x".repeat(300),
  });
  const beta = await register("Beta");
  const context = await x.mcp(credential, "get_context", { serverId: server.id });
  for (const result of [beta, context]) {
    const actions = result.meta.nextActions.filter((a) => a.arguments.mode === "around");
    assert.deepEqual(
      actions.map((a) => a.arguments.messageId),
      sent
        .slice(-3)
        .reverse()
        .map((m) => m.id),
    );
    for (const action of actions) {
      const full = await x.mcp(credential, action.tool, action.arguments);
      assert.equal(
        full.data.anchor.body,
        sent.find((m) => m.id === action.arguments.messageId).body,
      );
    }
  }
  // General also holds TalkTo's announcement of each channel created above.
  const latestGeneral = context.data.general.items.find((m) => m.id === general.data.item.id);
  assert.equal(latestGeneral?.body, general.data.item.body);
  assert.equal(context.data.general.items.filter((m) => m.notice !== undefined).length, 6);

  // Obtain a real directory cursor, then follow it through the public MCP entrypoint.
  const first = await x.call(
    "user_alice",
    "GET",
    `/v1/servers/${server.id}/channels?state=all&limit=3`,
  );
  const page = await x.mcp(credential, "get_context", {
    serverId: server.id,
    page: { section: "channels", cursor: first.nextCursor, limit: 2 },
  });
  assert.deepEqual(
    page.data.items.map((c) => c.name),
    ["Preview2", "Preview3"],
  );
  const continuation = page.meta.nextActions.find((a) => a.tool === "get_context");
  assert.ok(continuation);
  assert.equal(continuation.arguments.page.limit, 2);
  const remainder = await x.mcp(credential, continuation.tool, continuation.arguments);
  assert.deepEqual(
    remainder.data.items.map((c) => c.name),
    ["Preview4", "Preview5"],
  );
  for (const action of page.meta.nextActions.filter((a) => a.arguments.mode === "around")) {
    const full = await x.mcp(credential, action.tool, action.arguments);
    assert.ok(page.data.items.some((c) => c.latestMessage.id === full.data.anchor.id));
  }
});

test("MCP reaches granted servers in every organization and enforces current grants without D1 on message operations", async (t) => {
  const x = await start(t);
  const a = await x.account();
  const b = await x.account();
  const first = await x.server(a.id);
  const second = await x.server(b.id);
  const closed = await x.server(b.id);
  await x.control("member", x.member(a.organizationId));
  await x.control("member", x.member(b.organizationId));
  await x.call("user_alice", "PUT", `/v1/servers/${first.id}/access/user_bob`);
  await x.call("user_alice", "PUT", `/v1/servers/${second.id}/access/user_bob`);
  // A token from organization A reaches Bob's granted server in organization B as well. A token
  // without an organization sees the same; the server he was not granted looks unknown to both.
  const bob = await x.mcpToken(a.organizationId, "user_bob");
  const unscoped = await x.mcpToken(undefined, "user_bob");
  for (const credential of [bob, unscoped]) {
    const discovery = await x.mcp(credential, "get_context", {});
    assert.deepEqual(discovery.data.items.map((s) => s.id).sort(), [first.id, second.id].sort());
    const across = await x.mcp(credential, "get_context", { serverId: second.id });
    assert.equal(across.data.server.id, second.id);
    const denied = await x.mcp(credential, "get_context", { serverId: closed.id }, true);
    const unknown = await x.mcp(credential, "get_context", { serverId: randomUUID() }, true);
    assert.deepEqual(denied.error, unknown.error);
  }
  const elsewhere = await x.mcp(bob, "register_participant", {
    serverId: second.id,
    name: "Elsewhere",
    agentType: "claude",
    requestKey: randomUUID(),
  });
  assert.equal(elsewhere.data.created, true);
  const registered = await x.mcp(bob, "register_participant", {
    serverId: first.id,
    name: "Worker",
    agentType: "claude",
    requestKey: randomUUID(),
  });
  await x.control("database-down?value=true");
  const sent = await x.mcp(bob, "send_message", {
    serverId: first.id,
    participantId: registered.data.item.id,
    requestKey: randomUUID(),
    target: { kind: "conversation", conversationId: registered.data.generalConversationId },
    body: "No platform database required.",
  });
  assert.equal(sent.data.created, true);
  await x.mcp(bob, "read_messages", { serverId: first.id, mode: "search", query: "platform" });
  const watch = {
    serverId: first.id,
    participantId: registered.data.item.id,
    mode: "start",
    channelIds: [registered.data.generalConversationId],
    directChats: "own",
    startAt: "beginning",
  };
  const updates = await x.mcp(bob, "get_updates", watch);
  assert.deepEqual(updates.data.messages, []);
  await x.control("database-down?value=false");
  const renewed = await x.mcpToken(a.organizationId, "user_bob");
  const resume = {
    serverId: first.id,
    participantId: registered.data.item.id,
    mode: "poll",
    checkpoint: updates.data.checkpoint,
  };
  assert.deepEqual((await x.mcp(renewed, "get_updates", resume)).data.messages, []);
  await x.call("user_alice", "DELETE", `/v1/servers/${first.id}/access/user_bob`);
  assert.equal(
    (await x.mcp(renewed, "get_updates", resume, true)).error.code,
    "server_unavailable",
  );
  const revoked = await x.mcp(bob, "get_context", { serverId: first.id }, true);
  assert.equal(revoked.error.code, "server_unavailable");
  assert.deepEqual(
    (await x.mcp(bob, "get_context", {})).data.items.map((s) => s.id),
    [second.id],
  );
});

test("hosted updates upgrade existing servers and never schedule activity alarms", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const register = (name) =>
    x.mcp(credential, "register_participant", {
      serverId: server.id,
      name,
      agentType: "codex",
      requestKey: randomUUID(),
    });
  const me = await register("Watcher");
  const peer = await register("Sender");
  const sent = await x.mcp(credential, "send_message", {
    serverId: server.id,
    participantId: peer.data.item.id,
    requestKey: randomUUID(),
    target: { kind: "direct", recipientId: me.data.item.id },
    body: "Preserved across hosted upgrade.",
  });
  await x.control(`updates?server=${server.id}`, "downgrade");
  const watch = {
    serverId: server.id,
    participantId: me.data.item.id,
    mode: "start",
    channelIds: [],
    directChats: "own",
    startAt: "beginning",
  };
  const batch = await x.mcp(credential, "get_updates", watch);
  assert.deepEqual(batch.data.messages, [sent.data.item]);
  assert.equal(
    (await (await x.control(`updates?server=${server.id}`, "clear-alarm")).json()).version,
    11,
  );
  const resume = {
    serverId: server.id,
    participantId: me.data.item.id,
    mode: "poll",
    checkpoint: batch.data.checkpoint,
  };
  for (let index = 0; index < 3; index++) {
    assert.deepEqual((await x.mcp(credential, "get_updates", resume)).data.messages, []);
    const { serverId, ...input } = resume;
    assert.deepEqual(
      (await x.call("user_alice", "POST", `/v1/servers/${serverId}/updates`, input)).messages,
      [],
    );
  }
  assert.equal(
    (await (await x.control(`updates?server=${server.id}`, "inspect")).json()).alarm,
    null,
  );
});

test("SDK v2 validates schemas and tools independently in modern and legacy modes", async (t) => {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  for (const mode of [{ pin: "2026-07-28" }, "legacy"]) {
    const observed = [];
    const client = new Client(
      { name: "TalkTo SDK integration", version: "1" },
      { versionNegotiation: { mode } },
    );
    const transport = new StreamableHTTPClientTransport(new URL("https://talkto.test/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
      fetch: async (input, init) => {
        if (init?.body) observed.push(JSON.parse(init.body).method);
        const response = await x.raw(new URL(input).pathname, init);
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 15);
      const result = await client.callTool({ name: "get_context", arguments: {} });
      assert.equal(result.structuredContent.data.kind, "servers");
      assert.match(result.structuredContent.meta.instructions.text, /talkto:\/\/instructions/);
      const registered = await client.callTool({
        name: "register_participant",
        arguments: {
          serverId: server.id,
          name: `Native_${mode === "legacy" ? "Legacy" : "Modern"}`,
          agentType: "codex",
          requestKey: randomUUID(),
        },
      });
      const joined = registered.structuredContent;
      assert.equal(registered.isError ?? false, false, JSON.stringify(joined));
      assert.match(joined.meta.instructions.text, /stop when the work ends/);
      const startAction = joined.meta.nextActions.find((action) => action.tool === "get_updates");
      const baseline = await client.callTool({
        name: startAction.tool,
        arguments: { ...startAction.arguments, startAt: "now" },
      });
      const sender = await x.mcp(credential, "register_participant", {
        serverId: server.id,
        name: `Peer_${mode === "legacy" ? "Legacy" : "Modern"}`,
        agentType: "claude",
        requestKey: randomUUID(),
      });
      const message = await x.mcp(credential, "send_message", {
        serverId: server.id,
        participantId: sender.data.item.id,
        requestKey: randomUUID(),
        target: { kind: "direct", recipientId: joined.data.item.id },
        body: "Native client new DM.",
      });
      const pollAction = baseline.structuredContent.meta.nextActions.find(
        (action) => action.tool === "get_updates",
      );
      const incoming = await client.callTool({
        name: pollAction.tool,
        arguments: pollAction.arguments,
      });
      assert.deepEqual(incoming.structuredContent.data.messages, [message.data.item]);
      const guide = await client.readResource({ uri: "talkto://instructions" });
      assert.match(guide.contents[0].text, /get_updates/);
      assert.ok(observed.includes(mode === "legacy" ? "initialize" : "server/discover"));
      if (mode !== "legacy") assert.ok(!observed.includes("initialize"));
    } finally {
      await client.close();
    }
  }
});

test("MCP bounded context and message continuations return executable calls without skipped records", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const root = `/v1/servers/${server.id}`;
  let participant;
  for (let i = 0; i < 102; i++) {
    const registered = await x.call("user_alice", "POST", `${root}/participants`, {
      name: `Peer${String(i).padStart(3, "0")}`,
      agentType: "codex",
      requestKey: `peer-${i}`,
    });
    participant ??= registered.item;
  }
  const context = await x.mcp(credential, "get_context", { serverId: server.id });
  assert.equal(context.data.participants.items.length, 100);
  const action = context.meta.nextActions.find((a) => a.arguments.page?.section === "participants");
  assert.ok(action);
  const remainder = await x.mcp(credential, action.tool, action.arguments);
  assert.equal(remainder.data.kind, "participants");
  assert.equal(remainder.data.items.length, 2);
  assert.equal(remainder.data.nextCursor, null);
  assert.ok(!("general" in remainder.data));
  const oneParticipant = await x.mcp(credential, action.tool, {
    ...action.arguments,
    page: { ...action.arguments.page, limit: 1 },
  });
  assert.equal(oneParticipant.data.items.length, 1);
  const lastParticipantAction = oneParticipant.meta.nextActions[0];
  assert.equal(lastParticipantAction.arguments.page.limit, 1);
  const lastParticipant = await x.mcp(
    credential,
    lastParticipantAction.tool,
    lastParticipantAction.arguments,
  );
  assert.equal(lastParticipant.data.items.length, 1);
  assert.equal(lastParticipant.data.nextCursor, null);
  assert.notEqual(oneParticipant.data.items[0].id, lastParticipant.data.items[0].id);
  const conflicting = await x.mcp(
    credential,
    action.tool,
    { ...action.arguments, participant: { id: participant.id } },
    true,
  );
  assert.equal(conflicting.error.code, "invalid_input");
  const conversationId = context.data.general.conversation.id;
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const sent = await x.mcp(credential, "send_message", {
      serverId: server.id,
      participantId: participant.id,
      requestKey: `large-${i}`,
      target: { kind: "conversation", conversationId },
      body: `Budget ${i} ` + "x".repeat(16360),
    });
    ids.push(sent.data.item.id);
  }
  const first = await x.mcp(credential, "read_messages", {
    serverId: server.id,
    mode: "history",
    conversationId,
  });
  assert.equal(first.data.items.length, 4);
  const more = first.meta.nextActions[0];
  const second = await x.mcp(credential, more.tool, more.arguments);
  assert.deepEqual(
    [...second.data.items, ...first.data.items].map((m) => m.id),
    ids,
  );
  for (const selector of [
    { mode: "history", conversationId },
    { mode: "search", query: "Budget" },
  ]) {
    let page = await x.mcp(credential, "read_messages", {
      serverId: server.id,
      ...selector,
      limit: 2,
    });
    const seen = [];
    for (;;) {
      assert.equal(page.data.items.length, 2);
      seen.push(...page.data.items.map((item) => item.id));
      const action = page.meta.nextActions[0];
      if (!action) break;
      assert.equal(action.arguments.limit, 2);
      page = await x.mcp(credential, action.tool, action.arguments);
    }
    assert.equal(new Set(seen).size, 6);
    assert.deepEqual([...seen].sort(), [...ids].sort());
  }
  const malicious = await x.mcp(
    credential,
    "read_messages",
    { serverId: server.id, mode: "search", cursor: first.data.nextCursor, query: "changed" },
    true,
  );
  assert.equal(malicious.error.code, "invalid_input");
  for (let i = 0; i < 20; i++)
    await x.call("user_alice", "POST", `${root}/participants`, {
      name: `LongProfile${i}`,
      agentType: "codex",
      requestKey: `long-profile-${i}`,
      workingDirectory: "/" + "x".repeat(2000),
      joinedNote: "n".repeat(1000),
    });
  const bounded = await x.mcp(credential, "get_context", { serverId: server.id });
  assert.ok(bounded.data.participants.items.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.data.participants)) < 32768);
  assert.equal(bounded.data.participants.items[0].joinedNote.length, 1000);
  const seen = new Set(bounded.data.participants.items.map((p) => p.id));
  let next = bounded.meta.nextActions.find((a) => a.arguments.page?.section === "participants");
  while (next) {
    const continued = await x.mcp(credential, next.tool, next.arguments);
    for (const participant of continued.data.items) {
      assert.ok(!seen.has(participant.id));
      seen.add(participant.id);
    }
    next = continued.meta.nextActions[0];
  }
  assert.equal(seen.size, 122);
});

test("MCP accepts zoned timestamps with optional milliseconds and explains invalid fields", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const registered = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "Clock",
    agentType: "codex",
    requestKey: "clock",
  });
  const conversationId = registered.data.generalConversationId;
  const sent = await x.mcp(credential, "send_message", {
    serverId: server.id,
    participantId: registered.data.item.id,
    target: { kind: "conversation", conversationId },
    body: "Timestamp input",
    requestKey: "timestamp",
  });
  for (const time of [
    "1970-01-01T00:00:00Z",
    "1970-01-01T07:00:00.0+07:00",
    "1969-12-31T17:00:00.000-07:00",
  ]) {
    const history = await x.mcp(credential, "read_messages", {
      serverId: server.id,
      mode: "history",
      conversationId,
      position: { kind: "afterTime", time },
    });
    assert.deepEqual(history.data.items, [sent.data.item]);
    const search = await x.mcp(credential, "read_messages", {
      serverId: server.id,
      mode: "search",
      query: "Timestamp",
      afterTime: time,
    });
    assert.deepEqual(search.data.items, [sent.data.item]);
  }
  for (const time of ["2026-09-09T05:10:00", "2026-02-30T00:00:00Z"]) {
    const history = await x.mcp(
      credential,
      "read_messages",
      {
        serverId: server.id,
        mode: "history",
        conversationId,
        position: { kind: "afterTime", time },
      },
      true,
    );
    assert.match(history.error.message, /position.time: Use a valid timestamp/);
    const search = await x.mcp(
      credential,
      "read_messages",
      {
        serverId: server.id,
        mode: "search",
        query: "Timestamp",
        beforeTime: time,
      },
      true,
    );
    assert.match(search.error.message, /beforeTime: Use a valid timestamp/);
  }
});

test("MCP server and direct-chat directory actions retain their requested limit", async (t) => {
  const x = await start(t);
  const account = await x.account();
  for (let i = 0; i < 4; i++) await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const servers = await x.mcp(credential, "get_context", {});
  const seenServers = [servers.data.items[0].id];
  let page = await x.mcp(credential, "get_context", {
    page: { section: "servers", cursor: seenServers[0], limit: 1 },
  });
  for (;;) {
    assert.equal(page.data.items.length, 1);
    seenServers.push(page.data.items[0].id);
    const action = page.meta.nextActions.find((a) => a.arguments.page?.section === "servers");
    if (!action) break;
    assert.equal(action.arguments.page.limit, 1);
    page = await x.mcp(credential, action.tool, action.arguments);
  }
  assert.deepEqual(
    seenServers,
    servers.data.items.map((server) => server.id),
  );

  const serverId = seenServers[0];
  const peers = [];
  for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
    const joined = await x.mcp(credential, "register_participant", {
      serverId,
      name,
      agentType: "codex",
      requestKey: name,
    });
    peers.push(joined.data.item.id);
  }
  for (const recipientId of peers.slice(1))
    await x.mcp(credential, "send_message", {
      serverId,
      participantId: peers[0],
      target: { kind: "direct", recipientId },
      body: "Directory pagination",
      requestKey: recipientId,
    });
  const first = await x.call("user_alice", "GET", `/v1/servers/${serverId}/direct-chats?limit=1`);
  const next = await x.mcp(credential, "get_context", {
    serverId,
    page: { section: "directChats", cursor: first.nextCursor, limit: 1 },
  });
  assert.equal(next.data.items.length, 1);
  const action = next.meta.nextActions.find((a) => a.arguments.page?.section === "directChats");
  assert.equal(action.arguments.page.limit, 1);
  const last = await x.mcp(credential, action.tool, action.arguments);
  assert.equal(last.data.items.length, 1);
  assert.equal(last.data.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...next.data.items, ...last.data.items].map((item) => item.id)).size,
    3,
  );
});

test("MCP retry after a lost committed response cannot duplicate a direct chat or message", async (t) => {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const credential = await x.mcpToken(account.organizationId);
  const peers = [];
  for (const name of ["Sender", "Recipient"])
    peers.push(
      (
        await x.call("user_alice", "POST", `/v1/servers/${server.id}/participants`, {
          name,
          agentType: "codex",
          requestKey: name,
        })
      ).item,
    );
  let drop = true;
  const client = new Client(
    { name: "Interrupted MCP client", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL("https://talkto.test/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${credential}` } },
    fetch: async (input, init) => {
      const request = init?.body ? JSON.parse(init.body) : null;
      const response = await x.raw(new URL(input).pathname, init);
      const body = await response.arrayBuffer();
      if (drop && request?.method === "tools/call" && request.params.name === "send_message") {
        drop = false;
        throw new TypeError("Simulated lost response after the server committed");
      }
      return new Response(body, { status: response.status, headers: response.headers });
    },
  });
  try {
    await client.connect(transport);
    await client.listTools();
    const args = {
      serverId: server.id,
      participantId: peers[0].id,
      target: { kind: "direct", recipientId: peers[1].id },
      body: "Exactly once in storage",
      requestKey: "lost-response",
    };
    await assert.rejects(client.callTool({ name: "send_message", arguments: args }));
    const retry = await client.callTool({ name: "send_message", arguments: args });
    assert.equal(retry.isError, false);
    assert.equal(retry.structuredContent.data.created, false);
    const context = await x.mcp(credential, "get_context", {
      serverId: server.id,
      directChats: "all",
    });
    assert.equal(context.data.server.messageCount, 1);
    assert.equal(context.data.directChats.items.length, 1);
  } finally {
    await client.close();
  }
});

test("dashboard server feeds preserve history, catch up across pages, and search full directories", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const register = (name, agentType, workingDirectory) =>
    app.call("user_alice", "POST", `${root}/participants`, {
      name,
      agentType,
      workingDirectory,
      requestKey: randomUUID(),
    });
  const a = (await register("api-implementation-agent", "Codex", "/workspace/talkto")).item;
  const b = (await register("release-review-agent", "Claude", "/workspace/release")).item;
  const general = (await app.call("user_alice", "GET", root)).generalConversationId;
  const build = (
    await app.call("user_alice", "POST", `${root}/channels`, {
      name: "build-review",
      participantId: a.id,
      requestKey: randomUUID(),
    })
  ).item;
  const direct = (
    await app.call("user_alice", "POST", `${root}/direct-chats`, {
      participantId: a.id,
      recipientId: b.id,
    })
  ).item;
  const send = (conversationId, body, requestKey = randomUUID()) =>
    app.call("user_alice", "POST", `${root}/conversations/${conversationId}/messages`, {
      participantId: a.id,
      body,
      requestKey,
    });
  // Sequence 1 is TalkTo's announcement of build-review in General; sends start at 2.
  for (let i = 0; i < 7; i++) await send(i % 2 ? direct.id : general, `before ${i}`);
  const first = await app.call("user_alice", "GET", `${root}/messages?limit=2`);
  assert.deepEqual(
    first.items.map((m) => m.sequence),
    [8, 7],
  );
  const history = first.nextCursor;
  for (let i = 0; i < 5; i++) await send(build.id, `after ${i}`);
  const older = await app.call("user_alice", "GET", `${root}/messages?cursor=${history}&limit=2`);
  assert.deepEqual(
    older.items.map((m) => m.sequence),
    [6, 5],
  );
  let cursor = first.liveCursor;
  const seen = [];
  for (;;) {
    const page = await app.call("user_alice", "GET", `${root}/messages?cursor=${cursor}&limit=2`);
    seen.push(...page.items.map((m) => m.sequence));
    cursor = page.liveCursor;
    if (page.caughtUp) break;
  }
  assert.deepEqual(seen, [9, 10, 11, 12, 13]);
  assert.equal(
    (await app.call("user_alice", "GET", `${root}/messages?cursor=${cursor}`)).items.length,
    0,
  );
  const around = await app.call("user_alice", "GET", `${root}/messages?around=10&limit=4`);
  assert.deepEqual(
    around.items.map((m) => m.sequence),
    [12, 11, 10, 9],
  );
  assert.equal(around.caughtUp, false);
  const newer = await app.call("user_alice", "GET", `${root}/messages?cursor=${around.liveCursor}`);
  assert.deepEqual(
    newer.items.map((m) => m.sequence),
    [13],
  );
  assert.equal(newer.caughtUp, true);
  const before = await app.call(
    "user_alice",
    "GET",
    `${root}/messages?cursor=${around.nextCursor}`,
  );
  assert.deepEqual(
    before.items.map((m) => m.sequence),
    [8, 7, 6, 5, 4, 3, 2, 1],
  );
  const recent = await app.call("user_alice", "GET", `${root}/messages?around=12&limit=4`);
  assert.deepEqual(
    recent.items.map((m) => m.sequence),
    [13, 12, 11, 10],
  );
  assert.equal(recent.caughtUp, true);
  const scoped = await app.call(
    "user_alice",
    "GET",
    `${root}/messages?conversationId=${build.id}&around=10&limit=2`,
  );
  assert.deepEqual(
    scoped.items.map((m) => m.sequence),
    [11, 10],
  );
  assert.equal(scoped.caughtUp, false);
  await app.call(
    "user_alice",
    "GET",
    `${root}/messages?cursor=${around.nextCursor}&around=9`,
    undefined,
    400,
  );
  const filtered = await app.call(
    "user_alice",
    "GET",
    `${root}/messages?query=after&conversationId=${build.id}&limit=1`,
  );
  assert.equal(filtered.items[0].body, "after 4");
  await app.call(
    "user_alice",
    "GET",
    `${root}/messages?cursor=${filtered.nextCursor}&query=before`,
    undefined,
    400,
  );
  const participants = await app.call(
    "user_alice",
    "GET",
    `${root}/participants?query=workspace&limit=1`,
  );
  assert.equal(participants.items.length, 1);
  const next = await app.call(
    "user_alice",
    "GET",
    `${root}/participants?cursor=${participants.nextCursor}&limit=1`,
  );
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].id, participants.items[0].id);
  assert.equal(
    (await app.call("user_alice", "GET", `${root}/participants?query=Claude`)).items[0].id,
    b.id,
  );
  assert.equal(
    (await app.call("user_alice", "GET", `${root}/channels?query=build`)).items[0].id,
    build.id,
  );
  const summary = await app.call("user_alice", "GET", `${root}/summary`);
  assert.equal(summary.activity.messageCount, 13);
  assert.equal(summary.server.messageCount, 13);
  assert.equal(summary.server.participantCount, 2);
  const requestKey = randomUUID();
  const committed = await send(general, "single committed message", requestKey);
  const replay = await send(general, "single committed message", requestKey);
  assert.equal(committed.item.id, replay.item.id);
  assert.equal((await app.call("user_alice", "GET", `${root}/summary`)).activity.messageCount, 14);
});

test("account activity indexes idempotently, delivers late arrivals, and enforces current grants", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const one = await app.server(account.id, { name: "Busy" });
  const two = await app.server(account.id, { name: "Recent" });
  const createMessage = async (server, count) => {
    const root = `/v1/servers/${server.id}`;
    const agent = (
      await app.call("user_alice", "POST", `${root}/participants`, {
        name: "api-agent",
        agentType: "Codex",
        requestKey: randomUUID(),
      })
    ).item;
    const general = (await app.call("user_alice", "GET", root)).generalConversationId;
    for (let i = 0; i < count; i++)
      await app.call("user_alice", "POST", `${root}/conversations/${general}/messages`, {
        participantId: agent.id,
        body: `sentinel ${server.name} ${i}`,
        requestKey: randomUUID(),
      });
  };
  await createMessage(one, 7);
  await createMessage(two, 1);
  await app.control(`project?server=${one.id}`);
  const path = `/v1/accounts/${account.id}`;
  const initial = await app.call("user_alice", "GET", `${path}/activity?limit=2`);
  assert.equal(initial.items.length, 2);
  assert.equal(initial.freshness.pendingServers, 1);
  await app.control(`project?server=${two.id}`);
  await app.control(`project?server=${one.id}`);
  const late = await app.call("user_alice", "GET", `${path}/activity?cursor=${initial.liveCursor}`);
  assert.equal(late.items.length, 1);
  assert.equal(late.items[0].serverId, two.id);
  assert.equal(late.caughtUp, true);
  assert.equal(
    (await app.db.prepare("SELECT COUNT(*) AS count FROM activity_events").first()).count,
    8,
  );
  const home = await app.call("user_alice", "GET", `${path}/dashboard`);
  assert.deepEqual(
    home.servers.map((s) => s.summary.server.id),
    [one.id, two.id],
  );
  assert.deepEqual(
    home.servers.map((s) => s.activity.messageCount),
    [7, 1],
  );
  assert.equal(home.feed.freshness.pendingServers, 0);
  const smallHome = await app.call("user_alice", "GET", `${path}/dashboard?limit=2`);
  assert.equal(smallHome.feed.items.length, 2);
  const continuation = await app.call(
    "user_alice",
    "GET",
    `${path}/activity?cursor=${smallHome.feed.nextCursor}`,
  );
  assert.deepEqual(
    [...smallHome.feed.items, ...continuation.items].map((item) => item.message.id),
    home.feed.items.map((item) => item.message.id),
    "Home's requested size must produce a cursor with no skipped or repeated messages",
  );
  for (const limit of [0, 51])
    await app.call("user_alice", "GET", `${path}/dashboard?limit=${limit}`, undefined, 400);
  assert.ok(
    home.servers.every(
      (card) =>
        card.permissions.manageAccess && card.permissions.readMessages && !card.permissions.resume,
    ),
  );
  const search = await app.call("user_alice", "GET", `${path}/activity?query=sentinel%20Busy`);
  assert.equal(search.items.length, 7);
  const old = await app.call("user_alice", "GET", `${path}/activity?cursor=${initial.nextCursor}`);
  assert.equal(old.items.length, 5);
  assert.ok(old.items.every((m) => m.serverId === one.id));
  const another = await app.account();
  await app.call(
    "user_alice",
    "GET",
    `/v1/accounts/${another.id}/activity?cursor=${initial.liveCursor}`,
    undefined,
    400,
  );
  await app.control("member", app.member(account.organizationId));
  await app.call(
    "user_bob",
    "GET",
    `${path}/activity?cursor=${initial.liveCursor}`,
    undefined,
    400,
  );
  assert.equal((await app.call("user_bob", "GET", `${path}/activity`)).items.length, 0);
  await app.call("user_alice", "PUT", `/v1/servers/${one.id}/access/user_bob`);
  assert.equal((await app.call("user_bob", "GET", `${path}/activity`)).items.length, 7);
  assert.deepEqual(
    (await app.call("user_bob", "GET", `${path}/dashboard`)).servers[0].permissions,
    { readMessages: true, manageAccess: false, resume: false },
  );
  // Deliberately revoke only inside the authoritative object; leave a stale directory/index.
  const grant = await app.db
    .prepare("SELECT * FROM server_access WHERE server_id=? AND user_id='user_bob'")
    .bind(one.id)
    .first();
  await app.control(`apply?server=${one.id}`, {
    id: grant.id,
    serverId: one.id,
    userId: grant.user_id,
    membershipId: grant.membership_id,
    principalKey: grant.principal_key,
    createdAt: grant.created_at,
    revokedAt: new Date().toISOString(),
    revision: grant.revision + 1,
    appliedRevision: grant.applied_revision,
  });
  assert.equal((await app.call("user_bob", "GET", `${path}/activity`)).items.length, 0);
  assert.equal((await app.call("user_bob", "GET", `${path}/dashboard`)).servers.length, 0);
  await app.call("user_alice", "DELETE", `/v1/servers/${one.id}/access/user_alice`);
  const own = await app.call("user_alice", "GET", `${path}/servers/${one.id}`);
  assert.equal(own.permissions.manageAccess, true);
  assert.equal(own.permissions.readMessages, false);
  await app.call("user_alice", "GET", `/v1/servers/${one.id}/messages`, undefined, 404);
});

test("management directory search retains its scope and creation recovers the same reservation", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const path = `/v1/accounts/${account.id}/servers`;
  const servers = [];
  for (const name of ["API one", "Other", "API two", "API three"])
    servers.push(await app.server(account.id, { name }));
  const first = await app.call("user_alice", "GET", `${path}?query=api&limit=2`);
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const next = await app.call("user_alice", "GET", `${path}?after=${first.nextCursor}&limit=2`);
  assert.equal(next.items.length, 1);
  assert.equal(next.nextCursor, null);
  assert.equal(new Set([...first.items, ...next.items].map((s) => s.id)).size, 3);
  await app.call(
    "user_alice",
    "GET",
    `${path}?after=${first.nextCursor}&query=other`,
    undefined,
    400,
  );
  const input = { name: "Recover me", requestKey: randomUUID() };
  const created = await app.call("user_alice", "POST", path, input);
  const replay = await app.call("user_alice", "POST", path, input);
  assert.equal(replay.id, created.id);
  const detail = await app.call("user_alice", "GET", `${path}/${created.id}`);
  assert.equal(detail.status, "ready");
  await app.call("user_bob", "GET", `${path}/${created.id}`, undefined, 404);
});

test("identity searches continue beyond nonmatching provider pages and grants include profiles", async (t) => {
  const app = await start(t);
  const accounts = [];
  for (const name of ["Tools", "Release", "Agents"])
    accounts.push(
      await app.call("user_alice", "POST", "/v1/accounts", { name, requestKey: randomUUID() }),
    );
  const ordered = [...accounts].sort((a, b) => a.organizationId.localeCompare(b.organizationId));
  const target = ordered.at(-1);
  const first = await app.call("user_alice", "GET", `/v1/accounts?query=${target.name}&limit=1`);
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  const matches = [];
  let nextCursor = first.nextCursor;
  for (let page = 0; page < 4 && nextCursor; page++) {
    const next = await app.call("user_alice", "GET", `/v1/accounts?after=${nextCursor}&limit=1`);
    matches.push(...next.items);
    nextCursor = next.nextCursor;
  }
  assert.equal(nextCursor, null);
  assert.deepEqual(
    matches.map((item) => item.id),
    [target.id],
  );
  await app.call("user_bob", "GET", `/v1/accounts?after=${first.nextCursor}`, undefined, 400);
  await app.call(
    "user_alice",
    "GET",
    `/v1/accounts?after=${first.nextCursor}&query=other`,
    undefined,
    400,
  );
  const path = `/v1/accounts/${target.id}/members`;
  for (const user of ["user_alpha", "user_zulu"])
    await app.control("member", app.member(target.organizationId, user));
  const members = await app.call("user_alice", "GET", `${path}?query=zulu&limit=1`);
  assert.deepEqual(members.items, []);
  assert.ok(members.nextCursor);
  let cursor = members.nextCursor;
  const found = [];
  while (cursor) {
    const page = await app.call("user_alice", "GET", `${path}?after=${cursor}&limit=1`);
    found.push(...page.items);
    cursor = page.nextCursor;
  }
  assert.deepEqual(
    found.map((member) => member.user.email),
    ["user_zulu@example.com"],
  );
  assert.equal(found[0].permissions.remove, true);
  await app.call(
    "user_alice",
    "GET",
    `/v1/accounts/${ordered[0].id}/members?after=${members.nextCursor}`,
    undefined,
    400,
  );
  const server = await app.server(target.id);
  await app.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_zulu`);
  const access = await app.call("user_alice", "GET", `/v1/servers/${server.id}/access`);
  assert.deepEqual(access.items.map((grant) => grant.user.email).sort(), [
    "user_alice@example.com",
    "user_zulu@example.com",
  ]);
});

test("grant candidates exclude existing access through pending changes and bind searchable pages to the server", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const otherServer = await app.server(account.id);
  const otherAccount = await app.account();
  const foreignServer = await app.server(otherAccount.id);
  const access = `/v1/servers/${server.id}/access`;
  const candidates = `${access}/candidates`;
  assert.deepEqual((await app.call("user_alice", "GET", candidates)).items, []);
  // The owner has a random provider ID; keep the matching member on the second page.
  await app.control("member", { ...app.member(account.organizationId), id: "om_zzbob" });
  await app.control("member", app.member(account.organizationId, "user_inactive", "inactive"));
  await app.control("member", app.member(otherAccount.organizationId, "user_foreign"));
  const eligible = await app.call("user_alice", "GET", candidates);
  assert.deepEqual(
    eligible.items.map((user) => user.id),
    ["user_bob"],
  );
  assert.equal(eligible.nextCursor, null);
  await app.call("user_bob", "GET", candidates, undefined, 404);

  const first = await app.call(
    "user_alice",
    "GET",
    `${candidates}?query=BOB%40EXAMPLE.COM&limit=1`,
  );
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  const next = await app.call(
    "user_alice",
    "GET",
    `${candidates}?after=${first.nextCursor}&limit=1`,
  );
  assert.deepEqual(
    next.items.map((user) => user.id),
    ["user_bob"],
  );
  assert.equal(next.nextCursor, null);
  for (const path of [
    `/v1/servers/${otherServer.id}/access/candidates?after=${first.nextCursor}`,
    `/v1/servers/${foreignServer.id}/access/candidates?after=${first.nextCursor}`,
    `/v1/accounts/${account.id}/members?after=${first.nextCursor}`,
    `${candidates}?after=${first.nextCursor}&query=other`,
    `${candidates}?after=om_unscoped`,
  ])
    await app.call("user_alice", "GET", path, undefined, 400);
  assert.equal((await app.raw(candidates)).status, 401);

  await app.control(`fail?server=${server.id}`);
  await app.call("user_alice", "PUT", `${access}/user_bob`, undefined, 503);
  let grants = await app.call("user_alice", "GET", access);
  const pendingGrant = grants.items.find((grant) => grant.userId === "user_bob");
  assert.ok(pendingGrant.revision > pendingGrant.appliedRevision);
  assert.deepEqual((await app.call("user_alice", "GET", candidates)).items, []);
  await app.control("sync");
  assert.deepEqual((await app.call("user_alice", "GET", candidates)).items, []);

  await app.control(`fail?server=${server.id}`);
  await app.call("user_alice", "DELETE", `${access}/user_bob`, undefined, 503);
  grants = await app.call("user_alice", "GET", access);
  const pendingRevoke = grants.items.find((grant) => grant.userId === "user_bob");
  assert.ok(pendingRevoke.revokedAt);
  assert.ok(pendingRevoke.revision > pendingRevoke.appliedRevision);
  assert.deepEqual((await app.call("user_alice", "GET", candidates)).items, []);
  await app.control("sync");
  grants = await app.call("user_alice", "GET", access);
  const revoked = grants.items.find((grant) => grant.userId === "user_bob");
  assert.equal(revoked.revision, revoked.appliedRevision);
  assert.deepEqual((await app.call("user_alice", "GET", candidates)).items, []);
  await app.call("user_alice", "PUT", `${access}/user_bob`);
  grants = await app.call("user_alice", "GET", access);
  assert.equal(grants.items.filter((grant) => grant.userId === "user_bob").length, 1);
  assert.equal(grants.items.find((grant) => grant.userId === "user_bob").revokedAt, null);
  assert.deepEqual((await app.call("user_alice", "GET", candidates)).items, []);
});

test("grant candidates exclude grants beyond the first access page without hiding later eligible members", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const path = `/v1/servers/${server.id}/access`;
  for (let i = 0; i < 101; i++) {
    const userId = `user_member${String(i).padStart(3, "0")}`;
    await app.control("member", app.member(account.organizationId, userId));
    await app.call("user_alice", "PUT", `${path}/${userId}`);
  }
  await app.control("member", app.member(account.organizationId, "user_zulu"));
  const grants = await app.call("user_alice", "GET", path);
  assert.equal(grants.items.length, 100);
  assert.ok(grants.nextCursor);
  assert.equal(
    grants.items.some((grant) => grant.userId === "user_member100"),
    false,
  );
  const first = await app.call("user_alice", "GET", `${path}/candidates?limit=100`);
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  const next = await app.call(
    "user_alice",
    "GET",
    `${path}/candidates?after=${first.nextCursor}&limit=100`,
  );
  assert.deepEqual(
    next.items.map((user) => user.id),
    ["user_zulu"],
  );
  assert.equal(next.nextCursor, null);
});

// Keep message creation on the real HTTP service; only projection delivery/time is controlled.
async function traffic(app, server, count, body = (i) => `replay sentinel ${i}`) {
  const root = `/v1/servers/${server.id}`;
  const agent = (
    await app.call("user_alice", "POST", `${root}/participants`, {
      name: `agent-${randomUUID()}`,
      agentType: "Codex",
      requestKey: randomUUID(),
    })
  ).item;
  const general = (await app.call("user_alice", "GET", root)).generalConversationId;
  const messages = [];
  for (let i = 0; i < count; i++)
    messages.push(
      (
        await app.call("user_alice", "POST", `${root}/conversations/${general}/messages`, {
          participantId: agent.id,
          body: body(i),
          requestKey: randomUUID(),
        })
      ).item,
    );
  return messages;
}

test("activity projection rolls back atomically, recovers a lost acknowledgment, and replays concurrent batches once", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const path = `/v1/accounts/${account.id}/activity`;
  await app.db
    .prepare(
      "CREATE TRIGGER stop_projection BEFORE INSERT ON activity_progress BEGIN SELECT RAISE(ABORT,'injected index failure'); END",
    )
    .run();
  const messages = await traffic(app, server, 3);
  assert.equal((await app.control(`project?server=${server.id}`)).status, 503);
  assert.equal((await app.db.prepare("SELECT COUNT(*) AS n FROM activity_events").first()).n, 0);
  assert.equal(
    (await app.call("user_alice", "GET", `/v1/servers/${server.id}/messages`)).items.length,
    3,
  );
  assert.equal((await app.call("user_alice", "GET", path)).freshness.pendingServers, 1);
  // Search does not wait for the shared index: each server searches its own messages.
  assert.equal((await app.call("user_alice", "GET", `${path}?query=sentinel`)).items.length, 3);
  await app.db.prepare("DROP TRIGGER stop_projection").run();
  const input = {
    after: 0,
    batch: {
      serverId: server.id,
      items: messages,
      through: 3,
      caughtUp: true,
      asOf: new Date().toISOString(),
    },
  };
  const concurrent = await Promise.all([
    app.control("publish", input),
    app.control("publish", input),
  ]);
  assert.ok(concurrent.every((response) => response.status === 200));
  assert.equal((await app.control(`project?server=${server.id}&lose-response`)).status, 503);
  assert.equal((await app.control(`project?server=${server.id}`)).status, 200);
  assert.equal((await app.db.prepare("SELECT COUNT(*) AS n FROM activity_events").first()).n, 3);
  assert.equal((await app.call("user_alice", "GET", `${path}?query=sentinel`)).items.length, 3);
  const prior = await app.db
    .prepare("SELECT checked_at FROM activity_progress WHERE server_id=?")
    .bind(server.id)
    .first();
  const later = await traffic(app, server, 1);
  const olderClock = new Date(Date.parse(prior.checked_at) - 1000).toISOString();
  assert.equal(
    (
      await app.control("publish", {
        after: 3,
        batch: { serverId: server.id, items: later, through: 4, caughtUp: true, asOf: olderClock },
      })
    ).status,
    200,
  );
  const progressed = await app.db
    .prepare("SELECT sequence,checked_at FROM activity_progress WHERE server_id=?")
    .bind(server.id)
    .first();
  assert.equal(progressed.sequence, 4);
  assert.equal(progressed.checked_at, prior.checked_at);
  // The shared database keeps message IDs, sequences and times; no table holds message words.
  const columns = await app.db
    .prepare("SELECT name FROM pragma_table_info('activity_events')")
    .all();
  assert.deepEqual(columns.results.map((row) => row.name).sort(), [
    "account_id",
    "created_at",
    "id",
    "message_id",
    "sequence",
    "server_id",
  ]);
  const tables = await app.db
    .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'activity_search%'")
    .all();
  assert.deepEqual(tables.results, []);
});

/** Newest first: creation time, then server ID, then the server's own sequence. */
const newestFirst = (left, right) =>
  Date.parse(right.message.createdAt) - Date.parse(left.message.createdAt) ||
  (right.serverId < left.serverId ? -1 : right.serverId > left.serverId ? 1 : 0) ||
  right.message.sequence - left.message.sequence;

test("account search runs inside each server, pages across servers in order, and reports servers that do not answer", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const path = `/v1/accounts/${account.id}/activity`;
  const servers = [];
  for (const name of ["Alpha", "Beta", "Gamma"])
    servers.push(await app.server(account.id, { name }));
  const sent = [];
  for (let round = 0; round < 3; round++)
    for (const server of servers) {
      for (const message of await traffic(app, server, 1, () => `needle ${server.name} ${round}`))
        sent.push({ serverId: server.id, message });
      await traffic(app, server, 1, () => "haystack only");
    }
  const expected = sent.toSorted(newestFirst).map((item) => item.message.id);
  const pages = [];
  let page = await app.call("user_alice", "GET", `${path}?query=needle&limit=2`);
  const first = page;
  for (;;) {
    pages.push(page);
    assert.deepEqual(page.search, {
      serverLimit: 20,
      searchedServers: 3,
      unavailableServers: 0,
      notSearchedServers: 0,
    });
    assert.ok(page.items.length <= 2);
    if (page.nextCursor === null) break;
    page = await app.call("user_alice", "GET", `${path}?cursor=${page.nextCursor}&limit=2`);
  }
  assert.deepEqual(
    pages.flatMap((p) => p.items.map((item) => item.message.id)),
    expected,
    "every match once, newest first across servers",
  );
  assert.ok(pages.length >= 5);
  // Live continuation counts from each server's head when the search began.
  const [alpha, beta, gamma] = servers;
  assert.ok(alpha && beta && gamma);
  const quiet = await app.call("user_alice", "GET", `${path}?cursor=${first.liveCursor}`);
  assert.deepEqual(quiet.items, []);
  assert.equal(quiet.caughtUp, true);
  const [arrived] = await traffic(app, beta, 1, () => "needle arrived later");
  await traffic(app, gamma, 1, () => "haystack later");
  const live = await app.call("user_alice", "GET", `${path}?cursor=${first.liveCursor}`);
  assert.deepEqual(
    live.items.map((item) => item.message.id),
    [arrived.id],
  );
  assert.equal(live.caughtUp, true);
  const drained = await app.call("user_alice", "GET", `${path}?cursor=${live.liveCursor}`);
  assert.deepEqual(drained.items, []);
  // A cursor belongs to its caller.
  await app.control("member", app.member(account.organizationId));
  await app.call("user_bob", "GET", `${path}?cursor=${first.nextCursor}`, undefined, 400);
  // One server failing still returns the others' matches, and the page says one did not answer.
  await app.control(`break-search?server=${gamma.id}`);
  const partial = await app.call("user_alice", "GET", `${path}?query=needle`);
  assert.deepEqual(partial.search, {
    serverLimit: 20,
    searchedServers: 2,
    unavailableServers: 1,
    notSearchedServers: 0,
  });
  assert.equal(partial.items.length, 7);
  assert.ok(partial.items.every((item) => item.serverId !== gamma.id));
  // Searching never reads a shared index: no projection ran for these servers.
  assert.equal((await app.db.prepare("SELECT COUNT(*) AS n FROM activity_events").first()).n, 0);
});

test("account search asks at most 20 servers, most recently active first, and counts the rest", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const servers = [];
  for (let i = 0; i < 21; i++)
    servers.push(await app.server(account.id, { name: `Server ${String(i).padStart(2, "0")}` }));
  // The last server by ID is the only one with activity, so it is searched first.
  const active = servers.toSorted((a, b) => (a.id < b.id ? 1 : -1))[0];
  assert.ok(active);
  const [match] = await traffic(app, active, 1, () => "needle in the active server");
  await app.control(`project?server=${active.id}`);
  const result = await app.call(
    "user_alice",
    "GET",
    `/v1/accounts/${account.id}/activity?query=needle`,
  );
  assert.deepEqual(result.search, {
    serverLimit: 20,
    searchedServers: 20,
    unavailableServers: 0,
    notSearchedServers: 1,
  });
  assert.deepEqual(
    result.items.map((item) => item.message.id),
    [match.id],
  );
});

test("Home keeps up to three readable servers visible while larger directories use recent activity", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const path = `/v1/accounts/${account.id}/dashboard`;
  const home = (user = "user_alice") => app.call(user, "GET", path);
  const empty = await home();
  assert.equal(empty.serverSelection, "all");
  assert.deepEqual(empty.servers, []);

  const servers = [];
  for (let count = 1; count <= 3; count++) {
    servers.push(await app.server(account.id, { name: `Quiet ${count}` }));
    const result = await home();
    assert.equal(result.serverSelection, "all");
    assert.deepEqual(
      result.servers.map((card) => card.summary.server.id),
      servers.map((server) => server.id).sort(),
    );
    assert.ok(
      result.servers.every(
        (card) => card.activity.messageCount === 0 && card.activity.lastMessageAt === null,
      ),
    );
  }

  await traffic(app, servers[0], 2);
  await app.control(`project?server=${servers[0].id}`);
  const mixed = await home();
  assert.equal(mixed.servers.length, 3);
  assert.equal(mixed.servers[0].summary.server.id, servers[0].id);
  assert.deepEqual(
    mixed.servers.map((card) => card.activity.messageCount),
    [2, 0, 0],
  );
  await app.db.prepare("UPDATE activity_events SET created_at='2000-01-01T00:00:00.000Z'").run();
  const aged = await home();
  assert.equal(aged.servers.length, 3);
  assert.ok(aged.servers.every((card) => card.activity.messageCount === 0));

  const fourth = await app.server(account.id, { name: "Fourth" });
  const largeIdle = await home();
  assert.equal(largeIdle.serverSelection, "active");
  assert.deepEqual(largeIdle.servers, []);
  await traffic(app, fourth, 1);
  await app.control(`project?server=${fourth.id}`);
  assert.deepEqual(
    (await home()).servers.map((card) => card.summary.server.id),
    [fourth.id],
  );

  // Hidden servers do not change a colleague's threshold or appear in their Home cards.
  await app.control("member", app.member(account.organizationId));
  assert.deepEqual((await home("user_bob")).servers, []);
  for (const server of servers)
    await app.call("user_alice", "PUT", `/v1/servers/${server.id}/access/user_bob`);
  const shared = await home("user_bob");
  assert.equal(shared.serverSelection, "all");
  assert.equal(shared.servers.length, 3);
  assert.ok(
    shared.servers.every((card) => card.permissions.readMessages && !card.permissions.manageAccess),
  );
  await app.call("user_alice", "PUT", `/v1/servers/${fourth.id}/access/user_bob`);
  assert.equal((await home("user_bob")).serverSelection, "active");
  await app.call("user_alice", "DELETE", `/v1/servers/${fourth.id}/access/user_bob`);
  assert.equal((await home("user_bob")).servers.length, 3);

  // Even an idle fallback card must recheck its grant inside the authoritative object.
  const grant = await app.db
    .prepare("SELECT * FROM server_access WHERE server_id=? AND user_id='user_bob'")
    .bind(servers[0].id)
    .first();
  await app.control(`apply?server=${servers[0].id}`, {
    id: grant.id,
    serverId: servers[0].id,
    userId: grant.user_id,
    membershipId: grant.membership_id,
    principalKey: grant.principal_key,
    createdAt: grant.created_at,
    revokedAt: new Date().toISOString(),
    revision: grant.revision + 1,
    appliedRevision: grant.applied_revision,
  });
  const revoked = await home("user_bob");
  assert.equal(revoked.servers.length, 2);
  assert.ok(revoked.servers.every((card) => card.summary.server.id !== servers[0].id));
});

test("30-minute ranking excludes its lower boundary, expires idle servers, and breaks volume ties deterministically", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const servers = [];
  const end = "2099-04-01T01:00:00.000Z";
  const windowStart = "2099-04-01T00:30:00.000Z";
  const times = [
    ["2099-04-01T00:29:59.999Z", windowStart],
    ["2099-04-01T00:30:00.001Z", "2099-04-01T00:40:00.000Z"],
    ["2099-04-01T00:35:00.000Z", end],
    ["2099-04-01T00:35:00.000Z", end],
    ["2099-04-01T01:00:00.001Z", "2099-04-01T01:00:00.002Z"],
  ];
  for (let i = 0; i < times.length; i++) {
    const server = await app.server(account.id, { name: `server-${i}` });
    servers.push(server);
    const messages = await traffic(app, server, 2);
    assert.equal((await app.control(`project?server=${server.id}`)).status, 200);
    for (let j = 0; j < messages.length; j++)
      await app.db
        .prepare("UPDATE activity_events SET created_at=? WHERE message_id=?")
        .bind(times[i][j], messages[j].id)
        .run();
  }
  const rank = await (
    await app.control("rank", { accountId: account.id, start: windowStart, end })
  ).json();
  assert.deepEqual(
    rank.map((item) => item.serverId),
    [servers[2].id, servers[3].id].sort().concat(servers[1].id),
  );
  assert.ok(rank.every((item) => item.count === 2));
  assert.deepEqual(
    await (
      await app.control("rank", {
        accountId: account.id,
        start: "2099-04-01T01:01:00.000Z",
        end: "2099-04-01T01:31:00.000Z",
      })
    ).json(),
    [],
  );
});

test("busy account feeds bound server fan-out and full-body bytes without dropping messages", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const expected = [];
  for (let i = 0; i < 12; i++) {
    const server = await app.server(account.id);
    expected.push(...(await traffic(app, server, 1)));
    assert.equal((await app.control(`project?server=${server.id}`)).status, 200);
  }
  const root = `/v1/accounts/${account.id}`;
  const first = await app.call("user_alice", "GET", `${root}/activity`);
  assert.equal(first.items.length, 10);
  assert.equal(new Set(first.items.map((item) => item.serverId)).size, 10);
  const second = await app.call("user_alice", "GET", `${root}/activity?cursor=${first.nextCursor}`);
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.message.id).sort(),
    expected.map((item) => item.id).sort(),
  );
  assert.equal((await app.call("user_alice", "GET", `${root}/dashboard`)).servers.length, 6);
  const busy = await app.server(account.id);
  const large = await traffic(app, busy, 5, (i) => `large ${i} ${"x".repeat(16000)}`);
  // An export carries message references, never bodies, so large messages fit one bounded export.
  const exported = await (await app.control(`project?server=${busy.id}`)).json();
  assert.equal(exported.caughtUp, true);
  assert.equal(
    (await app.call("user_alice", "GET", `${root}/activity`)).freshness.pendingServers,
    0,
  );
  assert.equal((await app.control(`project?server=${busy.id}`)).status, 200);
  const all = [];
  let cursor = first.liveCursor;
  for (let page = 0; page < 3; page++) {
    const result = await app.call("user_alice", "GET", `${root}/activity?cursor=${cursor}`);
    assert.ok(
      result.items.reduce((sum, item) => sum + Buffer.byteLength(item.message.body), 0) <= 65536,
    );
    all.push(...result.items.map((item) => item.message.id));
    cursor = result.liveCursor;
    if (result.caughtUp) break;
  }
  assert.deepEqual(all.sort(), large.map((item) => item.id).sort());
  const serverPage = await app.call("user_alice", "GET", `/v1/servers/${busy.id}/messages`);
  assert.equal(serverPage.items.length, 4);
  assert.equal(
    (
      await app.call(
        "user_alice",
        "GET",
        `/v1/servers/${busy.id}/messages?cursor=${serverPage.nextCursor}`,
      )
    ).items.length,
    1,
  );
});

test("derived activity index keeps window and delivery queries indexed with 10,000 records", async (t) => {
  const app = await start(t);
  const account = await app.account();
  const server = await app.server(account.id);
  const [source] = await traffic(app, server, 1);
  const storageBytes = async () => {
    const result = await app.db.prepare("SELECT COUNT(*) FROM activity_events").all();
    return result.meta.size_after;
  };
  const before = await storageBytes();
  // Measure the derived store independently; these synthetic references are never hydrated.
  for (let after = 0; after < 10000; after += 50) {
    const items = Array.from({ length: 50 }, (_, i) => ({
      ...source,
      id: randomUUID(),
      sequence: after + i + 1,
      body: `api-contract-reviewer completed deployment review ${after + i + 1}. General and direct conversations remain available. ${"Additional implementation context. ".repeat(8)}`,
    }));
    const response = await app.control("publish", {
      after,
      batch: {
        serverId: server.id,
        items,
        through: after + 50,
        caughtUp: after + 50 === 10000,
        asOf: new Date().toISOString(),
      },
    });
    assert.equal(response.status, 200, await response.text());
  }
  const windowStart = new Date(Date.parse(source.createdAt) - 1800000).toISOString();
  const queries = [
    [
      "SELECT id,server_id,message_id FROM activity_events WHERE account_id=? AND id<=? AND id<? ORDER BY id DESC LIMIT 51",
      [account.id, 10000, 10001],
      "activity_account_delivery",
    ],
    [
      "SELECT server_id,COUNT(*) AS n FROM activity_events WHERE account_id=? AND created_at>? AND created_at<=? GROUP BY server_id",
      [account.id, windowStart, source.createdAt],
      "activity_account_time",
    ],
  ];
  const observations = [];
  for (const [sql, values, expectedIndex] of queries) {
    const plan = await app.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...values)
      .all();
    assert.ok(
      plan.results.some((row) => row.detail.includes(expectedIndex)),
      JSON.stringify(plan.results),
    );
    const result = await app.db
      .prepare(sql)
      .bind(...values)
      .all();
    observations.push({
      index: expectedIndex,
      rowsRead: result.meta.rows_read,
      rowsReturned: result.results.length,
    });
  }
  assert.equal(
    (await app.db.prepare("SELECT COUNT(*) AS n FROM activity_events").first()).n,
    10000,
  );
  t.diagnostic(
    JSON.stringify({
      records: 10000,
      storageGrowthBytes: (await storageBytes()) - before,
      observations,
    }),
  );
});
