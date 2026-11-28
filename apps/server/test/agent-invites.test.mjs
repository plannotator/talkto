import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";
import { rpc } from "./mcp-wire.mjs";

/*
  Agent invites (docs/agent-invites.md): any agent invites any agent; a person approves each
  newcomer in mode `ask` (the default), or newcomers join at once in mode `open`. A joined agent's
  key is one participant on one server, agent routes only, and never a person.
*/

/** The website's session for one person. */
const website = async (x, user = "user_alice") => {
  const flow = await x.browserLogin(user);
  const cookie = (await flow.callback()).headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-talkto-session="))
    .split(";")[0];
  return async (method, path, value) => {
    const response = await x.raw(path, {
      method,
      headers: { cookie, origin: "https://talkto.test", "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, json: await response.json() };
  };
};
/** A request with a bearer credential: an API key, an invited agent's key, or none. */
const bearer =
  (x, credential, extra = {}) =>
  async (method, path, value) => {
    const headers = { "content-type": "application/json", ...extra };
    if (credential !== null) headers.authorization = `Bearer ${credential}`;
    const response = await x.raw(path, {
      method,
      headers,
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, json: await response.json() };
  };
const ok = (answer, label = "") => {
  assert.equal(answer.status, 200, `${label} ${JSON.stringify(answer.json)}`);
  return answer.json.data;
};

/** Alice with a full key, an organization, a server and one agent of hers on it. */
const setup = async (t, options = {}) => {
  const x = await start(t, { apiKeySecret: true, ...options });
  const site = await website(x);
  const made = ok(await site("POST", "/v1/me/api-keys", { name: "invites", access: "full" }));
  const alice = bearer(x, made.secret);
  const account = ok(
    await alice("POST", "/v1/accounts", { name: "Acme", requestKey: randomUUID() }),
  );
  const server = ok(
    await alice("POST", `/v1/accounts/${account.id}/servers`, {
      name: "Builds",
      requestKey: randomUUID(),
    }),
  );
  const root = `/v1/servers/${server.id}`;
  const deployer = ok(
    await alice("POST", `${root}/participants`, {
      name: "deployer",
      agentType: "script",
      requestKey: randomUUID(),
    }),
  );
  const anyone = bearer(x, null);
  return { x, site, alice, anyone, account, server, root, deployer };
};

/** Redeem a code as an outside agent. */
const redeem = (s, code, name) =>
  s.anyone("POST", "/v1/agent-invites/redeem", { code, name, agentType: "claude-code" });
/** Check a request with its pickup secret. */
const check = (s, requestId, pickup, wait = 0) =>
  bearer(s.x, null, { "x-talkto-pickup": pickup })(
    "GET",
    `/v1/agent-invites/requests/${requestId}?wait=${wait}`,
  );

test("an agent invites an outside agent; a person approves it; it joins with its own key", async (t) => {
  const s = await setup(t);
  const invite = ok(
    await s.alice("POST", `${s.root}/agent-invites`, {
      participantId: s.deployer.item.id,
      note: "for the review bot",
      requestKey: randomUUID(),
    }),
  );
  assert.match(invite.code, /^tki_/);
  assert.equal(invite.invite.madeBy.name, "deployer");
  assert.equal(invite.invite.usesLeft, 1);

  const waiting = ok(await redeem(s, invite.code, "reviewer"), "redeem");
  assert.equal(waiting.status, "waiting");
  assert.ok(waiting.pickup.length > 20);
  // The link is used up: a second agent cannot join through it.
  assert.equal((await redeem(s, invite.code, "another")).status, 404);
  // Still waiting: no key yet.
  assert.equal(ok(await check(s, waiting.requestId, waiting.pickup)).status, "waiting");

  const requests = ok(await s.alice("GET", `${s.root}/agent-invites/requests`));
  assert.equal(requests.items.length, 1);
  const lineage = requests.items[0].lineage;
  assert.equal(lineage.invitedBy.name, "deployer");
  assert.deepEqual(
    lineage.chain.map((step) => step.name),
    ["deployer"],
  );
  assert.ok(lineage.origin.length > 0);

  const approved = ok(
    await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.requestId}/approve`),
  );
  assert.equal(approved.decision, "approved");
  const joined = ok(await check(s, waiting.requestId, waiting.pickup), "pickup");
  assert.equal(joined.status, "joined");
  assert.match(joined.key, new RegExp(`^tka_${s.server.id}\\.`));

  // The invited agent works as itself on its server.
  const reviewer = bearer(s.x, joined.key);
  const participants = ok(await reviewer("GET", `${s.root}/participants`));
  const listed = participants.items.find((item) => item.id === joined.participantId);
  assert.equal(listed.invite.invitedBy.name, "deployer");
  assert.deepEqual(
    listed.invite.chain.map((step) => step.name),
    ["deployer"],
  );
  assert.equal(listed.invite.originUserId, undefined);
  const own = participants.items.find((item) => item.id === s.deployer.item.id);
  assert.equal(own.invite, undefined);
  const sent = await reviewer(
    "POST",
    `${s.root}/conversations/${s.deployer.generalConversationId}/messages`,
    { participantId: joined.participantId, body: "Reviewing.", requestKey: randomUUID() },
  );
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
});

test("an invited agent's key is one agent on one server, and never a person", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const joined = ok(await redeem(s, invite.code, "outsider"));
  assert.equal(joined.status, "joined");
  const outsider = bearer(s.x, joined.key);
  const general = s.deployer.generalConversationId;

  // It cannot speak as Alice's agent, even in watch mode.
  const spoofed = await outsider("POST", `${s.root}/conversations/${general}/messages`, {
    participantId: s.deployer.item.id,
    body: "I am deployer.",
    requestKey: randomUUID(),
  });
  assert.equal(spoofed.status, 403, JSON.stringify(spoofed.json));
  // It cannot register another agent.
  const second = await outsider("POST", `${s.root}/participants`, {
    name: "second",
    agentType: "script",
    requestKey: randomUUID(),
  });
  assert.equal(second.status, 403, JSON.stringify(second.json));
  // Person routes, other servers, platform routes and approving are refused.
  for (const [method, path, value] of [
    ["POST", `${s.root}/people/me`, {}],
    ["POST", `${s.root}/people/me/renames`, { participantId: s.deployer.item.id, name: "x" }],
    ["GET", "/v1/me", undefined],
    ["GET", `/v1/accounts/${s.account.id}`, undefined],
    ["POST", `${s.root}/participants/${s.deployer.item.id}/remove`, {}],
    ["GET", `${s.root}/agent-invites/requests`, undefined],
    ["PUT", `${s.root}/agent-invites/mode`, { mode: "ask" }],
  ]) {
    const answer = await outsider(method, path, value);
    assert.equal(answer.status, 403, `${method} ${path}: ${JSON.stringify(answer.json)}`);
  }
  const other = ok(
    await s.alice("POST", `/v1/accounts/${s.account.id}/servers`, {
      name: "Other",
      requestKey: randomUUID(),
    }),
  );
  assert.equal((await outsider("GET", `/v1/servers/${other.id}/participants`)).status, 403);
  // A made-up key is 403, never 401 (a 401 sends MCP clients to sign-in).
  const forged = `tka_${s.server.id}.${"A".repeat(43)}`;
  assert.equal((await bearer(s.x, forged)("GET", `${s.root}/participants`)).status, 403);
});

test("an invited agent invites another; the chain and origin carry down", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const first = ok(
    await s.alice("POST", `${s.root}/agent-invites`, {
      participantId: s.deployer.item.id,
      requestKey: randomUUID(),
    }),
  );
  const reviewer = ok(await redeem(s, first.code, "reviewer"));
  const asReviewer = bearer(s.x, reviewer.key);
  // An invited agent invites only as its own participant.
  assert.equal(
    (await asReviewer("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() })).status,
    403,
  );
  const second = ok(
    await asReviewer("POST", `${s.root}/agent-invites`, {
      participantId: reviewer.participantId,
      requestKey: randomUUID(),
    }),
  );
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "ask" }));
  const waiting = ok(await redeem(s, second.code, "linter"));
  const [request] = ok(await s.alice("GET", `${s.root}/agent-invites/requests`)).items;
  assert.equal(request.id, waiting.requestId);
  assert.equal(request.lineage.invitedBy.name, "reviewer");
  assert.deepEqual(
    request.lineage.chain.map((step) => step.name),
    ["deployer", "reviewer"],
  );
});

test("declining ends a request; wrong codes and pickup secrets are refused", async (t) => {
  const s = await setup(t);
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const waiting = ok(await redeem(s, invite.code, "stranger"));
  ok(await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.requestId}/decline`));
  assert.equal(ok(await check(s, waiting.requestId, waiting.pickup)).status, "declined");
  // Approving after declining is a conflict.
  assert.equal(
    (await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.requestId}/approve`)).status,
    409,
  );
  assert.equal((await check(s, waiting.requestId, "wrong-pickup")).status, 404);
  assert.equal((await redeem(s, `tki_${s.server.id}.${"B".repeat(43)}`, "guess")).status, 404);
  // Only a person approves: an agent's own sign-in (a plain bearer token) cannot.
  const agentToken = await s.x.call(
    "user_alice",
    "GET",
    `${s.root}/agent-invites/requests`,
    undefined,
    403,
  );
  assert.equal(agentToken.error.code, "forbidden");
});

test("removing an invited agent stops its key at once", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const joined = ok(await redeem(s, invite.code, "temporary"));
  const temporary = bearer(s.x, joined.key);
  ok(await temporary("GET", `${s.root}/participants`));
  ok(await s.alice("POST", `${s.root}/participants/${joined.participantId}/remove`, {}));
  const after = await temporary("GET", `${s.root}/participants`);
  // 403 and "a new invite", never a retryable answer.
  assert.equal(after.status, 403, JSON.stringify(after.json));
  assert.match(after.json.error.message, /new invite/);
});

test("deleting a server ends its invite links and requests", async (t) => {
  const s = await setup(t);
  const invite = ok(
    await s.alice("POST", `${s.root}/agent-invites`, { uses: 2, requestKey: randomUUID() }),
  );
  const waiting = ok(await redeem(s, invite.code, "early"));
  ok(
    await s.alice("POST", `/v1/accounts/${s.account.id}/servers/${s.server.id}/delete`, {
      confirmation: "Builds",
    }),
    "delete",
  );
  assert.equal((await redeem(s, invite.code, "late")).status, 404);
  assert.equal((await check(s, waiting.requestId, waiting.pickup)).status, 404);
});

test("removing an agent revokes its invite links; a person may also remove the agents it invited", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const first = ok(
    await s.alice("POST", `${s.root}/agent-invites`, {
      participantId: s.deployer.item.id,
      uses: 3,
      requestKey: randomUUID(),
    }),
  );
  const reviewer = ok(await redeem(s, first.code, "reviewer"));
  const linter = ok(await redeem(s, first.code, "linter"));
  const asReviewer = bearer(s.x, reviewer.key);
  // The reviewer invites one more agent, and leaves a link open.
  const second = ok(
    await asReviewer("POST", `${s.root}/agent-invites`, {
      participantId: reviewer.participantId,
      uses: 2,
      requestKey: randomUUID(),
    }),
  );
  const grandchild = ok(await redeem(s, second.code, "formatter"));
  // An agent cannot use the option, even an invited one on its own server.
  assert.equal(
    (
      await asReviewer(
        "POST",
        `${s.root}/agent-invites/participants/${reviewer.participantId}/remove-invited`,
      )
    ).status,
    403,
  );

  // Removing the reviewer revokes its open link at once: nobody else joins through it.
  ok(await s.alice("POST", `${s.root}/participants/${reviewer.participantId}/remove`, {}));
  assert.equal((await redeem(s, second.code, "late")).status, 404);
  const open = ok(await s.alice("GET", `${s.root}/agent-invites`)).items;
  assert.deepEqual(
    open.map((item) => item.id),
    [first.invite.id],
  );
  // The agent it invited stays until a person chooses otherwise.
  ok(await bearer(s.x, grandchild.key)("GET", `${s.root}/participants`));

  // The option: remove the agents the deployer invited directly, and revoke their links and its.
  const result = ok(
    await s.alice(
      "POST",
      `${s.root}/agent-invites/participants/${s.deployer.item.id}/remove-invited`,
    ),
  );
  // The reviewer was already removed; only the linter is new. The formatter was the reviewer's.
  assert.deepEqual(result.removed, [linter.participantId]);
  assert.equal(result.revokedLinks, 1);
  assert.notEqual((await bearer(s.x, linter.key)("GET", `${s.root}/participants`)).status, 200);
  ok(await bearer(s.x, grandchild.key)("GET", `${s.root}/participants`));
  assert.equal((await redeem(s, first.code, "after")).status, 404);
  // The deployer itself stays.
  const agents = ok(await s.alice("GET", `${s.root}/participants`)).items;
  assert.equal(agents.find((item) => item.id === s.deployer.item.id).removedAt, undefined);
});

test("a link from a removed agent admits nobody, even waiting requests", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const first = ok(
    await s.alice("POST", `${s.root}/agent-invites`, {
      participantId: s.deployer.item.id,
      requestKey: randomUUID(),
    }),
  );
  const helper = ok(await redeem(s, first.code, "helper"));
  const link = ok(
    await bearer(s.x, helper.key)("POST", `${s.root}/agent-invites`, {
      participantId: helper.participantId,
      requestKey: randomUUID(),
    }),
  );
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "ask" }));
  const waiting = ok(await redeem(s, link.code, "queued"));
  ok(await s.alice("POST", `${s.root}/participants/${helper.participantId}/remove`, {}));
  // Approving after the inviter was removed lets nobody in.
  ok(await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.requestId}/approve`));
  const pickup = await check(s, waiting.requestId, waiting.pickup);
  assert.equal(pickup.status, 403, JSON.stringify(pickup.json));
  assert.match(pickup.json.error.message, /new invite/);
  const names = ok(await s.alice("GET", `${s.root}/participants`)).items.map((item) => item.name);
  assert.ok(!names.includes("queued"));
});

test("the page an invite link opens tells an agent how to join, and never sees the code", async (t) => {
  const s = await setup(t);
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const url = new URL(invite.url);
  assert.equal(url.pathname, "/join/agent");
  assert.equal(url.hash.slice(1), invite.code);
  const response = await s.x.raw(url.pathname);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/markdown/);
  const text = await response.text();
  assert.match(text, /\/v1\/agent-invites\/redeem/);
  assert.match(text, /x-talkto-pickup/);
  assert.ok(!text.includes(invite.code));
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  // HEAD answers with GET's headers and no body.
  const head = await s.x.raw(url.pathname, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("referrer-policy"), "no-referrer");
  assert.match(head.headers.get("content-type"), /^text\/markdown/);
  assert.equal((await head.text()).length, 0);
});

test("a pickup secret admits once: replays and parallel pickups get no second key", async (t) => {
  const s = await setup(t);
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const waiting = ok(await redeem(s, invite.code, "careful"));
  ok(await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.requestId}/approve`));
  const pickups = await Promise.all(
    Array.from({ length: 5 }, () => check(s, waiting.requestId, waiting.pickup)),
  );
  const joined = pickups.filter((answer) => answer.status === 200);
  assert.equal(joined.length, 1, JSON.stringify(pickups.map((answer) => answer.status)));
  assert.ok(pickups.every((answer) => answer.status === 200 || answer.status === 404));
  // A replay later, say from shell history, gets nothing; the real key keeps working.
  assert.equal((await check(s, waiting.requestId, waiting.pickup)).status, 404);
  ok(await bearer(s.x, joined[0].json.data.key)("GET", `${s.root}/participants`));
});

test("a taken name never strands a request", async (t) => {
  const s = await setup(t);
  // At redeem: refused before the use is spent.
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const taken = await redeem(s, invite.code, "deployer");
  assert.equal(taken.status, 409, JSON.stringify(taken.json));
  assert.equal(taken.json.error.code, "name_taken");
  const waiting = ok(await redeem(s, invite.code, "builder"));
  // At pickup: the name was taken meanwhile; the agent picks another with ?name=.
  ok(
    await s.alice("POST", `${s.root}/participants`, {
      name: "builder",
      agentType: "script",
      requestKey: randomUUID(),
    }),
  );
  ok(await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.requestId}/approve`));
  const clash = await check(s, waiting.requestId, waiting.pickup);
  assert.equal(clash.status, 409, JSON.stringify(clash.json));
  const renamed = await bearer(s.x, null, { "x-talkto-pickup": waiting.pickup })(
    "GET",
    `/v1/agent-invites/requests/${waiting.requestId}?name=builder-2`,
  );
  const joined = ok(renamed, "renamed pickup");
  const me = ok(await s.alice("GET", `${s.root}/participants/${joined.participantId}`));
  assert.equal(me.item?.name ?? me.name, "builder-2");
});

test("every redeem and check counts against the network", async (t) => {
  const s = await setup(t, { signalFailuresPerMinute: 3 });
  const invite = ok(
    await s.alice("POST", `${s.root}/agent-invites`, { uses: 10, requestKey: randomUUID() }),
  );
  const net = { "cf-connecting-ip": "203.0.113.9" };
  const from = bearer(s.x, null, net);
  const statuses = [];
  for (let n = 0; n < 5; n++)
    statuses.push(
      (
        await from("POST", "/v1/agent-invites/redeem", {
          code: invite.code,
          name: `agent-${n}`,
          agentType: "script",
        })
      ).status,
    );
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses.at(-1), 429);
});

test("deleting an account that started invite chains completes, and names a deleted person", async (t) => {
  const s = await setup(t);
  // Carol, a guest on Alice's server, invites an agent herself.
  const invitations = `${s.root}/invitations`;
  const sent = await s.x.call("user_alice", "POST", invitations, {
    email: "user_carol@example.com",
  });
  await s.x.call("user_carol", "POST", `/v1/invitations/${sent.invitation.id}/accept`);
  const carol = await website(s.x, "user_carol");
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const link = ok(
    await carol("POST", `${s.root}/agent-invites`, { uses: 2, requestKey: randomUUID() }),
  );
  const agent = ok(await redeem(s, link.code, "carols-agent"));
  const listed = () =>
    s
      .alice("GET", `${s.root}/participants`)
      .then((answer) => ok(answer).items.find((item) => item.id === agent.participantId).invite);
  assert.equal((await listed()).origin, "carol");

  const deleted = await carol("POST", "/v1/me/delete", { confirmation: "user_carol@example.com" });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  const [record] = (
    await s.x.db
      .prepare("SELECT completed_at FROM account_deletions WHERE user_id='user_carol'")
      .all()
  ).results;
  assert.notEqual(record.completed_at, null);
  assert.equal((await listed()).origin, "Deleted person");
  const stored = (
    await s.x.db
      .prepare("SELECT origin_user_id,origin_name,made_by_principal,revoked_at FROM agent_invites")
      .all()
  ).results;
  assert.deepEqual(
    stored.map((row) => [row.origin_user_id, row.origin_name]),
    [["deleted", "Deleted person"]],
  );
  assert.match(stored[0].made_by_principal, /^deleted:/);
  assert.ok(Number.isInteger(stored[0].revoked_at));
  // Her link stopped; her agent's own links carry the scrubbed origin.
  assert.equal((await redeem(s, link.code, "late")).status, 404);
  const next = ok(
    await bearer(s.x, agent.key)("POST", `${s.root}/agent-invites`, {
      participantId: agent.participantId,
      requestKey: randomUUID(),
    }),
  );
  const grandchild = ok(await redeem(s, next.code, "grandchild"));
  const shown = ok(await s.alice("GET", `${s.root}/participants`)).items.find(
    (item) => item.id === grandchild.participantId,
  ).invite;
  assert.equal(shown.origin, "Deleted person");
  const origins = (
    await s.x.db.prepare("SELECT DISTINCT origin_user_id AS id FROM agent_invites").all()
  ).results;
  assert.deepEqual(
    origins.map((row) => row.id),
    ["deleted"],
  );
});

test("the approved name stands: ?name= works only after a taken name", async (t) => {
  const s = await setup(t);
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const waiting = ok(await redeem(s, invite.code, "approved-name"));
  ok(await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.requestId}/approve`));
  const swapped = await bearer(s.x, null, { "x-talkto-pickup": waiting.pickup })(
    "GET",
    `/v1/agent-invites/requests/${waiting.requestId}?name=other-name`,
  );
  assert.equal(swapped.status, 403, JSON.stringify(swapped.json));
  // The secret was not spent: a plain pickup joins under the approved name.
  const joined = ok(await check(s, waiting.requestId, waiting.pickup));
  const names = ok(await s.alice("GET", `${s.root}/participants`)).items.map((item) => item.name);
  assert.ok(names.includes("approved-name"));
  assert.ok(!names.includes("other-name"));
  assert.ok(joined.participantId);
});

test("a removal spelled with a trailing slash still revokes the agent's links", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const first = ok(
    await s.alice("POST", `${s.root}/agent-invites`, {
      participantId: s.deployer.item.id,
      requestKey: randomUUID(),
    }),
  );
  const helper = ok(await redeem(s, first.code, "helper"));
  const link = ok(
    await bearer(s.x, helper.key)("POST", `${s.root}/agent-invites`, {
      participantId: helper.participantId,
      uses: 3,
      requestKey: randomUUID(),
    }),
  );
  const removed = await s.alice(
    "POST",
    `${s.root}/participants/${helper.participantId}/remove/`,
    {},
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  const open = ok(await s.alice("GET", `${s.root}/agent-invites`)).items;
  assert.ok(!open.some((item) => item.id === link.invite.id));
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "ask" }));
  assert.equal((await redeem(s, link.code, "queued")).status, 404);
});

test("an invited worker on a swarm reads memory and gets a write token while it holds a claim", async (t) => {
  const s = await setup(t, { board: true, memory: true });
  const swarm = ok(
    await s.alice("POST", `/v1/accounts/${s.account.id}/servers`, {
      name: "Swarm",
      board: true,
      requestKey: randomUUID(),
    }),
  );
  const root = `/v1/servers/${swarm.id}`;
  ok(await s.alice("PUT", `${root}/agent-invites/mode`, { mode: "open" }));
  const invite = ok(await s.alice("POST", `${root}/agent-invites`, { requestKey: randomUUID() }));
  const worker = ok(await redeem(s, invite.code, "worker"));
  const as = bearer(s.x, worker.key);
  const me = worker.participantId;
  ok(
    await as("POST", `${root}/participants/${me}/tasks`, {
      requestKey: randomUUID(),
      tasks: [{ title: "Fix the build", brief: "Do this: fix the build." }],
    }),
    "create",
  );
  const claimed = ok(
    await as("POST", `${root}/participants/${me}/tasks/claim`, {
      requestKey: randomUUID(),
      next: {},
    }),
    "claim",
  );
  assert.equal(claimed.claimed, true);
  // Memory as any agent reads it, and a write token while the claim is held.
  ok(await as("GET", `${root}/memory?participantId=${me}`), "read memory");
  const write = {
    taskId: claimed.task.id,
    leaseToken: claimed.lease.token,
    epoch: claimed.lease.epoch,
  };
  const token = ok(
    await as("POST", `${root}/participants/${me}/memory/access`, { write }),
    "write access",
  );
  assert.ok(JSON.stringify(token).includes("write"), JSON.stringify(token));
  ok(
    await as("POST", `${root}/participants/${me}/tasks/${claimed.task.id}/updates`, {
      requestKey: randomUUID(),
      leaseToken: claimed.lease.token,
      epoch: claimed.lease.epoch,
      action: "complete",
      summary: "Done",
    }),
    "complete",
  );
  // complete ends the claim: no write token after it, as for any agent.
  const after = await as("POST", `${root}/participants/${me}/memory/access`, { write });
  assert.equal(after.json.error?.code, "claim_lost", JSON.stringify(after.json));
});

/** Every operation name the four `run` transactions receive, read from their sources. */
const operations = async () => {
  const { readFile } = await import("node:fs/promises");
  const names = new Set();
  for (const file of ["talkto.ts", "board/service.ts", "memory/service.ts", "wakes/service.ts"]) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    // `run(access, "name", …)` and `detail(access, "name", …)`, the name possibly a ternary.
    for (const [, argument] of source.matchAll(
      /\b(?:run|detail)\(\s*[\w.]+,\s*([^,(]+?),\s*\(?/g,
    )) {
      if (argument.trim() === "operation") continue; // `run` and `detail`'s own definitions
      // In `kind === "cancel" ? "cancelTask" : "reopenTask"`, the names are after the `?`.
      const named = argument.includes("?") ? argument.slice(argument.indexOf("?")) : argument;
      const literals = [...named.matchAll(/"([A-Za-z.]+)"/g)].map((match) => match[1]);
      assert.ok(literals.length > 0, `${file}: an operation named by ${argument.trim()}`);
      for (const name of literals) names.add(name);
    }
  }
  return names;
};

/*
  The server object's allowlist for invited agents, decided operation by operation. A new
  operation fails this test until it is placed here: refused unless someone adds it.
*/
const invitedMay = new Set([
  "getServer",
  "getUpdates",
  "registerParticipant",
  "renameSelf",
  "getParticipant",
  "listParticipants",
  "createChannel",
  "listChannels",
  "getConversation",
  "setChannelArchived",
  "openDirectConversation",
  "listDirectConversations",
  "sendMessage",
  "sendTo",
  "confirmMessage",
  "readMessages",
  "searchMessages",
  "getMessageContext",
  "readArchive",
  "readArchive.authorize",
  "createSignal",
  "revokeSignal",
  "countSignal",
  "getPackCommand",
  "prepareTransfer",
  "prepareTransfer.refused",
  "prepareTransfer.pooled",
  "completeTransfer",
  "completeTransfer.read",
  "fetchTransfer.read",
  "fetchTransfer.record",
  "readTransfer",
  "listTransfers",
  "downloadTransfer",
  "listShares",
  "createTasks",
  "claimTask",
  "updateTask",
  "updateTask.files",
  "listTasks",
  "readTask",
  "boardContext",
  "board",
  "boardTasks",
  "boardLabels",
  "memory.provision",
  "memory.created",
  "memory.seeded",
  "memory.start",
  "memory.state",
  "memory.channel",
  "memory.read",
  "memory.access",
  "memory.granted",
  "wakes.subscribe",
  "wakes.subscribe.check",
  "wakes.unsubscribe",
]);
const invitedMayNot = new Set([
  "serverTimeline",
  "serverTimelineSenders",
  "serverSummary",
  "onboarding",
  "serverFeed",
  "hydrateMessages",
  "searchActivity",
  "renameAgent",
  "setAgentRemoved",
  "listRemovals",
  "listRenames",
  "getPersonSelf",
  "joinAsPerson",
  "openPersonDirectChat",
  "sendPersonMessage",
  "filesAccess",
  "filesAccess.record",
  "shareFile",
  "boardTask",
  "cancelTask",
  "reopenTask",
  "setBoard",
  "wakes.create",
  "wakes.revoke",
  "wakes.list",
  "wakes.cadence",
  "wakes.setCadence",
  "wakes.test",
]);

test("the server object decides every operation for invited agents, and refuses new ones", async () => {
  const { load } = await import("./sources.mjs");
  const Actors = await load("../src/actors.ts");
  const invited = "invited:00000000-0000-4000-8000-000000000000";
  const found = await operations();
  for (const name of found) {
    assert.ok(
      invitedMay.has(name) || invitedMayNot.has(name),
      `${name}: decide whether an invited agent may run it (actors.ts invitedOperations)`,
    );
    assert.equal(Actors.mayRun(invited, name), invitedMay.has(name), name);
    // Everyone else is unaffected.
    assert.ok(Actors.mayRun("workos:user_alice", name), name);
  }
  for (const name of [...invitedMay, ...invitedMayNot])
    assert.ok(found.has(name), `${name} is no longer an operation: drop it from this test`);
  // An operation nobody has decided yet is refused.
  assert.ok(!Actors.mayRun(invited, "someNewOperation"));
});

test("an invited agent works tasks on a swarm server", async (t) => {
  const s = await setup(t, { board: true });
  const swarm = ok(
    await s.alice("POST", `/v1/accounts/${s.account.id}/servers`, {
      name: "Swarm",
      board: true,
      requestKey: randomUUID(),
    }),
  );
  const root = `/v1/servers/${swarm.id}`;
  ok(await s.alice("PUT", `${root}/agent-invites/mode`, { mode: "open" }));
  const invite = ok(await s.alice("POST", `${root}/agent-invites`, { requestKey: randomUUID() }));
  const worker = ok(await redeem(s, invite.code, "worker"));
  const as = bearer(s.x, worker.key);
  const me = worker.participantId;
  ok(
    await as("POST", `${root}/participants/${me}/tasks`, {
      requestKey: randomUUID(),
      tasks: [{ title: "Fix the build", brief: "Do this: fix the build." }],
    }),
    "create",
  );
  const claimed = ok(
    await as("POST", `${root}/participants/${me}/tasks/claim`, {
      requestKey: randomUUID(),
      next: {},
    }),
    "claim",
  );
  assert.equal(claimed.claimed, true);
  const tasks = ok(await as("GET", `${root}/tasks?participantId=${me}`), "tasks");
  assert.ok(JSON.stringify(tasks).includes("Fix the build"));
  // The Board's own view is for people, as for any agent; so are a person's task actions.
  assert.equal((await as("GET", `${root}/board`)).status, 403);
  const taskId = claimed.task.id;
  for (const action of ["cancel", "reopen"])
    assert.equal(
      (
        await as("POST", `${root}/people/me/tasks/${taskId}/${action}`, {
          requestKey: randomUUID(),
        })
      ).status,
      403,
      action,
    );
  // Memory's Git access is an agent's, like any agent's: never refused as an invited agent.
  const memory = await as("POST", `${root}/participants/${me}/memory/access`, {});
  assert.ok(
    memory.status === 200 || memory.json.error.code !== "forbidden",
    JSON.stringify(memory.json),
  );
});

/** A JSON-RPC call to /mcp with this bearer. */
const mcpCall = async (x, credential, method, params = {}) => {
  const response = await x.raw("/mcp", rpc(method, params, credential));
  return { status: response.status, headers: response.headers, json: await response.json() };
};

test("an invited agent works on MCP with its key: its own tools, on its one server", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const joined = ok(await redeem(s, invite.code, "mcp-agent"));
  const me = joined.participantId;
  // Its catalog: an agent's own tools, privately cached; never registering, feedback, Git or wakes.
  const listed = await mcpCall(s.x, joined.key, "tools/list");
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  const names = listed.json.result.tools.map((tool) => tool.name);
  for (const name of [
    "get_context",
    "get_updates",
    "send_message",
    "confirm_message",
    "read_messages",
  ])
    assert.ok(names.includes(name), name);
  for (const name of [
    "register_participant",
    "send_feedback",
    "get_files_access",
    "share_file",
    "list_wakes",
    "revoke_wake",
  ])
    assert.ok(!names.includes(name), name);
  // It talks as itself.
  const context = await s.x.mcp(joined.key, "get_context", {
    serverId: s.server.id,
    participant: { id: me },
  });
  const general = context.data.server.generalConversationId;
  const sent = await s.x.mcp(joined.key, "send_message", {
    serverId: s.server.id,
    participantId: me,
    target: { kind: "conversation", conversationId: general },
    body: "Hello over MCP.",
    requestKey: randomUUID(),
  });
  assert.equal(sent.data.item.senderId, me);
  // Not as anyone else, and not on another server or none.
  const spoofed = await s.x.mcp(
    joined.key,
    "send_message",
    {
      serverId: s.server.id,
      participantId: s.deployer.item.id,
      target: { kind: "conversation", conversationId: general },
      body: "I am deployer.",
      requestKey: randomUUID(),
    },
    true,
  );
  assert.equal(spoofed.error.code, "forbidden", JSON.stringify(spoofed));
  const elsewhere = await s.x.mcp(
    joined.key,
    "get_context",
    { serverId: "00000000-0000-4000-8000-000000000000" },
    true,
  );
  assert.equal(elsewhere.error.code, "forbidden");
  assert.match(elsewhere.error.message, new RegExp(s.server.id));
  assert.equal((await s.x.mcp(joined.key, "get_context", {}, true)).error.code, "forbidden");
  // A tool it is not offered is unknown to it.
  const wakes = await mcpCall(s.x, joined.key, "tools/call", {
    name: "list_wakes",
    arguments: { serverId: s.server.id, participantId: me },
  });
  assert.ok(wakes.json.error, JSON.stringify(wakes.json));
  // Removed, its key gets 403-style "ask for a new invite", never "unavailable".
  ok(await s.alice("POST", `${s.root}/participants/${me}/remove`, {}));
  const gone = await s.x.mcp(
    joined.key,
    "get_context",
    { serverId: s.server.id, participant: { id: me } },
    true,
  );
  assert.equal(gone.error.code, "forbidden", JSON.stringify(gone));
  assert.match(gone.error.message, /Ask for a new invite/);
});

test("a key that is not genuine on /mcp is 403, never the sign-in 401", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const joined = ok(await redeem(s, invite.code, "mcp-try"));
  const forged = `${joined.key.slice(0, -4)}AAAA`;
  const response = await mcpCall(s.x, forged, "tools/list");
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.equal(response.json.error.code, "forbidden");
});

test("the server object's refusal reaches HTTP as 403 forbidden, saying what to do", async () => {
  const { load } = await import("./sources.mjs");
  const Responses = await load("../src/responses.ts");
  const Access = await load("../src/access.ts");
  const meta = { requestId: "r", serverTime: "2026-11-25T00:00:00.000Z" };
  const refused = Responses.projectFailure(
    { _tag: "ServerAccessDenied", message: Access.invitedRefusal },
    meta,
  );
  assert.equal(refused.error.code, "forbidden");
  assert.match(refused.error.message, /ask a person on the server/);
  const other = Responses.projectFailure(
    { _tag: "ServerAccessDenied", message: "The server is unavailable." },
    meta,
  );
  assert.equal(other.error.code, "server_unavailable");
});

test("only admission registers for an invited principal: no other caller sets the flag", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const root = new URL("../src/", import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
  const callers = [];
  for (const file of files) {
    const source = await readFile(new URL(file, root), "utf8");
    // Each call fits on one line: `.registerParticipant(access, input[, admission(admit)])`.
    for (const line of source.split("\n").filter((text) => text.includes(".registerParticipant(")))
      callers.push({ file, admits: /\.registerParticipant\(.*,\s*admission\(/.test(line) });
  }
  // HTTP (http.ts) and MCP (agent.ts) never admit, so an invited key there is refused
  // (`Actors.invitedRegistration`); only the server object's admission does.
  assert.deepEqual(
    callers.filter((caller) => caller.admits).map((caller) => caller.file),
    ["server-object.ts"],
  );
  assert.ok(
    callers.some((caller) => caller.file === "agent.ts" && !caller.admits),
    "MCP path",
  );
  assert.ok(
    callers.some((caller) => caller.file === "http.ts" && !caller.admits),
    "HTTP path",
  );
});

test("an invited agent's signal link counts, and the dashboard feed is not an agent route", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const joined = ok(await redeem(s, invite.code, "hooked"));
  const as = bearer(s.x, joined.key);
  const general = ok(await as("GET", s.root)).generalConversationId;
  const link = ok(
    await as("POST", `${s.root}/participants/${joined.participantId}/signals`, {
      channelIds: [general],
      directChats: "own",
    }),
    "mint",
  );
  // A hook checks the link with its secret as the bearer, never with the agent's key.
  const target = new URL(link.url);
  const dot = target.pathname.lastIndexOf(".");
  const checked = await s.x.raw(target.pathname.slice(0, dot), {
    headers: { authorization: `Bearer ${target.pathname.slice(dot + 1)}` },
  });
  assert.equal(checked.status, 200, await checked.clone().text());
  assert.ok(Number.isInteger((await checked.json()).pending));
  // `serverFeed` is the dashboard's: refused by the Worker as by the server object.
  assert.equal((await as("GET", `${s.root}/messages`)).status, 403);
});

/** A JSON-RPC call to /mcp/join, with no credential. */
const joinCall = async (x, method, params = {}, extra = {}) => {
  const request = rpc(method, params);
  const response = await x.raw("/mcp/join", {
    ...request,
    headers: { ...request.headers, ...extra },
  });
  return { status: response.status, headers: response.headers, json: await response.json() };
};
/** A tool on /mcp/join: its structured answer. */
const joinTool = async (x, name, args) => {
  const answer = await joinCall(x, "tools/call", { name, arguments: args });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json.result.structuredContent;
};

test("an agent joins over /mcp/join with no sign-in, then works on /mcp with its key", async (t) => {
  const s = await setup(t);
  const invite = ok(
    await s.alice("POST", `${s.root}/agent-invites`, {
      participantId: s.deployer.item.id,
      requestKey: randomUUID(),
    }),
  );
  // Only redeem and the request check, and nothing that sends a client to sign in.
  const listed = await joinCall(s.x, "tools/list");
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  assert.deepEqual(listed.json.result.tools.map((tool) => tool.name).sort(), [
    "check_agent_invite",
    "redeem_agent_invite",
  ]);
  assert.equal(listed.headers.get("www-authenticate"), null);
  const metadata = await s.x.raw("/.well-known/oauth-protected-resource/mcp/join");
  assert.notEqual(metadata.status, 200);

  const unknown = await joinTool(s.x, "redeem_agent_invite", {
    code: `${invite.code.slice(0, -4)}AAAA`,
    name: "reviewer",
    agentType: "claude-code",
  });
  assert.equal(unknown.error.code, "not_found", JSON.stringify(unknown));
  const bad = await joinTool(s.x, "redeem_agent_invite", { code: invite.code });
  assert.equal(bad.error.code, "invalid_input", JSON.stringify(bad));

  const waiting = await joinTool(s.x, "redeem_agent_invite", {
    code: invite.code,
    name: "reviewer",
    agentType: "claude-code",
    note: "Reviewing PRs.",
  });
  assert.equal(waiting.data.status, "waiting", JSON.stringify(waiting));
  const still = await joinTool(s.x, "check_agent_invite", {
    requestId: waiting.data.requestId,
    pickup: waiting.data.pickup,
  });
  assert.equal(still.data.status, "waiting", JSON.stringify(still));
  const wrong = await joinTool(s.x, "check_agent_invite", {
    requestId: waiting.data.requestId,
    pickup: `${waiting.data.pickup}x`,
  });
  assert.ok(wrong.error, JSON.stringify(wrong));

  ok(await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.data.requestId}/approve`));
  const joined = await joinTool(s.x, "check_agent_invite", {
    requestId: waiting.data.requestId,
    pickup: waiting.data.pickup,
    waitSeconds: 1,
  });
  assert.equal(joined.data.status, "joined", JSON.stringify(joined));
  assert.match(joined.data.key, new RegExp(`^tka_${s.server.id}\\.`));
  // The pickup is spent.
  const again = await joinTool(s.x, "check_agent_invite", {
    requestId: waiting.data.requestId,
    pickup: waiting.data.pickup,
  });
  assert.ok(again.error, JSON.stringify(again));

  const context = await s.x.mcp(joined.data.key, "get_context", {
    serverId: s.server.id,
    participant: { id: joined.data.participantId },
  });
  assert.equal(context.data.server.id, s.server.id);
});

test("an invited agent makes, lists and revokes invite links over MCP, as itself only", async (t) => {
  const s = await setup(t);
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const joined = ok(await redeem(s, invite.code, "lead"));
  const me = joined.participantId;
  const names = (await mcpCall(s.x, joined.key, "tools/list")).json.result.tools.map(
    (tool) => tool.name,
  );
  for (const name of ["create_agent_invite", "list_agent_invites", "revoke_agent_invite"])
    assert.ok(names.includes(name), name);

  const made = await s.x.mcp(joined.key, "create_agent_invite", {
    serverId: s.server.id,
    participantId: me,
    uses: 2,
    note: "for my helpers",
    requestKey: randomUUID(),
  });
  assert.match(made.data.code, /^tki_/);
  assert.equal(made.data.invite.madeBy.name, "lead");
  assert.equal(made.data.url, `https://talkto.test/join/agent#${made.data.code}`);
  // Its helper joins through it over /mcp/join, with lead in its chain.
  const helper = await joinTool(s.x, "redeem_agent_invite", {
    code: made.data.code,
    name: "helper",
    agentType: "claude-code",
  });
  assert.equal(helper.data.status, "joined", JSON.stringify(helper));
  const participants = ok(await s.alice("GET", `${s.root}/participants`));
  const listedHelper = participants.items.find((item) => item.id === helper.data.participantId);
  assert.deepEqual(
    listedHelper.invite.chain.map((step) => step.name),
    ["lead"],
  );

  // Not as another agent, and not on another server.
  const spoofed = await s.x.mcp(
    joined.key,
    "create_agent_invite",
    { serverId: s.server.id, participantId: s.deployer.item.id, requestKey: randomUUID() },
    true,
  );
  assert.equal(spoofed.error.code, "forbidden", JSON.stringify(spoofed));
  const elsewhere = await s.x.mcp(
    joined.key,
    "list_agent_invites",
    { serverId: "00000000-0000-4000-8000-000000000000" },
    true,
  );
  assert.equal(elsewhere.error.code, "forbidden");

  const open = await s.x.mcp(joined.key, "list_agent_invites", { serverId: s.server.id });
  const mine = open.data.items.find((item) => item.id === made.data.invite.id);
  assert.equal(mine.usesLeft, 1);
  assert.equal(JSON.stringify(open).includes(made.data.code), false);
  const revoked = await s.x.mcp(joined.key, "revoke_agent_invite", {
    serverId: s.server.id,
    inviteId: made.data.invite.id,
  });
  assert.equal(revoked.data.id, made.data.invite.id);
  const late = await joinTool(s.x, "redeem_agent_invite", {
    code: made.data.code,
    name: "late",
    agentType: "claude-code",
  });
  assert.equal(late.error.code, "not_found");

  // Removed, its invite tools say to ask for a new invite.
  ok(await s.alice("POST", `${s.root}/participants/${me}/remove`, {}));
  const gone = await s.x.mcp(joined.key, "list_agent_invites", { serverId: s.server.id }, true);
  assert.equal(gone.error.code, "forbidden", JSON.stringify(gone));
});

test("a signed-in person's agent makes an invite link over MCP; approving stays a person's", async (t) => {
  const s = await setup(t);
  const credential = await s.x.mcpToken(s.account.organizationId);
  const registered = await s.x.mcp(credential, "register_participant", {
    serverId: s.server.id,
    name: "planner",
    agentType: "claude-code",
    requestKey: randomUUID(),
  });
  const planner = registered.data.item.id;
  const made = await s.x.mcp(credential, "create_agent_invite", {
    serverId: s.server.id,
    participantId: planner,
    requestKey: randomUUID(),
  });
  assert.equal(made.data.invite.madeBy.name, "planner");
  const waiting = ok(await redeem(s, made.data.code, "outsider"));
  assert.equal(waiting.status, "waiting");
  // The same agent cannot approve: there is no MCP tool for it, and the route refuses its token.
  const approve = await s.x.raw(`${s.root}/agent-invites/requests/${waiting.requestId}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  });
  assert.notEqual(approve.status, 200);
  const listed = await s.x.mcp(credential, "list_agent_invites", { serverId: s.server.id });
  assert.ok(
    listed.data.items.every((item) => item.id !== made.data.invite.id),
    "used up",
  );
});

test("every redeem over /mcp/join counts against the caller's network, as over HTTP", async (t) => {
  const s = await setup(t, { signalFailuresPerMinute: 3 });
  const invite = ok(
    await s.alice("POST", `${s.root}/agent-invites`, { uses: 10, requestKey: randomUUID() }),
  );
  const codes = [];
  for (let n = 0; n < 5; n++) {
    const answer = await joinCall(
      s.x,
      "tools/call",
      {
        name: "redeem_agent_invite",
        arguments: { code: invite.code, name: `agent-${n}`, agentType: "script" },
      },
      { "cf-connecting-ip": "203.0.113.10" },
    );
    const content = answer.json.result.structuredContent;
    codes.push(content.error?.code ?? content.data.status);
  }
  assert.deepEqual(codes.slice(0, 3), ["waiting", "waiting", "waiting"]);
  assert.equal(codes.at(-1), "rate_limited");
});

test("a pickup secret that is not a minted one is invalid input on /mcp/join and matches nothing on HTTP", async (t) => {
  const s = await setup(t);
  const invite = ok(await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }));
  const waiting = ok(await redeem(s, invite.code, "checker"));
  for (const pickup of ["a\r\nb", "short", `${waiting.pickup}x`]) {
    const answer = await joinTool(s.x, "check_agent_invite", {
      requestId: waiting.requestId,
      pickup,
    });
    assert.equal(answer.error.code, "invalid_input", JSON.stringify(answer));
  }
  assert.equal((await check(s, waiting.requestId, "short")).status, 404);
  // The real secret still works.
  assert.equal(ok(await check(s, waiting.requestId, waiting.pickup)).status, "waiting");
});

/** General's messages, oldest first, as a person reads them. */
const generalMessages = async (s) =>
  ok(
    await s.alice(
      "GET",
      `${s.root}/conversations/${s.deployer.generalConversationId}/messages?limit=100`,
    ),
  ).items;

test("General hears once that an invited agent joined, naming the agent that invited it", async (t) => {
  const s = await setup(t);
  // A person's link, mode open: the agent joins at once.
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "open" }));
  const byPerson = ok(
    await s.alice("POST", `${s.root}/agent-invites`, { requestKey: randomUUID() }),
  );
  const first = ok(await redeem(s, byPerson.code, "scout"));
  // An agent's link, mode ask: the notice comes with the approved pickup, once.
  ok(await s.alice("PUT", `${s.root}/agent-invites/mode`, { mode: "ask" }));
  const byAgent = ok(
    await s.alice("POST", `${s.root}/agent-invites`, {
      participantId: s.deployer.item.id,
      requestKey: randomUUID(),
    }),
  );
  const waiting = ok(await redeem(s, byAgent.code, "reviewer"));
  assert.equal(
    (await generalMessages(s)).filter((item) => item.joined !== undefined).length,
    1,
    "no notice while waiting",
  );
  ok(await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.requestId}/approve`));
  const second = ok(await check(s, waiting.requestId, waiting.pickup));
  assert.equal(second.status, "joined");
  // A replayed pickup gets nothing, and adds no notice.
  assert.notEqual((await check(s, waiting.requestId, waiting.pickup)).status, 200);

  const notices = (await generalMessages(s)).filter((item) => item.joined !== undefined);
  assert.deepEqual(
    notices.map((item) => [item.senderId, item.joined.participantId]),
    [
      [first.participantId, first.participantId],
      [second.participantId, second.participantId],
    ],
  );
  // The person whose invite started the chain, by first name, as on the agent's lineage.
  const origin = ok(await s.alice("GET", `${s.root}/participants`)).items.find(
    (item) => item.id === second.participantId,
  ).invite.origin;
  assert.ok(origin.length > 0);
  assert.equal(notices[0].body, `TalkTo: scout joined, invited by ${origin}.`);
  assert.equal(
    notices[1].body,
    `TalkTo: reviewer joined, invited by deployer (from ${origin}'s invite).`,
  );
  for (const item of notices) assert.equal(item.notice, undefined);
});

test("a taken name at pickup posts no notice until the agent joins under another", async (t) => {
  const s = await setup(t);
  const invite = ok(
    await s.alice("POST", `${s.root}/agent-invites`, {
      participantId: s.deployer.item.id,
      requestKey: randomUUID(),
    }),
  );
  const waiting = ok(await redeem(s, invite.code, "builder"));
  ok(await s.alice("POST", `${s.root}/agent-invites/requests/${waiting.requestId}/approve`));
  // Someone takes the name before the pickup.
  ok(
    await s.alice("POST", `${s.root}/participants`, {
      name: "builder",
      agentType: "script",
      requestKey: randomUUID(),
    }),
  );
  assert.equal((await check(s, waiting.requestId, waiting.pickup)).status, 409);
  const joined = ok(
    await bearer(s.x, null, { "x-talkto-pickup": waiting.pickup })(
      "GET",
      `/v1/agent-invites/requests/${waiting.requestId}?name=builder-2`,
    ),
  );
  assert.equal(joined.status, "joined");
  const notices = (await generalMessages(s)).filter((item) => item.joined !== undefined);
  assert.equal(notices.length, 1);
  assert.match(
    notices[0].body,
    /^TalkTo: builder-2 joined, invited by deployer \(from .+'s invite\)\.$/,
  );
});
