import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rpc } from "./mcp-wire.mjs";
import { start } from "./platform-harness.mjs";
import { storageGigabytes } from "@talkto/api/pricing";

const sha = "a".repeat(64);
const toolNames = async (x, credential) =>
  (await (await x.raw("/mcp", rpc("tools/list", {}, credential))).json()).result.tools.map(
    (tool) => tool.name,
  );
/** One account, one server, a sender and a receiver, with helpers bound to that server. */
const setup = async (t, options = {}) => {
  const x = await start(t, { transfers: true, ...options });
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  const server = await x.server(account.id);
  const register = (name) =>
    x.mcp(credential, "register_participant", {
      serverId: server.id,
      name,
      agentType: "claude-code",
      requestKey: randomUUID(),
    });
  const sender = await register("sender");
  const receiver = await register("receiver");
  const general = sender.data.generalConversationId;
  const call = (name, args, error = false) =>
    x.mcp(credential, name, { serverId: server.id, ...args }, error);
  const prepare = (args = {}, error = false) =>
    call(
      "prepare_transfer",
      {
        participantId: sender.data.item.id,
        requestKey: randomUUID(),
        name: "report.pdf",
        kind: "file",
        bytes: 16,
        sha256: sha,
        ...args,
      },
      error,
    );
  const complete = (transferId, args = {}, error = false) =>
    call(
      "complete_transfer",
      {
        participantId: sender.data.item.id,
        requestKey: randomUUID(),
        target: { kind: "conversation", conversationId: general },
        transferId,
        body: "The report you asked for.",
        ...args,
      },
      error,
    );
  const upload = async (transferId, part, bytes) => {
    const key = `r30/${server.id}/${transferId}/${part}`;
    const response = await x.control(
      `transfer-object?key=${encodeURIComponent(key)}&bytes=${bytes}`,
    );
    assert.equal(response.status, 200);
  };
  const objects = async () => (await (await x.control("transfer-objects")).json()).keys;
  return {
    x,
    account,
    credential,
    server,
    general,
    senderId: sender.data.item.id,
    receiverId: receiver.data.item.id,
    call,
    prepare,
    complete,
    upload,
    objects,
  };
};

test("without a configured bucket the transfer tools are absent", async (t) => {
  const x = await start(t, { transfers: false });
  const account = await x.account();
  const credential = await x.mcpToken(account.organizationId);
  const names = await toolNames(x, credential);
  assert.ok(!names.includes("prepare_transfer"));
  assert.ok(!names.includes("fetch_transfer"));
});

test("a configured bucket offers the tools and reports the capability", async (t) => {
  const s = await setup(t);
  const names = await toolNames(s.x, s.credential);
  for (const name of [
    "get_pack_command",
    "prepare_transfer",
    "complete_transfer",
    "fetch_transfer",
    "read_transfer",
  ])
    assert.ok(names.includes(name), name);
  const context = await s.call("get_context", {});
  assert.ok(context.data.capabilities.includes("transfers"));
});

test("an upload link opens one object, for minutes, at the declared size, once", async (t) => {
  const s = await setup(t);
  const { data } = await s.prepare();
  const url = new URL(data.uploadUrl);
  assert.equal(url.hostname, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(
    url.pathname,
    `/talkto-test-transfers/r30/${s.server.id}/${data.transferId}/payload`,
  );
  assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
  const signed = url.searchParams.get("X-Amz-SignedHeaders").split(";");
  assert.ok(signed.includes("content-length"), signed.join());
  assert.ok(signed.includes("if-none-match"), signed.join());
  assert.equal(data.manifestUploadUrl, null);
  assert.match(data.procedure, /If-None-Match: \*/);
  assert.ok(data.procedure.includes(data.uploadUrl));
  assert.ok(data.expiresAt > data.uploadExpiresAt);
});

test("another S3-compatible store signs links at its own address", async (t) => {
  const base = "https://files.example.test:8443/fleet/r2/talkto-test-transfers";
  const s = await setup(t, { transferObjectBase: base });
  const { data } = await s.prepare();
  const url = new URL(data.uploadUrl);
  assert.equal(url.origin, "https://files.example.test:8443");
  assert.equal(
    url.pathname,
    `/fleet/r2/talkto-test-transfers/r30/${s.server.id}/${data.transferId}/payload`,
  );
  assert.ok(url.searchParams.get("X-Amz-Signature"));
});

test("nothing is offered until the upload arrives at its declared size", async (t) => {
  const s = await setup(t);
  const { data } = await s.prepare();
  const missing = await s.complete(data.transferId, {}, true);
  assert.equal(missing.error.code, "transfer_not_uploaded");
  // Nobody can accept what was never delivered.
  const early = await s.call(
    "fetch_transfer",
    { participantId: s.receiverId, transferId: data.transferId },
    true,
  );
  assert.equal(early.error.code, "transfer_not_found");

  await s.upload(data.transferId, "payload", 15);
  const wrong = await s.complete(data.transferId, {}, true);
  assert.equal(wrong.error.code, "transfer_not_uploaded");
  // The wrong object is gone, so the write-once link can be used again.
  assert.deepEqual(await s.objects(), []);
});

test("sending posts an offer; fetching is the accept and leaves a receipt", async (t) => {
  const s = await setup(t);
  const { data } = await s.prepare();
  await s.upload(data.transferId, "payload", 16);
  const sent = await s.complete(data.transferId);
  const offer = sent.data.item.transfer;
  assert.equal(offer.id, data.transferId);
  assert.equal(offer.name, "report.pdf");
  assert.equal(offer.bytes, 16);
  assert.equal(offer.sha256, sha);
  assert.match(offer.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // History and the updates feed carry the same offer.
  const history = await s.call("read_messages", { mode: "history", conversationId: s.general });
  const read = history.data.items.find((message) => message.id === sent.data.item.id);
  assert.deepEqual(read.transfer, offer);
  const updates = await s.call("get_updates", {
    participantId: s.receiverId,
    channelIds: [s.general],
    directChats: "own",
    mode: "start",
    startAt: "beginning",
  });
  assert.ok(updates.data.messages.some((message) => message.transfer?.id === offer.id));

  const before = await s.call("read_transfer", { transferId: offer.id });
  assert.equal(before.data.state, "ready");
  assert.deepEqual(before.data.fetches, []);
  assert.equal(before.data.fileListUrl, null);

  const fetched = await s.call("fetch_transfer", {
    participantId: s.receiverId,
    transferId: offer.id,
  });
  const url = new URL(fetched.data.url);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
  assert.equal(url.searchParams.get("response-content-disposition"), "attachment");
  assert.ok(fetched.data.procedure.includes(fetched.data.url));
  assert.ok(fetched.data.procedure.includes(sha));

  await s.call("fetch_transfer", { participantId: s.receiverId, transferId: offer.id });
  const after = await s.call("read_transfer", { transferId: offer.id });
  assert.equal(after.data.fetches.length, 1, "one receipt per participant");
  assert.equal(after.data.fetches[0].participantId, s.receiverId);
});

test("completing is idempotent and a changed note conflicts", async (t) => {
  const s = await setup(t);
  const { data } = await s.prepare();
  await s.upload(data.transferId, "payload", 16);
  const first = await s.complete(data.transferId);
  assert.equal(first.data.created, true);
  const again = await s.complete(data.transferId);
  assert.equal(again.data.created, false);
  assert.equal(again.data.item.id, first.data.item.id);
  const changed = await s.complete(data.transferId, { body: "Something else." }, true);
  assert.equal(changed.error.code, "idempotency_conflict");
});

test("preparing again with the same key renews the link; changed content conflicts", async (t) => {
  const s = await setup(t);
  const requestKey = randomUUID();
  const first = await s.prepare({ requestKey });
  const second = await s.prepare({ requestKey });
  assert.equal(second.data.transferId, first.data.transferId);
  const changed = await s.prepare({ requestKey, bytes: 17 }, true);
  assert.equal(changed.error.code, "idempotency_conflict");
});

test("only the sender can complete a transfer", async (t) => {
  const s = await setup(t);
  const { data } = await s.prepare();
  await s.upload(data.transferId, "payload", 16);
  const other = await s.complete(data.transferId, { participantId: s.receiverId }, true);
  assert.equal(other.error.code, "transfer_not_found");
});

const day = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
/** The organization pool as its authority reports it. */
const pool = async (s) => (await s.x.control(`storage?account=${s.account.id}`)).json();
/** A second server in the same organization, with its own sender. */
const sibling = async (s) => {
  const server = await s.x.server(s.account.id, { name: "Second" });
  const sender = await s.x.mcp(s.credential, "register_participant", {
    serverId: server.id,
    name: "sender",
    agentType: "claude-code",
    requestKey: randomUUID(),
  });
  return (args = {}, error = false) =>
    s.x.mcp(
      s.credential,
      "prepare_transfer",
      {
        serverId: server.id,
        participantId: sender.data.item.id,
        requestKey: randomUUID(),
        name: "build.zip",
        kind: "file",
        bytes: 16,
        sha256: sha,
        ...args,
      },
      error,
    );
};

test("the organization pool is enforced before any link is signed, up to exactly its size", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  await s.prepare({ bytes: 600 });
  const refused = await s.prepare({ bytes: 401 }, true);
  assert.equal(refused.error.code, "storage_pool_full");
  assert.equal(refused.error.retryable, false);
  assert.equal(refused.error.action, "send_smaller_or_wait");
  assert.equal(refused.error.limitBytes, 1000);
  assert.equal(refused.error.reservedBytes, 600);
  assert.equal(refused.error.requestedBytes, 401);
  assert.ok(refused.error.nextExpiryAt > new Date().toISOString());
  assert.match(refused.error.message, /Every server in the organization shares this pool/);
  assert.ok(!("uploadUrl" in refused));
  // A refused send reserved nothing, so the exact remainder still fits.
  await s.prepare({ bytes: 400 });
  assert.deepEqual(
    { limit: (await pool(s)).limitBytes, reserved: (await pool(s)).reservedBytes },
    { limit: 1000, reserved: 1000 },
  );
  assert.equal((await s.prepare({ bytes: 1 }, true)).error.code, "storage_pool_full");
});

test("servers in one organization share one pool; another organization has its own", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  const second = await sibling(s);
  await s.prepare({ bytes: 700 });
  await second({ bytes: 300 });
  assert.equal((await second({ bytes: 1 }, true)).error.code, "storage_pool_full");
  assert.equal((await s.prepare({ bytes: 1 }, true)).error.code, "storage_pool_full");
  // A folder's file list counts with its bundle.
  const other = await s.x.call("user_carol", "POST", "/v1/accounts", {
    name: "Other",
    requestKey: randomUUID(),
  });
  const otherServer = await s.x.call("user_carol", "POST", `/v1/accounts/${other.id}/servers`, {
    name: "Elsewhere",
    requestKey: randomUUID(),
  });
  const credential = await s.x.mcpToken(other.organizationId, "user_carol");
  const sender = await s.x.mcp(credential, "register_participant", {
    serverId: otherServer.id,
    name: "sender",
    agentType: "codex",
    requestKey: randomUUID(),
  });
  const folder = await s.x.mcp(credential, "prepare_transfer", {
    serverId: otherServer.id,
    participantId: sender.data.item.id,
    requestKey: randomUUID(),
    name: "project",
    kind: "folder",
    bytes: 990,
    fileCount: 2,
    manifestBytes: 10,
    sha256: sha,
  });
  assert.ok(folder.data.manifestUploadUrl);
  const otherPool = await (await s.x.control(`storage?account=${other.id}`)).json();
  assert.equal(otherPool.reservedBytes, 1000);
});

test("concurrent sends from different servers never both take the last space", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  const second = await sibling(s);
  const outcomes = await Promise.all([
    s.prepare({ bytes: 600 }).catch(() => null),
    second({ bytes: 600 }).catch(() => null),
    s.prepare({ bytes: 600 }).catch(() => null),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome !== null).length, 1);
  assert.equal((await pool(s)).reservedBytes, 600);
});

test("preparing again with the same key renews the link without counting twice", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  const requestKey = randomUUID();
  const first = await s.prepare({ bytes: 800, requestKey });
  const again = await s.prepare({ bytes: 800, requestKey });
  assert.equal(again.data.transferId, first.data.transferId);
  await s.prepare({ bytes: 200 });
  const current = await pool(s);
  assert.equal(current.reservedBytes, 1000);
  assert.equal(current.reservations, 2);
});

test("an upload that was never completed keeps counting after its link expires", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  await s.prepare({ bytes: 1000 });
  const expired = await s.x.control(`transfer-links-expired?server=${s.server.id}`);
  assert.equal(expired.status, 200);
  // The objects would still sit in the bucket for 30 days, so walking away frees nothing.
  const refused = await s.prepare({ bytes: 1 }, true);
  assert.equal(refused.error.code, "storage_pool_full");
});

test("an expired transfer cannot be prepared again, and its space frees", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  const requestKey = randomUUID();
  await s.prepare({ bytes: 1000, requestKey });
  assert.equal((await s.prepare({ bytes: 1 }, true)).error.code, "storage_pool_full");
  // Thirty-one days later, on both clocks.
  await s.x.control(`quota/configure?account=${s.account.id}`, { at: iso(Date.now() + 31 * day) });
  assert.equal((await pool(s)).reservedBytes, 0);
  const expired = await s.x.control(`transfers-expired?server=${s.server.id}`);
  assert.equal(expired.status, 200);
  // Fresh links would let a late upload sit in the bucket outside the allowance.
  const renewed = await s.prepare({ bytes: 1000, requestKey }, true);
  assert.equal(renewed.error.code, "transfer_expired");
  await s.prepare({ bytes: 1000 });
});

test("the pool follows the confirmed paid plan and its period", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  const now = Date.now();
  const publish = async (plan, start, end) =>
    (
      await s.x.control(`storage/plan?account=${s.account.id}`, {
        accountId: s.account.id,
        plan,
        start: iso(start),
        end: iso(end),
      })
    ).json();
  // Each plan's listed pool: 25 GB on Shop, 100 GB on Studio.
  const shop = storageGigabytes.shop * 1_000_000_000;
  const studio = storageGigabytes.studio * 1_000_000_000;
  assert.deepEqual([shop, studio], [25_000_000_000, 100_000_000_000]);
  assert.equal((await pool(s)).limitBytes, 1000);
  assert.deepEqual(await publish("shop", now - day, now + 29 * day), { ok: true });
  assert.equal((await pool(s)).limitBytes, shop);
  for (let sent = 0; sent < shop / 5_000_000_000; sent++) await s.prepare({ bytes: 5_000_000_000 });
  assert.equal((await s.prepare({ bytes: 1 }, true)).error.limitBytes, shop);
  // An upgrade inside the same period takes effect at once.
  assert.deepEqual(await publish("studio", now - day, now + 29 * day), { ok: true });
  assert.equal((await pool(s)).limitBytes, studio);
  await s.prepare({ bytes: 1 });
  // A late, older observation never overrides the current plan.
  assert.deepEqual(await publish("factory", now - 40 * day, now - 10 * day), { ok: false });
  assert.equal((await pool(s)).plan, "studio");
  // When the paid period ends without renewal, the unpaid pool applies; reservations stay counted.
  await s.x.control(`quota/configure?account=${s.account.id}`, { at: iso(now + 29 * day + 1000) });
  const lapsed = await pool(s);
  assert.equal(lapsed.limitBytes, 1000);
  assert.equal(lapsed.reservedBytes, shop + 1);
  const refused = await s.prepare({ bytes: 1 }, true);
  assert.equal(refused.error.code, "storage_pool_full");
  assert.equal(refused.error.limitBytes, 1000);
});

test("a smaller plan next month keeps stored files and refuses new sends until they expire", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  const first = Date.now();
  const at = (ms) => s.x.control(`quota/configure?account=${s.account.id}`, { at: iso(ms) });
  const publish = async (plan, start) =>
    (
      await s.x.control(`storage/plan?account=${s.account.id}`, {
        accountId: s.account.id,
        plan,
        start: iso(start),
        end: iso(start + 30 * day),
      })
    ).json();
  const reserve = async (bytes, expiresAt) =>
    (
      await s.x.control(`storage/reserve?account=${s.account.id}`, {
        id: randomUUID(),
        bytes,
        expiresAt: iso(expiresAt),
        accountId: s.account.id,
        serverId: s.server.id,
      })
    ).json();
  // A Studio month: 100 GB, of which 40 GB is stored.
  assert.deepEqual(await publish("studio", first), { ok: true });
  await at(first + 20 * day);
  assert.equal((await pool(s)).limitBytes, 100_000_000_000);
  assert.deepEqual(await reserve(40_000_000_000, first + 40 * day), { kind: "reserved" });
  // The next month is Shop: 25 GB. Files already stored stay counted and are not removed; new
  // sends are refused until enough of them expire.
  assert.deepEqual(await publish("shop", first + 30 * day), { ok: true });
  await at(first + 31 * day);
  const shrunk = await pool(s);
  assert.equal(shrunk.limitBytes, 25_000_000_000);
  assert.equal(shrunk.reservedBytes, 40_000_000_000);
  const refused = await reserve(1, first + 60 * day);
  assert.equal(refused.kind, "full");
  assert.equal(refused.limitBytes, 25_000_000_000);
  assert.equal(refused.reservedBytes, 40_000_000_000);
  await at(first + 41 * day);
  assert.equal((await pool(s)).reservedBytes, 0);
  assert.deepEqual(await reserve(25_000_000_000, first + 70 * day), { kind: "reserved" });
});

test("an unreachable pool fails the send as retryable, and the same key resumes it", async (t) => {
  const s = await setup(t, { storageUnpaidBytes: 1000 });
  const requestKey = randomUUID();
  await s.x.control(`quota/configure?account=${s.account.id}`, { down: true });
  const failed = await s.prepare({ bytes: 500, requestKey }, true);
  assert.equal(failed.error.code, "files_unavailable");
  assert.match(failed.error.message, /same requestKey/);
  await s.x.control(`quota/configure?account=${s.account.id}`, { down: false });
  const resumed = await s.prepare({ bytes: 500, requestKey });
  assert.ok(resumed.data.uploadUrl);
  assert.equal((await pool(s)).reservedBytes, 500);
});

test("inputs that could reach a shell or exceed the limits are refused", async (t) => {
  const s = await setup(t);
  for (const args of [
    { name: "../../etc/passwd" },
    { name: "a\nb" },
    { name: "back\\slash" },
    { sha256: "$(rm -rf ~)" },
    { sha256: "A".repeat(64) },
    { bytes: 5_363_466_241 },
    { bytes: -1 },
  ]) {
    const refused = await s.prepare(args, true);
    assert.equal(refused.error.code, "invalid_input", JSON.stringify(args));
  }
  // A name the shell would act on is legal to display, and never reaches a command.
  const name = "$(touch pwned) `x` 'y'.txt";
  const { data } = await s.prepare({ name });
  await s.upload(data.transferId, "payload", 16);
  await s.complete(data.transferId);
  const fetched = await s.call("fetch_transfer", {
    participantId: s.receiverId,
    transferId: data.transferId,
  });
  assert.equal(fetched.data.transfer.name, name);
  assert.ok(!fetched.data.procedure.includes("touch pwned"));
});

test("a folder needs its file list, which can be read without accepting", async (t) => {
  const s = await setup(t);
  const { data } = await s.prepare({
    name: "project",
    kind: "folder",
    fileCount: 3,
    manifestBytes: 30,
  });
  assert.ok(data.manifestUploadUrl.includes("/manifest?"));
  await s.upload(data.transferId, "payload", 16);
  const missing = await s.complete(data.transferId, {}, true);
  assert.equal(missing.error.code, "transfer_not_uploaded");
  await s.upload(data.transferId, "manifest", 30);
  const sent = await s.complete(data.transferId);
  assert.equal(sent.data.item.transfer.fileCount, 3);

  const status = await s.call("read_transfer", { transferId: data.transferId });
  assert.ok(new URL(status.data.fileListUrl).pathname.endsWith("/manifest"));
  assert.deepEqual(status.data.fetches, [], "reading the list is not accepting");

  const fetched = await s.call("fetch_transfer", {
    participantId: s.receiverId,
    transferId: data.transferId,
  });
  assert.match(fetched.data.procedure, /--no-same-owner/);
});

test("deleting a server removes its stored objects", async (t) => {
  const s = await setup(t);
  const { data } = await s.prepare();
  await s.upload(data.transferId, "payload", 16);
  await s.complete(data.transferId);
  assert.equal((await s.objects()).length, 1);
  const deleted = await s.x.call(
    "user_alice",
    "POST",
    `/v1/accounts/${s.account.id}/servers/${s.server.id}/delete`,
    { confirmation: s.server.name },
  );
  assert.deepEqual(deleted, { serverId: s.server.id, status: "deleted" });
  assert.deepEqual(await s.objects(), []);
  // The objects are gone, so the organization pool stops counting them.
  assert.equal((await pool(s)).reservedBytes, 0);
});

/** Run the commands exactly as an agent receives them. */
const sh = (command, cwd, env = {}) => {
  const run = spawnSync("sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
};
const values = (output) =>
  Object.fromEntries(
    output
      .split("\n")
      .filter((line) => /^(bundle|manifest|bytes|sha256|fileCount|manifestBytes)=/.test(line))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
const listing = (bundle) => execFileSync("tar", ["-tzf", bundle], { encoding: "utf8" }).split("\n");
const workspace = (t) => {
  const root = mkdtempSync(join(tmpdir(), "talkto-pack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "project");
  for (const dir of ["src", "node_modules/left", "empty"])
    mkdirSync(join(folder, dir), { recursive: true });
  const write = (path, content = path) => writeFileSync(join(folder, path), content);
  write("README.md");
  write("src/app.ts");
  write("src/-dash.txt");
  write("name with space.txt");
  write("node_modules/left/index.js");
  write(".env", "SENDER_DECIDES=1");
  symlinkSync("../README.md", join(folder, "src/up"));
  return { root, folder };
};
const packFor = (reply, folder) => reply.data.command.replace("<folder>", `'${folder}'`);
const packCommand = async (t) => {
  const s = await setup(t);
  return (await s.call("get_pack_command", {})).data.command;
};

test("packing sends the whole folder: the sender decides, and TalkTo filters nothing", async (t) => {
  const { root, folder } = workspace(t);
  const command = (await packCommand(t)).replace("<folder>", `'${folder}'`);
  const packed = values(sh(command, root));
  const names = listing(packed.bundle);
  for (const kept of [
    "./README.md",
    "./src/app.ts",
    "./src/-dash.txt",
    "./name with space.txt",
    "./node_modules/left/index.js",
    "./.env",
    "./src/up",
    "./empty/",
  ])
    assert.ok(names.includes(kept), `${kept} in ${names.join()}`);

  const bundle = readFileSync(packed.bundle);
  assert.equal(packed.sha256, createHash("sha256").update(bundle).digest("hex"));
  assert.equal(Number(packed.bytes), bundle.length);
  assert.equal(Number(packed.manifestBytes), readFileSync(packed.manifest).length);
  const files = names.filter((name) => name !== "" && !name.endsWith("/"));
  assert.equal(Number(packed.fileCount), files.length);
});

test("the sender can leave things out with tar options", async (t) => {
  const { root, folder } = workspace(t);
  const command = (await packCommand(t)).replace(
    "<folder>",
    `'${folder}' --exclude=node_modules --exclude=.env`,
  );
  const names = listing(values(sh(command, root)).bundle);
  assert.ok(names.includes("./README.md"));
  assert.ok(!names.some((name) => name.includes("node_modules")));
  assert.ok(!names.includes("./.env"));
});

test("the download procedure verifies the hash and unpacks only into a new directory", async (t) => {
  const { root, folder } = workspace(t);
  const s = await setup(t);
  const packed = values(sh(packFor(await s.call("get_pack_command", {}), folder), root));
  const { data } = await s.prepare({
    name: "project",
    kind: "folder",
    bytes: Number(packed.bytes),
    sha256: packed.sha256,
    fileCount: Number(packed.fileCount),
    manifestBytes: Number(packed.manifestBytes),
  });
  await s.upload(data.transferId, "payload", Number(packed.bytes));
  await s.upload(data.transferId, "manifest", Number(packed.manifestBytes));
  await s.complete(data.transferId);
  const fetched = await s.call("fetch_transfer", {
    participantId: s.receiverId,
    transferId: data.transferId,
  });
  // The link is real but points at no real bucket: stand in for curl with a local copy, and run
  // the remaining steps together, exactly as the agent runs the procedure.
  const steps = fetched.data.procedure.split(" &&\n");
  assert.equal(steps.length, 3);
  assert.match(steps[0], /^curl -fL --retry 5 -C - -o talkto-/);
  const afterDownload = steps.slice(1).join(" &&\n");
  const receiver = join(root, "receiver");
  mkdirSync(receiver);
  const file = `talkto-${data.transferId}`;
  const unpacked = join(receiver, `${file}.d`);
  const run = () => spawnSync("sh", ["-c", afterDownload], { cwd: receiver, encoding: "utf8" });

  // A corrupted download fails the check, and nothing is unpacked.
  writeFileSync(join(receiver, file), "corrupted");
  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(unpacked), false);

  sh(`cp '${packed.bundle}' ${file}`, receiver);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(unpacked, "README.md"), "utf8"), "README.md");
  assert.equal(readFileSync(join(unpacked, "src/-dash.txt"), "utf8"), "src/-dash.txt");

  // A hostile bundle is refused rather than unpacked, and the procedure fails.
  const hostile = join(root, "hostile");
  mkdirSync(hostile);
  writeFileSync(join(hostile, "evil"), "x");
  execFileSync("tar", ["-czf", join(receiver, file), "-P", join(hostile, "evil")]);
  rmSync(unpacked, { recursive: true });
  const refused = spawnSync("sh", ["-c", steps[2]], { cwd: receiver, encoding: "utf8" });
  assert.match(refused.stderr, /Refused/);
  assert.notEqual(refused.status, 0);
  assert.equal(existsSync(unpacked), false);
});
