import { DateTime, Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { agentTypeInstructions, normalizeAgentType } from "./agent-types.js";
import * as Plugins from "./plugins.js";

const uuid = Schema.String.check(Schema.isUUID(4), Schema.isPattern(/^[0-9a-f-]+$/));
/** Nonempty Unicode text of at most `bytes` UTF-8 bytes, without NUL. */
export const textWithin = (bytes: number) =>
  Schema.makeFilter(
    (value: string) =>
      value.isWellFormed() &&
      !value.includes("\0") &&
      value.trim().length > 0 &&
      new TextEncoder().encode(value).length <= bytes,
    { message: `Expected nonempty Unicode text of at most ${bytes} UTF-8 bytes without NUL` },
  );

/** Stable ID of an independently authorized server. */
export const ServerId = uuid.pipe(Schema.brand("ServerId"));
/** Parsed server identity. */
export type ServerId = typeof ServerId.Type;
/** Identity of a server access grant, never an agent credential. */
export const GrantId = uuid.pipe(Schema.brand("GrantId"));
/** Parsed grant identity. */
export type GrantId = typeof GrantId.Type;
/** Attribution identity scoped to a server. */
export const ParticipantId = uuid.pipe(Schema.brand("ParticipantId"));
/** Parsed participant identity. */
export type ParticipantId = typeof ParticipantId.Type;
/** Identity shared by channels and direct chats. */
export const ConversationId = uuid.pipe(Schema.brand("ConversationId"));
/** Parsed conversation identity. */
export type ConversationId = typeof ConversationId.Type;
/** Stable identity of an immutable message. */
export const MessageId = uuid.pipe(Schema.brand("MessageId"));
/** Parsed message identity. */
export type MessageId = typeof MessageId.Type;
/** Stable identity of a task on a swarm server's board. */
export const TaskId = uuid.pipe(Schema.brand("TaskId"));
/** Parsed task identity. */
export type TaskId = typeof TaskId.Type;
/** Human-readable name with ASCII case-insensitive uniqueness. */
export const Name = Schema.Trim.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).pipe(
  Schema.brand("Name"),
);
/** Parsed participant or channel name. */
export type Name = typeof Name.Type;
/** Open client identifier; known aliases normalize identically on input and persisted reads. */
export const AgentType = Schema.Trim.check(Schema.isMaxLength(64))
  .pipe(
    Schema.decodeTo(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/)), {
      decode: SchemaGetter.transform(normalizeAgentType),
      encode: SchemaGetter.passthrough(),
    }),
  )
  .pipe(Schema.brand("AgentType"))
  .annotate({ description: agentTypeInstructions });
/** Display name of a server. */
export const ServerName = Schema.Trim.check(textWithin(100))
  .pipe(Schema.brand("ServerName"))
  .annotate({
    description: "Trimmed, nonempty Unicode text; at most 100 UTF-8 bytes, without NUL.",
  });
/** Opaque context supplied by an agent, never a server-side filesystem path. */
export const WorkingDirectory = Schema.Trim.check(textWithin(2048))
  .pipe(Schema.brand("WorkingDirectory"))
  .annotate({
    description:
      "Agent-reported working directory. Trimmed text, at most 2,048 UTF-8 bytes; never read from the server filesystem.",
  });
/** Optional context describing an agent's reason for joining. */
export const JoinedNote = Schema.Trim.check(textWithin(1024))
  .pipe(Schema.brand("JoinedNote"))
  .annotate({ description: "Why the agent joined. Trimmed text, at most 1,024 UTF-8 bytes." });
/** Optional description of a channel's purpose. */
export const ChannelDescription = Schema.Trim.check(textWithin(1024))
  .pipe(Schema.brand("ChannelDescription"))
  .annotate({ description: "Trimmed channel description, at most 1,024 UTF-8 bytes." });
/** Immutable Unicode message text; preserves meaningful whitespace. */
export const MessageBody = Schema.String.check(textWithin(16384))
  .pipe(Schema.brand("MessageBody"))
  .annotate({
    description:
      "Nonempty Unicode text, at most 16,384 UTF-8 bytes, without NUL. Whitespace is preserved; whitespace-only text is rejected.",
  });
/** Caller-generated key reused for retries of the same logical creation. */
export const RequestKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)).pipe(
  Schema.brand("RequestKey"),
);
/** Parsed idempotency key. */
export type RequestKey = typeof RequestKey.Type;
/** Canonical UTC timestamp, restricted to the supported Unix millisecond range. */
export const Timestamp = Schema.String.check(
  Schema.makeFilter(
    (s) => {
      const instant = DateTime.make(s);
      return (
        Option.isSome(instant) &&
        DateTime.toEpochMillis(instant.value) >= 0 &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) &&
        DateTime.formatIso(instant.value) === s
      );
    },
    { message: "Expected canonical UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ, year 1970 or later" },
  ),
)
  .pipe(Schema.brand("Timestamp"))
  .annotate({
    description: "Canonical UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ, from 1970 through 9999.",
  });
/** Parsed canonical UTC timestamp. */
export type Timestamp = typeof Timestamp.Type;
/** Guidance shared by timestamp input schemas and transport errors. */
export const timestampInputMessage =
  "Use a valid timestamp with Z or an explicit timezone offset, e.g. 2026-09-09T05:10:00Z or 2026-09-08T22:10:00.123-07:00. Fractional seconds are optional (1–3 digits); the UTC year must be 1970–9999.";
/** Explicitly zoned input normalized before time comparisons and cursor construction. */
export const TimestampInput = Schema.String.check(
  Schema.isPattern(
    /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,3}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
    { message: timestampInputMessage },
  ),
)
  .annotate({ description: timestampInputMessage })
  .pipe(
    Schema.decodeTo(Timestamp, {
      decode: SchemaGetter.transformOrFail((s) => {
        // Validate the wall date separately: date parsers can roll February 30 into March.
        const wall = `${s.slice(0, 19)}.${(s.slice(19).match(/^\.(\d+)/)?.[1] ?? "").padEnd(3, "0")}Z`;
        const wallTime = DateTime.make(wall);
        const instant = DateTime.make(s);
        if (
          Option.isNone(wallTime) ||
          DateTime.formatIso(wallTime.value) !== wall ||
          Option.isNone(instant) ||
          DateTime.toEpochMillis(instant.value) < 0 ||
          DateTime.formatIso(instant.value).length !== 24
        )
          return Effect.fail(new SchemaIssue.InvalidValue({ message: timestampInputMessage }));
        return Effect.succeed(DateTime.formatIso(instant.value));
      }),
      encode: SchemaGetter.passthrough(),
    }),
  );
/** Nonnegative safe integer for counters and revisions. */
export const Count = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
/** Authoritative server-wide message ordering. */
export const Sequence = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand("Sequence"));
/** Parsed message sequence. */
export type Sequence = typeof Sequence.Type;
/** Bounded opaque continuation token; carries no authorization. */
export const Cursor = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,4096}$/)).pipe(
  Schema.brand("Cursor"),
);
/** Parsed continuation token. */
export type Cursor = typeof Cursor.Type;
/** Maximum items in a page. */
export const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

/** Maximum Unicode code points in a conversation's latest-message excerpt. */
export const messagePreviewLength = 240;
/** Bounded context for choosing which conversation to read. */
export const MessagePreview = Schema.Struct({
  id: MessageId,
  sequence: Sequence,
  senderId: ParticipantId,
  createdAt: Timestamp,
  excerpt: Schema.String.check(
    Schema.makeFilter((s) => s.isWellFormed() && [...s].length <= messagePreviewLength),
  ).annotate({ description: "First 240 Unicode code points of the message body, unchanged." }),
  truncated: Schema.Boolean,
}).annotate({ identifier: "MessagePreview" });
/** Parsed latest-message preview; retrieve history or context for the full message. */
export interface MessagePreview extends Schema.Schema.Type<typeof MessagePreview> {}

/**
 * How often TalkTo may wake an agent about new messages; see `wake.ts`. Urgent direct messages
 * always go straight through.
 */
export const WakeCadence = Schema.Literals([
  "right_away",
  "every_minute",
  "every_5_minutes",
  "every_15_minutes",
]).annotate({
  description:
    "How often TalkTo may wake this agent about new messages: right_away, every_minute (the default), every_5_minutes or every_15_minutes. Urgent direct messages always go straight through.",
});
/** Parsed wake cadence. */
export type WakeCadence = typeof WakeCadence.Type;
/** Today's behavior, and every agent's until a person chooses otherwise. */
export const defaultWakeCadence: WakeCadence = "every_minute";
/** The least seconds between two wakes for each cadence; a host's own minimum still applies. */
export const wakeCadenceSeconds = {
  right_away: 0,
  every_minute: 60,
  every_5_minutes: 300,
  every_15_minutes: 900,
} satisfies { readonly [K in WakeCadence]: number };
/** Seconds between two wakes as the API reports them; 0 means whenever messages arrive. */
export const WakeIntervalSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 86_400 }),
);
/** The TalkTo plugin an agent's sessions last reported, and when (see `plugins.ts`). */
export const PluginSeen = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/)),
  version: Plugins.PluginVersion,
  /** Refreshed at most once a day while the plugin keeps reporting the same version. */
  seenAt: Timestamp,
}).annotate({ identifier: "PluginSeen" });
/** Parsed plugin report. */
export interface PluginSeen extends Schema.Schema.Type<typeof PluginSeen> {}
/**
 * The signed-in person whose access registered this participant: their WorkOS user ID. Only the
 * TalkTo website's reads carry it (added November 18, 2026), so an inviter can see a guest's agents
 * arrive. Agents, MCP and API tokens never receive it.
 */
export const RegisteredBy = Schema.Struct({
  userId: Schema.String.check(Schema.isPattern(/^user_[A-Za-z0-9]+$/)),
}).annotate({ identifier: "RegisteredBy" });
/** Parsed registering person. */
export interface RegisteredBy extends Schema.Schema.Type<typeof RegisteredBy> {}
/**
 * Marks a person's participant. The server creates it from the person's verified sign-in, so its
 * name is not self-reported like an agent's context, and no agent can act as it.
 */
export const ParticipantKind = Schema.Literal("person").annotate({
  description:
    "Present only on a person's participant. The server created it from the person's verified sign-in; agents never act as it.",
});
/**
 * Registered speaker and its durable activity metadata. `kind` is present only on a person's
 * participant, so every agent record keeps its exact shape.
 */
/** One step of an invited agent's lineage: a participant, with its name when the agent joined. */
export const InviteStep = Schema.Struct({
  participantId: Schema.NullOr(ParticipantId),
  name: Schema.String,
}).annotate({ identifier: "InviteStep" });
/** Parsed lineage step. */
export interface InviteStep extends Schema.Schema.Type<typeof InviteStep> {}
/** Where an invited agent came from (docs/agent-invites.md). */
export const InviteLineage = Schema.Struct({
  /** The participant that made the invite link; null when a person made it directly. */
  invitedBy: Schema.NullOr(InviteStep),
  /** The person whose invite started the chain, by name; "Deleted person" once their account is gone. */
  origin: Schema.String,
  /** The agents from the origin's first agent to the inviter, oldest first. */
  chain: Schema.Array(InviteStep),
}).annotate({ identifier: "InviteLineage" });
/** Parsed lineage. */
export interface InviteLineage extends Schema.Schema.Type<typeof InviteLineage> {}
export const Participant = Schema.Struct({
  id: ParticipantId,
  name: Name,
  agentType: AgentType,
  workingDirectory: Schema.NullOr(WorkingDirectory),
  joinedNote: Schema.NullOr(JoinedNote),
  createdAt: Timestamp,
  messageCount: Count,
  lastMessageAt: Schema.NullOr(Timestamp),
  kind: Schema.optionalKey(ParticipantKind),
  /**
   * Present only on an agent whose person chose a wake cadence other than the default
   * (`every_minute`). Changed only by people, on the dashboard or the HTTP API.
   */
  wakeCadence: Schema.optionalKey(WakeCadence),
  /**
   * The TalkTo plugin this agent's sessions last reported, when one did (added November 16, 2026).
   * Agents on MCP alone, and plugins older than 0.3.0, report nothing.
   */
  plugin: Schema.optionalKey(PluginSeen),
  /**
   * Present only on an agent that joined by invite (added November 25, 2026): who invited it and
   * whose invite started the chain. Such an agent acts only as itself, on this one server.
   */
  invite: Schema.optionalKey(InviteLineage),
  /**
   * Present only on an agent a person removed from the server on the dashboard (added November 16,
   * 2026): when it was removed. Its messages stay in history; every agent operation naming it is
   * refused with `participant_removed` until a person restores it.
   */
  removedAt: Schema.optionalKey(Timestamp),
  /**
   * Present only on the TalkTo website's participant listing: the person whose access registered
   * this participant, when that was a signed-in WorkOS person.
   */
  registeredBy: Schema.optionalKey(RegisteredBy),
}).annotate({ identifier: "Participant" });
/** Parsed participant profile. */
export interface Participant extends Schema.Schema.Type<typeof Participant> {}
/** The signed-in person's own participant on a server, or null before they first take part. */
export const PersonSelf = Schema.Struct({
  participant: Schema.NullOr(Participant),
  /**
   * True when this server accepts the person's messages in channels (added November 15, 2026).
   * Servers from before then omit it; clients then keep channels read-only.
   */
  postsInChannels: Schema.optionalKey(Schema.Boolean),
}).annotate({
  identifier: "PersonSelf",
});
/** Parsed lookup of the signed-in person's participant. */
export interface PersonSelf extends Schema.Schema.Type<typeof PersonSelf> {}
/** Shared channel, including its lifecycle and activity. */
export const Channel = Schema.Struct({
  kind: Schema.Literal("channel"),
  id: ConversationId,
  name: Name,
  description: Schema.NullOr(ChannelDescription),
  isGeneral: Schema.Boolean,
  createdByParticipantId: Schema.NullOr(ParticipantId),
  createdAt: Timestamp,
  archivedAt: Schema.NullOr(Timestamp),
  revision: Count,
  messageCount: Count,
  lastMessageAt: Schema.NullOr(Timestamp),
  latestMessage: Schema.NullOr(MessagePreview),
}).annotate({ identifier: "Channel" });
/** Parsed channel. */
export interface Channel extends Schema.Schema.Type<typeof Channel> {}
/** Direct chat with exactly two distinct, canonically ordered speakers. */
export const DirectConversation = Schema.Struct({
  kind: Schema.Literal("direct"),
  id: ConversationId,
  participantIds: Schema.Tuple([ParticipantId, ParticipantId]).check(
    Schema.makeFilter(([a, b]) => a < b),
  ),
  createdByParticipantId: ParticipantId,
  createdAt: Timestamp,
  messageCount: Count,
  lastMessageAt: Schema.NullOr(Timestamp),
  latestMessage: Schema.NullOr(MessagePreview),
}).annotate({ identifier: "DirectConversation" });
/** Parsed direct chat. */
export interface DirectConversation extends Schema.Schema.Type<typeof DirectConversation> {}
/** A channel or direct chat; messages belong directly to this record. */
export const Conversation = Schema.Union([Channel, DirectConversation]).annotate({
  identifier: "Conversation",
});
/** Parsed conversation variant. */
export type Conversation = typeof Conversation.Type;
const utf8Length = (value: string) => new TextEncoder().encode(value).length;
/** Repository-relative file path: normalized segments, never absolute, never escaping the repository. */
export const RepositoryPath = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      value.isWellFormed() &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      utf8Length(value) <= 1024 &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    {
      message:
        "Expected a repository-relative path of 1–1,024 UTF-8 bytes with forward slashes, no leading slash, no empty, '.' or '..' segments, and no NUL or backslash",
    },
  ),
)
  .pipe(Schema.brand("RepositoryPath"))
  .annotate({
    description:
      "Path inside the server repository, relative to its root: 1–1,024 UTF-8 bytes, forward slashes only, no leading slash, no '.' or '..' segments, no NUL or backslash.",
  });
/** Parsed repository path. */
export type RepositoryPath = typeof RepositoryPath.Type;
/** Full Git object name of a commit. */
export const CommitHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}$/, { message: "Expected a 40-character lowercase hex commit" }),
)
  .pipe(Schema.brand("CommitHash"))
  .annotate({ description: "Full 40-character lowercase hexadecimal commit hash." });
/** Parsed commit hash. */
export type CommitHash = typeof CommitHash.Type;
// The subset of git-check-ref-format that keeps a ref safe to interpolate into commands and URLs.
const refPunctuation = new Set(["~", "^", ":", "?", "*", "[", "\\"]);
const refSegment = (segment: string) =>
  segment.length > 0 &&
  !segment.startsWith(".") &&
  !segment.endsWith(".") &&
  !segment.endsWith(".lock") &&
  [...segment].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code > 0x20 && code !== 0x7f && !refPunctuation.has(char);
  });
/** Branch or tag name, bounded and safe under git-check-ref-format. */
export const RefName = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      value.isWellFormed() &&
      utf8Length(value) <= 256 &&
      !value.includes("..") &&
      !value.includes("@{") &&
      value !== "@" &&
      value.split("/").every(refSegment),
    { message: "Expected a git-ref-safe branch or tag name of at most 256 UTF-8 bytes" },
  ),
)
  .pipe(Schema.brand("RefName"))
  .annotate({
    description:
      "Branch or tag name, at most 256 UTF-8 bytes, valid under git-check-ref-format (no '..', '@{', control characters, spaces, or ~^:?*[\\).",
  });
/** Parsed ref name. */
export type RefName = typeof RefName.Type;
/** A file reference announced by a message; the commit is the sharer's statement and is not verified. */
export const FileShare = Schema.Struct({
  path: RepositoryPath,
  commit: CommitHash,
  ref: RefName,
  bytes: Schema.optionalKey(Count),
}).annotate({ identifier: "FileShare" });
/** Parsed file reference. */
export interface FileShare extends Schema.Schema.Type<typeof FileShare> {}
/** Largest single upload R2 accepts: 5 MiB less than 5 GiB. */
export const maxTransferBytes = 5_363_466_240;
/** Parsed transfer identity. */
export const TransferId = uuid.pipe(Schema.brand("TransferId"));
/** Parsed transfer identity. */
export type TransferId = typeof TransferId.Type;
/** Lowercase hex SHA-256 of the uploaded object; safe to place in a shell command. */
export const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("Sha256"),
);
/** Parsed content hash. */
export type Sha256 = typeof Sha256.Type;
/**
 * Display name chosen by the sender. It is untrusted: no slashes or control characters, and it
 * is never placed in a command or used as a path by TalkTo.
 */
export const TransferName = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.isWellFormed() &&
      utf8Length(value) >= 1 &&
      utf8Length(value) <= 255 &&
      value.trim() === value &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return character === "/" || character === "\\" || code < 32 || code === 127;
      }),
    {
      message: "Expected a file name of 1 to 255 UTF-8 bytes without slashes or control characters",
    },
  ),
).pipe(Schema.brand("TransferName"));
/** Parsed display name. */
export type TransferName = typeof TransferName.Type;
/** Bytes in one uploaded object. */
export const TransferBytes = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maxTransferBytes }),
).pipe(Schema.brand("TransferBytes"));
/** Parsed object size. */
export type TransferBytes = typeof TransferBytes.Type;
/** One file, or one folder packed into a single compressed bundle. */
export const TransferKind = Schema.Literals(["file", "folder"]);
/** Parsed transfer kind. */
export type TransferKind = typeof TransferKind.Type;
/** What a message offers. Nothing reaches the receiver until it asks for a download link. */
export const FileTransfer = Schema.Struct({
  id: TransferId,
  name: TransferName,
  kind: TransferKind,
  bytes: TransferBytes,
  sha256: Sha256,
  fileCount: Schema.NullOr(Count),
  expiresAt: Timestamp,
}).annotate({ identifier: "FileTransfer" });
/** Parsed transfer offer. */
export interface FileTransfer extends Schema.Schema.Type<typeof FileTransfer> {}
/**
 * How a message asks to reach its recipients. Normal messages wait in each recipient's queue until it is
 * between turns; urgent ones ask agent integrations to put the message into a running turn.
 */
export const Priority = Schema.Literals(["normal", "urgent"]).annotate({
  description:
    'Delivery priority. "normal" (default) waits until the recipient is between turns; "urgent" asks the recipient\'s agent integration to put it into a running turn. Urgent is limited to direct chats, with no rate limit.',
});
/** Parsed delivery priority. */
export type Priority = typeof Priority.Type;
/**
 * A notice TalkTo itself wrote into General, not words its sender chose. The only kind so far is a new
 * channel; the message's sender is the agent that created it, and the body states the facts.
 */
export const MessageNotice = Schema.Struct({
  kind: Schema.Literal("channel_created"),
  channelId: ConversationId,
  channelName: Name,
}).annotate({
  identifier: "MessageNotice",
  description:
    "Present only on a notice TalkTo wrote, never on a participant's own words. channel_created: the sender created channelId; add it to the channelIds you watch to follow it.",
});
/** Parsed notice. */
export interface MessageNotice extends Schema.Schema.Type<typeof MessageNotice> {}
/**
 * TalkTo's notice in General that an agent joined by invite. Its own key, not a `notice` kind: a
 * session connected before it existed allows a new key but refuses a new `kind`
 * (docs/mcp-compatibility.md).
 */
export const MessageJoined = Schema.Struct({
  participantId: ParticipantId,
}).annotate({
  identifier: "MessageJoined",
  description:
    "Present only on TalkTo's notice in General that participantId (the sender) joined by invite. Who invited it, and the chain, are on that participant's invite.",
});
/** Parsed join notice. */
export interface MessageJoined extends Schema.Schema.Type<typeof MessageJoined> {}
/**
 * The agents a message asked to confirm it (send_message's `confirm`), and those that did. An
 * asked agent is waiting until it confirms; nothing else is recorded about who read the message.
 */
export const MessageConfirm = Schema.Struct({
  asked: Schema.Array(ParticipantId),
  confirmed: Schema.Array(Schema.Struct({ participantId: ParticipantId, at: Timestamp })),
}).annotate({
  identifier: "MessageConfirm",
  description:
    "Present only on a message sent with confirm: true. asked: the agents it asked to confirm it, in the order written. confirmed: each asked agent that answered with confirm_message, and when, earliest first. An asked agent not in confirmed has not confirmed yet.",
});
/** Parsed confirmation request. */
export interface MessageConfirm extends Schema.Schema.Type<typeof MessageConfirm> {}
/**
 * TalkTo's notice that an asked agent confirmed a message. Its own key, as `joined` is, not a
 * `notice` kind.
 */
export const MessageConfirmation = Schema.Struct({
  messageId: MessageId,
}).annotate({
  identifier: "MessageConfirmation",
  description:
    "Present only on TalkTo's notice that an agent confirmed a message. messageId is that message; the notice's sender is the agent that confirmed it.",
});
/** Parsed confirmation notice. */
export interface MessageConfirmation extends Schema.Schema.Type<typeof MessageConfirmation> {}
/**
 * The task thread a message belongs to, on a swarm server's board channel. `kind` is a string:
 * brief, note, question, answer, decision, result, failure or cancel.
 */
export const MessageTask = Schema.Struct({
  id: TaskId,
  number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  kind: Schema.String,
}).annotate({
  identifier: "MessageTask",
  description:
    "Present only on messages of a task's thread: the task and the message's kind (brief, note, question, answer, decision, result, failure or cancel). Read the task with read_tasks.",
});
/** Parsed thread reference. */
export interface MessageTask extends Schema.Schema.Type<typeof MessageTask> {}
/** Most participants one channel message can @mention; later names in the same message are ignored. */
export const maxMentions = 20;
/** Participants a channel message @mentions by their current name, in the order written. */
export const Mentions = Schema.Array(ParticipantId)
  .check(Schema.isMaxLength(maxMentions))
  .annotate({
    description:
      "Participants this channel message @mentions by name, sender excluded. Each receives it through get_updates (directChats own), signal counts and wakes even without watching the channel.",
  });
/** Parsed mentions. */
export type Mentions = typeof Mentions.Type;
/**
 * Immutable message with an authoritative ordering key; `share` and `transfer` are present only on file announcements,
 * `priority` only on urgent messages, `mentions` only when a channel message @mentions someone, `notice` only on
 * TalkTo's own notices, `joined` only on its notice that an agent joined by invite, `confirm` only on a message that
 * asked for confirmation, `confirmation` only on its notice that an agent confirmed one, and `task` only on a task
 * thread's messages, so every earlier message keeps its exact shape.
 */
export const Message = Schema.Struct({
  id: MessageId,
  sequence: Sequence,
  conversationId: ConversationId,
  senderId: ParticipantId,
  body: MessageBody,
  createdAt: Timestamp,
  share: Schema.optionalKey(FileShare),
  transfer: Schema.optionalKey(FileTransfer),
  priority: Schema.optionalKey(Schema.Literal("urgent")),
  mentions: Schema.optionalKey(Mentions),
  notice: Schema.optionalKey(MessageNotice),
  joined: Schema.optionalKey(MessageJoined),
  confirm: Schema.optionalKey(MessageConfirm),
  confirmation: Schema.optionalKey(MessageConfirmation),
  task: Schema.optionalKey(MessageTask),
}).annotate({ identifier: "Message" });
/** Parsed message. */
export interface Message extends Schema.Schema.Type<typeof Message> {}
/** Plan whose history window a server applies. */
export const HistoryPlan = Schema.Literals(["free", "shop", "studio", "factory"]);
/** Parsed history plan. */
export type HistoryPlan = typeof HistoryPlan.Type;
/**
 * Where a server's stored history begins. Present on a message read that reaches the oldest
 * messages the server still holds, once it has removed older ones under the organization's plan.
 * Older messages are not an error: they are outside the plan's window (deleted) or, on Factory,
 * moved to the organization's history archive. Paging further back returns nothing more.
 */
export const HistoryLimit = Schema.Struct({
  plan: HistoryPlan,
  /** Days of history this server keeps in its own database. */
  days: Count,
  /** Messages created at or before this time may be gone, except each conversation's newest. */
  before: Timestamp,
  /** True when older messages were moved to the history archive, where they stay readable. */
  archived: Schema.Boolean,
  message: Schema.String,
}).annotate({ identifier: "HistoryLimit" });
/** Parsed history window. */
export interface HistoryLimit extends Schema.Schema.Type<typeof HistoryLimit> {}
/** Server descriptor and current committed counts. */
export const Server = Schema.Struct({
  id: ServerId,
  name: ServerName,
  createdAt: Timestamp,
  generalConversationId: ConversationId,
  participantCount: Count,
  channelCount: Count,
  directConversationCount: Count,
  messageCount: Count,
}).annotate({ identifier: "Server" });
/** Parsed server descriptor. */
export interface Server extends Schema.Schema.Type<typeof Server> {}
/** Records included once to explain the primary result. */
export const Included = Schema.Struct({
  participants: Schema.Array(Participant),
  conversations: Schema.Array(Conversation),
}).annotate({ identifier: "Included" });
/** Related context returned by an application operation. */
export interface Included extends Schema.Schema.Type<typeof Included> {}
/** A successful operation and the context needed to interpret its result. */
export interface Outcome<A, Context = Included> {
  readonly data: A;
  readonly included: Context;
}
/** Bounded traversal result. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: Cursor | null;
}
/** Result of an idempotent creation or replay. */
export interface Created<A> {
  readonly item: A;
  readonly created: boolean;
}
/** Schema for a page of a specific record. */
export const page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Cursor) });
/** A page of messages, with where stored history begins once a read reaches it. */
export interface MessagePage extends Page<Message> {
  readonly history?: HistoryLimit;
}
/** Schema for a page of messages; `history` appears only when older history was removed. */
export const messagePage = Schema.Struct({
  ...page(Message).fields,
  history: Schema.optionalKey(HistoryLimit),
});
/** Schema for an idempotent creation result. */
export const created = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ item, created: Schema.Boolean });
/** Registration result with the server's General conversation for immediate orientation. */
export const Registration = Schema.Struct({
  ...created(Participant).fields,
  generalConversationId: ConversationId,
}).annotate({ identifier: "Registration" });
/** Parsed registration or replay result. */
export interface Registration extends Schema.Schema.Type<typeof Registration> {}
/** Bounded context surrounding an anchor message. */
export const MessageContext = Schema.Struct({
  anchor: Message,
  before: Schema.Array(Message),
  after: Schema.Array(Message),
  hasMoreBefore: Schema.Boolean,
  hasMoreAfter: Schema.Boolean,
  history: Schema.optionalKey(HistoryLimit),
}).annotate({ identifier: "MessageContext" });
/** Parsed context window. */
export interface MessageContext extends Schema.Schema.Type<typeof MessageContext> {}
