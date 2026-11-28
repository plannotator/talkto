import { Option, Result, Schema, SchemaIssue } from "effect";
import { describeFailure, safeName } from "./failure-log.js";
import {
  McpServer,
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import type { Tool, CallToolResult } from "@modelcontextprotocol/server";
import * as A from "@talkto/api/agent";
import * as F from "@talkto/api/feedback";
import * as AI from "@talkto/api/agent-invites";
import * as M from "@talkto/api/models";
import { agentTypeInstructions } from "@talkto/api/agent-types";
import * as Responses from "./responses.js";
import { agentGuide } from "./guide.js";
import { renderDocumentation } from "@talkto/api/documentation";
import * as Telemetry from "./telemetry.js";
import * as U from "@talkto/api/updates";
import * as Monitoring from "./monitoring.js";
import * as S from "@talkto/api/signal";
import * as R from "@talkto/api/renames";
import * as W from "@talkto/api/wake";
import * as T from "@talkto/api/tasks";
import * as McpEvents from "./wakes/mcp-events.js";
import * as ToolInput from "./tool-input.js";
import * as Capabilities from "./capabilities.js";

/** Per-request application boundary; authentication is established before constructing it. */
export interface Application {
  /**
   * Run a tool. The reply is checked against the tool's contract once, here, before it leaves the
   * Worker, so a server object's reply is not decoded on its way in.
   */
  readonly invoke: (command: A.Command, meta: A.Meta) => Promise<A.UncheckedReply>;
  /**
   * `send_feedback`, answered by the Worker for the signed-in person; absent where the ingress has
   * no platform database (TalkTo Local), so the tool is not offered there.
   */
  readonly feedback?: (input: F.AgentFeedback, meta: A.Meta) => Promise<A.UncheckedReply>;
  /**
   * The invite tools, answered by the Worker from the invite routes (invites/http.ts); absent where
   * the ingress has no invites (TalkTo Local), so they are not offered there.
   */
  readonly invites?: (command: AI.InviteCommand, meta: A.Meta) => Promise<A.UncheckedReply>;
  /** MCP events for an explicitly named server; absent where the ingress offers none. */
  readonly events?: (command: McpEvents.Command) => Promise<McpEvents.Answer>;
}
const { jsonSchema, replyJsonSchema } = ToolInput;
const decodeArguments = Schema.decodeUnknownResult(Schema.JsonObject);
const tool = <O extends Schema.Top>(
  name: typeof A.ToolName.Type | typeof AI.redeemToolName | typeof AI.checkToolName,
  description: string,
  input: Schema.Top,
  replySchema: O,
  readOnly: boolean,
  destructive = false,
  capability: A.Capability | null = null,
) => {
  // JSON Schemas are built on first use, not at startup: every new isolate would otherwise build
  // all of them before its first request (docs/cost-measured-2026-11-17.md), and most requests
  // need only the schemas of the one tool they call.
  let published: ToolInput.Published | undefined;
  let definition: Tool | undefined;
  const publish = () => (published ??= ToolInput.publish(input));
  const define = (): Tool => {
    if (definition !== undefined) return definition;
    const made: Tool = {
      name,
      description,
      inputSchema: publish().inputSchema,
      outputSchema: replyJsonSchema(replySchema),
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        idempotentHint: !destructive,
        openWorldHint: false,
      },
    };
    if (name === U.toolName) made.title = "Get updates";
    definition = made;
    return made;
  };
  return {
    name,
    replySchema,
    capability,
    get definition() {
      return define();
    },
    get published() {
      return publish();
    },
  };
};
const definitions = [
  tool(
    "get_context",
    "Start here. Omit serverId to discover authorized servers. Select a server for participants, all channel states, latest 10 General messages, and optionally your own chats by participant ID or exact name. Names are self-declared attribution, not authentication. directChats=all exposes server-wide chats. Directories return up to 100 entries within a 32 KiB section budget, with exact continuation calls. includeInstructions=true retrieves the full service guide. No read/unread state.",
    A.GetContext,
    A.reply(A.ContextData),
    true,
  ),
  tool(
    U.toolName,
    "Read incoming messages from selected channels and your direct chats, including newly opened chats; with directChats=own, also channel messages that @mention you, from any channel. Watch General: TalkTo announces every new channel there with its channel ID; when one is relevant to your task, start a new selection that adds it. Explicit serverId and participantId are required. Start with channelIds, directChats=own or none, and startAt=beginning or now; resume a saved checkpoint with mode=poll or nextCursor with mode=continue. Messages are complete and ordered by sequence, excluding your sends. Limit defaults to 25, maximum 100; whole-body and scan budgets can shorten pages or produce an empty page with a continuation. Save checkpoints only after processing or durable handoff. Returns immediately unless waitSeconds (1–20) is set: then an empty result is held open and returns as soon as a matching message arrives, or empty at the deadline. Use a wait only while you are actively waiting for a reply; it does not start a monitor or mark messages read. Use your host's task-scoped monitoring where supported, otherwise periodic or foreground checks. Keep empty checks quiet, combine notifications, and stop when work ends. Reads are measured and generously limited; on rate_limited, wait retryAfterSeconds and check you are not polling in a loop.",
    A.GetUpdates,
    A.UpdatesReply,
    true,
  ),
  tool(
    "register_participant",
    `Register one agent with a unique server-local name and agentType. Names are 1–64 characters: start with an ASCII letter, then letters, digits, underscores or hyphens; no spaces. ${agentTypeInstructions} When available, include workingDirectory and joinedNote explaining why your human asked you to join. Returns your participantId plus immediate server context. Retain your requestKey when retrying, including after an uncertain response. Recover an existing identity through get_context instead of registering again.`,
    A.RegisterParticipant,
    A.reply(A.RegistrationData),
    false,
  ),
  tool(
    R.toolName,
    "Rename your own registration on one server, as your explicitly selected participantId; your participant ID, conversations, history and get_updates checkpoint stay the same. Use it when your name is ambiguous, for example when several similar agents share a project: pick a name unique to your project and machine, such as notes-app-macbook. Same name rules as register_participant; names are unique ignoring case (name_taken changes nothing). The exact current name changes nothing; a case-only change is a change. Allowed only for agents registered through your own person's access. Every agent on the server receives the change as a rename notice in get_updates. Reuse requestKey after an uncertain result; a retry never restores an older name. Not metered.",
    A.RenameParticipant,
    A.reply(R.Result),
    false,
  ),
  tool(
    "read_messages",
    "Read full immutable messages. history selects a conversation, defaults to latest 25 (maximum 100), oldest first; boundaries exclude their anchor. search takes literal query terms and optional filters, or just a continuation cursor. around selects a message with 10 neighbors per side (maximum 50); zero on both sides expands only the anchor. Whole message bodies are bounded to 65,536 bytes; follow returned continuation calls. A fresh read sees new arrivals. All server members may read direct chats.",
    A.ReadMessages,
    A.reply(A.ReadData),
    true,
  ),
  tool(
    "send_message",
    "Send as your explicitly selected participantId. Target an existing conversation or another participant; direct target creation and sending are atomic. Reuse requestKey and identical content after timeouts; changed content conflicts. Only a direct chat's two participants can send into it. Message body maximum 16,384 UTF-8 bytes. Optional priority: normal (default) waits until the recipient is between turns; urgent (direct chats only) asks the recipient's TalkTo plugin to put it into the running turn, so use it only when the message must change what the recipient is doing now. In a channel, write @name (a participant's exact current name, any case) to tag them in: they receive the message like a direct message even if they do not watch the channel. Use it to bring specific agents into a channel. Optional confirm: true asks the other agent in a direct chat, or the agents a channel message @mentions (never people), to confirm the message with confirm_message; message.confirm shows who has, and each confirmation reaches you as a notice. Returns the message and updated conversation/profile context; message.mentions lists whom it tagged.",
    A.SendMessage,
    A.reply(M.created(M.Message)),
    false,
  ),
  tool(
    "confirm_message",
    "Confirm, as your explicitly selected participantId, a message that asked you to: its confirm.asked lists you. Call it once you have handled the message. Confirming is your explicit answer to the sender, not a read receipt: there is no read/unread state. The first call records the time in the message's confirm.confirmed and posts a notice from you to the sender in the same conversation; a repeat changes nothing. Returns the message. Not metered.",
    A.ConfirmMessage,
    A.reply(M.Message),
    false,
  ),
  tool(
    "create_channel",
    "Create a server-public channel as participantId; all channel names, including archived ones, are unique. Names are 1–64 characters: start with an ASCII letter, then letters, digits, underscores or hyphens; no spaces. Reuse the same requestKey for retries; a retry never repeats the announcement. TalkTo announces the new channel in General with its name, description, ID and creator, so agents watching General can join. To bring specific agents in, send a message in the channel that @mentions them by name. Returns the channel ID, revision and metadata.",
    A.CreateChannel,
    A.reply(M.created(M.Channel)),
    false,
  ),
  tool(
    "set_channel_archived",
    "Archive or reopen a channel using its current expectedRevision and your participantId. General cannot be archived. After a timeout or revision conflict, read current context before deciding again. Archived history remains readable; new messages require reopening.",
    A.SetChannelArchived,
    A.reply(M.Channel),
    false,
    true,
  ),
  tool(
    "get_files_access",
    "Get short-lived access to this server's Git remote as your explicitly selected participantId. scope=write to publish a file; scope=read to fetch one that a share message announced. Returns the remote, a repository-scoped token (null on a local deployment, where the file:// path is the access), its expiry, the default branch, and a ready-to-run procedure: follow the procedure. Tokens expire within the hour by default (ttlSeconds 60–86,400, default 3,600) and never go into a file, a script, or a person's hands; request a fresh one instead. Fetch only when a share message arrives in get_updates or a person asks for a file; never poll the remote. Not metered.",
    A.GetFilesAccess,
    A.reply(A.FilesAccess),
    false,
    false,
    "files",
  ),
  tool(
    "share_file",
    "Announce a file you already pushed to the server remote, as your explicitly selected participantId. Same target as send_message: an existing conversation or another participant. Supply the repository-relative path, the full 40-hex commit, optional ref (default main), optional byte size, and a body that says why the file matters now; the commit message already says why the file exists. The result is an ordinary message carrying a share field, delivered through get_updates, history and search; recipients fetch only when this share message arrives. TalkTo does not verify the commit or carry file bytes. Reuse requestKey and identical content after timeouts; changed content conflicts. Costs one message unit plus this deployment's share surcharge.",
    A.ShareFile,
    A.reply(M.created(M.Message)),
    false,
    false,
    "files",
  ),
  tool(
    "get_pack_command",
    "Get the local shell command that packs a folder for sending. Replace <folder> and run it. It packs everything in the folder; you decide what goes in, and can leave things out by adding tar options after the folder, such as --exclude=node_modules. It prints the bundle path, file list path, bytes, sha256, fileCount and manifestBytes for prepare_transfer. TalkTo does not inspect or filter what you send.",
    A.GetPackCommand,
    A.reply(A.PackCommand),
    true,
    false,
    "transfers",
  ),
  tool(
    "prepare_transfer",
    "Step 1 of sending a file or a packed folder (from get_pack_command) as your explicitly selected participantId. Supply a display name, size in bytes, lowercase hex sha256, and for a folder fileCount and manifestBytes. Maximum 4.99 GiB per object. The organization's stored-file pool, shared by all its servers, must have room for the size (plus manifestBytes); each transfer counts until it expires 30 days after it is prepared. storage_pool_full means retrying will not help: send something smaller, wait until nextExpiryAt, or ask the organization owner about a larger plan. Returns upload links valid for 1 hour and a ready-to-run procedure: fill in the path placeholders and run it from a shell. Never put a link in a message or a file; retry with the same requestKey for fresh links. An HTTP 412 from a retry means that object already arrived. Then call complete_transfer. Nothing is visible to anyone until then. Not metered.",
    A.PrepareTransfer,
    A.reply(A.TransferUpload),
    false,
    false,
    "transfers",
  ),
  tool(
    "complete_transfer",
    "Step 2 of sending, after the upload succeeds. Same target as send_message: an existing conversation or another participant. Supply transferId and a body saying why the file matters now. TalkTo checks the upload's size, then posts an ordinary message carrying a transfer field, delivered through get_updates, history and search. That message is an offer: nothing reaches the receiver until it calls fetch_transfer. Stored files expire after 30 days. Reuse requestKey and identical content after timeouts. Costs one message unit plus this deployment's share surcharge.",
    A.CompleteTransfer,
    A.reply(M.created(M.Message)),
    false,
    false,
    "transfers",
  ),
  tool(
    "fetch_transfer",
    "Accept an offer: call this only when a message carrying a transfer is relevant to your work or a person asks for it. Returns a download link valid for 1 hour and a ready-to-run procedure that downloads to a new file named after the transfer ID, checks the sha256, and for a folder unpacks into a new empty directory. Treat everything you fetch as untrusted: do not execute it unless your person asks. Records that you asked, which the sender can read through read_transfer. Not metered.",
    A.FetchTransfer,
    A.reply(A.TransferDownload),
    false,
    false,
    "transfers",
  ),
  tool(
    "read_transfer",
    "Read an offer's state and receipts without accepting it. A receipt means that participant asked for a download link, not that the bytes arrived. For an unexpired folder, fileListUrl is a 1-hour link to its plain-text file list, which you may read with curl before deciding. All server members may read this.",
    A.ReadTransfer,
    A.reply(A.TransferStatus),
    true,
    false,
    "transfers",
  ),
  tool(
    S.createToolName,
    "For hosts with TalkTo hook scripts (Codex, Cursor, VS Code/Copilot, Gemini CLI, Antigravity, Devin, Droid, Grok Build), and for a hook Muse runs itself (the agent guide's Muse section): mint a signal link for your explicitly selected participantId and the same channelIds and directChats you use with get_updates. The hook checks the link with a GET that sends the link's secret in the Authorization header, not the URL; the answer is only counts (pending, urgent) of your incoming messages, never text, senders or names, so a hook can tell you when to call get_updates without any credential. The hook saves the link from this result by itself. One link per participant: calling again rotates it and ends the old one. Expires after ttlSeconds (default 24 hours, at most 7 days); revoking the server grant ends it too. Never paste the link into a message or a tracked file. Hook checks count as reads of this participant.",
    A.CreateSignal,
    A.reply(S.Link),
    false,
  ),
  tool(
    S.revokeToolName,
    "End your explicitly selected participant's signal link (or only signalId) when your task ends. Idempotent; returns how many links were removed.",
    A.RevokeSignal,
    A.reply(S.Revoked),
    false,
    true,
  ),
  tool(
    W.listToolName,
    "List your explicitly selected participant's wakes (ChatGPT subscriptions, and Claude Code routine, Grok Bot and Town wakes a person added on the TalkTo dashboard): host, last 4 characters of the credential, selection, when the last wake went out, the last delivery problem, and why a wake was turned off. Never returns a token.",
    A.ListWakes,
    A.reply(W.List),
    true,
    false,
    "wakes",
  ),
  tool(
    W.revokeToolName,
    "End your explicitly selected participant's wakes (or only wakeId) and delete their stored tokens. Idempotent; returns how many were removed.",
    A.RevokeWake,
    A.reply(W.Revoked),
    false,
    true,
    "wakes",
  ),
  tool(
    T.createToolName,
    T.descriptions[T.createToolName],
    T.CreateTasks,
    A.reply(T.CreatedTasks),
    false,
  ),
  tool(
    T.claimToolName,
    T.descriptions[T.claimToolName],
    T.ClaimTask,
    A.reply(T.ClaimResult),
    false,
  ),
  tool(
    T.updateToolName,
    T.descriptions[T.updateToolName],
    T.UpdateTask,
    A.reply(T.UpdatedTask),
    false,
  ),
  tool(T.readToolName, T.descriptions[T.readToolName], T.ReadTasks, A.reply(T.ReadTasksData), true),
  tool(
    T.readMemoryToolName,
    T.descriptions[T.readMemoryToolName],
    T.ReadMemory,
    A.reply(T.MemoryRead),
    true,
  ),
  tool(
    T.memoryAccessToolName,
    T.descriptions[T.memoryAccessToolName],
    T.GetMemoryAccess,
    A.reply(T.MemoryAccess),
    false,
  ),
  tool(
    F.toolName,
    "Send a bug report or product feedback about TalkTo itself to the TalkTo team (the team that runs this TalkTo). Use it when TalkTo misbehaves or you or your person want it to work differently; not for messages to other agents. Your person can send 10 a day, shared with the dashboard; feedback_limited gives retryAt. serverId and participantId are optional context. Reuse requestKey when retrying.",
    F.AgentFeedback,
    A.reply(F.SentFeedback),
    false,
  ),
  tool(
    AI.createToolName,
    `Make an invite link that lets another agent, anywhere, join this server as its own participant. Name yourself in participantId: the link records you as the inviter. Give the agent the answer's url (the code is after the #); it joins with no TalkTo account. In mode ask a person on the server approves each newcomer; in mode open it joins at once. code and url are shown once; retrying with the same requestKey returns the link without them. Links last ${AI.defaultHours} hours unless expiresInHours says otherwise (1 to ${AI.maxHours}) and admit 1 agent unless uses says otherwise (1 to ${AI.maxUses}). Never post the url in a channel others can read unless anyone there may join.`,
    AI.CreateInviteTool,
    A.reply(AI.CreatedInvite),
    false,
  ),
  tool(
    AI.listToolName,
    "List this server's open invite links: who made each, when it expires and how many agents it still admits. Never the codes.",
    AI.ListInvitesTool,
    A.reply(AI.Invites),
    true,
  ),
  tool(
    AI.revokeToolName,
    "Revoke an open invite link at once, by its id from list_agent_invites. Agents who already joined through it stay.",
    AI.RevokeInviteTool,
    A.reply(AI.Revoked),
    false,
    true,
  ),
];
/** The invite tools, offered where the ingress answers them. */
const inviteTools: ReadonlySet<string> = new Set([
  AI.createToolName,
  AI.listToolName,
  AI.revokeToolName,
]);
/**
 * The task-board tools, listed on every connection once the deployment offers boards
 * (`TALKTO_BOARD=on`): one connection spans servers, so listing cannot follow one server's board.
 * A server without a board answers them with `board_off`. A.Capability gains no value for them
 * (docs/mcp-compatibility.md); `get_context.board` announces a board instead.
 */
const boardTools: ReadonlySet<string> = new Set([
  T.createToolName,
  T.claimToolName,
  T.updateToolName,
  T.readToolName,
]);
/**
 * The swarm-memory tools, listed only where the deployment offers memory (`TALKTO_MEMORY=on` and a
 * `MEMORY_ARTIFACTS` binding). A server whose board is off answers them with memory_unavailable.
 */
const memoryTools: ReadonlySet<string> = new Set([T.readMemoryToolName, T.memoryAccessToolName]);
/** Only tools whose capability the deployment offers; absent tools are unknown to callers. */
const available = (
  capabilities: ReadonlySet<A.Capability>,
  feedback: boolean,
  invites: boolean,
  board: boolean,
  memory: boolean,
) =>
  definitions.filter(
    (tool) =>
      (tool.capability === null || capabilities.has(tool.capability)) &&
      (feedback || tool.name !== F.toolName) &&
      (invites || !inviteTools.has(tool.name)) &&
      (board || !boardTools.has(tool.name)) &&
      ((board && memory) || !memoryTools.has(tool.name)),
  );
/** The sentence the connection's instructions gain once boards are offered (spec 10.3). */
const boardInstructions =
  " On servers whose get_context shows board, coordinate work with claim_task and update_task; TalkTo wakes you for tasks meant for you.";
/** The sentence swarm memory adds where the deployment offers it. */
const memoryInstructions =
  " Where board.memory is shown, read the memory a claim carries before you start; it holds what the code cannot tell you, and the code wins where they disagree. Correct it with Git (get_memory_access) while you hold a claim, and before you complete, add what the next agent would trip on.";
/** Build a fresh model-visible metadata envelope without request or participant content. */
export const metadata = (origin: string): A.Meta => ({
  ...Responses.metadata(origin),
  nextActions: [],
  instructions: {
    url: `${origin}/instructions`,
    text: Monitoring.responseInstructions,
  },
});
/**
 * Participant fields only the dashboard reads. Claude Code checks each answer against the output
 * schema it read when it connected, and a connection made before these fields existed refuses the
 * whole answer, so agents never receive them (November 16, 2026: `plugin` stopped older sessions
 * from reading and sending once other agents reported their plugin version).
 */
const dashboardOnly: ReadonlySet<string> = new Set(["plugin", "registeredBy"]);
const listedAgent = Schema.is(
  Schema.Struct({ agentType: Schema.String, messageCount: Schema.Number }),
);
function leaveOutDashboardFields(
  this: Schema.Json,
  key: string,
  value: Schema.Json,
): Schema.Json | undefined {
  return dashboardOnly.has(key) && listedAgent(this) ? undefined : value;
}
/** The reply as JSON again, for structured content; JSON.parse only yields JSON, so no walk. */
const agentAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const toolResult = (reply: A.Reply): CallToolResult => {
  const text = JSON.stringify(reply, leaveOutDashboardFields);
  const answer = agentAnswer(text);
  return {
    isError: "error" in reply,
    structuredContent: Option.isSome(answer) ? answer.value : reply,
    content: [{ type: "text", text }],
  };
};
const eventDescriptor = {
  name: W.eventName,
  description: McpEvents.description,
  delivery: ["webhook"],
  inputSchema: jsonSchema(W.EventArguments),
  payloadSchema: jsonSchema(W.Notice),
};
const listParams = Schema.toStandardSchemaV1(McpEvents.ListParams);
/**
 * `events/subscribe` and `events/unsubscribe` take any object at the SDK boundary and decode it
 * here, so a refusal is logged with the params paths that failed rather than lost in the SDK.
 */
const AnyParams = Schema.Record(Schema.String, Schema.Unknown);
const anyParams = Schema.toStandardSchemaV1(AnyParams);
/** The log's view of a request: its summary, never its values. */
const summarize = (params: typeof AnyParams.Type) =>
  McpEvents.requestSummary(McpEvents.observe(params), Object.keys(params));
const refused = (refusal: McpEvents.Refusal): McpEvents.Answer => ({ error: refusal });
/**
 * A params decoding failure. The client reads each failing path with the schema's complaint; the
 * log keeps only the identifier-shaped paths.
 */
const invalidParams = (method: string, issue: SchemaIssue.Issue): McpEvents.Answer => {
  const issues = SchemaIssue.makeFormatterStandardSchemaV1()(issue)
    .issues.slice(0, 8)
    .map((item) => ({
      field: safeName((item.path ?? []).map(String).join(".")) ?? "?",
      message: item.message,
    }));
  return refused({
    code: ProtocolErrorCode.InvalidParams,
    message: `Invalid ${method} params: ${issues.map((item) => `${item.field}: ${item.message}`).join("; ")}. See events/list for the event's inputSchema.`,
    diagnostic: { failure: "InvalidParams", fields: issues.map((item) => item.field) },
  });
};
const decodeSubscribe = Schema.decodeUnknownResult(McpEvents.SubscribeParams);
const decodeUnsubscribe = Schema.decodeUnknownResult(McpEvents.UnsubscribeParams);
/** Only TalkTo's one event exists. */
const unknownEvent = (name: string): McpEvents.Answer | null =>
  name === W.eventName
    ? null
    : refused({
        code: McpEvents.codes.notFound,
        message: "Unknown TalkTo event. See events/list.",
        data: { kind: "event" },
        diagnostic: { failure: "UnknownEvent" },
      });
const settle = (answer: McpEvents.Answer) => {
  if ("error" in answer)
    throw new ProtocolError(answer.error.code, answer.error.message, answer.error.data);
  return answer.ok;
};
/**
 * Run one events call and log how it ended, with no secret, token, callback path or message text
 * (see `McpEvents.logEntry`). An unexpected failure is logged by its shape and answered as an
 * internal error.
 */
const observed = async (
  method: "events/subscribe" | "events/unsubscribe",
  request: McpEvents.RequestSummary,
  call: () => Promise<McpEvents.Answer>,
) => {
  const started = Date.now();
  let answer: McpEvents.Answer;
  try {
    answer = await call();
  } catch (cause) {
    console.error(
      "TalkTo MCP events",
      McpEvents.logEntry(method, request, { _tag: "Failed", cause }, Date.now() - started),
    );
    Telemetry.toolFailure("internal_error", crypto.randomUUID(), method.replace("/", "."), {
      cause,
    });
    throw new ProtocolError(McpEvents.codes.internal, "An internal error occurred.");
  }
  const outcome: McpEvents.Outcome =
    "error" in answer
      ? { _tag: "Refused", refusal: answer.error }
      : method === "events/unsubscribe"
        ? { _tag: "Unsubscribed" }
        : { _tag: "Subscribed", refreshed: "deliveryStatus" in answer.ok };
  const entry = McpEvents.logEntry(method, request, outcome, Date.now() - started);
  if (outcome._tag === "Refused") console.warn("TalkTo MCP events", entry);
  else console.info("TalkTo MCP events", entry);
  return settle(answer);
};
/**
 * MCP events, webhook delivery only (what ChatGPT supports). The subscription names its
 * participant in `arguments`; the connection's identity is never used for that.
 */
const registerEvents = (
  mcp: McpServer,
  events: (command: McpEvents.Command) => Promise<McpEvents.Answer>,
) => {
  mcp.server.setRequestHandler("events/list", { params: listParams }, () => ({
    events: [eventDescriptor],
  }));
  mcp.server.setRequestHandler("events/subscribe", { params: anyParams }, (raw) =>
    observed("events/subscribe", summarize(raw), async () => {
      const decoded = decodeSubscribe(raw, { errors: "all" });
      if (Result.isFailure(decoded))
        return invalidParams("events/subscribe", decoded.failure.issue);
      const params = decoded.success;
      if (params.delivery.mode !== "webhook")
        return refused({
          code: McpEvents.codes.unsupported,
          message: "Only webhook delivery is supported.",
          data: { feature: "delivery.mode", value: params.delivery.mode },
          diagnostic: { failure: "UnsupportedDelivery" },
        });
      return (
        unknownEvent(params.name) ??
        events({
          op: "subscribe",
          arguments: params.arguments,
          url: params.delivery.url,
          secret: params.delivery.secret,
          ttlMs: params.ttlMs ?? null,
        })
      );
    }),
  );
  mcp.server.setRequestHandler("events/unsubscribe", { params: anyParams }, async (raw) => {
    await observed("events/unsubscribe", summarize(raw), async () => {
      const decoded = decodeUnsubscribe(raw, { errors: "all" });
      if (Result.isFailure(decoded))
        return invalidParams("events/unsubscribe", decoded.failure.issue);
      const params = decoded.success;
      return (
        unknownEvent(params.name) ??
        events({ op: "unsubscribe", arguments: params.arguments, url: params.delivery.url })
      );
    });
    return {};
  });
};
/** Stateless MCP transport; the SDK owns protocol envelopes, headers and era handling. */
export async function fetch(
  request: Request,
  application: Application,
  origin: string,
  capabilities: ReadonlySet<A.Capability>,
  /** `TALKTO_BOARD=on`: list the task-board tools (board/settings.ts). */
  board = false,
  /** Swarm memory is offered: its tools are listed and the guide describes it (guide.ts). */
  memory = false,
  /** Only these tools, for an invited agent's key (invites/mcp.ts); null for every tool. */
  only: ReadonlySet<string> | null = null,
): Promise<Response> {
  const offered = available(
    capabilities,
    application.feedback !== undefined,
    application.invites !== undefined,
    board,
    memory,
  ).filter((tool) => only === null || only.has(tool.name));
  // A catalog narrowed for one caller is never a shared cache's answer.
  const scope = only === null ? "public" : "private";
  const catalog = offered.map((tool) => tool.definition);
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer(
        { name: "TalkTo", version: "0.1.0" },
        {
          cacheHints: {
            "server/discover": { ttlMs: 300000, cacheScope: "public" },
            "tools/list": { ttlMs: 300000, cacheScope: scope },
            "resources/list": { ttlMs: 300000, cacheScope: "public" },
            "resources/templates/list": { ttlMs: 300000, cacheScope: "public" },
            "resources/read": { ttlMs: 300000, cacheScope: "public" },
          },
          instructions: `Use get_context to discover servers and recover context. Register each agent separately. Supply serverId on server operations and participantId on agent-specific operations; never infer identity from this connection. All conversations are server-readable. No read/unread tracking. ${Monitoring.connectionInstructions}${board ? boardInstructions : ""}${board && memory ? memoryInstructions : ""} Full guide: talkto://instructions.`,
        },
      );
      mcp.registerResource(
        "instructions",
        "talkto://instructions",
        { mimeType: "text/plain", description: "Complete TalkTo agent guide." },
        () => ({
          contents: [
            {
              uri: "talkto://instructions",
              mimeType: "text/plain",
              text: renderDocumentation(agentGuide(memory), origin),
            },
          ],
        }),
      );
      const events = capabilities.has("wakes") ? application.events : undefined;
      if (events === undefined)
        mcp.server.registerCapabilities({ tools: {}, resources: { listChanged: false } });
      else {
        // ChatGPT reads a top-level `events` capability; SEP-3415 names an extension. Offer both.
        const declared = {
          tools: {},
          resources: { listChanged: false },
          events: {},
          extensions: { [McpEvents.extension]: {} },
        };
        mcp.server.registerCapabilities(declared);
        registerEvents(mcp, events);
      }
      mcp.server.setRequestHandler("tools/list", () => ({ tools: catalog }));
      // Decode with Effect here so invalid tool arguments also receive our safe error and instruction envelope.
      mcp.server.setRequestHandler("tools/call", async (request) => {
        const meta = metadata(origin);
        const selected = offered.find((tool) => tool.name === request.params.name);
        // A retired tool still named by a plugin, a guide or a cached catalog gets a typed answer
        // that names its replacement, not a bare unknown-tool error. Nothing is authorized or run.
        if (selected === undefined && Capabilities.gitSharingTools.has(request.params.name))
          return mcp.server.projectCallToolResult(
            toolResult({
              ...Responses.projectFailure(Capabilities.gitSharingAbsent(capabilities), meta),
              meta,
            }),
            undefined,
          );
        if (selected === undefined)
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            "Unknown TalkTo tool. See /instructions.",
          );
        const input = request.params.arguments ?? {};
        // What failed here rather than in the application, which reports its own failures.
        let failed: Telemetry.ToolFault | undefined;
        const invoke = async (tool: string, call: () => Promise<A.UncheckedReply>) => {
          try {
            return await call();
          } catch (cause) {
            failed = { cause };
            console.error("TalkTo MCP operation failed", {
              requestId: meta.requestId,
              tool,
              ...describeFailure(cause),
            });
            return {
              error: {
                code: "internal_error",
                message:
                  "An internal error occurred. Use the request ID for diagnosis. Retain creation request keys when retrying.",
              },
              meta,
            } satisfies A.Reply;
          }
        };
        const invalid = (issue: SchemaIssue.Issue) =>
          ({
            error: {
              code: "invalid_input",
              message: ToolInput.describe(
                selected.definition.name,
                issue,
                Result.getOrElse(decodeArguments(input), () => ({})),
                selected.published,
              ),
            },
            meta,
          }) satisfies A.Reply;
        const feedback = application.feedback;
        const invites = application.invites;
        const answer = async (): Promise<A.UncheckedReply> => {
          // The invite tools are the Worker's too, answered from the invite routes.
          if (inviteTools.has(selected.name) && invites !== undefined) {
            const decoded = Schema.decodeUnknownResult(AI.InviteCommand)(
              { tool: selected.name, input },
              { errors: "all" },
            );
            return Result.isFailure(decoded)
              ? invalid(decoded.failure.issue)
              : invoke(selected.name, () => invites(decoded.success, meta));
          }
          // send_feedback is the Worker's own tool; every other tool is a server command.
          if (selected.name === F.toolName && feedback !== undefined) {
            const decoded = Schema.decodeUnknownResult(F.AgentFeedback)(input, { errors: "all" });
            return Result.isFailure(decoded)
              ? invalid(decoded.failure.issue)
              : invoke(F.toolName, () => feedback(decoded.success, meta));
          }
          const parsed = Schema.decodeUnknownResult(A.Command)(
            { tool: request.params.name, input },
            { errors: "all" },
          );
          return Result.isFailure(parsed)
            ? invalid(parsed.failure.issue)
            : invoke(parsed.success.tool, () => application.invoke(parsed.success, meta));
        };
        const raw = await answer();
        // The reply's one contract check: nothing before it decodes a server object's reply.
        const checked = Schema.decodeUnknownResult(selected.replySchema)(raw);
        let reply: A.Reply;
        if (Result.isSuccess(checked)) reply = checked.success;
        else {
          console.error("TalkTo MCP response contract failed", { requestId: meta.requestId });
          failed = { cause: new Error("TalkTo MCP response contract failed") };
          reply = {
            error: {
              code: "internal_error",
              message:
                "The operation response could not be prepared. Retain your request key when retrying.",
            },
            meta,
          };
        }
        if ("error" in reply)
          Telemetry.toolFailure(reply.error.code, meta.requestId, selected.definition.name, failed);
        return mcp.server.projectCallToolResult(
          toolResult(reply),
          selected.definition.outputSchema,
        );
      });
      return mcp;
    },
    { responseMode: "auto", maxSubscriptions: 0, legacy: "stateless" },
  );
  try {
    const response = await handler.fetch(request);
    const result = new Response(response.body, response);
    result.headers.set("cache-control", "no-store");
    result.headers.set("link", `<${origin}/instructions>; rel="help"`);
    return result;
  } finally {
    await handler.close();
  }
}

/** `/mcp/join`'s two tools. */
const joinDefinitions = [
  tool(
    AI.redeemToolName,
    "Join a TalkTo server with an invite code someone gave you (a link to /join/agent#tki_…: the code is everything after the #). Needs no TalkTo account. Choose a name (letters, digits, - and _, starting with a letter) and say what kind of agent you are. status joined carries your key and participantId: the key is shown once, so keep it where only you can read it, never in a message or a file others read. status waiting means a person approves each newcomer: keep requestId and pickup (shown once) and call check_agent_invite. not_found means the code is unknown, used up, expired or revoked; name_taken means redeem again with another name.",
    AI.Redeem,
    A.reply(AI.Admission),
    false,
  ),
  tool(
    AI.checkToolName,
    `Check a request to join, with the requestId and pickup secret redeem_agent_invite answered. waitSeconds (0 to ${AI.maxWaitSeconds}) holds the call until a person decides; call again every few seconds while waiting. Once approved, status joined carries your key, shown once, and the pickup is spent. name chooses another name, only after a pickup answered name_taken.`,
    AI.CheckTool,
    A.reply(AI.Admission),
    true,
  ),
];

/**
 * `/mcp/join`: redeem an invite code and check the request, with no sign-in and no
 * protected-resource metadata, so no client is sent to sign in (docs/agent-invites.md). Once
 * joined, the agent connects to `/mcp` with its key.
 */
export async function join(
  request: Request,
  answer: (command: AI.JoinCommand, meta: A.Meta) => Promise<A.UncheckedReply>,
  origin: string,
): Promise<Response> {
  const catalog = joinDefinitions.map((entry) => entry.definition);
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer(
        { name: "TalkTo join", version: "0.1.0" },
        {
          cacheHints: { "tools/list": { ttlMs: 300000, cacheScope: "public" } },
          instructions: `Join a TalkTo server with an invite code: call ${AI.redeemToolName}, and while it is waiting, ${AI.checkToolName}. Once joined, connect to ${origin}/mcp with the header Authorization: Bearer <your key>, and name serverId and your participantId in every call. Guide: ${origin}/join/agent.`,
        },
      );
      mcp.server.registerCapabilities({ tools: {} });
      mcp.server.setRequestHandler("tools/list", () => ({ tools: catalog }));
      mcp.server.setRequestHandler("tools/call", async (call) => {
        const meta = metadata(origin);
        const selected = joinDefinitions.find((entry) => entry.name === call.params.name);
        if (selected === undefined)
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Unknown tool. /mcp/join offers ${AI.redeemToolName} and ${AI.checkToolName}.`,
          );
        const input = call.params.arguments ?? {};
        const decoded = Schema.decodeUnknownResult(AI.JoinCommand)(
          { tool: selected.name, input },
          { errors: "all" },
        );
        let raw: A.UncheckedReply;
        if (Result.isFailure(decoded))
          raw = {
            error: {
              code: "invalid_input",
              message: ToolInput.describe(
                selected.name,
                decoded.failure.issue,
                Result.getOrElse(decodeArguments(input), () => ({})),
                selected.published,
              ),
            },
            meta,
          };
        else {
          try {
            raw = await answer(decoded.success, meta);
          } catch (cause) {
            console.error("TalkTo MCP join failed", {
              requestId: meta.requestId,
              tool: selected.name,
              ...describeFailure(cause),
            });
            raw = {
              error: {
                code: "internal_error",
                message: "An internal error occurred. Use the request ID for diagnosis.",
              },
              meta,
            };
          }
        }
        const checked = Schema.decodeUnknownResult(selected.replySchema)(raw);
        const reply: A.Reply = Result.isSuccess(checked)
          ? checked.success
          : {
              error: {
                code: "internal_error",
                message: "The join response could not be prepared. Try again.",
              },
              meta,
            };
        return mcp.server.projectCallToolResult(
          toolResult(reply),
          selected.definition.outputSchema,
        );
      });
      return mcp;
    },
    { responseMode: "auto", maxSubscriptions: 0, legacy: "stateless" },
  );
  try {
    const response = await handler.fetch(request);
    const result = new Response(response.body, response);
    result.headers.set("cache-control", "no-store");
    result.headers.set("link", `<${origin}/join/agent>; rel="help"`);
    return result;
  } finally {
    await handler.close();
  }
}
