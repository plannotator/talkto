import { Clock, Context, DateTime, Effect, Layer, Result, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as I from "@talkto/api/inputs";
import * as E from "@talkto/api/errors";
import * as D from "@talkto/api/dashboard";
import type * as O from "@talkto/api/onboarding";
import * as Dashboard from "./dashboard.js";
import type * as Agent from "@talkto/api/agent";
import type { AccessContext } from "./access.js";
import * as Store from "./persistence.js";
import * as Metering from "./metering/model.js";
import * as BoardDomain from "./board/domain.js";
import * as BoardModel from "./board/model.js";
import * as Navigation from "./navigation.js";
import * as ActivitySearch from "./platform/activity-search.js";
import * as Updates from "./updates.js";
import * as Access from "./access.js";
import * as Actors from "./actors.js";
import * as People from "./people.js";
import * as Signal from "./update-signal.js";
import type * as U from "@talkto/api/updates";
import * as R from "@talkto/api/renames";
import type * as Removals from "@talkto/api/removals";
import * as Files from "./files/model.js";
import * as Telemetry from "./telemetry.js";
import { procedure } from "./files/procedure.js";
import * as Transfers from "./files/transfers.js";
import * as TransferProcedure from "./files/transfer-procedure.js";
import * as Pool from "./files/pool.js";
import * as Signals from "./signals.js";
import * as PluginReports from "./plugin-reports.js";
import * as Mentions from "./mentions.js";
import * as BudgetModel from "./budgets/model.js";
import * as History from "./history/model.js";
import * as Archive from "./history/archive.js";
import * as S from "@talkto/api/signal";
import * as WakeSchedule from "./wakes/schedule.js";
import * as WakeStore from "./wakes/store.js";

/** Injectable source of UUID v4 values; the runtime owns cryptographic randomness. */
export class Identifiers extends Context.Service<
  Identifiers,
  { readonly uuid: () => Effect.Effect<string> }
>()("@talkto/Identifiers") {}
type BaseFailure = E.ServerAccessDenied | E.StorageUnavailable;
/** What the verified sign-in says about the person; only the trusted ingress supplies it. */
export interface PersonProfile {
  readonly name: M.Name;
}
/** Person sends allowed per person per server in each window. */
export const personLimits = [
  { count: 30, seconds: 60, label: "30 messages a minute" },
  { count: 1000, seconds: 86_400, label: "1,000 messages a day" },
] as const;
type Response<A, F = never> = Effect.Effect<M.Outcome<A>, BaseFailure | F>;
type RenameFailure =
  | E.ParticipantNotFound
  | E.NotAnAgent
  | E.ParticipantRemoved
  | E.NameTaken
  | E.IdempotencyConflict;
/** Shared application operations used by HTTP and MCP. */
export interface Interface {
  readonly getUpdates: (
    access: AccessContext,
    input: U.Input,
  ) => Effect.Effect<
    U.Outcome,
    | BaseFailure
    | E.InvalidCursor
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.ConversationNotFound
    | E.WrongConversationKind
  >;
  readonly serverTimeline: (access: AccessContext, input: D.TimelineInput) => Response<D.Timeline>;
  readonly serverTimelineSenders: (
    access: AccessContext,
    input: D.TimelineSendersInput,
  ) => Response<D.TimelineSenders, E.InvalidCursor>;
  readonly serverSummary: (access: AccessContext) => Response<D.Summary>;
  readonly onboarding: (
    access: AccessContext,
    names: readonly [M.Name, M.Name],
    agents?: O.AgentLookups,
    /** Slots 2 and up; their arrivals come back as `moreAgents`. */
    more?: O.MoreLookups,
    /**
     * When the run started. A slot no agent registered with its key takes the next agent the
     * caller's own access registered since then, so an agent that joined with a key of its own
     * still counts.
     */
    since?: M.Timestamp,
  ) => Response<O.ServerProgress>;
  readonly serverFeed: (
    access: AccessContext,
    input: D.FeedInput,
  ) => Response<D.Feed, E.InvalidCursor | E.InvalidSearch | E.ConversationNotFound>;
  readonly hydrateMessages: (
    access: AccessContext,
    ids: ReadonlyArray<M.MessageId>,
  ) => Response<ReadonlyArray<M.Message>>;
  /** One server's part of an account search, run against this server's own search index. */
  readonly searchActivity: (
    access: AccessContext,
    input: ActivitySearch.Request,
  ) => Response<
    { readonly items: ReadonlyArray<M.Message>; readonly more: boolean; readonly head: number },
    E.InvalidSearch
  >;
  readonly getServer: (access: AccessContext) => Response<M.Server>;
  readonly registerParticipant: (
    access: AccessContext,
    input: I.RegisterParticipant,
    /** Set only when the server admits an invited agent: its one participant (invites.ts). */
    admission?: Admission,
  ) => Response<
    M.Registration,
    E.NameTaken | E.IdempotencyConflict | E.ParticipantRemoved | E.AgentNotOwned
  >;
  /**
   * An agent renames its own registration. Allowed only when the participant was registered
   * through the caller's own person's access; TalkTo cannot tell that person's agents apart, so
   * any of them can rename another, and the notice every agent receives is the safeguard.
   */
  readonly renameSelf: (
    access: AccessContext,
    participantId: M.ParticipantId,
    input: R.RenameSelf,
  ) => Response<R.Result, RenameFailure | E.RenameNotAllowed>;
  /**
   * A signed-in person renames one agent on a server they can access, like other dashboard agent
   * management. The first call can create the person's participant from `person.name`.
   */
  readonly renameAgent: (
    access: AccessContext,
    person: PersonProfile,
    input: R.RenameAgent,
  ) => Response<R.Result, RenameFailure>;
  /**
   * A signed-in person on the dashboard removes one agent from the server, or restores it. Removing
   * ends its waits and deletes its signal links and wakes in the same transaction; its messages and
   * name stay. The first call can create the person's participant from `person.name`. Already in
   * the requested state: nothing changes.
   */
  readonly setAgentRemoved: (
    access: AccessContext,
    person: PersonProfile,
    agentId: M.ParticipantId,
    action: Removals.Action,
  ) => Response<Removals.Result, E.ParticipantNotFound | E.NotAnAgent>;
  /** Recent removals and restorations on the server, newest first. */
  readonly listRemovals: (
    access: AccessContext,
    input: Removals.ListInput,
  ) => Response<Removals.List>;
  /** Recent renames on the server, or of one participant, newest first. */
  readonly listRenames: (
    access: AccessContext,
    input: R.ListInput,
  ) => Response<R.List, E.ParticipantNotFound>;
  /**
   * `website` adds `registeredBy` to each participant a signed-in person registered. Only the
   * website's own reads pass it; agents, MCP and API tokens never receive the field.
   */
  readonly listParticipants: (
    access: AccessContext,
    input: I.ListParticipants,
    website?: boolean,
  ) => Response<M.Page<M.Participant>, E.InvalidCursor>;
  readonly getParticipant: (
    access: AccessContext,
    id: M.ParticipantId,
  ) => Response<M.Participant, E.ParticipantNotFound>;
  readonly createChannel: (
    access: AccessContext,
    input: I.CreateChannel,
  ) => Response<
    M.Created<M.Channel>,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.NameTaken
    | E.IdempotencyConflict
  >;
  readonly listChannels: (
    access: AccessContext,
    input: I.ListChannels,
  ) => Response<M.Page<M.Channel>, E.InvalidCursor>;
  readonly getConversation: (
    access: AccessContext,
    id: M.ConversationId,
  ) => Response<M.Conversation, E.ConversationNotFound>;
  readonly setChannelArchived: (
    access: AccessContext,
    id: M.ConversationId,
    input: I.SetChannelArchived,
  ) => Response<
    M.Channel,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.ConversationNotFound
    | E.WrongConversationKind
    | E.ProtectedGeneral
    | E.RevisionConflict
    | E.Forbidden
  >;
  readonly openDirectConversation: (
    access: AccessContext,
    input: I.OpenDirectConversation,
  ) => Response<
    M.Created<M.DirectConversation>,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.SelfConversation
  >;
  readonly listDirectConversations: (
    access: AccessContext,
    input: I.ListDirectConversations,
  ) => Response<M.Page<M.DirectConversation>, E.ParticipantNotFound | E.InvalidCursor>;
  readonly sendMessage: (
    access: AccessContext,
    id: M.ConversationId,
    input: I.SendMessage,
  ) => Response<
    M.Created<M.Message>,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.ConversationNotFound
    | E.ChannelArchived
    | Metering.Failure
    | E.NotConversationParticipant
    | E.IdempotencyConflict
    | E.WrongConversationKind
  >;
  readonly sendTo: (
    access: AccessContext,
    input: typeof Agent.SendMessage.Type,
  ) => Response<
    M.Created<M.Message>,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.ConversationNotFound
    | E.ChannelArchived
    | Metering.Failure
    | E.NotConversationParticipant
    | E.IdempotencyConflict
    | E.SelfConversation
    | E.WrongConversationKind
    | E.InvalidInput
  >;
  /**
   * An agent confirms a message that asked it to (send_message's `confirm`), as itself. The first
   * time records when and posts TalkTo's notice to the sender; a repeat changes nothing. Returns
   * the message with its current `confirm`.
   */
  readonly confirmMessage: (
    access: AccessContext,
    input: Agent.ConfirmMessage,
  ) => Response<
    M.Message,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.MessageNotFound
    | E.Forbidden
    | E.ChannelArchived
  >;
  /** The signed-in person's own participant, or null before they first take part. Creates nothing. */
  readonly getPersonSelf: (access: AccessContext) => Response<M.PersonSelf, never>;
  /**
   * Create, or return, the signed-in person's participant from `person.name`, so they can post in
   * channels before any direct chat. The principal on the grant binds it.
   */
  readonly joinAsPerson: (
    access: AccessContext,
    person: PersonProfile,
  ) => Response<M.Created<M.Participant>, never>;
  /**
   * Open, or return, the signed-in person's direct chat with one agent. The first call creates the
   * person's participant from `person.name`; the principal on the grant binds it.
   */
  readonly openPersonDirectChat: (
    access: AccessContext,
    person: PersonProfile,
    input: I.OpenPersonDirectChat,
  ) => Response<
    M.Created<M.DirectConversation>,
    E.ParticipantNotFound | E.NotAnAgent | E.ParticipantRemoved | E.IdempotencyConflict
  >;
  /**
   * The signed-in person sends into their own direct chat with an agent, or into a channel.
   * Rate-limited, not metered.
   */
  readonly sendPersonMessage: (
    access: AccessContext,
    input: I.SendPersonMessage,
  ) => Response<
    M.Created<M.Message>,
    | E.ParticipantNotFound
    | E.ConversationNotFound
    | E.ChannelArchived
    | E.NotConversationParticipant
    | E.NotAnAgent
    | E.ParticipantRemoved
    | E.IdempotencyConflict
    | E.WrongConversationKind
    | E.RateLimited
  >;
  readonly readMessages: (
    access: AccessContext,
    id: M.ConversationId,
    input: I.ReadMessages,
  ) => Response<M.MessagePage, E.ConversationNotFound | E.MessageNotFound | E.InvalidCursor>;
  readonly searchMessages: (
    access: AccessContext,
    input: I.SearchMessages,
  ) => Response<
    M.MessagePage,
    E.ConversationNotFound | E.ParticipantNotFound | E.InvalidCursor | E.InvalidSearch
  >;
  readonly getMessageContext: (
    access: AccessContext,
    id: M.MessageId,
    input: I.GetMessageContext,
  ) => Response<M.MessageContext, E.MessageNotFound>;
  /**
   * Factory's history archive, oldest first: messages this server moved out of its own database
   * after a year. Empty where nothing was ever archived. Readable by anyone who can read history.
   */
  readonly readArchive: (
    access: AccessContext,
    input: { readonly cursor?: M.Cursor; readonly limit?: typeof M.Limit.Type },
  ) => Response<M.Page<M.Message>, E.InvalidCursor>;
  /** Ensure the server repository once, mint a scoped token, and record it in the ledger. Not metered. */
  readonly filesAccess: (
    access: AccessContext,
    input: Agent.GetFilesAccess,
  ) => Response<
    Agent.FilesAccess,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.FilesUnavailable
  >;
  /** Append the announcement and its file reference in one transaction, metered as a share. */
  readonly shareFile: (
    access: AccessContext,
    input: Agent.ShareFile,
  ) => Response<
    M.Created<M.Message>,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.ConversationNotFound
    | E.ChannelArchived
    | Metering.Failure
    | E.NotConversationParticipant
    | E.IdempotencyConflict
    | E.SelfConversation
    | E.WrongConversationKind
  >;
  readonly listShares: (
    access: AccessContext,
    input: I.ListShares,
  ) => Response<M.Page<M.Message>, E.InvalidCursor>;
  /** The local command that packs a folder for sending. Touches no store. */
  readonly getPackCommand: (access: AccessContext) => Response<Agent.PackCommand>;
  /** Reserve storage and sign upload links; retrying the same request key renews the links. */
  readonly prepareTransfer: (
    access: AccessContext,
    input: Agent.PrepareTransfer,
  ) => Response<
    Agent.TransferUpload,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.FilesUnavailable
    | E.IdempotencyConflict
    | E.StoragePoolFull
    | E.TransferExpired
  >;
  /** Check the upload arrived at its declared size, then post the offer as a metered message. */
  readonly completeTransfer: (
    access: AccessContext,
    input: Agent.CompleteTransfer,
  ) => Response<
    M.Created<M.Message>,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.ConversationNotFound
    | E.ChannelArchived
    | Metering.Failure
    | E.NotConversationParticipant
    | E.IdempotencyConflict
    | E.SelfConversation
    | E.WrongConversationKind
    | E.FilesUnavailable
    | E.TransferNotFound
    | E.TransferExpired
    | E.TransferNotUploaded
  >;
  /** Accept an offer: sign a download link and record the receipt. */
  readonly fetchTransfer: (
    access: AccessContext,
    input: Agent.FetchTransfer,
  ) => Response<
    Agent.TransferDownload,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.FilesUnavailable
    | E.TransferNotFound
    | E.TransferExpired
  >;
  /** Mint or rotate the participant's content-free signal link. The secret is returned once. */
  readonly createSignal: (
    access: AccessContext,
    input: Agent.CreateSignal,
  ) => Response<
    Signals.Minted,
    | E.ParticipantNotFound
    | E.NotAnAgent
    | E.AgentNotOwned
    | E.ParticipantRemoved
    | E.ConversationNotFound
    | E.WrongConversationKind
  >;
  /** Delete one or all of the participant's signal links. Idempotent. */
  readonly revokeSignal: (
    access: AccessContext,
    input: Agent.RevokeSignal,
  ) => Response<
    S.Revoked,
    E.ParticipantNotFound | E.NotAnAgent | E.AgentNotOwned | E.ParticipantRemoved
  >;
  /**
   * Open a link by its secret. There is no caller credential: the grant that minted the link
   * becomes the access, so revoking that grant ends the link.
   */
  readonly openSignal: (
    serverId: M.ServerId,
    id: S.SignalId,
    secret: S.Secret,
  ) => Effect.Effect<Signals.Opened, Signals.SignalUnavailable | E.StorageUnavailable>;
  /**
   * Count incoming messages for an opened link, after `since` when it is a later message. `plugin`
   * is the check's `TalkTo-Plugin` header, as in `hooks/0.3.0`, or null.
   */
  readonly countSignal: (
    opened: Signals.Opened,
    since: M.MessageId | null,
    plugin?: string | null,
  ) => Effect.Effect<S.Counts, Signals.SignalUnavailable | E.StorageUnavailable>;
  /**
   * Every file and folder agents sent on the server, newest first, for anyone with access to it,
   * the same rule as reading its conversations. Reads the ledger only; the store is not asked.
   */
  readonly listTransfers: (
    access: AccessContext,
    input: D.ListTransfers,
  ) => Response<D.ServerTransfers, E.InvalidCursor>;
  /**
   * A short-lived download link for one sent, unexpired transfer, for a person on the dashboard.
   * Not metered, and it records no receipt: receipts say which agents accepted an offer.
   */
  readonly downloadTransfer: (
    access: AccessContext,
    id: M.TransferId,
  ) => Response<D.TransferDownload, E.FilesUnavailable | E.TransferNotFound | E.TransferExpired>;
  /** Read an offer's state and receipts without accepting it. */
  readonly readTransfer: (
    access: AccessContext,
    input: Agent.ReadTransfer,
  ) => Response<Agent.TransferStatus, E.FilesUnavailable | E.TransferNotFound>;
}
/** Server application service; it depends on application ports rather than HTTP or SQLite. */
export class Service extends Context.Service<Service, Interface>()("@talkto/TalkTo") {}

const now = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(ms)))),
);
const empty = <A>(data: A): M.Outcome<A> => ({
  data,
  included: { participants: [], conversations: [] },
});
const participant = Effect.fn("TalkTo.requireParticipant")(function* (
  tx: Store.Session,
  id: M.ParticipantId,
) {
  const item = yield* tx.participant(id);
  if (item === null)
    return yield* new E.ParticipantNotFound({
      message: "The participant does not exist in this server.",
    });
  return item;
});
const conversation = Effect.fn("TalkTo.requireConversation")(function* (
  tx: Store.Session,
  id: M.ConversationId,
) {
  const item = yield* tx.conversation(id);
  if (item === null)
    return yield* new E.ConversationNotFound({
      message: "The conversation does not exist in this server.",
    });
  return item;
});
const message = Effect.fn("TalkTo.requireMessage")(function* (tx: Store.Session, id: M.MessageId) {
  const item = yield* tx.message(id);
  if (item === null) {
    const limit = yield* tx.historyLimit();
    return yield* new E.MessageNotFound({
      message: `The message does not exist in this server.${limit === null ? "" : History.missingHint(limit)}`,
    });
  }
  return item;
});
/**
 * Where stored history begins, when this read reached it: an older page that found nothing more,
 * or a newer read that started before the removed history.
 */
const historyReached = Effect.fn("TalkTo.historyReached")(function* (
  tx: Store.Session,
  state: Pick<Navigation.MessageCursor, "direction" | "afterTime" | "boundary">,
  exhausted: boolean,
) {
  const limit = yield* tx.historyLimit();
  if (limit === null) return null;
  const reached =
    state.direction === "older"
      ? exhausted
      : state.afterTime !== null
        ? state.afterTime <= limit.throughAt
        : state.boundary <= limit.throughSequence;
  return reached ? History.describe(limit) : null;
});
const describe = Effect.fn("TalkTo.describe")(function* <A>(
  tx: Store.Session,
  data: A,
  conversations: ReadonlyArray<M.Conversation>,
  senders: ReadonlyArray<M.ParticipantId>,
  includeConversations: boolean,
) {
  const ids = new Set(senders);
  for (const item of conversations) {
    if (item.latestMessage !== null) ids.add(item.latestMessage.senderId);
    if (item.createdByParticipantId !== null) ids.add(item.createdByParticipantId);
    if (item.kind === "direct") for (const id of item.participantIds) ids.add(id);
  }
  const participants = yield* tx.participantsByIds([...ids]);
  return {
    data,
    included: { participants, conversations: includeConversations ? conversations : [] },
  };
});
const registration = Effect.fn("TalkTo.describeRegistration")(function* (
  tx: Store.Session,
  result: M.Created<M.Participant>,
) {
  const general = yield* tx.channelNamed(M.Name.make("General"));
  if (general === null) return yield* Effect.die("Initialized server is missing General");
  return yield* describe(tx, { ...result, generalConversationId: general.id }, [general], [], true);
});
/** Who a rename acts for: the agent itself, or the signed-in person's participant. */
type RenameActor =
  | { readonly kind: "self" }
  | { readonly kind: "person"; readonly participantId: M.ParticipantId };
/**
 * Rename one agent inside an authorized transaction. A retry of the same grant's request key
 * returns its recorded change and never restores that older name over a later one; the exact
 * current name changes nothing; a case-only change is a change; a name another participant holds
 * (ignoring case) is refused and changes nothing. Renames are never metered.
 */
const renameParticipant = Effect.fn("TalkTo.renameParticipant")(function* (
  tx: Store.Session,
  access: AccessContext,
  input: {
    readonly participantId: M.ParticipantId;
    readonly name: M.Name;
    readonly requestKey: M.RequestKey;
  },
  actor: RenameActor,
  id: R.RenameId,
  at: M.Timestamp,
) {
  const prior = yield* tx.renameRequest(access.grantId, input.requestKey);
  if (prior !== null) {
    const sameActor =
      actor.kind === "self"
        ? prior.renamedBy.kind === "self"
        : prior.renamedBy.kind === "person" &&
          prior.renamedBy.participantId === actor.participantId;
    if (prior.participantId !== input.participantId || prior.name !== input.name || !sameActor)
      return yield* conflict();
    const current = yield* participant(tx, input.participantId);
    return empty<R.Result>({ participant: current, rename: prior, changed: false });
  }
  // A person may rename an agent they removed, which frees its name for a new agent.
  const target =
    actor.kind === "self"
      ? yield* Actors.requireAgent(tx, input.participantId)
      : yield* Actors.requireAgentRecord(tx, input.participantId);
  if (target.name === input.name)
    return empty<R.Result>({ participant: target, rename: null, changed: false });
  const holder = yield* tx.participantNamed(input.name);
  if (holder !== null && holder.id !== target.id)
    return yield* new E.NameTaken({
      message:
        "A participant with that name already exists. Choose a name unique to your project and machine.",
    });
  const rename = yield* tx.addRename({
    id,
    participantId: target.id,
    previousName: target.name,
    name: input.name,
    renamedById: actor.kind === "self" ? target.id : actor.participantId,
    grantId: access.grantId,
    requestKey: input.requestKey,
    createdAt: at,
  });
  const current = yield* participant(tx, target.id);
  return empty<R.Result>({ participant: current, rename, changed: true });
});
export const describeMessages = Effect.fn("TalkTo.describeMessages")(function* <A>(
  tx: Store.Session,
  data: A,
  messages: ReadonlyArray<M.Message>,
) {
  const conversations = yield* tx.conversationsByIds([
    ...new Set(messages.map((item) => item.conversationId)),
  ]);
  return yield* describe(
    tx,
    data,
    conversations,
    messages.map((item) => item.senderId),
    true,
  );
});
/** A signed-in person's principal (`workos:<userId>`, platform/model.ts) as `registeredBy`. */
const registrant = Schema.decodeUnknownOption(M.RegisteredBy);
/** The website's listing: each participant a signed-in person registered names that person. */
const withRegistrants = Effect.fn("TalkTo.withRegistrants")(function* (
  tx: Store.Session,
  items: ReadonlyArray<M.Participant>,
) {
  if (items.length === 0) return items;
  const keys = new Map(
    (yield* tx.registrants(items.map((item) => item.id))).map((row) => [row.id, row.principalKey]),
  );
  return items.map((item): M.Participant => {
    const key = keys.get(item.id);
    if (key === undefined || !key.startsWith("workos:")) return item;
    const by = registrant({ userId: key.slice("workos:".length) });
    return by._tag === "Some" ? { ...item, registeredBy: by.value } : item;
  });
});
const conflict = () =>
  new E.IdempotencyConflict({ message: "The request key was already used for different input." });
const invalidCursor = () =>
  new E.InvalidCursor({ message: "The continuation token does not match this request." });
const scope = (serverId: M.ServerId) => ({ version: 1 as const, serverId });

const direct = Effect.fn("TalkTo.resolveDirect")(function* (
  tx: Store.Session,
  access: AccessContext,
  input: I.OpenDirectConversation,
  id: M.ConversationId,
  createdAt: M.Timestamp,
) {
  if (input.participantId === input.recipientId)
    return yield* new E.SelfConversation({
      message: "A direct chat requires two different participants.",
    });
  // An agent may open a chat with a person, but acts only as an agent its own person registered.
  yield* Actors.requireOwnAgent(tx, access, input.participantId);
  yield* participant(tx, input.recipientId);
  return yield* pairDirect(tx, access, input.participantId, input.recipientId, id, createdAt);
});
/** The existing direct chat between two checked, different participants, or a new one. */
const pairDirect = Effect.fn("TalkTo.pairDirect")(function* (
  tx: Store.Session,
  access: AccessContext,
  openerId: M.ParticipantId,
  otherId: M.ParticipantId,
  id: M.ConversationId,
  createdAt: M.Timestamp,
) {
  const pair: readonly [M.ParticipantId, M.ParticipantId] =
    openerId < otherId ? [openerId, otherId] : [otherId, openerId];
  const prior = yield* tx.direct(...pair);
  if (prior !== null) return { item: prior, created: false };
  const item = M.DirectConversation.make({
    kind: "direct",
    id,
    participantIds: pair,
    createdByParticipantId: openerId,
    createdAt,
    messageCount: 0,
    lastMessageAt: null,
    latestMessage: null,
  });
  yield* tx.addDirect(item, access.grantId);
  return { item, created: true };
});

/**
 * Create the signed-in person's participant on this server and bind it to their principal. The
 * name comes from the verified sign-in, made unique on the server like any participant name.
 */
export const addPerson = Effect.fn("TalkTo.addPerson")(function* (
  tx: Store.Session,
  access: AccessContext,
  profile: PersonProfile,
  id: M.ParticipantId,
  createdAt: M.Timestamp,
) {
  // The HTTP routes that reach here refuse invited agents first (http.ts `asPerson`); MCP has none.
  if (Access.isInvited(access.principalKey))
    return yield* Effect.die(new Error("An invited agent cannot join as a person."));
  let name = M.Name.make(`${profile.name.slice(0, 50)}-${id.slice(0, 8)}`);
  for (const candidate of People.candidates(profile.name)) {
    if ((yield* tx.participantNamed(candidate)) === null) {
      name = candidate;
      break;
    }
  }
  const item = M.Participant.make({
    id,
    name,
    agentType: People.agentType,
    workingDirectory: null,
    joinedNote: null,
    createdAt,
    messageCount: 0,
    lastMessageAt: null,
    kind: "person",
  });
  yield* tx.addPerson({ item, principalKey: access.principalKey, grantId: access.grantId });
  return item;
});

/** What one append journals and attaches; a plain message spends one unit and carries neither reference. */
interface Spend {
  readonly units: Metering.Units;
  readonly kind: Metering.UsageKind;
  readonly share: M.FileShare | null;
  readonly transferId: M.TransferId | null;
}
const plainMessage: Spend = {
  units: Metering.singleUnit,
  kind: "message",
  share: null,
  transferId: null,
};
/** Shares default to the branch every store creates; the repository row is not required to share. */
const mainRef = M.RefName.make("main");
const sameShare = (a: M.FileShare | undefined, b: M.FileShare | null) =>
  a === undefined
    ? b === null
    : b !== null &&
      a.path === b.path &&
      a.commit === b.commit &&
      a.ref === b.ref &&
      a.bytes === b.bytes;
const isUrgent = (priority: M.Priority | undefined) => priority === "urgent";
/** Who an append acts for: an agent through its own operations, or a signed-in person. */
type Actor = "agent" | "person";
/**
 * A person's sends are not metered, so they are bounded instead: per person per server, a sliding
 * minute and day over the person's own messages. Replays never reach this check.
 */
const withinPersonLimits = Effect.fn("TalkTo.withinPersonLimits")(function* (
  tx: Store.Session,
  personId: M.ParticipantId,
  at: M.Timestamp,
) {
  const ms = DateTime.toEpochMillis(DateTime.makeUnsafe(at));
  for (const limit of personLimits) {
    const since = secondsAfter(at, -limit.seconds);
    const recent = yield* tx.recentSends(personId, limit.count, since);
    if (recent.count < limit.count || recent.oldest === null) continue;
    const frees = DateTime.toEpochMillis(DateTime.makeUnsafe(recent.oldest)) + limit.seconds * 1000;
    const wait = Math.min(3600, Math.max(1, Math.ceil((frees - ms) / 1000)));
    return yield* new E.RateLimited({
      retryable: true,
      action: "retry_after",
      retryAfterSeconds: wait,
      scope: "participant",
      message: `Too many messages: a person can send ${limit.label} on this server. ${BudgetModel.waitFor(wait)}, then retry with the same request key.`,
    });
  }
});
/**
 * The participants a channel message @mentions by current name (names are unique ignoring case), in
 * the order written, without the sender, at most `M.maxMentions`. Unknown names mention nobody.
 */
export const mentioned = Effect.fn("TalkTo.mentioned")(function* (
  tx: Store.Session,
  body: string,
  senderId: M.ParticipantId,
) {
  const found: M.ParticipantId[] = [];
  for (const readings of Mentions.tags(body)) {
    for (const name of readings) {
      const item = yield* tx.participantNamed(name);
      if (item === null) continue;
      if (item.id !== senderId && !found.includes(item.id)) found.push(item.id);
      break;
    }
    if (found.length >= M.maxMentions) break;
  }
  return found;
});
/**
 * The agents a message sent with `confirm` asks to confirm it: in a direct chat the other member,
 * in a channel those it @mentions, in the order written. People are never asked: confirming is an
 * agent tool. An agent a person removed stays asked, since a person can restore it.
 */
const askedToConfirm = Effect.fn("TalkTo.askedToConfirm")(function* (
  tx: Store.Session,
  target: M.Conversation,
  senderId: M.ParticipantId,
  mentions: ReadonlyArray<M.ParticipantId>,
) {
  const candidates =
    target.kind === "direct" ? target.participantIds.filter((id) => id !== senderId) : mentions;
  const agents = new Set(
    (yield* tx.participantsByIds(candidates))
      .filter((item) => item.kind !== "person")
      .map((item) => item.id),
  );
  return candidates.filter((id) => agents.has(id));
});
/**
 * TalkTo's notice in General for a channel created in this same transaction. It is a message so it
 * reaches agents and people through everything that already delivers General; its sender is the
 * creating agent and its body states only the facts, marked by `notice`. It is never metered, and it
 * exists only when the channel is new, so a create_channel retry never repeats it.
 */
export const channelNotice = Effect.fn("TalkTo.channelNotice")(function* (
  tx: Store.Session,
  access: AccessContext,
  channel: M.Channel,
  creator: M.Participant,
  messageId: M.MessageId,
) {
  const general = yield* tx.channelNamed(M.Name.make("General"));
  if (general === null) return yield* Effect.die("Initialized server is missing General");
  const latest = yield* tx.latestMessage();
  const createdAt =
    [
      channel.createdAt,
      creator.createdAt,
      general.createdAt,
      latest?.createdAt ?? channel.createdAt,
    ]
      .sort()
      .at(-1) ?? channel.createdAt;
  const appended = yield* tx.append({
    id: messageId,
    conversationId: general.id,
    senderId: creator.id,
    body: M.MessageBody.make(channelNoticeBody(channel, creator)),
    createdAt,
    grantId: access.grantId,
    // Outside what agents choose in practice, and unique per channel; replays never reach here.
    requestKey: M.RequestKey.make(`talkto.channel-created:${channel.id}`),
  });
  yield* tx.addNotice(appended, { kind: "channel_created", channelId: channel.id });
  const item = yield* tx.message(appended.id);
  if (item === null) return yield* Effect.die("Appended notice is missing");
  return yield* describeMessages(tx, { item, created: true }, [item]);
});
/** An invited agent's admission: who made the link it joined through, for General's notice. */
export interface Admission {
  /** The agent that made the link, or null when a person did. */
  readonly invitedBy: string | null;
  /** The person whose invite started the chain, by first name. */
  readonly origin: string;
}
/**
 * TalkTo's notice in General that an agent joined by invite, written with its participant in the
 * same transaction, so it exists once however often a pickup is retried. Its sender is the agent
 * that joined. It names the inviting agent and the person whose invite started the chain, by first
 * name, as the owner chose (November 25, 2026): a message is never rewritten, so that name stays in
 * General's history after the person deletes their account, while the participant's lineage then
 * says "Deleted person". It is never metered and wakes no one.
 */
const joinNotice = Effect.fn("TalkTo.joinNotice")(function* (
  tx: Store.Session,
  access: AccessContext,
  agent: M.Participant,
  admission: Admission,
  messageId: M.MessageId,
) {
  const general = yield* tx.channelNamed(M.Name.make("General"));
  if (general === null) return yield* Effect.die("Initialized server is missing General");
  const latest = yield* tx.latestMessage();
  const createdAt =
    [agent.createdAt, general.createdAt, latest?.createdAt ?? agent.createdAt].sort().at(-1) ??
    agent.createdAt;
  const appended = yield* tx.append({
    id: messageId,
    conversationId: general.id,
    senderId: agent.id,
    body: M.MessageBody.make(
      admission.invitedBy === null
        ? `TalkTo: ${agent.name} joined, invited by ${admission.origin}.`
        : `TalkTo: ${agent.name} joined, invited by ${admission.invitedBy} (from ${admission.origin}'s invite).`,
    ),
    createdAt,
    grantId: access.grantId,
    // Outside what agents choose in practice, and unique per participant.
    requestKey: M.RequestKey.make(`talkto.joined:${agent.id}`),
  });
  yield* tx.addJoinNotice(appended, agent.id);
  const item = yield* tx.message(appended.id);
  if (item === null) return yield* Effect.die("Appended notice is missing");
  return yield* describeMessages(tx, { item, created: true }, [item]);
});
/**
 * TalkTo's notice that an agent confirmed a message that asked it to, written with the
 * confirmation in the same transaction, so it exists once per message and agent. Its sender is the
 * confirming agent, in the message's conversation; in a channel it @mentions the message's sender,
 * who receives it like a direct message. It is never metered.
 */
const confirmNotice = Effect.fn("TalkTo.confirmNotice")(function* (
  tx: Store.Session,
  access: AccessContext,
  confirmed: M.Message,
  target: M.Conversation,
  confirmer: M.Participant,
  messageId: M.MessageId,
  at: M.Timestamp,
) {
  const sender = yield* participant(tx, confirmed.senderId);
  const latest = yield* tx.latestMessage();
  const createdAt =
    [at, confirmer.createdAt, target.createdAt, latest?.createdAt ?? at].sort().at(-1) ?? at;
  const appended = yield* tx.append({
    id: messageId,
    conversationId: confirmed.conversationId,
    senderId: confirmer.id,
    body: M.MessageBody.make(
      `TalkTo: ${confirmer.name} confirmed @${sender.name}'s message ${confirmed.id}.`,
    ),
    createdAt,
    grantId: access.grantId,
    // Outside what agents choose in practice, and unique per message and confirming agent.
    requestKey: M.RequestKey.make(`talkto.confirmed:${confirmed.id}:${confirmer.id}`),
  });
  yield* tx.addConfirmNotice(appended, confirmed.id);
  if (target.kind === "channel") yield* tx.addMentions(appended, [confirmed.senderId]);
  // Re-read, so the outcome carries the mention and the conversation that decide who is woken.
  const item = yield* tx.message(appended.id);
  if (item === null) return yield* Effect.die("Appended notice is missing");
  return yield* describeMessages(tx, { item, created: true }, [item]);
});
/** The notice's text: who created which channel, its description, and how to follow it. */
const channelNoticeBody = (
  channel: Pick<M.Channel, "id" | "name" | "description">,
  creator: Pick<M.Participant, "name">,
) =>
  [
    `TalkTo: ${creator.name} created the channel #${channel.name}.`,
    ...(channel.description === null ? [] : [`Description: ${channel.description}`]),
    `To follow it, add channel ID ${channel.id} to the channelIds you watch (get_updates, create_signal or your plugin's follow). Agents @mentioned in a channel receive that message without following it.`,
  ].join("\n");
const append = Effect.fn("TalkTo.append")(function* (
  tx: Store.Session,
  access: AccessContext,
  id: M.ConversationId,
  input: I.SendMessage,
  messageId: M.MessageId,
  at: M.Timestamp,
  meter: Metering.Meter["Service"],
  spend: Spend = plainMessage,
  actor: Actor = "agent",
  /** Set only by send_message (`sendTo`): ask the agents the message addresses to confirm it. */
  confirm = false,
) {
  // A person's participant never sends through an agent operation, not even as a replay, and an
  // agent sends only as an agent its own person registered.
  const sender =
    actor === "agent"
      ? yield* Actors.requireOwnAgent(tx, access, input.participantId)
      : yield* participant(tx, input.participantId);
  const prior = yield* tx.messageCreation(access.grantId, input.requestKey);
  if (prior !== null) {
    const item = prior.item;
    if (
      item.senderId !== input.participantId ||
      item.conversationId !== id ||
      item.body !== input.body ||
      !sameShare(item.share, spend.share) ||
      (item.transfer?.id ?? null) !== spend.transferId ||
      isUrgent(item.priority) !== isUrgent(input.priority) ||
      (item.confirm !== undefined) !== confirm
    )
      return yield* conflict();
    return yield* describeMessages(tx, { item, created: false }, [item]);
  }
  const target = yield* conversation(tx, id);
  if (target.kind === "channel" && target.archivedAt !== null)
    return yield* new E.ChannelArchived({
      message: "Reopen the channel before sending new messages.",
    });
  if (target.kind === "direct" && !target.participantIds.includes(input.participantId))
    return yield* new E.NotConversationParticipant({
      message: "Only the two participants can send into this direct chat.",
    });
  const urgent = isUrgent(input.priority);
  if (urgent && target.kind !== "direct")
    return yield* new E.WrongConversationKind({
      message:
        'priority="urgent" is limited to direct chats. Send it to the participant directly, or send it to this channel without priority.',
    });
  const mentions =
    target.kind === "channel" ? yield* mentioned(tx, input.body, input.participantId) : [];
  const asked = confirm ? yield* askedToConfirm(tx, target, input.participantId, mentions) : [];
  if (confirm && asked.length === 0)
    return yield* new E.InvalidInput({
      message:
        "confirm: true would ask no agent. It asks the other agent in a direct chat, or the agents a channel message @mentions; people are never asked. In a channel, @mention the agents that should confirm it; otherwise send it without confirm.",
    });
  const latest = yield* tx.latestMessage();
  const createdAt =
    [at, sender.createdAt, target.createdAt, latest?.createdAt ?? at].sort().at(-1) ?? at;
  yield* meter.consume(messageId, spend.units, spend.kind);
  const appended = yield* tx.append({
    id: messageId,
    conversationId: id,
    senderId: input.participantId,
    body: input.body,
    createdAt,
    grantId: access.grantId,
    requestKey: input.requestKey,
  });
  if (
    spend.share === null &&
    spend.transferId === null &&
    !urgent &&
    mentions.length === 0 &&
    asked.length === 0
  )
    return yield* describeMessages(tx, { item: appended, created: true }, [appended]);
  if (spend.share !== null) yield* tx.addShare(appended, spend.share);
  if (spend.transferId !== null) yield* tx.attachTransfer(spend.transferId, appended.id);
  if (urgent) yield* tx.addPriority(appended);
  if (asked.length > 0) yield* tx.addConfirms(appended, asked);
  if (mentions.length > 0) yield* tx.addMentions(appended, mentions);
  // Re-read through the shared projection so the reply carries exactly what every reader will see.
  const item = yield* tx.message(appended.id);
  if (item === null) return yield* Effect.die("Appended message is missing");
  return yield* describeMessages(tx, { item, created: true }, [item]);
});
/** Who a committed message can wake: its conversation, sender, and a direct chat's two members. */
export const arrival = (outcome: M.Outcome<M.Created<M.Message>>): WakeStore.Arrival => {
  const item = outcome.data.item;
  const target = outcome.included.conversations.find((entry) => entry.id === item.conversationId);
  return {
    conversationId: item.conversationId,
    senderId: item.senderId,
    directParticipantIds: target?.kind === "direct" ? target.participantIds : [],
    mentionedIds: item.mentions ?? [],
    urgent: isUrgent(item.priority),
  };
};
const filesFailure = (error: Files.Failure): E.FilesUnavailable =>
  error._tag === "FileStoreUnavailable"
    ? new E.FilesUnavailable({
        message:
          "File sharing is not available on this deployment. Paste the content into a message if it fits.",
        operation: "files",
        reason: "absent",
      })
    : // The store's failure stays behind, so Sentry can tag its safe failure kind.
      Telemetry.withCause(
        new E.FilesUnavailable({
          message: "The file store could not complete the operation. Retry shortly.",
          operation: error.operation,
          reason: "failed",
        }),
        error,
      );

const secondsAfter = (at: M.Timestamp, seconds: number) =>
  M.Timestamp.make(DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { seconds })));
const transferOffer = (record: Transfers.TransferRecord): M.FileTransfer => ({
  id: record.id,
  name: record.name,
  kind: record.kind,
  bytes: record.bytes,
  sha256: record.sha256,
  fileCount: record.fileCount,
  expiresAt: record.expiresAt,
});
const transferMissing = () =>
  new E.TransferNotFound({ message: "No transfer with this ID has been sent on this server." });
const transferExpired = () =>
  new E.TransferExpired({ message: "This transfer has expired. Ask the sender to send it again." });
/**
 * Check that a transfer not offered yet has its objects in the store at the declared sizes, as
 * `complete_transfer` and a task result both require. TalkTo checks sizes only; the receiver's
 * download procedure checks the hash. An object at the wrong size is removed so the sender can
 * upload again, because each link writes its object only once.
 */
export const verifyUpload = Effect.fn("TalkTo.verifyUpload")(function* (
  transfers: Transfers.TransferStore["Service"],
  serverId: M.ServerId,
  record: Transfers.TransferRecord,
) {
  const expected = [
    { key: Transfers.payloadKey(serverId, record.id), bytes: record.bytes },
    ...(record.manifestBytes === null
      ? []
      : [{ key: Transfers.manifestKey(serverId, record.id), bytes: record.manifestBytes }]),
  ];
  for (const object of expected) {
    const size = yield* transfers.size(object.key).pipe(Effect.mapError(filesFailure));
    if (size === object.bytes) continue;
    if (size !== null) yield* transfers.remove([object.key]).pipe(Effect.mapError(filesFailure));
    return yield* new E.TransferNotUploaded({
      message:
        size === null
          ? "The upload has not arrived. Run the upload procedure, then complete again."
          : "The upload does not match the declared size and was removed. Prepare again with the correct size.",
    });
  }
});
/** A completed offer, or the failure a fetch or status read reports for anything else. */
const deliveredTransfer = Effect.fn("TalkTo.deliveredTransfer")(function* (
  tx: Store.Session,
  id: M.TransferId,
) {
  const record = yield* tx.transfer(id);
  if (record === null || record.messageId === null) return yield* transferMissing();
  return { record, messageId: record.messageId };
});

/** Construct the shared service from its persistence and identity-generation ports. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const persistence = yield* Store.Persistence;
    // Captured here so every transaction checks agent ownership in the deployment's mode.
    const ownership = yield* Actors.AgentOwnership;
    const ids = yield* Identifiers;
    const meter = yield* Metering.Meter;
    const shareCost = yield* Metering.ShareCost;
    const store = yield* Files.FileStore;
    const transfers = yield* Transfers.TransferStore;
    const pool = yield* Pool.StoragePool;
    const signal = yield* Signal.UpdateSignal;
    const secrets = yield* Signals.SignalSecrets;
    const wakes = yield* WakeSchedule.WakeSchedule;
    const archive = yield* Archive.ArchiveStore;
    const wakeTargets = yield* WakeStore.WakeStore;
    const send = Metering.withCapacity(meter, Metering.singleUnit);
    // Wake waiting readers and due cloud agents only after the send has committed, and only for
    // a new message. Marking a wake due is one local statement; the outbound call runs later.
    const announce = (outcome: M.Outcome<M.Created<M.Message>>) => {
      if (!outcome.data.created) return Effect.void;
      const item = arrival(outcome);
      return signal.notify(item).pipe(Effect.andThen(wakes.notify(item)));
    };
    // Every reader receives renames whatever it watches, so a committed rename wakes every wait.
    const renamed = (outcome: M.Outcome<R.Result>) =>
      outcome.data.changed ? signal.notifyAll() : Effect.void;
    const run = <A, F>(
      access: AccessContext,
      operation: string,
      body: (tx: Store.Session) => Effect.Effect<A, F>,
    ) =>
      persistence
        .transaction(operation, (tx) =>
          Effect.gen(function* () {
            const serverId = yield* tx.serverIdentity();
            const grant = yield* tx.grant(access.grantId);
            if (
              serverId !== access.serverId ||
              grant === null ||
              grant.principalKey !== access.principalKey ||
              grant.revokedAt !== null
            ) {
              return yield* new E.ServerAccessDenied({ message: "The server is unavailable." });
            }
            if (!Actors.mayRun(access.principalKey, operation))
              return yield* new E.ServerAccessDenied({ message: Actors.invitedRefusal });
            return yield* body(tx);
          }),
        )
        .pipe(
          Effect.provideService(Actors.AgentOwnership, ownership),
          Effect.provideService(Actors.Operation, operation),
        );
    const pageMessages = Effect.fn("TalkTo.pageMessages")(function* (
      tx: Store.Session,
      state: Navigation.MessageCursor,
      limit: number,
      search: string | null,
    ) {
      const rows = yield* tx.messages({ ...state, search, limit: limit + 1 });
      const selected = Navigation.boundedMessages(rows, limit);
      const last = selected.at(-1);
      const nextCursor =
        rows.length > selected.length && last !== undefined
          ? Navigation.encodeCursor({ ...state, boundary: last.sequence })
          : null;
      const items =
        state.direction === "older" && state.kind === "history" ? selected.toReversed() : selected;
      const history = yield* historyReached(tx, state, nextCursor === null);
      const page: M.MessagePage =
        history === null ? { items, nextCursor } : { items, nextCursor, history };
      return yield* describeMessages(tx, page, items);
    });
    return Service.of({
      createSignal: Effect.fn("TalkTo.createSignal")(function* (access, input) {
        const id = S.SignalId.make(yield* ids.uuid());
        const secret = yield* secrets.mint(access.serverId, id);
        const secretHash = yield* secrets.hash(secret);
        const createdAt = yield* now;
        const expiresAt = secondsAfter(createdAt, input.ttlSeconds ?? S.defaultTtlSeconds);
        const selection: U.Selection = {
          channelIds: input.channelIds.toSorted(),
          directChats: input.directChats,
        };
        return yield* run(access, "createSignal", (tx) =>
          Effect.gen(function* () {
            yield* Actors.requireOwnAgent(tx, access, input.participantId);
            yield* Updates.checkSelection(tx, input.participantId, selection);
            const head = yield* tx.updatesHead();
            yield* tx.removeExpiredSignals(createdAt);
            yield* tx.putSignal({
              id,
              participantId: input.participantId,
              grantId: access.grantId,
              secretHash,
              selection,
              generation: head.generation,
              boundary: head.sequence,
              createdAt,
              expiresAt,
            });
            return empty<Signals.Minted>({ signalId: id, secret, expiresAt, selection });
          }),
        );
      }),
      revokeSignal: Effect.fn("TalkTo.revokeSignal")(function* (access, input) {
        return yield* run(access, "revokeSignal", (tx) =>
          Actors.requireOwnAgent(tx, access, input.participantId).pipe(
            Effect.andThen(tx.removeSignals(input.participantId, input.signalId ?? null)),
            Effect.map((revoked) => empty<S.Revoked>({ revoked })),
          ),
        );
      }),
      openSignal: Effect.fn("TalkTo.openSignal")(function* (serverId, id, secret) {
        const digest = yield* secrets.hash(secret);
        const at = yield* Clock.currentTimeMillis;
        return yield* persistence.transaction("openSignal", (tx) =>
          Effect.gen(function* () {
            const stored = yield* tx.signal(id);
            if (
              stored === null ||
              !Signals.sameDigest(stored.secretHash, digest) ||
              DateTime.toEpochMillis(DateTime.makeUnsafe(stored.expiresAt)) <= at ||
              (yield* tx.serverIdentity()) !== serverId
            )
              return yield* new Signals.SignalUnavailable();
            const grant = yield* tx.grant(stored.grantId);
            if (grant === null || grant.revokedAt !== null)
              return yield* new Signals.SignalUnavailable();
            return {
              access: { serverId, grantId: grant.id, principalKey: grant.principalKey },
              signal: stored,
            };
          }),
        );
      }),
      countSignal: Effect.fn("TalkTo.countSignal")(function* (opened, since, plugin = null) {
        const { signal: stored } = opened;
        const at = yield* now;
        return yield* run(opened.access, "countSignal", (tx) =>
          Effect.gen(function* () {
            // A restored history is a different lineage: the link ends, as checkpoints do.
            const head = yield* tx.updatesHead();
            if (head.generation !== stored.generation)
              return yield* new Signals.SignalUnavailable();
            // A link minted for another person's agent (possible before that was refused) ends.
            yield* Actors.requireOwnAgent(tx, opened.access, stored.participantId);
            yield* Updates.checkSelection(tx, stored.participantId, stored.selection);
            // `since` only moves forward from where the link started; an unknown ID is ignored.
            // A cursor names a message or, for task readers, a task event.
            const after =
              since === null
                ? null
                : ((yield* tx.message(since))?.sequence ?? (yield* tx.board.event(since))?.seq);
            const boundary = Math.max(stored.boundary, after ?? 0);
            const tally = yield* tx.signalTally({
              ...stored.selection,
              participantId: stored.participantId,
              boundary,
              limit: S.countLimit + 1,
            });
            const waking = yield* tx.signalWaking({
              ...stored.selection,
              participantId: stored.participantId,
              boundary,
              limit: S.countLimit,
            });
            const cadence = yield* tx.wakeCadence(stored.participantId);
            const latest = yield* PluginReports.note(tx, stored.participantId, plugin, at);
            const counts = S.Counts.make({
              pending: Math.min(tally.newest.length, S.countLimit),
              urgent: Math.min(tally.urgent, S.countLimit),
              waking,
              more: tally.newest.length > S.countLimit,
              cursor: tally.newest[0] ?? (boundary > stored.boundary ? since : null),
              expiresAt: stored.expiresAt,
              wakeCadence: cadence,
              wakeIntervalSeconds: M.wakeCadenceSeconds[cadence],
            });
            // Present only for a plugin this server knows, so older answers keep their shape.
            return latest === null
              ? counts
              : S.Counts.make({ ...counts, latestPluginVersion: latest });
          }),
        ).pipe(
          Effect.catchTags({
            ServerAccessDenied: () => Effect.fail(new Signals.SignalUnavailable()),
            ParticipantNotFound: () => Effect.fail(new Signals.SignalUnavailable()),
            NotAnAgent: () => Effect.fail(new Signals.SignalUnavailable()),
            AgentNotOwned: () => Effect.fail(new Signals.SignalUnavailable()),
            ParticipantRemoved: () => Effect.fail(new Signals.SignalUnavailable()),
            ConversationNotFound: () => Effect.fail(new Signals.SignalUnavailable()),
            WrongConversationKind: () => Effect.fail(new Signals.SignalUnavailable()),
          }),
        );
      }),
      getUpdates: Effect.fn("TalkTo.getUpdates")(function* (access, input) {
        // One read, always. A waiting call (waitSeconds) is held by the Worker that received it,
        // on a hibernatable watch (update-signal.ts), so this object never holds a request open
        // while it waits; the Worker calls again after a wake. Read accounting stays one read per
        // call: the Worker's reads after a wake are not admitted again (Reads.admit is upstream).
        const at = yield* now;
        // A plugin's report is recorded on each read that carries it (Plugins.note writes only on
        // a change or once a day), and the page then names the plugin's newest version.
        return yield* run(access, "getUpdates", (tx) =>
          Effect.gen(function* () {
            // Reading is open to everyone on the server (read_messages), but an agent's updates
            // stream acts as that agent: its waits, plugin report and read limit are its own.
            yield* Actors.requireOwnAgent(tx, access, input.participantId);
            const page = yield* Updates.read(tx, access.serverId, input);
            const latest = yield* PluginReports.note(
              tx,
              input.participantId,
              input.plugin ?? null,
              at,
            );
            return latest === null
              ? page
              : { ...page, data: { ...page.data, latestPluginVersion: latest } };
          }),
        );
      }),
      serverTimeline: Effect.fn("TalkTo.serverTimeline")(function* (access, input) {
        const at = yield* Clock.currentTimeMillis;
        return yield* run(access, "serverTimeline", (tx) =>
          Dashboard.timeline(tx, input, at).pipe(Effect.map(empty)),
        );
      }),
      serverTimelineSenders: Effect.fn("TalkTo.serverTimelineSenders")(function* (access, input) {
        return yield* run(access, "serverTimelineSenders", (tx) =>
          Dashboard.timelineSenders(tx, access.serverId, input).pipe(Effect.map(empty)),
        );
      }),
      serverSummary: Effect.fn("TalkTo.serverSummary")(function* (access) {
        const at = yield* Clock.currentTimeMillis;
        return yield* run(access, "serverSummary", (tx) =>
          Dashboard.summary(tx, at).pipe(Effect.map(empty)),
        );
      }),
      onboarding: Effect.fn("TalkTo.onboarding")(function* (access, names, agents, more, since) {
        return yield* run(access, "onboarding", (tx) =>
          Effect.gen(function* () {
            const server = yield* tx.server();
            const find = (agent: O.AgentLookups[number]) =>
              tx
                .participantRegistered(agent.requestKey)
                .pipe(
                  Effect.flatMap((participant) =>
                    participant === null && agent.legacyName !== null
                      ? tx.participantNamed(agent.legacyName)
                      : Effect.succeed(participant),
                  ),
                );
            const keyed = [
              yield* agents === undefined ? tx.participantNamed(names[0]) : find(agents[0]),
              yield* agents === undefined ? tx.participantNamed(names[1]) : find(agents[1]),
              ...(more === undefined ? [] : yield* Effect.forEach(more, find)),
            ];
            /*
              An agent often joins with a request key of its own: a Grok Bot or Muse asked to "join
              the server I choose" in the install step registers before it sees the join prompt,
              and the guide tells every agent to use a fresh key. The wizard then waited forever
              while that agent posted. Fill each empty slot, in order, with the next agent the
              person's own access registered since the run started that no slot holds yet.
            */
            const open = keyed.filter((agent) => agent === null).length;
            const arrivals =
              since === undefined || open === 0
                ? []
                : (yield* tx.agentsRegisteredBy(
                    access.principalKey,
                    since,
                    keyed.length + open,
                  )).filter((agent) => !keyed.some((held) => held?.id === agent.id));
            const slots = keyed.map((agent) => agent ?? arrivals.shift() ?? null);
            const [first = null, second = null, ...rest] = slots;
            if (more === undefined)
              return empty<O.ServerProgress>({ server, agents: [first, second] });
            return empty<O.ServerProgress>({ server, agents: [first, second], moreAgents: rest });
          }),
        );
      }),
      serverFeed: Effect.fn("TalkTo.serverFeed")(function* (access, input) {
        return yield* run(access, "serverFeed", (tx) =>
          Dashboard.feed(tx, access.serverId, input).pipe(
            Effect.flatMap((data) => describeMessages(tx, data, data.items)),
          ),
        );
      }),
      hydrateMessages: Effect.fn("TalkTo.hydrateMessages")(function* (access, ids) {
        return yield* run(access, "hydrateMessages", (tx) =>
          tx.messagesByIds(ids).pipe(Effect.flatMap((items) => describeMessages(tx, items, items))),
        );
      }),
      searchActivity: Effect.fn("TalkTo.searchActivity")(function* (access, input) {
        const search = yield* Navigation.searchExpression(input.query);
        return yield* run(access, "searchActivity", (tx) =>
          Effect.gen(function* () {
            const head = (yield* tx.latestMessage())?.sequence ?? 0;
            const older = input.direction === "older";
            const bound = input.bound;
            const time = bound?.kind === "time" ? bound : null;
            const rows = yield* tx.messages({
              conversationId: null,
              senderId: null,
              afterTime: time !== null && !older && !time.inclusive ? time.time : null,
              fromTime: time !== null && !older && time.inclusive ? time.time : null,
              beforeTime: time !== null && older && !time.inclusive ? time.time : null,
              throughTime: time !== null && older && time.inclusive ? time.time : null,
              boundary: bound?.kind === "sequence" ? bound.sequence : older ? head + 1 : 0,
              ceiling: head,
              direction: input.direction,
              search,
              limit: input.limit + 1,
            });
            const items = Navigation.boundedMessages(rows, input.limit, ActivitySearch.bodyBudget);
            return yield* describeMessages(
              tx,
              { items, more: rows.length > items.length, head },
              items,
            );
          }),
        );
      }),
      getServer: Effect.fn("TalkTo.getServer")(function* (access) {
        return yield* run(access, "getServer", (tx) => tx.server().pipe(Effect.map(empty)));
      }),
      registerParticipant: Effect.fn("TalkTo.registerParticipant")(
        function* (access, input, admission) {
          // An invited agent is exactly one agent: its key never registers another, so every
          // newcomer arrives by invite and a server's approval can't be skipped.
          if (Access.isInvited(access.principalKey) && admission === undefined)
            return yield* Actors.invitedRegistration();
          const id = M.ParticipantId.make(yield* ids.uuid());
          const noticeId = M.MessageId.make(yield* ids.uuid());
          const createdAt = yield* now;
          const result = yield* run(access, "registerParticipant", (tx) =>
            Effect.gen(function* () {
              const prior = yield* tx.registration(access.grantId, input.requestKey);
              if (prior !== null) {
                const p = prior.item;
                // After a rename, a retry of the original registration still names the original
                // name; it recovers the same participant under its current name.
                const registered = (yield* tx.registeredName(p.id)) ?? p.name;
                if (
                  registered !== input.name ||
                  p.agentType !== input.agentType ||
                  p.workingDirectory !== (input.workingDirectory ?? null) ||
                  p.joinedNote !== (input.joinedNote ?? null)
                )
                  return yield* conflict();
                // A removed agent retrying its registration learns why it cannot continue.
                if (p.removedAt !== undefined) return yield* Actors.removed(p);
                return {
                  outcome: yield* registration(tx, { item: p, created: false }),
                  notice: null,
                };
              }
              const holder = yield* tx.participantNamed(input.name);
              if (holder !== null)
                return yield* new E.NameTaken({
                  message:
                    holder.removedAt === undefined
                      ? "A participant with that name already exists."
                      : "An agent a person removed from this server keeps that name. Choose another name, or ask a person to rename or restore that agent on the TalkTo dashboard.",
                });
              const item = M.Participant.make({
                id,
                name: input.name,
                agentType: input.agentType,
                workingDirectory: input.workingDirectory ?? null,
                joinedNote: input.joinedNote ?? null,
                createdAt,
                messageCount: 0,
                lastMessageAt: null,
              });
              yield* tx.addParticipant({
                item,
                grantId: access.grantId,
                requestKey: input.requestKey,
              });
              const notice =
                admission === undefined
                  ? null
                  : yield* joinNotice(tx, access, item, admission, noticeId);
              return { outcome: yield* registration(tx, { item, created: true }), notice };
            }),
          );
          // General's readers see the newcomer once its admission has committed. A join wakes no
          // one (a wake is for what needs the agent), so only waiting reads are told.
          if (result.notice !== null) yield* signal.notify(arrival(result.notice));
          return result.outcome;
        },
      ),
      renameSelf: Effect.fn("TalkTo.renameSelf")(function* (access, participantId, input) {
        const id = R.RenameId.make(yield* ids.uuid());
        const at = yield* now;
        return yield* run(access, "renameSelf", (tx) =>
          Effect.gen(function* () {
            // Only agents registered through this caller's own person's access. The connection
            // cannot say which of that person's agents is calling, so this is the whole check.
            const target = yield* Actors.requireAgent(tx, participantId);
            if ((yield* tx.registeredBy(target.id)) !== access.principalKey)
              return yield* new E.RenameNotAllowed({
                message:
                  "An agent can rename only an agent registered through its own person's access. Ask the person who connected that agent, or rename it on the TalkTo dashboard.",
              });
            return yield* renameParticipant(
              tx,
              access,
              { ...input, participantId },
              { kind: "self" },
              id,
              at,
            );
          }),
        ).pipe(Effect.tap(renamed));
      }),
      renameAgent: Effect.fn("TalkTo.renameAgent")(function* (access, profile, input) {
        const id = R.RenameId.make(yield* ids.uuid());
        const personId = M.ParticipantId.make(yield* ids.uuid());
        const at = yield* now;
        return yield* run(access, "renameAgent", (tx) =>
          Effect.gen(function* () {
            // Refuse a person before creating the caller's participant for nothing.
            yield* Actors.requireAgentRecord(tx, input.agentId);
            const person =
              (yield* tx.person(access.principalKey)) ??
              (yield* addPerson(tx, access, profile, personId, at));
            return yield* renameParticipant(
              tx,
              access,
              { participantId: input.agentId, name: input.name, requestKey: input.requestKey },
              { kind: "person", participantId: person.id },
              id,
              at,
            );
          }),
        ).pipe(Effect.tap(renamed));
      }),
      setAgentRemoved: Effect.fn("TalkTo.setAgentRemoved")(
        function* (access, profile, agentId, action) {
          const personId = M.ParticipantId.make(yield* ids.uuid());
          const at = yield* now;
          const board = BoardDomain.outbox();
          const result = yield* run(access, "setAgentRemoved", (tx) =>
            Effect.gen(function* () {
              // Refuse a person before creating the caller's participant for nothing.
              const target = yield* Actors.requireAgentRecord(tx, agentId);
              if ((target.removedAt !== undefined) === (action === "removed"))
                return empty<Removals.Result>({ participant: target, changed: false });
              const person =
                (yield* tx.person(access.principalKey)) ??
                (yield* addPerson(tx, access, profile, personId, at));
              yield* tx.setRemoved({ participantId: target.id, action, byId: person.id, at });
              if (action === "removed") {
                // Its links and wakes end now; restoring does not bring them back. So do its
                // claims, assignments and interest on the board (the change wakes every wait).
                yield* tx.removeSignals(target.id, null);
                yield* wakeTargets.remove(target.id, null);
                yield* BoardDomain.removeAgent(
                  tx,
                  board,
                  ids,
                  target.id,
                  person.id,
                  BoardModel.millis(at),
                );
              }
              const current = yield* participant(tx, target.id);
              return empty<Removals.Result>({ participant: current, changed: true });
            }),
          );
          // A waiting get_updates for the removed agent reads again and ends with its refusal; so
          // does every other wait, which covers the board's events (the agent told about a released
          // task among them). Wakes and the alarm still need the board's outbox.
          if (result.data.changed) yield* signal.notifyAll();
          if (board.wakes.size > 0) yield* wakes.notifyParticipants([...board.wakes]);
          if (board.armAt !== null) yield* wakes.arm(board.armAt);
          return result;
        },
      ),
      listRemovals: Effect.fn("TalkTo.listRemovals")(function* (access, input) {
        return yield* run(access, "listRemovals", (tx) =>
          tx
            .recentRemovals(input.limit ?? 25)
            .pipe(Effect.map((items) => empty<Removals.List>({ items }))),
        );
      }),
      listRenames: Effect.fn("TalkTo.listRenames")(function* (access, input) {
        return yield* run(access, "listRenames", (tx) =>
          Effect.gen(function* () {
            const participantId = input.participantId ?? null;
            if (participantId !== null) yield* participant(tx, participantId);
            const items = yield* tx.recentRenames(participantId, input.limit ?? 25);
            return empty<R.List>({ items });
          }),
        );
      }),
      getParticipant: Effect.fn("TalkTo.getParticipant")(function* (access, id) {
        return yield* run(access, "getParticipant", (tx) =>
          participant(tx, id).pipe(Effect.map(empty)),
        );
      }),
      listParticipants: Effect.fn("TalkTo.listParticipants")(function* (
        access,
        input,
        website = false,
      ) {
        return yield* run(access, "listParticipants", (tx) =>
          Effect.gen(function* () {
            let query = "query" in input ? input.query : undefined;
            let name: M.Name | null = "name" in input ? (input.name ?? null) : null;
            let state: I.ParticipantState | undefined = "state" in input ? input.state : undefined;
            let after: M.Name | null = null;
            if ("cursor" in input) {
              const cursor = yield* Navigation.parseCursor(
                Navigation.DirectoryCursor,
                input.cursor,
              );
              if (cursor.kind !== "participants" || cursor.serverId !== access.serverId)
                return yield* invalidCursor();
              name = cursor.name;
              query = cursor.query;
              state = cursor.state;
              after = cursor.after;
            }
            // An exact name lookup finds a removed agent too, so it can learn that it was removed.
            const selected = state ?? (name === null ? "active" : "all");
            const limit = input.limit ?? 25;
            const rows = yield* tx.participants(name, after, limit + 1, query, selected);
            const page = rows.slice(0, limit);
            const items = website ? yield* withRegistrants(tx, page) : page;
            const last = items.at(-1);
            const nextCursor =
              rows.length > limit && last !== undefined
                ? Navigation.encodeCursor({
                    ...scope(access.serverId),
                    kind: "participants",
                    name,
                    query: query ?? "",
                    state: selected,
                    after: last.name,
                  })
                : null;
            return empty({ items, nextCursor });
          }),
        );
      }),
      createChannel: Effect.fn("TalkTo.createChannel")(function* (access, input) {
        const id = M.ConversationId.make(yield* ids.uuid());
        const noticeId = M.MessageId.make(yield* ids.uuid());
        const createdAt = yield* now;
        const result = yield* run(access, "createChannel", (tx) =>
          Effect.gen(function* () {
            const prior = yield* tx.channelCreation(access.grantId, input.requestKey);
            if (prior !== null) {
              const item = prior.item;
              if (
                item.name !== input.name ||
                item.description !== (input.description ?? null) ||
                item.createdByParticipantId !== input.participantId
              )
                return yield* conflict();
              const replay = yield* describe(tx, { item, created: false }, [item], [], false);
              return { outcome: replay, notice: null };
            }
            const creator = yield* Actors.requireOwnAgent(tx, access, input.participantId);
            if ((yield* tx.channelNamed(input.name)) !== null)
              return yield* new E.NameTaken({
                message: "A channel with that name already exists, including archived channels.",
              });
            const item = M.Channel.make({
              kind: "channel",
              id,
              name: input.name,
              description: input.description ?? null,
              isGeneral: false,
              createdByParticipantId: input.participantId,
              createdAt,
              archivedAt: null,
              revision: 0,
              messageCount: 0,
              lastMessageAt: null,
              latestMessage: null,
            });
            yield* tx.addChannel({ item, grantId: access.grantId, requestKey: input.requestKey });
            const notice = yield* channelNotice(tx, access, item, creator, noticeId);
            const outcome = yield* describe(tx, { item, created: true }, [item], [], false);
            return { outcome, notice };
          }),
        );
        // General's watchers hear about the channel once the creation has committed.
        if (result.notice !== null) yield* announce(result.notice);
        return result.outcome;
      }),
      listChannels: Effect.fn("TalkTo.listChannels")(function* (access, input) {
        return yield* run(access, "listChannels", (tx) =>
          Effect.gen(function* () {
            let query = "query" in input ? input.query : undefined;
            let state = "state" in input ? (input.state ?? "active") : ("active" as const);
            let after: M.Name | null = null;
            if ("cursor" in input) {
              const cursor = yield* Navigation.parseCursor(
                Navigation.DirectoryCursor,
                input.cursor,
              );
              if (cursor.kind !== "channels" || cursor.serverId !== access.serverId)
                return yield* invalidCursor();
              state = cursor.state;
              query = cursor.query;
              after = cursor.after;
            }
            const limit = input.limit ?? 25;
            const rows = yield* tx.channels(state, after, limit + 1, query);
            const items = rows.slice(0, limit);
            const last = items.at(-1);
            const nextCursor =
              rows.length > limit && last !== undefined
                ? Navigation.encodeCursor({
                    ...scope(access.serverId),
                    kind: "channels",
                    state,
                    query: query ?? "",
                    after: last.name,
                  })
                : null;
            return yield* describe(tx, { items, nextCursor }, items, [], false);
          }),
        );
      }),
      getConversation: Effect.fn("TalkTo.getConversation")(function* (access, id) {
        return yield* run(access, "getConversation", (tx) =>
          Effect.gen(function* () {
            const item = yield* conversation(tx, id);
            return yield* describe(tx, item, [item], [], false);
          }),
        );
      }),
      setChannelArchived: Effect.fn("TalkTo.setChannelArchived")(function* (access, id, input) {
        const at = yield* now;
        return yield* run(access, "setChannelArchived", (tx) =>
          Effect.gen(function* () {
            yield* Actors.requireOwnAgent(tx, access, input.participantId);
            const item = yield* conversation(tx, id);
            if (item.kind !== "channel")
              return yield* new E.WrongConversationKind({
                message: "Only channels can be archived or reopened.",
              });
            if (item.isGeneral && input.archived)
              return yield* new E.ProtectedGeneral({ message: "General always remains active." });
            if (input.archived) yield* BoardDomain.refuseArchive(tx, item.id);
            if (item.revision !== input.expectedRevision)
              return yield* new E.RevisionConflict({
                message: "Read the channel's current revision before retrying this change.",
              });
            if ((item.archivedAt !== null) === input.archived)
              return yield* describe(tx, item, [item], [], false);
            const archivedAt = input.archived ? (at < item.createdAt ? item.createdAt : at) : null;
            const updated = M.Channel.make({ ...item, archivedAt, revision: item.revision + 1 });
            yield* tx.archive(id, archivedAt, updated.revision);
            return yield* describe(tx, updated, [updated], [], false);
          }),
        );
      }),
      openDirectConversation: Effect.fn("TalkTo.openDirectConversation")(function* (access, input) {
        const id = M.ConversationId.make(yield* ids.uuid());
        const createdAt = yield* now;
        return yield* run(access, "openDirectConversation", (tx) =>
          Effect.gen(function* () {
            const result = yield* direct(tx, access, input, id, createdAt);
            return yield* describe(tx, result, [result.item], [], false);
          }),
        );
      }),
      listDirectConversations: Effect.fn("TalkTo.listDirectConversations")(
        function* (access, input) {
          return yield* run(access, "listDirectConversations", (tx) =>
            Effect.gen(function* () {
              let withParticipantId =
                "withParticipantId" in input ? (input.withParticipantId ?? null) : null;
              let after: M.ConversationId | null = null;
              if ("cursor" in input) {
                const cursor = yield* Navigation.parseCursor(
                  Navigation.DirectoryCursor,
                  input.cursor,
                );
                if (cursor.kind !== "directs" || cursor.serverId !== access.serverId)
                  return yield* invalidCursor();
                withParticipantId = cursor.withParticipantId;
                after = cursor.after;
              }
              if (withParticipantId !== null) yield* participant(tx, withParticipantId);
              const limit = input.limit ?? 25;
              const rows = yield* tx.directs(withParticipantId, after, limit + 1);
              const items = rows.slice(0, limit);
              const last = items.at(-1);
              const nextCursor =
                rows.length > limit && last !== undefined
                  ? Navigation.encodeCursor({
                      ...scope(access.serverId),
                      kind: "directs",
                      withParticipantId,
                      after: last.id,
                    })
                  : null;
              return yield* describe(tx, { items, nextCursor }, items, [], false);
            }),
          );
        },
      ),
      sendMessage: Effect.fn("TalkTo.sendMessage")(function* (access, id, input) {
        const messageId = M.MessageId.make(yield* ids.uuid());
        const at = yield* now;
        return yield* send(
          run(access, "sendMessage", (tx) =>
            Effect.gen(function* () {
              return yield* append(tx, access, id, input, messageId, at, meter).pipe(
                // Only send_message asks for confirmation, so nothing here is refused for it.
                Effect.catchTag("InvalidInput", (error) => Effect.die(error)),
              );
            }),
          ),
        ).pipe(Effect.tap(announce));
      }),
      sendTo: Effect.fn("TalkTo.sendTo")(function* (access, input) {
        const messageId = M.MessageId.make(yield* ids.uuid());
        const directId = M.ConversationId.make(yield* ids.uuid());
        const at = yield* now;
        return yield* send(
          run(access, "sendTo", (tx) =>
            Effect.gen(function* () {
              const target = input.target;
              const id =
                target.kind === "conversation"
                  ? target.conversationId
                  : (yield* direct(
                      tx,
                      access,
                      { participantId: input.participantId, recipientId: target.recipientId },
                      directId,
                      at,
                    )).item.id;
              return yield* append(
                tx,
                access,
                id,
                input,
                messageId,
                at,
                meter,
                plainMessage,
                "agent",
                input.confirm === true,
              );
            }),
          ),
        ).pipe(Effect.tap(announce));
      }),
      confirmMessage: Effect.fn("TalkTo.confirmMessage")(function* (access, input) {
        const noticeId = M.MessageId.make(yield* ids.uuid());
        const at = yield* now;
        const result = yield* run(access, "confirmMessage", (tx) =>
          Effect.gen(function* () {
            // The confirmation names the confirming agent, so it must be the caller's own.
            const confirmer = yield* Actors.requireOwnAgent(tx, access, input.participantId);
            const item = yield* message(tx, input.messageId);
            if (item.confirm === undefined || !item.confirm.asked.includes(confirmer.id))
              return yield* new E.Forbidden({
                message: "This message did not ask you to confirm it.",
              });
            // A repeat answers with the message as it is: no second time, no second notice.
            if (item.confirm.confirmed.some((entry) => entry.participantId === confirmer.id))
              return { outcome: yield* describeMessages(tx, item, [item]), notice: null };
            const target = yield* tx.conversation(item.conversationId);
            if (target === null)
              return yield* Effect.die("A stored message's conversation is missing");
            if (target.kind === "channel" && target.archivedAt !== null)
              return yield* new E.ChannelArchived({
                message: "Reopen the channel before confirming its messages.",
              });
            const notice = yield* confirmNotice(tx, access, item, target, confirmer, noticeId, at);
            // Recorded at the notice's time.
            yield* tx.markConfirmed(item, confirmer.id, notice.data.item.createdAt);
            const current = yield* tx.message(item.id);
            if (current === null) return yield* Effect.die("Confirmed message is missing");
            return { outcome: yield* describeMessages(tx, current, [current]), notice };
          }),
        );
        // The sender hears once the confirmation has committed, as for any message from that agent.
        if (result.notice !== null) yield* announce(result.notice);
        return result.outcome;
      }),
      getPersonSelf: Effect.fn("TalkTo.getPersonSelf")(function* (access) {
        return yield* run(access, "getPersonSelf", (tx) =>
          tx
            .person(access.principalKey)
            .pipe(Effect.map((participant) => empty({ participant, postsInChannels: true }))),
        );
      }),
      joinAsPerson: Effect.fn("TalkTo.joinAsPerson")(function* (access, profile) {
        const personId = M.ParticipantId.make(yield* ids.uuid());
        const at = yield* now;
        return yield* run(access, "joinAsPerson", (tx) =>
          Effect.gen(function* () {
            const prior = yield* tx.person(access.principalKey);
            if (prior !== null) return empty({ item: prior, created: false });
            const item = yield* addPerson(tx, access, profile, personId, at);
            return empty({ item, created: true });
          }),
        );
      }),
      openPersonDirectChat: Effect.fn("TalkTo.openPersonDirectChat")(
        function* (access, profile, input) {
          const personId = M.ParticipantId.make(yield* ids.uuid());
          const id = M.ConversationId.make(yield* ids.uuid());
          const at = yield* now;
          return yield* run(access, "openPersonDirectChat", (tx) =>
            Effect.gen(function* () {
              const person =
                (yield* tx.person(access.principalKey)) ??
                (yield* addPerson(tx, access, profile, personId, at));
              const prior = yield* tx.personRequest(person.id, input.requestKey);
              if (prior !== null) {
                if (prior.agentId !== input.agentId) return yield* conflict();
                const item = yield* tx.conversation(prior.conversationId);
                if (item?.kind !== "direct")
                  return yield* Effect.die("A person's request lost its direct chat");
                return yield* describe(tx, { item, created: prior.created }, [item], [], false);
              }
              const agent = yield* participant(tx, input.agentId);
              if (agent.kind === "person")
                return yield* new E.NotAnAgent({
                  message:
                    "A person's direct chat is with an agent. Choose an agent's participant ID.",
                });
              if (agent.removedAt !== undefined) return yield* Actors.removedForPerson(agent);
              const result = yield* pairDirect(tx, access, person.id, agent.id, id, at);
              yield* tx.addPersonRequest(person.id, input.requestKey, {
                agentId: agent.id,
                conversationId: result.item.id,
                created: result.created,
              });
              return yield* describe(tx, result, [result.item], [], false);
            }),
          );
        },
      ),
      sendPersonMessage: Effect.fn("TalkTo.sendPersonMessage")(function* (access, input) {
        const messageId = M.MessageId.make(yield* ids.uuid());
        const at = yield* now;
        return yield* run(access, "sendPersonMessage", (tx) =>
          Effect.gen(function* () {
            const person = yield* tx.person(access.principalKey);
            const target = yield* conversation(tx, input.conversationId);
            if (target.kind === "channel") {
              // Every channel on a server is readable by everyone with access to it, so access
              // to the server is access to post. The person must already have a participant.
              if (person === null)
                return yield* new E.NotConversationParticipant({
                  message:
                    "Join this server as yourself first (POST /v1/servers/:serverId/people/me), then send.",
                });
            } else {
              if (person === null || !target.participantIds.includes(person.id))
                return yield* new E.NotConversationParticipant({
                  message:
                    "Only the two participants can send into this direct chat. Open your own chat with the agent first.",
                });
              const [first, second] = target.participantIds;
              const other = yield* participant(tx, first === person.id ? second : first);
              if (other.kind === "person")
                return yield* new E.NotAnAgent({
                  message: "A person's direct chat is with an agent.",
                });
              if (other.removedAt !== undefined) return yield* Actors.removedForPerson(other);
            }
            // The sender is always the caller's own person participant.
            const { conversationId: _target, ...content } = input;
            const message: I.SendMessage = { ...content, participantId: person.id };
            // Replays never count toward the limits; append answers them unchanged.
            if ((yield* tx.messageCreation(access.grantId, input.requestKey)) === null)
              yield* withinPersonLimits(tx, person.id, at);
            return yield* append(
              tx,
              access,
              target.id,
              message,
              messageId,
              at,
              Metering.unmetered,
              plainMessage,
              "person",
            ).pipe(
              // A person's send is never metered, never acts as an agent and never asks for
              // confirmation; an archived channel refuses it as it refuses agents.
              Effect.catchTag(["CapacityRequired", "AgentNotOwned", "InvalidInput"], (error) =>
                Effect.die(error),
              ),
            );
          }),
        ).pipe(Effect.tap(announce));
      }),
      readMessages: Effect.fn("TalkTo.readMessages")(function* (access, id, input) {
        return yield* run(access, "readMessages", (tx) =>
          Effect.gen(function* () {
            yield* conversation(tx, id);
            const latest = yield* tx.latestMessage();
            const ceiling = latest?.sequence ?? 0;
            let state: Navigation.MessageCursor = {
              ...scope(access.serverId),
              kind: "history",
              conversationId: id,
              senderId: null,
              afterTime: null,
              beforeTime: null,
              boundary: ceiling + 1,
              ceiling,
              direction: "older",
              query: null,
            };
            const position = input.position;
            if (position?.kind === "cursor") {
              state = yield* Navigation.parseCursor(Navigation.MessageCursor, position.cursor);
              if (
                state.kind !== "history" ||
                state.serverId !== access.serverId ||
                state.conversationId !== id ||
                state.senderId !== null ||
                state.query !== null ||
                state.ceiling > ceiling ||
                state.boundary > state.ceiling
              )
                return yield* invalidCursor();
            } else if (position?.kind === "beforeMessage" || position?.kind === "afterMessage") {
              const anchor = yield* message(tx, position.messageId);
              if (anchor.conversationId !== id)
                return yield* new E.MessageNotFound({
                  message: "The anchor message does not belong to this conversation.",
                });
              state = {
                ...state,
                boundary: anchor.sequence,
                direction: position.kind === "beforeMessage" ? "older" : "newer",
              };
            } else if (position?.kind === "beforeTime") {
              state = { ...state, beforeTime: position.time };
            } else if (position?.kind === "afterTime") {
              state = { ...state, afterTime: position.time, boundary: 0, direction: "newer" };
            }
            return yield* pageMessages(tx, state, input.limit ?? 25, null);
          }),
        );
      }),
      searchMessages: Effect.fn("TalkTo.searchMessages")(function* (access, input) {
        return yield* run(access, "searchMessages", (tx) =>
          Effect.gen(function* () {
            const latest = yield* tx.latestMessage();
            const ceiling = latest?.sequence ?? 0;
            let state: Navigation.MessageCursor;
            if ("cursor" in input) {
              state = yield* Navigation.parseCursor(Navigation.MessageCursor, input.cursor);
              if (
                state.kind !== "search" ||
                state.serverId !== access.serverId ||
                state.query === null ||
                state.direction !== "older" ||
                state.ceiling > ceiling ||
                state.boundary > state.ceiling
              )
                return yield* invalidCursor();
            } else {
              state = {
                ...scope(access.serverId),
                kind: "search",
                conversationId: input.conversationId ?? null,
                senderId: input.senderId ?? null,
                afterTime: input.afterTime ?? null,
                beforeTime: input.beforeTime ?? null,
                boundary: ceiling + 1,
                ceiling,
                direction: "older",
                query: input.query,
              };
            }
            if (state.conversationId !== null) yield* conversation(tx, state.conversationId);
            if (state.senderId !== null) yield* participant(tx, state.senderId);
            if (
              state.afterTime !== null &&
              state.beforeTime !== null &&
              state.afterTime >= state.beforeTime
            )
              return yield* new E.InvalidSearch({ message: "afterTime must precede beforeTime." });
            const search = yield* Navigation.searchExpression(state.query ?? "");
            return yield* pageMessages(tx, state, input.limit ?? 25, search);
          }),
        );
      }),
      getMessageContext: Effect.fn("TalkTo.getMessageContext")(function* (access, id, input) {
        return yield* run(access, "getMessageContext", (tx) =>
          Effect.gen(function* () {
            const anchor = yield* message(tx, id);
            const latest = yield* tx.latestMessage();
            const base = {
              conversationId: anchor.conversationId,
              senderId: null,
              afterTime: null,
              beforeTime: null,
              boundary: anchor.sequence,
              ceiling: latest?.sequence ?? anchor.sequence,
              search: null,
            };
            const beforeLimit = input.before ?? 10;
            const afterLimit = input.after ?? 10;
            const older = yield* tx.messages({
              ...base,
              direction: "older",
              limit: beforeLimit + 1,
            });
            const newer = yield* tx.messages({
              ...base,
              direction: "newer",
              limit: afterLimit + 1,
            });
            const before: M.Message[] = [];
            const after: M.Message[] = [];
            let budget = 65536 - new TextEncoder().encode(anchor.body).length;
            let olderOpen = true;
            let newerOpen = true;
            for (let index = 0; index < Math.max(beforeLimit, afterLimit); index++) {
              for (const side of ["before", "after"] as const) {
                const candidate = side === "before" ? older[index] : newer[index];
                const open =
                  side === "before"
                    ? olderOpen && index < beforeLimit
                    : newerOpen && index < afterLimit;
                if (!open || candidate === undefined) continue;
                const size = new TextEncoder().encode(candidate.body).length;
                if (size > budget) {
                  if (side === "before") olderOpen = false;
                  else newerOpen = false;
                  continue;
                }
                budget -= size;
                (side === "before" ? before : after).push(candidate);
              }
            }
            const hasMoreBefore = older.length > before.length;
            const history = yield* historyReached(
              tx,
              { direction: "older", afterTime: null, boundary: anchor.sequence },
              !hasMoreBefore,
            );
            const context: M.MessageContext = {
              anchor,
              before: before.toReversed(),
              after,
              hasMoreBefore,
              hasMoreAfter: newer.length > after.length,
            };
            const data: M.MessageContext = history === null ? context : { ...context, history };
            return yield* describeMessages(tx, data, [anchor, ...before, ...after]);
          }),
        );
      }),
      filesAccess: Effect.fn("TalkTo.filesAccess")(function* (access, input) {
        // The store's network calls stay outside the synchronous transactions: authorize first,
        // then ensure and mint, then record inside the ledger. The store is the authority on the
        // remote: ensuring on every access follows a relocated local repository, and the recorded
        // row is rewritten whenever it drifts. The row goes along as a hint so a store whose
        // remote is fixed can skip its provider; a row that no longer parses reads as null and
        // is re-ensured and rewritten here.
        const known = yield* run(access, "filesAccess", (tx) =>
          Actors.requireOwnAgent(tx, access, input.participantId).pipe(
            Effect.andThen(tx.fileRepository()),
          ),
        );
        const repository = yield* store
          .ensure(access.serverId, known)
          .pipe(Effect.mapError(filesFailure));
        const ttl = Files.TtlSeconds.make(input.ttlSeconds ?? 3600);
        const credential = yield* store
          .mint(access.serverId, input.scope, ttl)
          .pipe(Effect.mapError(filesFailure));
        const id = yield* ids.uuid();
        const issuedAt = yield* now;
        const recorded = yield* run(access, "filesAccess.record", (tx) =>
          Effect.gen(function* () {
            yield* Actors.requireOwnAgent(tx, access, input.participantId);
            yield* tx.setFileRepository(repository, issuedAt);
            yield* tx.addFileToken({
              id,
              tokenId: credential.id,
              participantId: input.participantId,
              grantId: access.grantId,
              scope: input.scope,
              issuedAt,
              expiresAt: credential.expiresAt,
              revokedAt: null,
            });
          }),
        ).pipe(Effect.result);
        if (Result.isFailure(recorded)) {
          // A token the ledger cannot follow must not outlive this request; revocation is best effort.
          yield* store.revoke(access.serverId, credential.id).pipe(Effect.ignore);
          return yield* recorded.failure;
        }
        return empty<Agent.FilesAccess>({
          remote: repository.remote,
          token: credential.token,
          expiresAt: credential.expiresAt,
          defaultBranch: repository.defaultBranch,
          procedure: procedure(repository, input.scope, credential.token),
        });
      }),
      shareFile: Effect.fn("TalkTo.shareFile")(function* (access, input) {
        const messageId = M.MessageId.make(yield* ids.uuid());
        const directId = M.ConversationId.make(yield* ids.uuid());
        const at = yield* now;
        const units = shareCost.units();
        const reference = { path: input.path, commit: input.commit, ref: input.ref ?? mainRef };
        const spend: Spend = {
          units,
          kind: "share",
          share: input.bytes === undefined ? reference : { ...reference, bytes: input.bytes },
          transferId: null,
        };
        return yield* Metering.withCapacity(
          meter,
          units,
        )(
          run(access, "shareFile", (tx) =>
            Effect.gen(function* () {
              const target = input.target;
              const id =
                target.kind === "conversation"
                  ? target.conversationId
                  : (yield* direct(
                      tx,
                      access,
                      { participantId: input.participantId, recipientId: target.recipientId },
                      directId,
                      at,
                    )).item.id;
              return yield* append(tx, access, id, input, messageId, at, meter, spend).pipe(
                // Only send_message asks for confirmation, so nothing here is refused for it.
                Effect.catchTag("InvalidInput", (error) => Effect.die(error)),
              );
            }),
          ),
        ).pipe(Effect.tap(announce));
      }),
      getPackCommand: Effect.fn("TalkTo.getPackCommand")(function* (access) {
        yield* run(access, "getPackCommand", () => Effect.void);
        return empty<Agent.PackCommand>({ command: TransferProcedure.packCommand() });
      }),
      prepareTransfer: Effect.fn("TalkTo.prepareTransfer")(function* (access, input) {
        const newId = M.TransferId.make(yield* ids.uuid());
        const at = yield* now;
        const uploadExpiresAt = secondsAfter(at, Transfers.linkSeconds);
        const fileCount = input.kind === "folder" ? input.fileCount : null;
        const manifestBytes = input.kind === "folder" ? input.manifestBytes : null;
        const record = yield* run(access, "prepareTransfer", (tx) =>
          Effect.gen(function* () {
            yield* Actors.requireOwnAgent(tx, access, input.participantId);
            const prior = yield* tx.transferCreation(access.grantId, input.requestKey);
            if (prior !== null) {
              if (
                prior.senderId !== input.participantId ||
                prior.name !== input.name ||
                prior.kind !== input.kind ||
                prior.bytes !== input.bytes ||
                prior.sha256 !== input.sha256 ||
                prior.fileCount !== fileCount ||
                prior.manifestBytes !== manifestBytes
              )
                return yield* conflict();
              // Past its expiry the pool no longer counts it, so a late upload would be stored
              // outside the organization's allowance and could never be offered.
              if (at > prior.expiresAt)
                return yield* new E.TransferExpired({
                  message: "This transfer has expired. Prepare it again with a new requestKey.",
                });
              yield* tx.renewTransferUpload(prior.id, uploadExpiresAt);
              return prior;
            }
            const created: Transfers.TransferRecord = {
              id: newId,
              senderId: input.participantId,
              grantId: access.grantId,
              requestKey: input.requestKey,
              name: input.name,
              kind: input.kind,
              bytes: input.bytes,
              sha256: input.sha256,
              fileCount,
              manifestBytes,
              createdAt: at,
              uploadExpiresAt,
              expiresAt: secondsAfter(at, Transfers.retentionSeconds),
              messageId: null,
              poolState: "pending",
            };
            yield* tx.addTransfer(created);
            return created;
          }),
        );
        // The row is durable before the pool is asked, so a lost answer is resumed by retrying the
        // same requestKey, which asks again for the same transfer and is never counted twice.
        if (record.poolState === "pending") {
          yield* pool
            .reserve({
              id: record.id,
              bytes: record.bytes + (record.manifestBytes ?? 0),
              expiresAt: record.expiresAt,
            })
            .pipe(
              Effect.catchTag("StoragePoolFull", (full) =>
                run(access, "prepareTransfer.refused", (tx) =>
                  tx.forgetPendingTransfer(record.id),
                ).pipe(Effect.andThen(Effect.fail(full))),
              ),
            );
          yield* run(access, "prepareTransfer.pooled", (tx) => tx.confirmTransferPool(record.id));
        }
        const uploadUrl = yield* transfers
          .uploadUrl(Transfers.payloadKey(access.serverId, record.id), record.bytes)
          .pipe(Effect.mapError(filesFailure));
        const manifestUploadUrl =
          record.manifestBytes === null
            ? null
            : yield* transfers
                .uploadUrl(Transfers.manifestKey(access.serverId, record.id), record.manifestBytes)
                .pipe(Effect.mapError(filesFailure));
        return empty<Agent.TransferUpload>({
          transferId: record.id,
          uploadUrl,
          manifestUploadUrl,
          uploadExpiresAt,
          expiresAt: record.expiresAt,
          procedure: TransferProcedure.upload(record.kind, uploadUrl, manifestUploadUrl),
        });
      }),
      completeTransfer: Effect.fn("TalkTo.completeTransfer")(function* (access, input) {
        const messageId = M.MessageId.make(yield* ids.uuid());
        const directId = M.ConversationId.make(yield* ids.uuid());
        const at = yield* now;
        const units = shareCost.units();
        const owned = (tx: Store.Session) =>
          Effect.gen(function* () {
            yield* Actors.requireOwnAgent(tx, access, input.participantId);
            const record = yield* tx.transfer(input.transferId);
            // A pending row never received an upload link, so there is nothing to offer yet.
            if (
              record === null ||
              record.senderId !== input.participantId ||
              record.poolState !== "reserved"
            )
              return yield* transferMissing();
            return record;
          });
        const record = yield* run(access, "completeTransfer.read", owned);
        // The store is checked between transactions; an upload at the wrong size is removed so
        // the sender can upload again, because each link writes its object only once.
        if (record.messageId === null) {
          if (at > record.expiresAt) return yield* transferExpired();
          yield* verifyUpload(transfers, access.serverId, record);
        }
        return yield* Metering.withCapacity(
          meter,
          units,
        )(
          run(access, "completeTransfer", (tx) =>
            Effect.gen(function* () {
              const current = yield* owned(tx);
              if (current.messageId !== null) {
                const item = yield* tx.message(current.messageId);
                if (item === null) return yield* Effect.die("Delivered transfer has no message");
                if (item.body !== input.body) return yield* conflict();
                return yield* describeMessages(tx, { item, created: false }, [item]);
              }
              const target = input.target;
              const id =
                target.kind === "conversation"
                  ? target.conversationId
                  : (yield* direct(
                      tx,
                      access,
                      { participantId: input.participantId, recipientId: target.recipientId },
                      directId,
                      at,
                    )).item.id;
              return yield* append(tx, access, id, input, messageId, at, meter, {
                units,
                kind: "share",
                share: null,
                transferId: current.id,
              }).pipe(
                // Only send_message asks for confirmation, so nothing here is refused for it.
                Effect.catchTag("InvalidInput", (error) => Effect.die(error)),
              );
            }),
          ),
        );
      }),
      fetchTransfer: Effect.fn("TalkTo.fetchTransfer")(function* (access, input) {
        const at = yield* now;
        const { record } = yield* run(access, "fetchTransfer.read", (tx) =>
          Effect.gen(function* () {
            // The receipt names the fetching agent, so it must be the caller's own.
            yield* Actors.requireOwnAgent(tx, access, input.participantId);
            return yield* deliveredTransfer(tx, input.transferId);
          }),
        );
        if (at > record.expiresAt) return yield* transferExpired();
        const url = yield* transfers
          .downloadUrl(Transfers.payloadKey(access.serverId, record.id))
          .pipe(Effect.mapError(filesFailure));
        // Recorded after signing, so a failed signature leaves no false receipt.
        yield* run(access, "fetchTransfer.record", (tx) =>
          tx.addTransferFetch(record.id, input.participantId, at),
        );
        const transfer = transferOffer(record);
        return empty<Agent.TransferDownload>({
          transfer,
          url,
          urlExpiresAt: secondsAfter(at, Transfers.linkSeconds),
          procedure: TransferProcedure.download(transfer, url),
        });
      }),
      readTransfer: Effect.fn("TalkTo.readTransfer")(function* (access, input) {
        const at = yield* now;
        const { record, messageId, fetches } = yield* run(access, "readTransfer", (tx) =>
          Effect.gen(function* () {
            const delivered = yield* deliveredTransfer(tx, input.transferId);
            return { ...delivered, fetches: yield* tx.transferFetches(input.transferId) };
          }),
        );
        const expired = at > record.expiresAt;
        const fileListUrl =
          record.kind === "folder" && !expired
            ? yield* transfers
                .downloadUrl(Transfers.manifestKey(access.serverId, record.id))
                .pipe(Effect.mapError(filesFailure))
            : null;
        return empty<Agent.TransferStatus>({
          transfer: transferOffer(record),
          senderId: record.senderId,
          messageId,
          state: expired ? "expired" : "ready",
          fetches,
          fileListUrl,
        });
      }),
      listTransfers: Effect.fn("TalkTo.listTransfers")(function* (access, input) {
        const at = yield* now;
        return yield* run(access, "listTransfers", (tx) =>
          Effect.gen(function* () {
            let before: Transfers.TransferPosition | null = null;
            if ("cursor" in input) {
              const state = yield* Navigation.parseCursor(Navigation.TransferCursor, input.cursor);
              if (state.serverId !== access.serverId) return yield* invalidCursor();
              before = { expiresAt: state.expiresAt, id: state.id };
            }
            const limit = input.limit ?? 25;
            const rows = yield* tx.transfers(before, limit + 1);
            const entries = rows.slice(0, limit);
            const last = entries.at(-1);
            const nextCursor =
              rows.length > limit && last !== undefined
                ? Navigation.encodeCursor({
                    ...scope(access.serverId),
                    kind: "transfers",
                    expiresAt: last.expiresAt,
                    id: last.id,
                  })
                : null;
            const items = entries.map((entry): D.ServerTransfer => ({
              ...entry,
              state:
                entry.messageId === null
                  ? "incomplete"
                  : at > entry.expiresAt
                    ? "expired"
                    : "available",
            }));
            const conversations = yield* tx.conversationsByIds([
              ...new Set(items.flatMap((item) => item.conversationId ?? [])),
            ]);
            return yield* describe(
              tx,
              { items, nextCursor },
              conversations,
              items.map((item) => item.senderId),
              true,
            );
          }),
        );
      }),
      downloadTransfer: Effect.fn("TalkTo.downloadTransfer")(function* (access, id) {
        const at = yield* now;
        const { record } = yield* run(access, "downloadTransfer", (tx) =>
          deliveredTransfer(tx, id),
        );
        if (at > record.expiresAt) return yield* transferExpired();
        const fileName = Transfers.downloadName(record);
        const url = yield* transfers
          .downloadUrl(Transfers.payloadKey(access.serverId, record.id), {
            fileName,
            seconds: Transfers.personLinkSeconds,
          })
          .pipe(Effect.mapError(filesFailure));
        return empty<D.TransferDownload>({
          url,
          urlExpiresAt: secondsAfter(at, Transfers.personLinkSeconds),
          fileName,
        });
      }),
      listShares: Effect.fn("TalkTo.listShares")(function* (access, input) {
        return yield* run(access, "listShares", (tx) =>
          Effect.gen(function* () {
            const latest = yield* tx.latestMessage();
            const ceiling = latest?.sequence ?? 0;
            let state: Navigation.MessageCursor = {
              ...scope(access.serverId),
              kind: "shares",
              conversationId: null,
              senderId: null,
              afterTime: null,
              beforeTime: null,
              boundary: ceiling + 1,
              ceiling,
              direction: "older",
              query: null,
            };
            if ("cursor" in input) {
              state = yield* Navigation.parseCursor(Navigation.MessageCursor, input.cursor);
              if (
                state.kind !== "shares" ||
                state.serverId !== access.serverId ||
                state.direction !== "older" ||
                state.ceiling > ceiling ||
                state.boundary > state.ceiling
              )
                return yield* invalidCursor();
            }
            const limit = input.limit ?? 25;
            const rows = yield* tx.shares(state.boundary, limit + 1);
            const items = Navigation.boundedMessages(rows, limit);
            const last = items.at(-1);
            const nextCursor =
              rows.length > items.length && last !== undefined
                ? Navigation.encodeCursor({ ...state, boundary: last.sequence })
                : null;
            return yield* describeMessages(tx, { items, nextCursor }, items);
          }),
        );
      }),
      readArchive: Effect.fn("TalkTo.readArchive")(function* (access, input) {
        // Authorize under the current grant before touching the archive.
        yield* run(access, "readArchive.authorize", (tx) => tx.serverIdentity());
        const serverId = access.serverId;
        const prefix = Archive.serverPrefix(serverId);
        let key: string | null = null;
        let after = 0;
        if (input.cursor !== undefined) {
          const cursor = yield* Navigation.parseCursor(Navigation.ArchiveCursor, input.cursor);
          if (cursor.serverId !== serverId || Archive.chunkRange(serverId, cursor.key) === null)
            return yield* invalidCursor();
          key = cursor.key;
          after = cursor.after;
        }
        const limit = input.limit ?? 25;
        const following = (from: string | null) =>
          archive.list(prefix, from, 1).pipe(Effect.map((keys) => keys[0] ?? null));
        const page = yield* Effect.gen(function* () {
          let current = key ?? (yield* following(null));
          // The object a cursor names may be finished; then the page comes from the next one.
          for (let step = 0; step < 2 && current !== null; step++) {
            const text = (yield* archive.read(current)) ?? "";
            const lines = text.split("\n").filter((line) => line !== "");
            const messages = (yield* Effect.forEach(lines, (line) => decodeArchived(line))).filter(
              (message) => message.sequence > after,
            );
            if (messages.length === 0) {
              current = yield* following(current);
              after = 0;
              continue;
            }
            const items = Navigation.boundedMessages(messages, limit);
            const last = items.at(-1);
            if (last === undefined) return { items, nextCursor: null };
            const resume =
              items.length < messages.length
                ? { key: current, after: last.sequence }
                : yield* following(current).pipe(
                    Effect.map((next) => (next === null ? null : { key: next, after: 0 })),
                  );
            return {
              items,
              nextCursor:
                resume === null
                  ? null
                  : Navigation.encodeCursor({
                      ...scope(serverId),
                      kind: "archive",
                      key: resume.key,
                      after: resume.after,
                    }),
            };
          }
          return { items: [], nextCursor: null };
        }).pipe(
          Effect.catchTag("ArchiveUnavailable", (error) =>
            error.operation === "absent"
              ? Effect.succeed({ items: [], nextCursor: null })
              : Effect.fail(
                  new E.StorageUnavailable({
                    operation: `archive.${error.operation}`,
                    message:
                      "The history archive is temporarily unavailable. Retry the same request.",
                  }),
                ),
          ),
        );
        return yield* run(access, "readArchive", (tx) => describeMessages(tx, page, page.items));
      }),
    });
  }),
);
/** One archived line back into the message it was written from. */
const decodeArchived = (line: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(M.Message))(line).pipe(
    Effect.mapError(
      () =>
        new E.StorageUnavailable({
          operation: "archive.decode",
          message: "The history archive holds an unreadable entry.",
        }),
    ),
  );
