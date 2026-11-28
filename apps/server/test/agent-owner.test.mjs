import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  Agents act only under the person whose access registered them (KEY_DECISIONS.md, November 20,
  2026). Agents registered through one person's access may act as one another, because a shared
  connection cannot tell them apart; another person's agents are refused with `forbidden`. These
  tests run in enforce mode; agent-owner-watch.test.mjs covers watch mode.
*/

/**
 * One server with Ana and Ben registered over Alice's MCP connection, and Dana registered over
 * Bob's, who has his own grant to the server.
 */
const setup = async (t, options = {}) => {
  const x = await start(t, { agentOwnership: "enforce", ...options });
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const alice = await x.mcpToken(account.organizationId);
  await x.control("member", x.member(account.organizationId, "user_bob"));
  await x.call("user_alice", "PUT", `${root}/access/user_bob`);
  const bob = await x.mcpToken(account.organizationId, "user_bob");
  const register = async (name, token) =>
    (
      await x.mcp(token, "register_participant", {
        serverId: server.id,
        name,
        agentType: "codex",
        requestKey: randomUUID(),
      })
    ).data;
  const first = await register("Ana", alice);
  const ana = first.item.id;
  const ben = (await register("Ben", alice)).item.id;
  const dana = (await register("Dana", bob)).item.id;
  const general = first.generalConversationId;
  const call = (token, name, args, error = false) =>
    x.mcp(token, name, { serverId: server.id, ...args }, error);
  const send = (token, participantId, target, error = false) =>
    call(
      token,
      "send_message",
      { participantId, requestKey: randomUUID(), target, body: "Hello" },
      error,
    );
  const toChannel = (conversationId) => ({ kind: "conversation", conversationId });
  const history = async (conversationId) =>
    (await call(alice, "read_messages", { mode: "history", conversationId })).data.items;
  return {
    x,
    account,
    server,
    root,
    alice,
    bob,
    ana,
    ben,
    dana,
    general,
    call,
    send,
    toChannel,
    history,
  };
};

/** The refusal an agent gets for acting as another person's agent. */
const refused = (result) => {
  assert.equal(result.error.code, "forbidden", JSON.stringify(result));
  assert.match(result.error.message, /registered through another person's access/);
  assert.match(result.error.message, /register_participant/);
};

test("an agent cannot send as another person's agent, not even into that person's chat with it", async (t) => {
  const s = await setup(t);
  // Alice talks to her own agent in a person–agent direct chat.
  const chat = (
    await s.x.call("user_alice", "POST", `${s.root}/people/me/direct-chats`, {
      agentId: s.ana,
      requestKey: randomUUID(),
    })
  ).item.id;
  await s.x.call("user_alice", "POST", `${s.root}/people/me/messages`, {
    conversationId: chat,
    requestKey: randomUUID(),
    body: "Ana, are you there?",
  });

  // Bob's connection cannot post in that chat as Ana, nor anywhere else as her.
  refused(await s.send(s.bob, s.ana, s.toChannel(chat), true));
  refused(await s.send(s.bob, s.ana, s.toChannel(s.general), true));
  refused(await s.send(s.bob, s.ana, { kind: "direct", recipientId: s.dana }, true));
  // Nor Alice's connection as Bob's agent.
  refused(await s.send(s.alice, s.dana, s.toChannel(s.general), true));
  // The HTTP agent routes have the same rule.
  await s.x.call(
    "user_bob",
    "POST",
    `${s.root}/conversations/${s.general}/messages`,
    { participantId: s.ana, requestKey: randomUUID(), body: "Hello" },
    403,
  );
  await s.x.call(
    "user_bob",
    "POST",
    `${s.root}/direct-chats`,
    { participantId: s.ana, recipientId: s.dana },
    403,
  );

  // Nothing was posted, and no direct chat between Ana and Dana was opened.
  assert.deepEqual(
    (await s.history(chat)).map((item) => item.body),
    ["Ana, are you there?"],
  );
  assert.deepEqual(await s.history(s.general), []);
  const directs = await s.call(s.alice, "get_context", {
    participant: { id: s.dana },
    directChats: "own",
  });
  assert.deepEqual(directs.data.directChats.items, []);

  // Ana answers her person, and each person's own agents keep working.
  await s.send(s.alice, s.ana, s.toChannel(chat));
  await s.send(s.bob, s.dana, { kind: "direct", recipientId: s.ana });
  assert.equal((await s.history(chat)).length, 2);
});

test("agents under one person's access still act as one another, across a new grant", async (t) => {
  const s = await setup(t);
  // TalkTo cannot tell Alice's agents apart on her connection: Ana's ID works from it for Ben.
  await s.send(s.alice, s.ben, s.toChannel(s.general));
  await s.send(s.alice, s.ana, { kind: "direct", recipientId: s.ben });
  const channel = (
    await s.call(s.alice, "create_channel", {
      participantId: s.ben,
      name: "side",
      requestKey: randomUUID(),
    })
  ).data.item;
  await s.call(s.alice, "set_channel_archived", {
    participantId: s.ana,
    conversationId: channel.id,
    archived: true,
    expectedRevision: channel.revision,
  });
  const updates = await s.call(s.alice, "get_updates", {
    participantId: s.ben,
    mode: "start",
    channelIds: [s.general],
    directChats: "own",
    startAt: "beginning",
  });
  assert.ok(updates.data.messages.length > 0);

  // Bob's access is revoked and granted again: a new grant, the same person. Dana is still his.
  await s.x.call("user_alice", "DELETE", `${s.root}/access/user_bob`);
  await s.x.call("user_alice", "PUT", `${s.root}/access/user_bob`);
  const sent = await s.send(s.bob, s.dana, s.toChannel(s.general));
  assert.equal(sent.data.item.senderId, s.dana);
  refused(await s.send(s.bob, s.ana, s.toChannel(s.general), true));
});

test("an agent with no recorded registrant keeps working from any access", async (t) => {
  const s = await setup(t);
  const forgotten = await s.x.control(`forget-registrant?server=${s.server.id}`, s.ana);
  assert.equal(forgotten.status, 200, await forgotten.clone().text());
  // As before this change: nothing says whose agent Ana is, so nobody is refused.
  await s.send(s.alice, s.ana, s.toChannel(s.general));
  const sent = await s.send(s.bob, s.ana, s.toChannel(s.general));
  assert.equal(sent.data.item.senderId, s.ana);
  await s.call(s.bob, "get_updates", {
    participantId: s.ana,
    mode: "start",
    channelIds: [s.general],
    directChats: "own",
    startAt: "now",
  });
  // Ben still has his registrant, so Bob still cannot act as him.
  refused(await s.send(s.bob, s.ben, s.toChannel(s.general), true));
});

test("every other agent operation refuses another person's agent; reads stay open", async (t) => {
  const s = await setup(t);
  const channel = (
    await s.call(s.alice, "create_channel", {
      participantId: s.ana,
      name: "planning",
      requestKey: randomUUID(),
    })
  ).data.item;
  const selection = { channelIds: [s.general], directChats: "own" };
  const link = await s.call(s.alice, "create_signal", { participantId: s.ana, ...selection });

  refused(
    await s.call(
      s.bob,
      "create_channel",
      { participantId: s.ana, name: "hijack", requestKey: randomUUID() },
      true,
    ),
  );
  refused(
    await s.call(
      s.bob,
      "set_channel_archived",
      {
        participantId: s.ana,
        conversationId: channel.id,
        archived: true,
        expectedRevision: channel.revision,
      },
      true,
    ),
  );
  refused(
    await s.call(
      s.bob,
      "get_updates",
      { participantId: s.ana, mode: "start", startAt: "beginning", ...selection },
      true,
    ),
  );
  // A checkpoint Ana saved does not let Bob's connection read as her either.
  const own = await s.call(s.alice, "get_updates", {
    participantId: s.ana,
    mode: "start",
    startAt: "now",
    ...selection,
  });
  refused(
    await s.call(
      s.bob,
      "get_updates",
      { participantId: s.ana, mode: "poll", checkpoint: own.data.checkpoint },
      true,
    ),
  );
  refused(await s.call(s.bob, "create_signal", { participantId: s.ana, ...selection }, true));
  refused(await s.call(s.bob, "revoke_signal", { participantId: s.ana }, true));
  const rename = await s.call(
    s.bob,
    "rename_participant",
    { participantId: s.ana, name: "taken-over", requestKey: randomUUID() },
    true,
  );
  assert.equal(rename.error.code, "forbidden");
  // Dana asks Ana to confirm; Bob's connection cannot confirm it as her.
  const asking = (
    await s.call(s.bob, "send_message", {
      participantId: s.dana,
      requestKey: randomUUID(),
      target: { kind: "direct", recipientId: s.ana },
      body: "Ana, please confirm.",
      confirm: true,
    })
  ).data.item;
  refused(
    await s.call(s.bob, "confirm_message", { participantId: s.ana, messageId: asking.id }, true),
  );
  assert.deepEqual(
    (await s.history(asking.conversationId)).map((item) => item.confirm),
    [{ asked: [s.ana], confirmed: [] }],
  );
  // HTTP agent routes too.
  await s.x.call(
    "user_bob",
    "POST",
    `${s.root}/channels`,
    { participantId: s.ana, name: "hijack", requestKey: randomUUID() },
    403,
  );
  await s.x.call(
    "user_bob",
    "POST",
    `${s.root}/updates`,
    { participantId: s.ana, mode: "start", startAt: "now", ...selection },
    403,
  );

  // Nothing changed: the channel is open, no channel was added, Ana's link still counts.
  const channels = await s.call(s.alice, "get_context", {});
  assert.deepEqual(
    channels.data.channels.items.map((item) => [item.name, item.archivedAt]),
    [
      ["General", null],
      ["planning", null],
    ],
  );
  const url = new URL(link.data.url);
  const dot = url.pathname.lastIndexOf(".");
  const check = await s.x.raw(url.pathname.slice(0, dot), {
    headers: { authorization: `Bearer ${url.pathname.slice(dot + 1)}` },
  });
  assert.equal(check.status, 200, await check.text());

  // Reads that name no acting agent are open to everyone with access, as before.
  await s.call(s.bob, "read_messages", { mode: "history", conversationId: s.general });
  await s.call(s.bob, "get_context", { participant: { id: s.dana }, directChats: "own" });
  // Bob's own agent does all of these.
  await s.call(s.bob, "create_signal", { participantId: s.dana, ...selection });
  await s.call(s.bob, "revoke_signal", { participantId: s.dana });
  await s.call(s.bob, "get_updates", {
    participantId: s.dana,
    mode: "start",
    startAt: "now",
    ...selection,
  });
});

test("transfers refuse another person's agent as sender and as receiver", async (t) => {
  const s = await setup(t, { transfers: true });
  const prepare = (token, participantId, error = false) =>
    s.call(
      token,
      "prepare_transfer",
      {
        participantId,
        requestKey: randomUUID(),
        name: "report.pdf",
        kind: "file",
        bytes: 16,
        sha256: "a".repeat(64),
      },
      error,
    );
  const complete = (token, participantId, transferId, error = false) =>
    s.call(
      token,
      "complete_transfer",
      {
        participantId,
        requestKey: randomUUID(),
        target: { kind: "conversation", conversationId: s.general },
        transferId,
        body: "The report.",
      },
      error,
    );
  refused(await prepare(s.bob, s.ana, true));
  const prepared = (await prepare(s.alice, s.ana)).data;
  const key = `r30/${s.server.id}/${prepared.transferId}/payload`;
  const uploaded = await s.x.control(`transfer-object?key=${encodeURIComponent(key)}&bytes=16`);
  assert.equal(uploaded.status, 200);
  refused(await complete(s.bob, s.ana, prepared.transferId, true));
  const offer = (await complete(s.alice, s.ana, prepared.transferId)).data.item.transfer;

  // Accepting as Ana from Bob's connection would leave a receipt in Ana's name.
  refused(
    await s.call(s.bob, "fetch_transfer", { participantId: s.ana, transferId: offer.id }, true),
  );
  await s.call(s.bob, "fetch_transfer", { participantId: s.dana, transferId: offer.id });
  const status = await s.call(s.bob, "read_transfer", { transferId: offer.id });
  assert.deepEqual(
    status.data.fetches.map((item) => item.participantId),
    [s.dana],
  );
});

test("Git sharing refuses another person's agent", async (t) => {
  const s = await setup(t, { files: true });
  refused(await s.call(s.bob, "get_files_access", { participantId: s.ana, scope: "write" }, true));
  refused(
    await s.call(
      s.bob,
      "share_file",
      {
        participantId: s.ana,
        target: { kind: "conversation", conversationId: s.general },
        requestKey: randomUUID(),
        path: "specs/api.md",
        commit: "9f3c2ab4d1e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
        body: "Review this.",
      },
      true,
    ),
  );
  await s.call(s.alice, "get_files_access", { participantId: s.ana, scope: "write" });
  assert.deepEqual(await s.history(s.general), []);
});
