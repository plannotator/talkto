import { Schema } from "effect";
import * as M from "./models.js";
import * as I from "./inputs.js";
import * as P from "./platform.js";
import * as Envelope from "./envelope.js";
import * as U from "./updates.js";
import * as S from "./signal.js";
import * as W from "./wake.js";
import * as R from "./renames.js";
import * as F from "./feedback.js";
import * as T from "./tasks.js";
import * as AI from "./agent-invites.js";

const strict = { parseOptions: { onExcessProperty: "error" } } as const;
const server = { serverId: M.ServerId };
const selection = Schema.Union([
  Schema.Struct({ id: M.ParticipantId }),
  Schema.Struct({ name: M.Name }),
]);
const section = Schema.Literals(["servers", "participants", "channels", "directChats"]);
/** Select a server overview, recover an explicitly named identity, or continue one directory. */
export const GetContext = Schema.Struct({
  serverId: Schema.optionalKey(M.ServerId),
  participant: Schema.optionalKey(selection),
  directChats: Schema.optionalKey(Schema.Literals(["own", "all"])),
  includeInstructions: Schema.optionalKey(Schema.Boolean),
  page: Schema.optionalKey(
    Schema.Struct({ section, cursor: M.Cursor, limit: Schema.optionalKey(M.Limit) }),
  ),
}).annotate(strict);
/** Parsed context selection. */
export type GetContext = typeof GetContext.Type;
/** Incoming feed with explicit server and participant scope, as tools/list publishes it. */
export const GetUpdates = Schema.Union([
  Schema.Struct({ ...server, ...U.Input.members[0].fields }),
  Schema.Struct({ ...server, ...U.Input.members[1].fields }),
  Schema.Struct({ ...server, ...U.Input.members[2].fields }),
  Schema.Struct({ ...server, ...U.Input.members[3].fields }),
]).annotate(strict);
const pluginWaitSeconds = { waitSeconds: Schema.optionalKey(U.AcceptedWaitSeconds) };
/**
 * get_updates as the server accepts it: `GetUpdates`, except that a call naming a plugin may wait
 * up to `U.maxPluginWaitSeconds`; any other call is refused past 20 in the same words as before.
 * Only `GetUpdates` is published, in tools/list and nextActions.
 */
export const AcceptedGetUpdates = Schema.Union([
  Schema.Struct({ ...server, ...U.Input.members[0].fields, ...pluginWaitSeconds }).check(
    U.pluginWait,
  ),
  Schema.Struct({ ...server, ...U.Input.members[1].fields, ...pluginWaitSeconds }).check(
    U.pluginWait,
  ),
  Schema.Struct({ ...server, ...U.Input.members[2].fields, ...pluginWaitSeconds }).check(
    U.pluginWait,
  ),
  Schema.Struct({ ...server, ...U.Input.members[3].fields, ...pluginWaitSeconds }).check(
    U.pluginWait,
  ),
]).annotate(strict);
/** Register one agent under a unique server-local name. */
export const RegisterParticipant = Schema.Struct({
  ...server,
  ...I.RegisterParticipant.fields,
}).annotate(strict);
/**
 * Rename your own registration on one server. participantId is your own, supplied explicitly like
 * on every agent operation; the connection never chooses it.
 */
export const RenameParticipant = Schema.Struct({
  ...server,
  participantId: M.ParticipantId,
  ...R.RenameSelf.fields,
}).annotate(strict);
/** Parsed self-rename. */
export type RenameParticipant = typeof RenameParticipant.Type;
/** One message selection, with mutually exclusive filters and continuation. */
export const ReadMessages = Schema.Union([
  Schema.Struct({
    ...server,
    mode: Schema.Literal("history"),
    conversationId: M.ConversationId,
    ...I.ReadMessages.fields,
  }),
  Schema.Struct({
    ...server,
    mode: Schema.Literal("search"),
    ...I.SearchMessages.members[0].fields,
  }),
  Schema.Struct({
    ...server,
    mode: Schema.Literal("search"),
    ...I.SearchMessages.members[1].fields,
  }),
  Schema.Struct({
    ...server,
    mode: Schema.Literal("around"),
    messageId: M.MessageId,
    ...I.GetMessageContext.fields,
  }),
]).annotate(strict);
/** A destination is either an existing conversation or another participant. */
export const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("conversation"), conversationId: M.ConversationId }),
  Schema.Struct({ kind: Schema.Literal("direct"), recipientId: M.ParticipantId }),
]).annotate(strict);
/** Atomically resolve the destination and persist a message; `confirm` asks the agents it addresses to confirm it. */
export const SendMessage = Schema.Struct({
  ...server,
  ...I.SendMessage.fields,
  target: Target,
  confirm: Schema.optionalKey(Schema.Boolean),
}).annotate(strict);
/** Confirm, as yourself, a message that asked you to; a repeat changes nothing. */
export const ConfirmMessage = Schema.Struct({
  ...server,
  participantId: M.ParticipantId,
  messageId: M.MessageId,
}).annotate(strict);
/** Parsed confirmation. */
export type ConfirmMessage = typeof ConfirmMessage.Type;
/** Create a public channel. */
export const CreateChannel = Schema.Struct({ ...server, ...I.CreateChannel.fields }).annotate(
  strict,
);
/** Revision-checked channel lifecycle operation. */
export const SetChannelArchived = Schema.Struct({
  ...server,
  ...I.SetChannelArchived.fields,
  conversationId: M.ConversationId,
}).annotate(strict);
/** Repository access level requested from the server's file store. */
export const FilesScope = Schema.Literals(["read", "write"]);
/** Mint a short-lived, repository-scoped token for the explicitly selected participant. */
export const GetFilesAccess = Schema.Struct({
  ...server,
  participantId: M.ParticipantId,
  scope: FilesScope,
  ttlSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 86400 })).annotate({
      description: "Token lifetime in seconds, 60–86,400; defaults to 3,600.",
    }),
  ),
}).annotate(strict);
/** Parsed access request. */
export type GetFilesAccess = typeof GetFilesAccess.Type;
/** Announce a pushed file as an ordinary message with a file reference. */
export const ShareFile = Schema.Struct({
  ...server,
  ...I.SendMessage.fields,
  target: Target,
  path: M.RepositoryPath,
  commit: M.CommitHash,
  ref: Schema.optionalKey(M.RefName),
  bytes: Schema.optionalKey(M.Count),
}).annotate(strict);
/** Parsed share announcement. */
export type ShareFile = typeof ShareFile.Type;
/** Everything an agent needs to clone and push; `token` and `expiresAt` are null on a local deployment. */
export const FilesAccess = Schema.Struct({
  remote: Schema.String,
  token: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(M.Timestamp),
  defaultBranch: Schema.String,
  procedure: Schema.String,
}).annotate({ identifier: "FilesAccess" });
/** Parsed access reply. */
export interface FilesAccess extends Schema.Schema.Type<typeof FilesAccess> {}
const transferOffer = {
  ...server,
  participantId: M.ParticipantId,
  requestKey: M.RequestKey,
  name: M.TransferName,
  bytes: M.TransferBytes,
  sha256: M.Sha256,
};
/** A folder's file list stays small enough to read before accepting. */
export const maxManifestBytes = 8_388_608;
/** Reserve storage and get a short-lived upload link for one file or one packed folder. */
export const PrepareTransfer = Schema.Union([
  Schema.Struct({ ...transferOffer, kind: Schema.Literal("file") }),
  Schema.Struct({
    ...transferOffer,
    kind: Schema.Literal("folder"),
    fileCount: M.Count,
    manifestBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxManifestBytes })),
  }),
]).annotate(strict);
/** Parsed transfer reservation. */
export type PrepareTransfer = typeof PrepareTransfer.Type;
/** Confirm the upload and post the offer as an ordinary message. */
export const CompleteTransfer = Schema.Struct({
  ...server,
  ...I.SendMessage.fields,
  target: Target,
  transferId: M.TransferId,
}).annotate(strict);
/** Parsed transfer completion. */
export type CompleteTransfer = typeof CompleteTransfer.Type;
/** Accept an offer: get a short-lived download link and record who asked. */
export const FetchTransfer = Schema.Struct({
  ...server,
  participantId: M.ParticipantId,
  transferId: M.TransferId,
}).annotate(strict);
/** Parsed transfer acceptance. */
export type FetchTransfer = typeof FetchTransfer.Type;
/** Read an offer's state, its receipts, and a folder's file list without accepting it. */
export const ReadTransfer = Schema.Struct({ ...server, transferId: M.TransferId }).annotate(strict);
/** Parsed transfer status request. */
export type ReadTransfer = typeof ReadTransfer.Type;
/** Ask for the local command that packs a folder for sending. */
export const GetPackCommand = Schema.Struct({ ...server }).annotate(strict);
/** Parsed pack command request. */
export type GetPackCommand = typeof GetPackCommand.Type;
/** Where to upload; the links open one object each, for minutes. */
export const TransferUpload = Schema.Struct({
  transferId: M.TransferId,
  uploadUrl: Schema.String,
  manifestUploadUrl: Schema.NullOr(Schema.String),
  uploadExpiresAt: M.Timestamp,
  expiresAt: M.Timestamp,
  procedure: Schema.String,
}).annotate({ identifier: "TransferUpload" });
/** Parsed upload instructions. */
export interface TransferUpload extends Schema.Schema.Type<typeof TransferUpload> {}
/** Where to download an accepted transfer. */
export const TransferDownload = Schema.Struct({
  transfer: M.FileTransfer,
  url: Schema.String,
  urlExpiresAt: M.Timestamp,
  procedure: Schema.String,
}).annotate({ identifier: "TransferDownload" });
/** Parsed download instructions. */
export interface TransferDownload extends Schema.Schema.Type<typeof TransferDownload> {}
/** One participant that asked for a download link; a receipt, not proof the bytes arrived. */
export const TransferFetch = Schema.Struct({
  participantId: M.ParticipantId,
  firstFetchedAt: M.Timestamp,
}).annotate({ identifier: "TransferFetch" });
/** Parsed receipt. */
export interface TransferFetch extends Schema.Schema.Type<typeof TransferFetch> {}
/** An offer's state and receipts, plus how to read a folder's file list. */
export const TransferStatus = Schema.Struct({
  transfer: M.FileTransfer,
  senderId: M.ParticipantId,
  messageId: M.MessageId,
  state: Schema.Literals(["ready", "expired"]),
  fetches: Schema.Array(TransferFetch),
  fileListUrl: Schema.NullOr(Schema.String),
}).annotate({ identifier: "TransferStatus" });
/** Parsed transfer status. */
export interface TransferStatus extends Schema.Schema.Type<typeof TransferStatus> {}
/** A local command that reads a folder, prints a preview, and writes the bundle and file list. */
export const PackCommand = Schema.Struct({ command: Schema.String }).annotate({
  identifier: "PackCommand",
});
/** Parsed pack command. */
export interface PackCommand extends Schema.Schema.Type<typeof PackCommand> {}
const signalScope = {
  ...server,
  participantId: M.ParticipantId,
  ttlSeconds: Schema.optionalKey(S.TtlSeconds),
};
/** Mint or rotate a participant's content-free signal link for its host's hook scripts. */
export const CreateSignal = Schema.Union([
  Schema.Struct({ ...signalScope, channelIds: U.ChannelIds, directChats: Schema.Literal("own") }),
  Schema.Struct({
    ...signalScope,
    channelIds: U.RequiredChannelIds,
    directChats: Schema.Literal("none"),
  }),
]).annotate(strict);
/** Parsed signal request. */
export type CreateSignal = typeof CreateSignal.Type;
/** Revoke one of a participant's signal links, or all of them when signalId is omitted. */
export const RevokeSignal = Schema.Struct({
  ...server,
  participantId: M.ParticipantId,
  signalId: Schema.optionalKey(S.SignalId),
}).annotate(strict);
/** Parsed signal revocation. */
export type RevokeSignal = typeof RevokeSignal.Type;
const wakeScope = { ...server, participantId: M.ParticipantId };
/** End one of a participant's wakes, or all of them when wakeId is omitted. */
export const RevokeWake = Schema.Struct({
  ...wakeScope,
  wakeId: Schema.optionalKey(W.WakeId),
}).annotate(strict);
/** Parsed wake revocation. */
export type RevokeWake = typeof RevokeWake.Type;
/** Read a participant's wakes and their delivery state. */
export const ListWakes = Schema.Struct(wakeScope).annotate(strict);
/** Parsed wake listing. */
export type ListWakes = typeof ListWakes.Type;
/**
 * Optional deployment features an agent may branch on without listing tools. `wakes` means the
 * deployment can wake subscribed cloud agents; `wake_tokens` means a person can also add a
 * Claude Code routine, Grok Bot or Town wake on the TalkTo dashboard. No tool accepts those tokens.
 */
export const Capability = Schema.Literals(["files", "transfers", "wakes", "wake_tokens"]);
/** Parsed capability name. */
export type Capability = typeof Capability.Type;
/**
 * Stable names, scoped to this MCP server by the client. `send_feedback` and the invite tools are
 * answered by the Worker and are not server-object `Command`s.
 */
export const ToolName = Schema.Literals([
  "get_context",
  U.toolName,
  "register_participant",
  R.toolName,
  "read_messages",
  "send_message",
  "confirm_message",
  "create_channel",
  "set_channel_archived",
  "get_files_access",
  "share_file",
  "get_pack_command",
  "prepare_transfer",
  "complete_transfer",
  "fetch_transfer",
  "read_transfer",
  S.createToolName,
  S.revokeToolName,
  W.revokeToolName,
  W.listToolName,
  F.toolName,
  T.createToolName,
  T.claimToolName,
  T.updateToolName,
  T.readToolName,
  T.readMemoryToolName,
  T.memoryAccessToolName,
  AI.createToolName,
  AI.listToolName,
  AI.revokeToolName,
]);
/** Validated commands shared by the protocol adapter and private server binding. */
export const Command = Schema.Union([
  Schema.Struct({ tool: Schema.Literal("get_context"), input: GetContext }),
  Schema.Struct({ tool: Schema.Literal(U.toolName), input: AcceptedGetUpdates }),
  Schema.Struct({ tool: Schema.Literal("register_participant"), input: RegisterParticipant }),
  Schema.Struct({ tool: Schema.Literal(R.toolName), input: RenameParticipant }),
  Schema.Struct({ tool: Schema.Literal("read_messages"), input: ReadMessages }),
  Schema.Struct({ tool: Schema.Literal("send_message"), input: SendMessage }),
  Schema.Struct({ tool: Schema.Literal("confirm_message"), input: ConfirmMessage }),
  Schema.Struct({ tool: Schema.Literal("create_channel"), input: CreateChannel }),
  Schema.Struct({ tool: Schema.Literal("set_channel_archived"), input: SetChannelArchived }),
  Schema.Struct({ tool: Schema.Literal("get_files_access"), input: GetFilesAccess }),
  Schema.Struct({ tool: Schema.Literal("share_file"), input: ShareFile }),
  Schema.Struct({ tool: Schema.Literal("get_pack_command"), input: GetPackCommand }),
  Schema.Struct({ tool: Schema.Literal("prepare_transfer"), input: PrepareTransfer }),
  Schema.Struct({ tool: Schema.Literal("complete_transfer"), input: CompleteTransfer }),
  Schema.Struct({ tool: Schema.Literal("fetch_transfer"), input: FetchTransfer }),
  Schema.Struct({ tool: Schema.Literal("read_transfer"), input: ReadTransfer }),
  Schema.Struct({ tool: Schema.Literal(S.createToolName), input: CreateSignal }),
  Schema.Struct({ tool: Schema.Literal(S.revokeToolName), input: RevokeSignal }),
  Schema.Struct({ tool: Schema.Literal(W.revokeToolName), input: RevokeWake }),
  Schema.Struct({ tool: Schema.Literal(W.listToolName), input: ListWakes }),
  Schema.Struct({ tool: Schema.Literal(T.createToolName), input: T.CreateTasks }),
  Schema.Struct({ tool: Schema.Literal(T.claimToolName), input: T.ClaimTask }),
  Schema.Struct({ tool: Schema.Literal(T.updateToolName), input: T.UpdateTask }),
  Schema.Struct({ tool: Schema.Literal(T.readToolName), input: T.ReadTasks }),
  Schema.Struct({ tool: Schema.Literal(T.readMemoryToolName), input: T.ReadMemory }),
  Schema.Struct({ tool: Schema.Literal(T.memoryAccessToolName), input: T.GetMemoryAccess }),
]).annotate(strict);
/** Decoded application command; never contains credentials or a grant ID. */
export type Command = typeof Command.Type;
/** Executable navigation hint with the exact arguments of a valid tool call. */
export const NextAction = Schema.Union(
  Command.members.map((s) =>
    Schema.Struct({
      reason: Schema.String,
      tool: s.fields.tool,
      // As published: a next action never suggests a plugin's longer wait.
      arguments: s.fields.input === AcceptedGetUpdates ? GetUpdates : s.fields.input,
    }),
  ),
);
/** Parsed optional next action. */
export type NextAction = typeof NextAction.Type;
/** Overview assembled from the same application operations used by HTTP. */
export const Context = Schema.Struct({
  server: M.Server,
  self: Schema.NullOr(M.Participant),
  participants: M.page(M.Participant),
  channels: M.page(M.Channel),
  directChats: Schema.NullOr(M.page(M.DirectConversation)),
  general: Schema.Struct({ conversation: M.Channel, ...M.page(M.Message).fields }),
  capabilities: Schema.Array(Capability),
  /**
   * Present only on a server whose task board was ever switched on (a swarm server): whether it
   * is on, its channel, counts per state, and the tasks you hold or are assigned (`yours`).
   */
  board: Schema.optionalKey(T.ContextBoard),
});
/** Parsed server overview. */
export type Context = typeof Context.Type;
/** Server discovery uses platform metadata without waking every server. */
export const Discovery = Schema.Struct({
  kind: Schema.Literal("servers"),
  ...M.page(Schema.Union([P.Server, M.Server])).fields,
});
/** Context or a single continued directory. */
export const ContextData = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("context"), ...Context.fields }),
  Discovery,
  Schema.Struct({ kind: Schema.Literal("participants"), ...M.page(M.Participant).fields }),
  Schema.Struct({ kind: Schema.Literal("channels"), ...M.page(M.Channel).fields }),
  Schema.Struct({ kind: Schema.Literal("directChats"), ...M.page(M.DirectConversation).fields }),
]);
/** Registration returns its creation result and immediate server context. */
export const RegistrationData = Schema.Struct({ ...M.Registration.fields, context: Context });
/** Message retrieval preserves the selection discriminator. */
export const ReadData = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("history"), ...M.messagePage.fields }),
  Schema.Struct({ mode: Schema.Literal("search"), ...M.messagePage.fields }),
  Schema.Struct({ mode: Schema.Literal("around"), ...M.MessageContext.fields }),
]);
/** Metadata remains model-visible on both successful and failed tool calls. */
export const Meta = Schema.Struct({
  ...Envelope.Meta.fields,
  serverId: Schema.optionalKey(M.ServerId),
  nextActions: Schema.Array(NextAction),
  instructionSheet: Schema.optionalKey(Schema.String),
});
/** Parsed MCP application metadata. */
export type Meta = typeof Meta.Type;
/** Typed failure with optional recovery navigation. */
export const Failure = Schema.Struct({
  error: Schema.Union(Envelope.Failure.members.map((s) => s.fields.error)),
  meta: Meta,
});
/** Build the tool-specific response schema, including expected failures. */
export const reply = <S extends Schema.Top>(data: S) =>
  Schema.Union([Schema.Struct({ data, included: M.Included, meta: Meta }), Failure]);
/** Full validated response vocabulary for private RPC transport. */
const standardReply = reply(
  Schema.Union([
    ContextData,
    RegistrationData,
    R.Result,
    ReadData,
    M.created(M.Message),
    M.Message,
    M.created(M.Channel),
    M.Channel,
    FilesAccess,
    TransferUpload,
    TransferDownload,
    TransferStatus,
    PackCommand,
    S.Link,
    S.Revoked,
    W.List,
    W.Revoked,
    F.SentFeedback,
    T.CreatedTasks,
    T.ClaimResult,
    T.UpdatedTask,
    T.ReadTasksData,
    T.MemoryRead,
    T.MemoryAccess,
    AI.CreatedInvite,
    AI.Invites,
    AI.Revoked,
    AI.Admission,
  ]),
);
/** Updates use compact context while retaining the shared failure and metadata contract. */
export const UpdatesReply = Schema.Union([
  Schema.Struct({ data: U.Page, included: U.Included, meta: Meta }),
  Failure,
]);
/** Complete private-RPC response vocabulary, including compact updates. */
export const Reply = Schema.Union([standardReply, UpdatesReply]);
/** Decoded tool response. */
export type Reply = typeof Reply.Type;
/**
 * A private-RPC reply as it arrives from a server object: an object whose fields are not checked
 * yet. The MCP boundary checks it against its tool's contract once, before it leaves the Worker.
 */
export const UncheckedReply = Schema.Record(Schema.String, Schema.Unknown);
/** A reply not yet checked against its tool's contract. */
export type UncheckedReply = typeof UncheckedReply.Type;
