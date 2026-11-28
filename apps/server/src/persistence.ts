import { Context, Effect } from "effect";
import type * as M from "@talkto/api/models";
import type * as E from "@talkto/api/errors";
import type * as I from "@talkto/api/inputs";
import type * as D from "@talkto/api/dashboard";
import type * as U from "@talkto/api/updates";
import type { Grant, PrincipalKey } from "./access.js";
import type * as Files from "./files/model.js";
import type * as Agent from "@talkto/api/agent";
import type * as Transfers from "./files/transfers.js";
import type * as S from "@talkto/api/signal";
import type * as R from "@talkto/api/renames";
import type * as Removals from "@talkto/api/removals";
import type * as P from "@talkto/api/plugins";
import type * as History from "./history/model.js";
import type { BoardStore } from "./board/store.js";
import type { MemoryStore } from "./memory/store.js";

type Read<A> = Effect.Effect<A, E.StorageUnavailable>;
/** Creation metadata used for scoped idempotency; not exposed to agents. */
export interface Creation<A> {
  readonly item: A;
  readonly grantId: M.GrantId;
  readonly requestKey: M.RequestKey;
}
/** A person's participant, created from the authenticated principal under its current grant. */
export interface PersonCreation {
  readonly item: M.Participant;
  readonly principalKey: PrincipalKey;
  readonly grantId: M.GrantId;
}
/** The chat a person's request key opened, and whether that request created it. */
export interface PersonRequest {
  readonly agentId: M.ParticipantId;
  readonly conversationId: M.ConversationId;
  readonly created: boolean;
}
/** A bounded message selection, already interpreted by the application. */
export interface MessageSelection {
  readonly conversationId: M.ConversationId | null;
  readonly senderId: M.ParticipantId | null;
  readonly afterTime: M.Timestamp | null;
  readonly beforeTime: M.Timestamp | null;
  /** Inclusive upper bound for dashboard histogram selections; search keeps beforeTime exclusive. */
  readonly throughTime?: M.Timestamp | null;
  /** Inclusive lower bound, used where an account search resumes at a shared creation time. */
  readonly fromTime?: M.Timestamp | null;
  readonly boundary: number;
  readonly ceiling: number;
  readonly direction: "older" | "newer";
  readonly search: string | null;
  readonly limit: number;
}
/** New message before storage assigns its authoritative sequence. */
export interface MessageAppend {
  readonly id: M.MessageId;
  readonly conversationId: M.ConversationId;
  readonly senderId: M.ParticipantId;
  readonly body: M.Message["body"];
  readonly createdAt: M.Timestamp;
  readonly grantId: M.GrantId;
  readonly requestKey: M.RequestKey;
}
/** One participant's signal link as stored; the link's secret itself is never stored. */
export interface SignalRecord {
  readonly id: S.SignalId;
  readonly participantId: M.ParticipantId;
  readonly grantId: M.GrantId;
  readonly secretHash: string;
  readonly selection: U.Selection;
  readonly generation: U.Generation;
  /** Message sequence the link counts after. */
  readonly boundary: number;
  readonly createdAt: M.Timestamp;
  readonly expiresAt: M.Timestamp;
}
/** One name change to record with the participant's new name, in the same transaction. */
export interface RenameRecord {
  readonly id: R.RenameId;
  readonly participantId: M.ParticipantId;
  readonly previousName: M.Name;
  readonly name: M.Name;
  /** The participant itself for an agent operation, or the person's participant. */
  readonly renamedById: M.ParticipantId;
  readonly grantId: M.GrantId;
  readonly requestKey: M.RequestKey;
  readonly createdAt: M.Timestamp;
}
/** A person removes or restores an agent; `byId` is the person's participant. */
export interface RemovalChange {
  readonly participantId: M.ParticipantId;
  readonly action: Removals.Action;
  readonly byId: M.ParticipantId;
  readonly at: M.Timestamp;
}
/**
 * The newest incoming items after a boundary, newest first, and how many are urgent. Items are
 * messages and, for task readers, task events: both are UUIDs, so a signal link's `cursor` names
 * either.
 */
export interface SignalTally {
  readonly newest: ReadonlyArray<M.MessageId>;
  readonly urgent: number;
}
/** Cohesive persistence capabilities available only inside one synchronous transaction. */
export interface Session {
  /** The task board's tables (migrations/board.sql). */
  readonly board: BoardStore;
  /** Swarm memory's ledger (migrations/memory-repository.sql). */
  readonly memory: MemoryStore;
  readonly updatesHead: () => Read<{
    readonly generation: U.Generation;
    readonly sequence: number;
  }>;
  readonly updateCandidates: (
    selection: U.Selection & {
      readonly participantId: M.ParticipantId;
      readonly boundary: number;
      readonly ceiling: number;
      readonly limit: number;
    },
  ) => Read<ReadonlyArray<M.MessageId>>;
  /**
   * Count with the same incoming rule as `updateCandidates`, newest first, walking each selected
   * conversation's own index so other conversations' traffic costs nothing.
   */
  readonly signalTally: (
    selection: U.Selection & {
      readonly participantId: M.ParticipantId;
      readonly boundary: number;
      readonly limit: number;
    },
  ) => Read<SignalTally>;
  /**
   * How many incoming messages after `boundary` should wake an idle agent, at most `limit`: its
   * own direct chats and channel messages that @mention it (both only with `directChats: "own"`),
   * and TalkTo's own notices in the selected channels. Other channel messages are not counted.
   */
  readonly signalWaking: (
    selection: U.Selection & {
      readonly participantId: M.ParticipantId;
      readonly boundary: number;
      readonly limit: number;
    },
  ) => Read<number>;
  /** Store a participant's link, replacing any earlier one (rotation). */
  readonly putSignal: (signal: SignalRecord) => Read<void>;
  readonly signal: (id: S.SignalId) => Read<SignalRecord | null>;
  /** Delete one of the participant's links, or all of them; returns how many were removed. */
  readonly removeSignals: (participantId: M.ParticipantId, id: S.SignalId | null) => Read<number>;
  readonly removeExpiredSignals: (at: M.Timestamp) => Read<void>;
  /** How often TalkTo may wake this agent; the default when no choice is stored. */
  readonly wakeCadence: (participantId: M.ParticipantId) => Read<M.WakeCadence>;
  /** Store a person's choice; the default is stored as no row. */
  readonly setWakeCadence: (
    participantId: M.ParticipantId,
    cadence: M.WakeCadence,
    at: M.Timestamp,
  ) => Read<void>;
  /** The plugin this agent's sessions last reported, or null when none did. */
  readonly pluginReport: (participantId: M.ParticipantId) => Read<M.PluginSeen | null>;
  /** Record a plugin report, replacing the earlier one. */
  readonly notePlugin: (
    participantId: M.ParticipantId,
    report: P.Report,
    at: M.Timestamp,
  ) => Read<void>;
  readonly updateParticipants: (
    ids: ReadonlyArray<M.ParticipantId>,
  ) => Read<U.Included["participants"]>;
  readonly updateConversations: (
    ids: ReadonlyArray<M.ConversationId>,
  ) => Read<U.Included["conversations"]>;
  readonly serverIdentity: () => Read<M.ServerId>;
  readonly server: () => Read<M.Server>;
  readonly grant: (id: M.GrantId) => Read<Grant | null>;
  readonly participantsByIds: (
    ids: ReadonlyArray<M.ParticipantId>,
  ) => Read<ReadonlyArray<M.Participant>>;
  readonly conversationsByIds: (
    ids: ReadonlyArray<M.ConversationId>,
  ) => Read<ReadonlyArray<M.Conversation>>;
  readonly participant: (id: M.ParticipantId) => Read<M.Participant | null>;
  readonly participantNamed: (name: M.Name) => Read<M.Participant | null>;
  /** Earliest registration for a shared invitation, across authorized human clients. */
  readonly participantRegistered: (key: M.RequestKey) => Read<M.Participant | null>;
  /**
   * Agents registered through any grant of `principal` at or after `since`, oldest first; persons
   * and removed agents are left out.
   */
  readonly agentsRegisteredBy: (
    principal: PrincipalKey,
    since: M.Timestamp,
    limit: number,
  ) => Read<ReadonlyArray<M.Participant>>;
  readonly registration: (
    grant: M.GrantId,
    key: M.RequestKey,
  ) => Read<Creation<M.Participant> | null>;
  readonly addParticipant: (creation: Creation<M.Participant>) => Read<void>;
  /**
   * The name a participant registered with, when it has been renamed since (the earliest
   * rename's previous name); null for a participant that was never renamed.
   */
  readonly registeredName: (id: M.ParticipantId) => Read<M.Name | null>;
  /** The principal whose access registered this participant; null if it is unknown. */
  readonly registeredBy: (id: M.ParticipantId) => Read<PrincipalKey | null>;
  /** The principals whose access registered these participants, for the website's listing. */
  readonly registrants: (
    ids: ReadonlyArray<M.ParticipantId>,
  ) => Read<ReadonlyArray<{ readonly id: M.ParticipantId; readonly principalKey: PrincipalKey }>>;
  /** The rename this grant's request key already recorded, if any. */
  readonly renameRequest: (grant: M.GrantId, key: M.RequestKey) => Read<R.Rename | null>;
  /**
   * Record a rename and apply the new name. Its sequence is the next value of the message
   * sequence, so checkpoints order it with messages; returns the stored notice.
   */
  readonly addRename: (record: RenameRecord) => Read<R.Rename>;
  /** Renames with a sequence after `after` and up to `through`, oldest first. */
  readonly renamesBetween: (
    after: number,
    through: number,
    limit: number,
  ) => Read<ReadonlyArray<R.Rename>>;
  /** The newest renames on the server, or of one participant, newest first. */
  readonly recentRenames: (
    participantId: M.ParticipantId | null,
    limit: number,
  ) => Read<ReadonlyArray<R.Rename>>;
  /** The person participant bound to this authenticated principal, if the person has one here. */
  readonly person: (principalKey: PrincipalKey) => Read<M.Participant | null>;
  /** Store a person's participant and bind it to its principal in one statement group. */
  readonly addPerson: (person: PersonCreation) => Read<void>;
  /** What a person's earlier "open a direct chat" with this request key returned. */
  readonly personRequest: (
    personId: M.ParticipantId,
    key: M.RequestKey,
  ) => Read<PersonRequest | null>;
  readonly addPersonRequest: (
    personId: M.ParticipantId,
    key: M.RequestKey,
    request: PersonRequest,
  ) => Read<void>;
  /**
   * Among the sender's newest `limit` messages, how many were created after `since`, and the
   * oldest of those. Bounded by `limit` rows on the sender index.
   */
  readonly recentSends: (
    senderId: M.ParticipantId,
    limit: number,
    since: M.Timestamp,
  ) => Read<{ readonly count: number; readonly oldest: M.Timestamp | null }>;
  readonly participants: (
    name: M.Name | null,
    after: M.Name | null,
    limit: number,
    query?: string,
    state?: I.ParticipantState,
  ) => Read<ReadonlyArray<M.Participant>>;
  /**
   * Remove an agent (record who and when) or restore it (delete that record), and append the event
   * for the Activity view. The caller has checked the current state.
   */
  readonly setRemoved: (change: RemovalChange) => Read<void>;
  /** The newest removals and restorations on the server, newest first. */
  readonly recentRemovals: (limit: number) => Read<ReadonlyArray<Removals.Event>>;
  /** Bounded roster, most recent senders first, then idle agents by name. */
  readonly recentParticipants: (limit: number) => Read<ReadonlyArray<M.Participant>>;
  readonly conversation: (id: M.ConversationId) => Read<M.Conversation | null>;
  readonly channelNamed: (name: M.Name) => Read<M.Channel | null>;
  readonly channelCreation: (
    grant: M.GrantId,
    key: M.RequestKey,
  ) => Read<Creation<M.Channel> | null>;
  readonly addChannel: (creation: Creation<M.Channel>) => Read<void>;
  readonly channels: (
    state: typeof I.ChannelState.Type,
    after: M.Name | null,
    limit: number,
    query?: string,
  ) => Read<ReadonlyArray<M.Channel>>;
  readonly direct: (
    low: M.ParticipantId,
    high: M.ParticipantId,
  ) => Read<M.DirectConversation | null>;
  readonly addDirect: (item: M.DirectConversation, grantId: M.GrantId) => Read<void>;
  readonly directs: (
    withParticipant: M.ParticipantId | null,
    after: M.ConversationId | null,
    limit: number,
  ) => Read<ReadonlyArray<M.DirectConversation>>;
  readonly archive: (
    id: M.ConversationId,
    archivedAt: M.Timestamp | null,
    revision: number,
  ) => Read<void>;
  readonly message: (id: M.MessageId) => Read<M.Message | null>;
  readonly messageCreation: (
    grant: M.GrantId,
    key: M.RequestKey,
  ) => Read<Creation<M.Message> | null>;
  readonly append: (item: MessageAppend) => Read<M.Message>;
  readonly activityBuckets: (
    start: M.Timestamp,
    end: M.Timestamp,
    bucketMillis: number,
  ) => Read<
    ReadonlyArray<{
      readonly bucket: number;
      readonly messageCount: number;
      readonly participantCount: number;
    }>
  >;
  readonly activityTotals: (
    start: M.Timestamp,
    end: M.Timestamp,
  ) => Read<{
    readonly messageCount: number;
    readonly participantCount: number;
    readonly firstMessageAt: M.Timestamp | null;
    readonly lastMessageAt: M.Timestamp | null;
  }>;
  readonly activitySenders: (
    start: M.Timestamp,
    end: M.Timestamp,
    options: {
      readonly limit: number;
      readonly ceiling?: number;
      readonly after?: { readonly id: M.ParticipantId; readonly messageCount: number } | undefined;
    },
  ) => Read<D.Timeline["senders"]>;
  readonly activityCount: (start: M.Timestamp, end: M.Timestamp) => Read<number>;
  readonly messagesByIds: (ids: ReadonlyArray<M.MessageId>) => Read<ReadonlyArray<M.Message>>;
  readonly latestMessage: () => Read<M.Message | null>;
  readonly messages: (selection: MessageSelection) => Read<ReadonlyArray<M.Message>>;
  readonly revokeGrant: (id: M.GrantId, at: M.Timestamp) => Read<void>;
  /** The recorded remote, or null before any access or view has ensured the repository. */
  readonly fileRepository: () => Read<Files.Repository | null>;
  /** Record the ensured remote, rewriting a row whose remote or branch drifted; `createdAt` is kept from the first ensure. */
  readonly setFileRepository: (repository: Files.Repository, createdAt: M.Timestamp) => Read<void>;
  readonly addFileToken: (token: Files.TokenRecord) => Read<void>;
  /** Unrevoked, unexpired tokens whose grant has been revoked, oldest first. */
  readonly revocableFileTokens: (at: M.Timestamp) => Read<ReadonlyArray<Files.TokenRecord>>;
  readonly revokeFileToken: (id: string, at: M.Timestamp) => Read<void>;
  /** Attach a file reference to a message appended in this same transaction. */
  readonly addShare: (message: M.Message, share: M.FileShare) => Read<void>;
  /** Reserve storage for one upload; the row becomes an offer once a message is attached. */
  readonly addTransfer: (transfer: Transfers.TransferRecord) => Read<void>;
  readonly transfer: (id: M.TransferId) => Read<Transfers.TransferRecord | null>;
  /** The transfer an earlier attempt of this request reserved, if any. */
  readonly transferCreation: (
    grantId: M.GrantId,
    requestKey: M.RequestKey,
  ) => Read<Transfers.TransferRecord | null>;
  readonly renewTransferUpload: (id: M.TransferId, uploadExpiresAt: M.Timestamp) => Read<void>;
  /** The organization pool now holds this transfer's space; upload links may be signed. */
  readonly confirmTransferPool: (id: M.TransferId) => Read<void>;
  /** The pool refused this transfer, so its pending row reserved nothing and is removed. */
  readonly forgetPendingTransfer: (id: M.TransferId) => Read<void>;
  /** Attach the offer to its announcement, appended in this same transaction. */
  readonly attachTransfer: (id: M.TransferId, messageId: M.MessageId) => Read<void>;
  /** Record the first time a participant asked for a download link. */
  readonly addTransferFetch: (
    id: M.TransferId,
    participantId: M.ParticipantId,
    at: M.Timestamp,
  ) => Read<void>;
  readonly transferFetches: (id: M.TransferId) => Read<ReadonlyArray<Agent.TransferFetch>>;
  /** Every reservation and offer, newest first, strictly after `before` when it is given. */
  readonly transfers: (
    before: Transfers.TransferPosition | null,
    limit: number,
  ) => Read<ReadonlyArray<Transfers.TransferEntry>>;
  /** Mark a message appended in this same transaction as urgent. */
  readonly addPriority: (message: M.Message) => Read<void>;
  /** Mark a message appended in this same transaction as TalkTo's own notice. */
  readonly addNotice: (
    message: M.Message,
    notice: Pick<M.MessageNotice, "kind" | "channelId">,
  ) => Read<void>;
  /** Mark a message appended in this same transaction as the notice that an agent joined by invite. */
  readonly addJoinNotice: (message: M.Message, participantId: M.ParticipantId) => Read<void>;
  /** Record whom a channel message appended in this same transaction @mentions, in order. */
  readonly addMentions: (
    message: M.Message,
    participantIds: ReadonlyArray<M.ParticipantId>,
  ) => Read<void>;
  /** Record which agents a message appended in this same transaction asks to confirm it, in order. */
  readonly addConfirms: (
    message: M.Message,
    participantIds: ReadonlyArray<M.ParticipantId>,
  ) => Read<void>;
  /** Record that an asked agent confirmed a message, at `at`; an earlier confirmation is kept. */
  readonly markConfirmed: (
    message: M.Message,
    participantId: M.ParticipantId,
    at: M.Timestamp,
  ) => Read<void>;
  /** Mark a message appended in this same transaction as the notice that `confirmedId` was confirmed. */
  readonly addConfirmNotice: (message: M.Message, confirmedId: M.MessageId) => Read<void>;
  /** Messages carrying a share, newest first, strictly below the sequence boundary. */
  readonly shares: (boundary: number, limit: number) => Read<ReadonlyArray<M.Message>>;
  /** Where stored history begins once the retention prune removed older messages; else null. */
  readonly historyLimit: () => Read<History.Stored | null>;
}
/** Application-owned transaction port; implementations must not yield to asynchronous I/O. */
export class Persistence extends Context.Service<
  Persistence,
  {
    readonly transaction: <A, E>(
      operation: string,
      body: (session: Session) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | EStorage>;
  }
>()("@talkto/Persistence") {}
type EStorage = E.StorageUnavailable;
