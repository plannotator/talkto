import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { rpc } from "./mcp-wire.mjs";
import { start } from "./platform-harness.mjs";

const commit = "9f3c2ab4d1e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0";
const later = "2c77e10aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5";
const path = "specs/billing-rewrite/api.md";
const control = async (x, route, data) => {
  const response = await x.control(route, data);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const toolNames = async (x, credential) =>
  (await (await x.raw("/mcp", rpc("tools/list", {}, credential))).json()).result.tools;
/** One account, one server, one registered sharer, with helpers bound to that server. */
const setup = async (t, options = {}) => {
  const x = await start(t, { files: true, ...options });
  const account = await x.account();
  if (options.metering)
    await control(x, `quota/publish?account=${account.id}`, {
      accountId: account.id,
      start: new Date(Date.now() - 3600000).toISOString(),
      end: new Date(Date.now() + 3600000).toISOString(),
      allowance: options.allowance ?? 40,
      overdraft: 0,
    });
  const credential = await x.mcpToken(account.organizationId);
  const server = await x.server(account.id);
  const registered = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "sharer",
    agentType: "claude-code",
    requestKey: randomUUID(),
  });
  const participantId = registered.data.item.id;
  const general = registered.data.generalConversationId;
  const mcp = (name, args, error = false) =>
    x.mcp(credential, name, { serverId: server.id, participantId, ...args }, error);
  const read = (args) => x.mcp(credential, "read_messages", { serverId: server.id, ...args });
  const share = (args = {}, error = false) =>
    mcp(
      "share_file",
      {
        target: { kind: "conversation", conversationId: general },
        requestKey: randomUUID(),
        path,
        commit,
        bytes: 18432,
        body: "Draft API for the billing rewrite. Review before Thursday.",
        ...args,
      },
      error,
    );
  return {
    x,
    account,
    credential,
    server,
    registered,
    participantId,
    general,
    mcp,
    read,
    share,
    files: () => control(x, `files?server=${server.id}`),
    meter: () => control(x, `meter?server=${server.id}`),
    catalog: () => toolNames(x, credential),
  };
};

/** A raw tools/call, answered either as a tool result or as a protocol error. */
const callTool = async (x, credential, name, args) =>
  (await x.raw("/mcp", rpc("tools/call", { name, arguments: args }, credential))).json();

test("without a file store the Git tools are absent, a call to one answers files_unavailable, and the capability is empty", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  const server = await x.server(account.id);
  const names = (await toolNames(x, credential)).map((tool) => tool.name);
  assert.ok(!names.includes("get_files_access"));
  assert.ok(!names.includes("share_file"));
  assert.equal(names.length, 15);
  const context = await x.mcp(credential, "get_context", { serverId: server.id });
  assert.deepEqual(context.data.capabilities, []);
  const answered = await callTool(x, credential, "get_files_access", {
    serverId: server.id,
    participantId: randomUUID(),
    scope: "write",
  });
  assert.equal(answered.result.isError, true, JSON.stringify(answered));
  assert.equal(answered.result.structuredContent.error.code, "files_unavailable");
  assert.match(answered.result.structuredContent.error.message, /Paste the content/);
  const unknown = await callTool(x, credential, "no_such_tool", {});
  assert.equal(unknown.result, undefined, JSON.stringify(unknown));
  assert.match(unknown.error.message, /Unknown TalkTo tool/);
});

test("after Git sharing retires, old shares still read everywhere, the Git tools name transfers, and deletion does not wait for a repository", async (t) => {
  // Hosted since 2026-11-16: transfers configured, no Artifacts binding and no local remote.
  const x = await start(t, { transfers: true, manualAlarms: true });
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  const server = await x.server(account.id);
  const registered = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "sharer",
    agentType: "claude-code",
    requestKey: randomUUID(),
  });
  const participantId = registered.data.item.id;
  const general = registered.data.generalConversationId;
  assert.deepEqual(registered.data.context.capabilities, ["transfers"]);
  const names = (await toolNames(x, credential)).map((tool) => tool.name);
  assert.ok(names.includes("prepare_transfer"));
  assert.ok(!names.includes("get_files_access"));
  assert.ok(!names.includes("share_file"));
  // A share announced before retirement: its message, its share row and the recorded repository.
  const sent = await x.mcp(credential, "send_message", {
    serverId: server.id,
    participantId,
    target: { kind: "conversation", conversationId: general },
    requestKey: randomUUID(),
    body: "Draft API for the billing rewrite. Review before Thursday.",
  });
  await control(x, `files?server=${server.id}`, {
    shareMessageId: sent.data.item.id,
    recordedRemote: `https://acct.artifacts.cloudflare.net/git/talkto-production/srv-${server.id}.git`,
  });
  const share = { path, commit, ref: "main", bytes: 18432 };
  const item = { ...sent.data.item, share };
  const history = await x.mcp(credential, "read_messages", {
    serverId: server.id,
    mode: "history",
    conversationId: general,
  });
  assert.deepEqual(history.data.items.at(-1), item);
  const found = await x.mcp(credential, "read_messages", {
    serverId: server.id,
    mode: "search",
    query: "billing rewrite",
  });
  assert.deepEqual(found.data.items, [item]);
  const reader = await x.mcp(credential, "register_participant", {
    serverId: server.id,
    name: "reader",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const updates = await x.mcp(credential, "get_updates", {
    serverId: server.id,
    participantId: reader.data.item.id,
    mode: "start",
    channelIds: [general],
    directChats: "own",
    startAt: "beginning",
  });
  assert.deepEqual(updates.data.messages, [item]);
  const feed = await x.call("user_alice", "GET", `/v1/servers/${server.id}/messages`);
  assert.deepEqual(feed.items[0], item);
  const shares = await x.call("user_alice", "GET", `/v1/servers/${server.id}/files/shares`);
  assert.deepEqual(shares.items, [item]);
  const managed = await x.call(
    "user_alice",
    "GET",
    `/v1/accounts/${account.id}/servers/${server.id}`,
  );
  assert.equal(managed.files, null, "no Files tab");
  // Both retired tools answer with a typed error that names the replacement.
  for (const [name, args] of [
    ["get_files_access", { scope: "read" }],
    [
      "share_file",
      {
        target: { kind: "conversation", conversationId: general },
        requestKey: randomUUID(),
        path,
        commit,
        body: "Another file",
      },
    ],
  ]) {
    const answered = await callTool(x, credential, name, {
      serverId: server.id,
      participantId,
      ...args,
    });
    assert.equal(answered.result.isError, true, JSON.stringify(answered));
    const error = answered.result.structuredContent.error;
    assert.equal(error.code, "files_unavailable");
    assert.match(error.message, /has ended/);
    assert.match(error.message, /prepare_transfer/);
    assert.match(error.message, /complete_transfer/);
    assert.match(error.message, /fetch_transfer/);
  }
  assert.equal((await control(x, `files?server=${server.id}`)).shares.length, 1, "nothing shared");
  // The server once had a repository; with no Git store to ask, deletion completes at once.
  assert.deepEqual(
    await x.call("user_alice", "POST", `/v1/accounts/${account.id}/servers/${server.id}/delete`, {
      confirmation: server.name,
    }),
    { serverId: server.id, status: "deleted" },
  );
  const completed = await x.db
    .prepare("SELECT deletion_completed_at AS completed FROM servers WHERE id=?")
    .bind(server.id)
    .first();
  assert.ok(completed.completed, "the deletion finished without a scheduled retry");
  assert.deepEqual((await control(x, `deletion?server=${server.id}`)).keys, []);
});

test("get_files_access ensures the repository, mints scoped tokens, records the ledger, and denies unregistered participants", async (t) => {
  const s = await setup(t);
  const tools = await s.catalog();
  const access = tools.find((tool) => tool.name === "get_files_access");
  const announce = tools.find((tool) => tool.name === "share_file");
  assert.equal(tools.length, 17);
  for (const tool of [access, announce]) {
    assert.ok(tool.inputSchema && tool.outputSchema);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.match(tool.description, /fetch only when/i);
  }
  assert.match(access.description, /never go into a file, a script/);
  assert.match(access.description, /expire/);
  assert.deepEqual(s.registered.data.context.capabilities, ["files"]);
  const context = await s.x.mcp(s.credential, "get_context", { serverId: s.server.id });
  assert.deepEqual(context.data.capabilities, ["files"]);

  const write = await s.mcp("get_files_access", { scope: "write" });
  const remote = `https://fake.artifacts.test/git/test/srv-${s.server.id}.git`;
  assert.equal(write.data.remote, remote);
  assert.equal(write.data.token, "fake_1");
  assert.equal(write.data.defaultBranch, "main");
  const lifetime = Date.parse(write.data.expiresAt) - Date.parse(write.meta.serverTime);
  assert.ok(Math.abs(lifetime - 3600000) < 10000, String(lifetime));
  assert.deepEqual(write.data.procedure.split("\n"), [
    `git -c http.extraHeader="Authorization: Bearer fake_1" clone ${remote} talkto-files`,
    "cp <your file> talkto-files/<path>",
    'git -C talkto-files add -A && git -C talkto-files commit -m "<why this file exists>"',
    'git -C talkto-files -c http.extraHeader="Authorization: Bearer fake_1" push origin main',
  ]);
  assert.deepEqual(write.included, { participants: [], conversations: [] });

  const read = await s.mcp("get_files_access", { scope: "read", ttlSeconds: 120 });
  assert.equal(read.data.token, "fake_2");
  assert.ok(
    Math.abs(Date.parse(read.data.expiresAt) - Date.parse(read.meta.serverTime) - 120000) < 10000,
  );
  assert.deepEqual(read.data.procedure.split("\n"), [
    `git -c http.extraHeader="Authorization: Bearer fake_2" clone ${remote} talkto-files`,
    "git -C talkto-files show <commit>:<path>",
  ]);

  const state = await s.files();
  // Every access ensures, so the store stays the authority on the remote; the recorded row goes
  // along once it exists, so a store with a fixed remote can answer from it.
  assert.deepEqual(state.recorded.ensured, [s.server.id, s.server.id]);
  assert.deepEqual(state.recorded.hinted, [null, remote]);
  assert.deepEqual(
    state.recorded.minted.map((token) => [token.id, token.scope, token.ttlSeconds]),
    [
      ["fake_1", "write", 3600],
      ["fake_2", "read", 120],
    ],
  );
  assert.deepEqual(state.recorded.revoked, []);
  assert.equal(state.repository.length, 1);
  assert.equal(state.repository[0].remote, remote);
  assert.deepEqual(
    state.tokens.map((row) => [row.token_id, row.scope, row.participant_id, row.revoked_at]),
    [
      ["fake_1", "write", s.participantId, null],
      ["fake_2", "read", s.participantId, null],
    ],
  );
  assert.ok(state.tokens.every((row) => row.grant_id && row.expires_at > row.issued_at));

  const denied = await s.mcp(
    "get_files_access",
    { scope: "write", participantId: randomUUID() },
    true,
  );
  assert.equal(denied.error.code, "participant_not_found");
  const short = await s.mcp("get_files_access", { scope: "write", ttlSeconds: 30 }, true);
  assert.equal(short.error.code, "invalid_input");
  assert.equal((await s.files()).recorded.minted.length, 2);
});

test("the managed server context carries no files without a file store", async (t) => {
  const x = await start(t);
  const account = await x.account();
  const server = await x.server(account.id);
  const managed = await x.call(
    "user_alice",
    "GET",
    `/v1/accounts/${account.id}/servers/${server.id}`,
  );
  assert.equal(managed.permissions.readMessages, true);
  assert.equal(managed.files, null);
});

test("the managed server context ensures the repository once for readers and hides it from non-readers", async (t) => {
  const s = await setup(t);
  const path = `/v1/accounts/${s.account.id}/servers/${s.server.id}`;
  const remote = `https://fake.artifacts.test/git/test/srv-${s.server.id}.git`;
  // Nothing has ensured the repository yet: the first view creates it and records the row.
  assert.deepEqual((await s.files()).recorded.ensured, []);
  const first = await s.x.call("user_alice", "GET", path);
  assert.deepEqual(first.files, { repository: { remote, defaultBranch: "main" } });
  let state = await s.files();
  assert.deepEqual(state.recorded.ensured, [s.server.id]);
  assert.equal(state.repository.length, 1);
  assert.equal(state.repository[0].remote, remote);
  // Later views answer from the recorded row without reaching the store.
  const second = await s.x.call("user_alice", "GET", path);
  assert.deepEqual(second.files, first.files);
  assert.deepEqual((await s.files()).recorded.ensured, [s.server.id]);
  // An agent access rewrites the row from the store, and the next view shows the move.
  const moved = "https://fake.artifacts.test/git/test/moved.git";
  await control(s.x, `files?server=${s.server.id}`, { remote: moved });
  await s.mcp("get_files_access", { scope: "read" });
  const third = await s.x.call("user_alice", "GET", path);
  assert.deepEqual(third.files, { repository: { remote: moved, defaultBranch: "main" } });
  // The directory page never carries files; the capability stays on the agent context.
  const listed = await s.x.call("user_alice", "GET", `/v1/accounts/${s.account.id}/servers`);
  assert.equal("files" in listed.items[0], false);
  const context = await s.x.mcp(s.credential, "get_context", { serverId: s.server.id });
  assert.deepEqual(context.data.capabilities, ["files"]);
  // An owner who cannot read messages manages the server without seeing its remote.
  await s.x.call("user_alice", "DELETE", `/v1/servers/${s.server.id}/access/user_alice`);
  const managing = await s.x.call("user_alice", "GET", path);
  assert.deepEqual(managing.permissions, {
    readMessages: false,
    manageAccess: true,
    resume: false,
  });
  assert.equal(managing.files, null);
});

test("the recorded remote follows the store when it moves between accesses", async (t) => {
  const s = await setup(t);
  const first = await s.mcp("get_files_access", { scope: "write" });
  const original = `https://fake.artifacts.test/git/test/srv-${s.server.id}.git`;
  assert.equal(first.data.remote, original);
  const moved = "https://fake.artifacts.test/git/test/moved.git";
  await control(s.x, `files?server=${s.server.id}`, { remote: moved });
  const second = await s.mcp("get_files_access", { scope: "read" });
  assert.equal(second.data.remote, moved);
  assert.match(second.data.procedure, new RegExp(`clone ${moved.replaceAll(".", "\\.")} `));
  const state = await s.files();
  assert.equal(state.repository.length, 1);
  assert.equal(state.repository[0].remote, moved);
  assert.deepEqual(state.recorded.ensured, [s.server.id, s.server.id]);
});

test("a recorded row that no longer parses is read as missing and healed by the next access or view", async (t) => {
  const s = await setup(t);
  const path = `/v1/accounts/${s.account.id}/servers/${s.server.id}`;
  const remote = `https://fake.artifacts.test/git/test/srv-${s.server.id}.git`;
  const corrupt = "[object JsRpcProperty]";
  await s.mcp("get_files_access", { scope: "write" });
  // What the staging rows held after a provider stub was recorded through the old adapter.
  await control(s.x, `files?server=${s.server.id}`, { recordedRemote: corrupt });
  assert.equal((await s.files()).repository[0].remote, corrupt);
  const access = await s.mcp("get_files_access", { scope: "read" });
  assert.equal(access.data.remote, remote);
  assert.match(access.data.procedure, new RegExp(`clone ${remote.replaceAll(".", "\\.")} `));
  let state = await s.files();
  assert.equal(state.repository.length, 1);
  assert.equal(state.repository[0].remote, remote);
  // The corrupted row reached the store as no row at all; the healed one is handed over next time.
  await s.mcp("get_files_access", { scope: "read" });
  assert.deepEqual((await s.files()).recorded.hinted, [null, null, remote]);
  // The managed view re-ensures and rewrites the row too, instead of showing the stub text.
  await control(s.x, `files?server=${s.server.id}`, { recordedRemote: corrupt });
  const managed = await s.x.call("user_alice", "GET", path);
  assert.deepEqual(managed.files, { repository: { remote, defaultBranch: "main" } });
  state = await s.files();
  assert.equal(state.repository.length, 1);
  assert.equal(state.repository[0].remote, remote);
  assert.equal(state.recorded.ensured.length, 4);
});

test("share_file announces a share as a message, meters it as a share, replays on the same key, and hydrates everywhere", async (t) => {
  const s = await setup(t, { metering: true });
  const key = randomUUID();
  const first = await s.share({ requestKey: key });
  const item = first.data.item;
  assert.equal(first.data.created, true);
  assert.deepEqual(item.share, { path, commit, ref: "main", bytes: 18432 });
  assert.equal(item.senderId, s.participantId);
  assert.equal(item.conversationId, s.general);
  assert.ok(first.included.participants.some((p) => p.id === s.participantId));
  assert.ok(first.included.conversations.some((c) => c.id === s.general));
  assert.equal(first.meta.nextActions[0].tool, "read_messages");
  const journal = await s.meter();
  assert.deepEqual(
    journal.usage.map((row) => [row.message_id, row.units, row.kind]),
    [[item.id, 1, "share"]],
  );

  const replay = await s.share({ requestKey: key });
  assert.equal(replay.data.created, false);
  assert.deepEqual(replay.data.item, item);
  const changed = await s.share({ requestKey: key, commit: later }, true);
  assert.equal(changed.error.code, "idempotency_conflict");
  const plain = await s.mcp(
    "send_message",
    {
      target: { kind: "conversation", conversationId: s.general },
      requestKey: key,
      body: item.body,
    },
    true,
  );
  assert.equal(plain.error.code, "idempotency_conflict");
  assert.equal((await s.files()).shares.length, 1);
  assert.equal((await s.meter()).usage.length, 1);

  const minimal = await s.share({
    bytes: undefined,
    ref: "share/sharer/topic",
    commit: later,
    body: "Renamed allowance fields to match the ledger.",
  });
  assert.deepEqual(minimal.data.item.share, { path, commit: later, ref: "share/sharer/topic" });
  assert.equal("bytes" in minimal.data.item.share, false);
  const message = await s.mcp("send_message", {
    target: { kind: "conversation", conversationId: s.general },
    requestKey: randomUUID(),
    body: "No file here",
  });
  assert.equal("share" in message.data.item, false);

  const reader = await s.x.mcp(s.credential, "register_participant", {
    serverId: s.server.id,
    name: "reader",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const updates = await s.x.mcp(s.credential, "get_updates", {
    serverId: s.server.id,
    participantId: reader.data.item.id,
    mode: "start",
    channelIds: [s.general],
    directChats: "own",
    startAt: "beginning",
  });
  assert.deepEqual(updates.data.messages, [item, minimal.data.item, message.data.item]);
  const history = await s.read({ mode: "history", conversationId: s.general });
  assert.deepEqual(history.data.items, [item, minimal.data.item, message.data.item]);
  const around = await s.read({ mode: "around", messageId: item.id });
  assert.deepEqual(around.data.anchor, item);
  const found = await s.read({ mode: "search", query: "billing rewrite" });
  assert.deepEqual(found.data.items, [item]);
  const feed = await s.x.call("user_alice", "GET", `/v1/servers/${s.server.id}/messages`);
  assert.deepEqual(feed.items[0], message.data.item);
  assert.deepEqual(feed.items[2], item);

  const page = await s.x.call(
    "user_alice",
    "GET",
    `/v1/servers/${s.server.id}/files/shares?limit=1`,
  );
  assert.deepEqual(page.items, [minimal.data.item]);
  assert.ok(page.nextCursor);
  const rest = await s.x.call(
    "user_alice",
    "GET",
    `/v1/servers/${s.server.id}/files/shares?limit=1&cursor=${page.nextCursor}`,
  );
  assert.deepEqual(rest.items, [item]);
  assert.equal(rest.nextCursor, null);
  const full = await (
    await s.x.raw(`/v1/servers/${s.server.id}/files/shares`, {
      headers: { authorization: `Bearer ${await s.x.token()}` },
    })
  ).json();
  assert.deepEqual(
    full.data.items.map((m) => m.id),
    [minimal.data.item.id, item.id],
  );
  assert.ok(full.included.participants.some((p) => p.id === s.participantId));
  assert.ok(full.included.conversations.some((c) => c.id === s.general));
  const stale = await s.x.call(
    "user_alice",
    "GET",
    `/v1/servers/${s.server.id}/files/shares?cursor=${updates.data.checkpoint}`,
    undefined,
    400,
  );
  assert.equal(stale.error.code, "invalid_cursor");
});

test("the share surcharge adds to the message unit", async (t) => {
  const s = await setup(t, { metering: true, shareUnits: 3 });
  const shared = await s.share();
  const message = await s.mcp("send_message", {
    target: { kind: "conversation", conversationId: s.general },
    requestKey: randomUUID(),
    body: "Plain",
  });
  const journal = await s.meter();
  assert.deepEqual(
    journal.usage.map((row) => [row.message_id, row.units, row.kind]).sort(),
    [
      [message.data.item.id, 1, "message"],
      [shared.data.item.id, 4, "share"],
    ].sort(),
  );
  assert.equal(journal.allocation[0].used, 5);
});

test("share references are parsed before anything is written", async (t) => {
  const s = await setup(t);
  for (const bad of [
    { path: "../x" },
    { path: "/abs/file.md" },
    { path: "a\0b" },
    { path: "a\\b" },
    { path: "a//b" },
    { path: "a/./b" },
    { path: "" },
    { path: `${"x".repeat(1025)}` },
    { commit: "9f3c2ab" },
    { commit: commit.toUpperCase() },
    { ref: "bad..ref" },
    { ref: "refs/heads/main.lock" },
    { ref: "with space" },
    { ref: "@{upstream}" },
    { bytes: -1 },
    { target: { kind: "direct", recipientId: s.participantId } },
  ]) {
    const result = await s.share(bad, true);
    assert.equal(
      result.error.code,
      "target" in bad ? "self_conversation" : "invalid_input",
      JSON.stringify(bad),
    );
  }
  assert.deepEqual((await s.files()).shares, []);
  const unregistered = await s.share({ participantId: randomUUID() }, true);
  assert.equal(unregistered.error.code, "participant_not_found");
});

test("revoking a grant revokes its live tokens through the store and stamps the ledger", async (t) => {
  const s = await setup(t);
  await control(s.x, "member", s.x.member(s.account.organizationId));
  const root = `/v1/servers/${s.server.id}`;
  await s.x.call("user_alice", "PUT", `${root}/access/user_bob`);
  const bob = await s.x.mcpToken(s.account.organizationId, "user_bob");
  const registered = await s.x.mcp(bob, "register_participant", {
    serverId: s.server.id,
    name: "bob-agent",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const bobAccess = await s.x.mcp(bob, "get_files_access", {
    serverId: s.server.id,
    participantId: registered.data.item.id,
    scope: "write",
  });
  const aliceAccess = await s.mcp("get_files_access", { scope: "read" });
  assert.deepEqual((await s.files()).recorded.revoked, []);
  await s.x.call("user_alice", "DELETE", `${root}/access/user_bob`);
  const state = await s.files();
  assert.deepEqual(state.recorded.revoked, [
    { serverId: s.server.id, tokenId: bobAccess.data.token },
  ]);
  const byToken = new Map(state.tokens.map((row) => [row.token_id, row]));
  assert.ok(
    byToken.get(bobAccess.data.token).revoked_at >= byToken.get(bobAccess.data.token).issued_at,
  );
  assert.equal(byToken.get(aliceAccess.data.token).revoked_at, null);
  // A later delivery finds nothing left to revoke.
  await s.x.call("user_alice", "PUT", `${root}/access/user_bob`);
  assert.equal((await s.files()).recorded.revoked.length, 1);
});

test("a revocation the store failed is retried by the alarm-driven flush pass", async (t) => {
  const s = await setup(t, { manualAlarms: true });
  await control(s.x, "member", s.x.member(s.account.organizationId));
  const root = `/v1/servers/${s.server.id}`;
  await s.x.call("user_alice", "PUT", `${root}/access/user_bob`);
  const bob = await s.x.mcpToken(s.account.organizationId, "user_bob");
  const registered = await s.x.mcp(bob, "register_participant", {
    serverId: s.server.id,
    name: "bob-agent",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const bobAccess = await s.x.mcp(bob, "get_files_access", {
    serverId: s.server.id,
    participantId: registered.data.item.id,
    scope: "write",
  });
  const resources = (action) => control(s.x, `resources?server=${s.server.id}`, action);
  await resources("clear-alarm");
  await control(s.x, `files?server=${s.server.id}`, { failRevocations: 1 });
  await s.x.call("user_alice", "DELETE", `${root}/access/user_bob`);
  // The delivery still succeeds; the row stays unstamped and a wake is kept for the retry.
  const failedSweep = await s.files();
  assert.deepEqual(failedSweep.recorded.revoked, []);
  const row = (state) => state.tokens.find((token) => token.token_id === bobAccess.data.token);
  assert.equal(row(failedSweep).revoked_at, null);
  assert.notEqual((await resources("inspect")).alarm, null);
  // The flush pass retries against a store that has recovered and stamps the ledger.
  await resources("flush");
  const retried = await s.files();
  assert.deepEqual(retried.recorded.revoked, [
    { serverId: s.server.id, tokenId: bobAccess.data.token },
  ]);
  assert.ok(row(retried).revoked_at >= row(retried).issued_at);
  assert.equal((await resources("inspect")).alarm, null);
});

test("a file store failure keeps a server deletion pending until its repository is removed", async (t) => {
  const s = await setup(t, { manualAlarms: true });
  await s.mcp("get_files_access", { scope: "write" });
  const path = `/v1/accounts/${s.account.id}/servers/${s.server.id}`;
  const remove = (status) =>
    s.x.call("user_alice", "POST", `${path}/delete`, { confirmation: s.server.name }, status);
  const completed = async () =>
    (
      await s.x.db
        .prepare("SELECT deletion_completed_at AS completed FROM servers WHERE id=?")
        .bind(s.server.id)
        .first()
    ).completed;
  // Three failures in a row outlast the in-call retries: the deletion stays pending.
  await control(s.x, `files?server=${s.server.id}`, { failRemovals: 3 });
  await remove(503);
  const waiting = await s.files();
  assert.deepEqual(waiting.recorded.removed, []);
  assert.equal(await completed(), null);
  const state = await control(s.x, `deletion?server=${s.server.id}`);
  assert.ok(state.keys.includes("deleting"), "the server stays closed");
  assert.ok(
    state.tables.some((table) => table.name === "file_repository"),
    "the ledger that names the files is kept until they are removed",
  );
  await s.x.call("user_alice", "GET", `/v1/servers/${s.server.id}/messages`, undefined, 404);
  // The scheduled pass retries pending deletions and finishes once the store answers.
  await control(s.x, "sync");
  assert.deepEqual((await s.files()).recorded.removed, [s.server.id]);
  assert.ok(await completed());
  const erased = await control(s.x, `deletion?server=${s.server.id}`);
  assert.deepEqual(erased.keys, []);
});

test("a brief file store failure is retried within the deletion", async (t) => {
  const s = await setup(t, { manualAlarms: true });
  await s.mcp("get_files_access", { scope: "write" });
  await control(s.x, `files?server=${s.server.id}`, { failRemovals: 2 });
  assert.deepEqual(
    await s.x.call(
      "user_alice",
      "POST",
      `/v1/accounts/${s.account.id}/servers/${s.server.id}/delete`,
      { confirmation: s.server.name },
    ),
    { serverId: s.server.id, status: "deleted" },
  );
  assert.deepEqual((await s.files()).recorded.removed, [s.server.id]);
});

test("erasing a server removes its repository only when one was ensured", async (t) => {
  const s = await setup(t, { manualAlarms: true });
  await s.mcp("get_files_access", { scope: "write" });
  const untouched = await s.x.server(s.account.id, { name: "Never shared" });
  const remove = (server) =>
    s.x.call("user_alice", "POST", `/v1/accounts/${s.account.id}/servers/${server.id}/delete`, {
      confirmation: server.name,
    });
  assert.deepEqual(await remove(s.server), { serverId: s.server.id, status: "deleted" });
  const erased = await s.files();
  assert.deepEqual(erased.recorded.removed, [s.server.id]);
  assert.deepEqual(erased.repository, []);
  assert.deepEqual(await remove(untouched), { serverId: untouched.id, status: "deleted" });
  const other = await control(s.x, `files?server=${untouched.id}`);
  assert.deepEqual(other.recorded.removed, []);
});
