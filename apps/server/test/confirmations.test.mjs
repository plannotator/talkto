import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { start } from "./platform-harness.mjs";

/*
  Message confirmation: send_message's confirm asks the agents a message addresses, each answers with
  confirm_message, and the sender gets TalkTo's notice in the same conversation.
*/

/** One server with Ana, Ben and Cal on Alice's MCP connection, and helpers to ask and confirm. */
const setup = async (t, options = {}) => {
  const x = await start(t, options);
  const account = await x.account();
  const server = await x.server(account.id);
  const root = `/v1/servers/${server.id}`;
  const credential = await x.mcpToken(account.organizationId);
  const call = (tool, input, error = false) =>
    x.mcp(credential, tool, { serverId: server.id, ...input }, error);
  const register = async (name) =>
    (
      await call("register_participant", {
        name,
        agentType: "codex",
        requestKey: randomUUID(),
      })
    ).data.item.id;
  const ana = await register("Ana");
  const ben = await register("Ben");
  const cal = await register("cal-macbook");
  /** Ana's new channel. */
  const channel = async (name) =>
    (await call("create_channel", { participantId: ana, requestKey: randomUUID(), name })).data
      .item;
  /** Send `body` as `participantId` into a conversation, or to a participant with `{ to }`. */
  const send = (participantId, where, body, extra = {}, error = false) =>
    call(
      "send_message",
      {
        participantId,
        requestKey: randomUUID(),
        target:
          "to" in where
            ? { kind: "direct", recipientId: where.to }
            : { kind: "conversation", conversationId: where.in },
        body,
        ...extra,
      },
      error,
    );
  const confirm = (participantId, messageId, error = false) =>
    call("confirm_message", { participantId, messageId }, error);
  /** A fresh watch from now: the reader's own direct chats plus the given channels. */
  const watch = async (participantId, channelIds = []) =>
    (
      await call("get_updates", {
        participantId,
        mode: "start",
        channelIds,
        directChats: "own",
        startAt: "now",
      })
    ).data.checkpoint;
  const poll = async (participantId, checkpoint) =>
    (await call("get_updates", { participantId, mode: "poll", checkpoint })).data;
  const history = async (conversationId) =>
    (await call("read_messages", { mode: "history", conversationId })).data.items;
  /** Alice as a person on the server, named "alice" from her sign-in. */
  const person = async () => (await x.call("user_alice", "POST", `${root}/people/me`)).item.id;
  return {
    x,
    account,
    server,
    root,
    call,
    ana,
    ben,
    cal,
    channel,
    send,
    confirm,
    watch,
    poll,
    history,
    person,
  };
};

test("a direct message sent with confirm asks the other agent; it shows as waiting everywhere it is read", async (t) => {
  const s = await setup(t);
  const checkpoint = await s.watch(s.ben);
  const sent = await s.send(s.ana, { to: s.ben }, "Deploy is done, please confirm.", {
    confirm: true,
  });
  const waiting = { asked: [s.ben], confirmed: [] };
  assert.deepEqual(sent.data.item.confirm, waiting);

  const page = await s.poll(s.ben, checkpoint);
  assert.deepEqual(
    page.messages.map((item) => [item.id, item.confirm]),
    [[sent.data.item.id, waiting]],
  );
  const direct = sent.data.item.conversationId;
  assert.deepEqual(
    (await s.history(direct)).find((item) => item.id === sent.data.item.id).confirm,
    waiting,
  );

  // A message that does not ask keeps its exact shape, confirm: false included.
  const plain = await s.send(s.ana, { in: direct }, "No confirmation needed.");
  assert.equal("confirm" in plain.data.item, false);
  const declined = await s.send(s.ana, { in: direct }, "Nor here.", { confirm: false });
  assert.equal("confirm" in declined.data.item, false);
  assert.equal(
    (await s.history(direct)).filter((item) => "confirm" in item).length,
    1,
    "only the asking message carries confirm",
  );
});

test("a channel message sent with confirm asks the agents it @mentions, in order, never a person", async (t) => {
  const s = await setup(t);
  const alice = await s.person();
  const channel = await s.channel("release");
  const sent = await s.send(
    s.ana,
    { in: channel.id },
    "@cal-macbook and @Ben, the release branch is cut. cc @alice",
    { confirm: true },
  );
  assert.deepEqual(sent.data.item.mentions, [s.cal, s.ben, alice]);
  assert.deepEqual(sent.data.item.confirm, { asked: [s.cal, s.ben], confirmed: [] });
});

test("confirm with no agent to ask is refused with invalid_input and stores nothing", async (t) => {
  const s = await setup(t);
  const alice = await s.person();
  const channel = await s.channel("quiet");
  const nobody = await s.send(
    s.ana,
    { in: channel.id },
    "No one is tagged.",
    { confirm: true },
    true,
  );
  assert.equal(nobody.error.code, "invalid_input");
  assert.match(nobody.error.message, /@mention the agents that should confirm it/);
  const onlyPerson = await s.send(
    s.ana,
    { in: channel.id },
    "@alice please look.",
    { confirm: true },
    true,
  );
  assert.equal(onlyPerson.error.code, "invalid_input");
  assert.deepEqual(await s.history(channel.id), []);

  // A direct chat with a person asks no agent either, and the refused send opens no chat.
  const person = await s.send(s.ana, { to: alice }, "Hello", { confirm: true }, true);
  assert.equal(person.error.code, "invalid_input");
  const chats = await s.x.call(
    "user_alice",
    "GET",
    `${s.root}/direct-chats?withParticipantId=${alice}`,
  );
  assert.equal(chats.items.length, 0);
});

test("a retry returns the same asking message, and a changed confirm is an idempotency conflict", async (t) => {
  const s = await setup(t);
  const asking = { requestKey: randomUUID(), confirm: true };
  const first = await s.send(s.ana, { to: s.ben }, "Ship it?", asking);
  const retry = await s.send(s.ana, { to: s.ben }, "Ship it?", asking);
  assert.equal(retry.data.created, false);
  assert.equal(retry.data.item.id, first.data.item.id);
  assert.deepEqual(retry.data.item.confirm, first.data.item.confirm);
  const dropped = await s.send(
    s.ana,
    { to: s.ben },
    "Ship it?",
    { requestKey: asking.requestKey },
    true,
  );
  assert.equal(dropped.error.code, "idempotency_conflict");

  const plain = { requestKey: randomUUID() };
  await s.send(s.ana, { to: s.ben }, "Shipped.", plain);
  const added = await s.send(s.ana, { to: s.ben }, "Shipped.", { ...plain, confirm: true }, true);
  assert.equal(added.error.code, "idempotency_conflict");
});

test("each asked agent confirms once, a repeat changes nothing, and one agent confirms two messages", async (t) => {
  const s = await setup(t);
  const channel = await s.channel("handover");
  const sent = (
    await s.send(s.ana, { in: channel.id }, "@cal-macbook @Ben take over the queue.", {
      confirm: true,
    })
  ).data.item;

  // Ben and Cal are registered by the same person and share its connection; each answers alone.
  const ben = (await s.confirm(s.ben, sent.id)).data;
  assert.equal(ben.id, sent.id);
  assert.deepEqual(ben.confirm.asked, [s.cal, s.ben]);
  assert.deepEqual(
    ben.confirm.confirmed.map((item) => item.participantId),
    [s.ben],
  );
  const cal = (await s.confirm(s.cal, sent.id)).data;
  assert.deepEqual(
    cal.confirm.confirmed.map((item) => item.participantId),
    [s.ben, s.cal],
  );
  assert.ok(cal.confirm.confirmed[0].at <= cal.confirm.confirmed[1].at);
  const again = (await s.confirm(s.ben, sent.id)).data;
  assert.deepEqual(again.confirm, cal.confirm, "a repeat keeps the first time");
  const notices = (await s.history(channel.id)).filter((item) => item.confirmation !== undefined);
  assert.deepEqual(
    notices.map((item) => item.senderId),
    [s.ben, s.cal],
    "one notice per agent",
  );

  // Two messages to Ben, two confirmations and two notices.
  const one = (await s.send(s.ana, { to: s.ben }, "First check.", { confirm: true })).data.item;
  const two = (await s.send(s.ana, { to: s.ben }, "Second check.", { confirm: true })).data.item;
  await s.confirm(s.ben, one.id);
  await s.confirm(s.ben, two.id);
  assert.deepEqual(
    (await s.history(one.conversationId))
      .filter((item) => item.confirmation !== undefined)
      .map((item) => item.confirmation.messageId),
    [one.id, two.id],
  );
});

test("confirm_message refuses the sender, an agent not asked and an unknown message; archiving refuses only a first confirm", async (t) => {
  const s = await setup(t);
  const sent = (await s.send(s.ana, { to: s.ben }, "Confirm this.", { confirm: true })).data.item;
  for (const participantId of [s.ana, s.cal]) {
    const refused = await s.confirm(participantId, sent.id, true);
    assert.equal(refused.error.code, "forbidden");
    assert.equal(refused.error.message, "This message did not ask you to confirm it.");
  }
  const plain = (await s.send(s.ana, { to: s.ben }, "No confirmation asked.")).data.item;
  assert.equal((await s.confirm(s.ben, plain.id, true)).error.code, "forbidden");
  assert.equal((await s.confirm(s.ben, randomUUID(), true)).error.code, "message_not_found");

  const channel = await s.channel("closing");
  const asking = (
    await s.send(s.ana, { in: channel.id }, "@Ben @cal-macbook wrap up.", { confirm: true })
  ).data.item;
  await s.confirm(s.ben, asking.id);
  await s.call("set_channel_archived", {
    participantId: s.ana,
    conversationId: channel.id,
    archived: true,
    expectedRevision: channel.revision,
  });
  const late = await s.confirm(s.cal, asking.id, true);
  assert.equal(late.error.code, "channel_archived");
  const repeat = (await s.confirm(s.ben, asking.id)).data;
  assert.deepEqual(
    repeat.confirm.confirmed.map((item) => item.participantId),
    [s.ben],
  );
});

test("the sender reads the notice once, in a direct chat and in a channel it does not watch", async (t) => {
  const s = await setup(t);
  let checkpoint = await s.watch(s.ana);
  const direct = (await s.send(s.ana, { to: s.ben }, "Please confirm.", { confirm: true })).data
    .item;
  await s.confirm(s.ben, direct.id);
  let page = await s.poll(s.ana, checkpoint);
  assert.equal(page.messages.length, 1);
  const [notice] = page.messages;
  assert.equal(notice.senderId, s.ben, "the confirming agent sends the notice");
  assert.equal(notice.conversationId, direct.conversationId);
  assert.equal(notice.body, `TalkTo: Ben confirmed @Ana's message ${direct.id}.`);
  assert.deepEqual(notice.confirmation, { messageId: direct.id });
  assert.equal("mentions" in notice, false);
  assert.equal("confirm" in notice, false);
  const confirmed = (await s.confirm(s.ben, direct.id)).data.confirm.confirmed;
  assert.deepEqual(confirmed, [{ participantId: s.ben, at: notice.createdAt }]);
  checkpoint = page.checkpoint;
  page = await s.poll(s.ana, checkpoint);
  assert.equal(page.messages.length, 0, "a repeat posts nothing");

  // Ana does not watch the channel; the notice @mentions her, so it reaches her anyway.
  const channel = await s.channel("ops");
  const asking = (
    await s.send(s.ana, { in: channel.id }, "@Ben restart the queue.", { confirm: true })
  ).data.item;
  await s.confirm(s.ben, asking.id);
  page = await s.poll(s.ana, page.checkpoint);
  assert.deepEqual(
    page.messages.map((item) => [item.conversationId, item.mentions, item.confirmation]),
    [[channel.id, [s.ana], { messageId: asking.id }]],
  );
  assert.equal(page.messages[0].body, `TalkTo: Ben confirmed @Ana's message ${asking.id}.`);
  await s.confirm(s.ben, asking.id);
  assert.equal((await s.poll(s.ana, page.checkpoint)).messages.length, 0);
});

test("a waiting get_updates call of a sender outside the channel returns as soon as a confirmation commits", async (t) => {
  const s = await setup(t);
  const channel = await s.channel("ops");
  const asking = (
    await s.send(s.ana, { in: channel.id }, "@Ben check the logs.", { confirm: true })
  ).data.item;
  const checkpoint = await s.watch(s.ana);
  const started = Date.now();
  const waiting = s.call("get_updates", {
    participantId: s.ana,
    mode: "poll",
    checkpoint,
    waitSeconds: 15,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await s.confirm(s.ben, asking.id);
  const page = (await waiting).data;
  assert.deepEqual(
    page.messages.map((item) => item.confirmation),
    [{ messageId: asking.id }],
  );
  assert.ok(Date.now() - started < 10_000, "the confirmation woke the wait");
});

test("a confirmation is never metered, even with the allowance spent", async (t) => {
  const s = await setup(t, { metering: true });
  const quota = async (action = "", data) => {
    const response = await s.x.control(`quota${action}?account=${s.account.id}`, data);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  await quota("/publish", {
    accountId: s.account.id,
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() + 3600000).toISOString(),
    allowance: 1,
    overdraft: 0,
  });
  const sent = (await s.send(s.ana, { to: s.ben }, "The one included message.", { confirm: true }))
    .data.item;
  const over = await s.send(s.ana, { to: s.ben }, "Over the allowance", {}, true);
  assert.equal(over.error.code, "message_allowance_exhausted");
  const confirmed = (await s.confirm(s.ben, sent.id)).data;
  assert.equal(confirmed.confirm.confirmed.length, 1);
  assert.equal((await quota()).used, 1, "the confirmation and its notice spend nothing");
  const notices = (await s.history(sent.conversationId)).filter(
    (item) => item.confirmation !== undefined,
  );
  assert.equal(notices.length, 1);
});

test("history pruning removes a confirmed message and its notice", async (t) => {
  const s = await setup(t);
  const sent = (await s.send(s.ana, { to: s.ben }, "Prune me.", { confirm: true })).data.item;
  await s.confirm(s.ben, sent.id);
  const notice = (await s.history(sent.conversationId)).find(
    (item) => item.confirmation !== undefined,
  );
  // Each conversation keeps its newest message, so a later one lets both go.
  const later = (await s.send(s.ana, { in: sent.conversationId }, "Still here.")).data.item;
  const response = await s.x.control(`board?server=${s.server.id}`, { action: "prune-messages" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok((await response.json()).messages >= 2);
  for (const messageId of [sent.id, notice.id]) {
    const read = await s.call("read_messages", { mode: "around", messageId }, true);
    assert.equal(read.error.code, "message_not_found");
  }
  assert.equal(
    (await s.call("read_messages", { mode: "around", messageId: later.id })).data.anchor.id,
    later.id,
  );
});
