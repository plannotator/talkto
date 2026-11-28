import {
  Cause,
  Context,
  Tracer,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  SchemaGetter,
} from "effect";
import * as M from "@talkto/api/models";
import * as D from "@talkto/api/dashboard";
import * as U from "@talkto/api/updates";
import * as S from "@talkto/api/signal";
import * as R from "@talkto/api/renames";
import * as Removals from "@talkto/api/removals";
import type * as I from "@talkto/api/inputs";
import { StorageUnavailable } from "@talkto/api/errors";
import * as Access from "../access.js";
import * as Persistence from "../persistence.js";
import * as Telemetry from "../telemetry.js";
import * as Files from "../files/model.js";
import * as Transfers from "../files/transfers.js";
import migration from "../migrations/0001.sql";
import accessMigration from "../migrations/0002.sql";
import updatesMigration from "../migrations/0003.sql";
import filesMigration from "../migrations/0004.sql";
import transfersMigration from "../migrations/0005.sql";
import transferPoolMigration from "../migrations/0006.sql";
import priorityMigration from "../migrations/0007.sql";
import signalsMigration from "../migrations/0008.sql";
import wakesMigration from "../migrations/0009.sql";
import peopleMigration from "../migrations/0010.sql";
import cadenceMigration from "../migrations/0011.sql";
import renamesExtension from "../migrations/renames.sql";
import pluginsExtension from "../migrations/plugins.sql";
import noticesExtension from "../migrations/notices.sql";
import retentionExtension from "../migrations/retention.sql";
import removalsExtension from "../migrations/removals.sql";
import historySizeExtension from "../migrations/history-size.sql";
import wakeTestsExtension from "../migrations/wake-tests.sql";
import serverNameExtension from "../migrations/server-name.sql";
import boardExtension from "../migrations/board.sql";
import taskHoldersExtension from "../migrations/task-holders.sql";
import taskResultsExtension from "../migrations/task-results.sql";
import memoryExtension from "../migrations/memory-repository.sql";
import invitedExtension from "../migrations/invited.sql";
import joinNoticesExtension from "../migrations/join-notices.sql";
import confirmsExtension from "../migrations/confirms.sql";
import * as Board from "./board.js";
import * as Memory from "./memory.js";
import type * as Platform from "../platform/model.js";

/** Incremental migrations after the bootstrap schema, applied in order when their version is absent. */
const upgrades: ReadonlyArray<readonly [version: number, sql: string]> = [
  [2, accessMigration],
  [3, updatesMigration],
  [4, filesMigration],
  [5, transfersMigration],
  [6, transferPoolMigration],
  [7, priorityMigration],
  [8, signalsMigration],
  [9, wakesMigration],
  [10, peopleMigration],
  [11, cadenceMigration],
];
const latestVersion = 11;
/**
 * Additive tables created if absent on every upgrade without recording a version, so a Worker
 * built before them still finds exactly its own latest version and keeps running after a rollback.
 */
const extensions: ReadonlyArray<string> = [
  renamesExtension,
  pluginsExtension,
  noticesExtension,
  retentionExtension,
  removalsExtension,
  historySizeExtension,
  wakeTestsExtension,
  serverNameExtension,
  boardExtension,
  taskHoldersExtension,
  // Its cleanup trigger on tasks touches only task_results and task_result_files.
  taskResultsExtension,
  // Swarm memory's ledger beside its Git repository: no triggers and no foreign keys.
  memoryExtension,
  invitedExtension,
  joinNoticesExtension,
  confirmsExtension,
];

const epoch = (timestamp: M.Timestamp): number =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(timestamp));
const timestamp = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 253402300799999 })).pipe(
  Schema.decodeTo(M.Timestamp, {
    decode: SchemaGetter.transform((n) =>
      M.Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(n))),
    ),
    encode: SchemaGetter.transform((s: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(s))),
  }),
);
// Storage yields NULL for agents; the model omits the key, so agent records keep their shape.
const kindColumn = Schema.NullOr(M.ParticipantKind).pipe(
  Schema.decodeTo(Schema.optionalKey(M.ParticipantKind), {
    decode: SchemaGetter.transformOptional<"person", "person" | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<"person" | null, "person">(
      () => "Participant rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for agents on the default cadence; the model omits the key for them.
const cadenceColumn = Schema.NullOr(M.WakeCadence).pipe(
  Schema.decodeTo(Schema.optionalKey(M.WakeCadence), {
    decode: SchemaGetter.transformOptional<M.WakeCadence, M.WakeCadence | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.WakeCadence | null, M.WakeCadence>(
      () => "Participant rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for agents that never reported a plugin; the model omits the key for them.
const pluginReport = Schema.Struct({ ...M.PluginSeen.fields, seenAt: timestamp });
const pluginColumn = Schema.NullOr(Schema.fromJsonString(pluginReport)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.PluginSeen), {
    decode: SchemaGetter.transformOptional<typeof M.PluginSeen.Encoded, M.PluginSeen | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.PluginSeen | null, typeof M.PluginSeen.Encoded>(
      () => "Participant rows are decoded from storage, never encoded",
    ),
  }),
);
// An invited agent's stored lineage (invited.sql); NULL for every other participant. The stored
// JSON also names the origin's WorkOS user, which decoding drops.
const inviteColumn = Schema.NullOr(Schema.fromJsonString(M.InviteLineage)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.InviteLineage), {
    decode: SchemaGetter.transformOptional<typeof M.InviteLineage.Encoded, M.InviteLineage | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.InviteLineage | null, typeof M.InviteLineage.Encoded>(
      () => "Participant rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for agents nobody removed; the model omits the key for them.
const removedColumn = Schema.NullOr(timestamp).pipe(
  Schema.decodeTo(Schema.optionalKey(M.Timestamp), {
    decode: SchemaGetter.transformOptional<string, M.Timestamp | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.Timestamp | null, string>(
      () => "Participant rows are decoded from storage, never encoded",
    ),
  }),
);
const participantRow = Schema.Struct({
  ...M.Participant.fields,
  createdAt: timestamp,
  lastMessageAt: Schema.NullOr(timestamp),
  kind: kindColumn,
  wakeCadence: cadenceColumn,
  plugin: pluginColumn,
  invite: inviteColumn,
  removedAt: removedColumn,
});
const updateParticipantRow = Schema.Struct({ ...U.Participant.fields, kind: kindColumn });
const personRequestRow = Schema.Struct({
  agentId: M.ParticipantId,
  conversationId: M.ConversationId,
  created: Schema.Literals([0, 1]),
});
/**
 * Only agents count as agents: a person's participant is excluded from every agent count, and so is
 * an agent a person removed.
 */
const agentsOnly = "kind IS NULL AND id NOT IN (SELECT participant_id FROM participant_removals)";
/** The participant-listing filter for each state; `participants` is the row being filtered. */
const participantStates: Record<I.ParticipantState, string> = {
  active: "id NOT IN (SELECT participant_id FROM participant_removals)",
  removed: "id IN (SELECT participant_id FROM participant_removals)",
  all: "1",
};
const notPerson = (column: string) =>
  `${column} NOT IN (SELECT id FROM participants WHERE kind IS NOT NULL)`;
const previewRow = Schema.NullOr(
  Schema.fromJsonString(Schema.Struct({ ...M.MessagePreview.fields, createdAt: timestamp })),
);
const channelRow = Schema.Struct({
  ...M.Channel.fields,
  isGeneral: Schema.Number.pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transform((n) => n === 1),
      encode: SchemaGetter.transform((b) => (b ? 1 : 0)),
    }),
  ),
  createdAt: timestamp,
  archivedAt: Schema.NullOr(timestamp),
  lastMessageAt: Schema.NullOr(timestamp),
  latestMessage: previewRow,
});
const directRow = Schema.Struct({
  ...M.DirectConversation.fields,
  participantIds: Schema.fromJsonString(M.DirectConversation.fields.participantIds),
  createdAt: timestamp,
  lastMessageAt: Schema.NullOr(timestamp),
  latestMessage: previewRow,
});
// Storage yields NULL for messages without a share; the model omits the key instead.
const shareColumn = Schema.NullOr(Schema.fromJsonString(M.FileShare)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.FileShare), {
    decode: SchemaGetter.transformOptional<typeof M.FileShare.Encoded, M.FileShare | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.FileShare | null, typeof M.FileShare.Encoded>(
      () => "Message rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for messages without a transfer; the model omits the key instead.
const transferColumn = Schema.NullOr(Schema.fromJsonString(M.FileTransfer)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.FileTransfer), {
    decode: SchemaGetter.transformOptional<typeof M.FileTransfer.Encoded, M.FileTransfer | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.FileTransfer | null, typeof M.FileTransfer.Encoded>(
      () => "Message rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for normal messages; the model omits the key instead.
const priorityColumn = Schema.NullOr(Schema.Literal("urgent")).pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.Literal("urgent")), {
    decode: SchemaGetter.transformOptional<"urgent", "urgent" | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<"urgent" | null, "urgent">(
      () => "Message rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for messages that mention nobody; the model omits the key instead.
const mentionsColumn = Schema.NullOr(Schema.fromJsonString(M.Mentions)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.Mentions), {
    decode: SchemaGetter.transformOptional<typeof M.Mentions.Encoded, M.Mentions | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.Mentions | null, typeof M.Mentions.Encoded>(
      () => "Message rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for participants' own messages; the model omits the key instead.
const noticeColumn = Schema.NullOr(Schema.fromJsonString(M.MessageNotice)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.MessageNotice), {
    decode: SchemaGetter.transformOptional<typeof M.MessageNotice.Encoded, M.MessageNotice | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.MessageNotice | null, typeof M.MessageNotice.Encoded>(
      () => "Message rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for every message but a join notice; the model omits the key instead.
const joinedColumn = Schema.NullOr(Schema.fromJsonString(M.MessageJoined)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.MessageJoined), {
    decode: SchemaGetter.transformOptional<typeof M.MessageJoined.Encoded, M.MessageJoined | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.MessageJoined | null, typeof M.MessageJoined.Encoded>(
      () => "Message rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for messages that asked no one to confirm; the model omits the key instead.
const confirmColumn = Schema.NullOr(Schema.fromJsonString(M.MessageConfirm)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.MessageConfirm), {
    decode: SchemaGetter.transformOptional<
      typeof M.MessageConfirm.Encoded,
      M.MessageConfirm | null
    >(Option.flatMap(Option.fromNullOr)),
    encode: SchemaGetter.forbidden<M.MessageConfirm | null, typeof M.MessageConfirm.Encoded>(
      () => "Message rows are decoded from storage, never encoded",
    ),
  }),
);
// Storage yields NULL for every message but a confirmation notice; the model omits the key instead.
const confirmationColumn = Schema.NullOr(Schema.fromJsonString(M.MessageConfirmation)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.MessageConfirmation), {
    decode: SchemaGetter.transformOptional<
      typeof M.MessageConfirmation.Encoded,
      M.MessageConfirmation | null
    >(Option.flatMap(Option.fromNullOr)),
    encode: SchemaGetter.forbidden<
      M.MessageConfirmation | null,
      typeof M.MessageConfirmation.Encoded
    >(() => "Message rows are decoded from storage, never encoded"),
  }),
);
// Storage yields NULL for messages outside a task's thread; the model omits the key instead.
const taskColumn = Schema.NullOr(Schema.fromJsonString(M.MessageTask)).pipe(
  Schema.decodeTo(Schema.optionalKey(M.MessageTask), {
    decode: SchemaGetter.transformOptional<typeof M.MessageTask.Encoded, M.MessageTask | null>(
      Option.flatMap(Option.fromNullOr),
    ),
    encode: SchemaGetter.forbidden<M.MessageTask | null, typeof M.MessageTask.Encoded>(
      () => "Message rows are decoded from storage, never encoded",
    ),
  }),
);
const messageRow = Schema.Struct({
  ...M.Message.fields,
  createdAt: timestamp,
  share: shareColumn,
  transfer: transferColumn,
  priority: priorityColumn,
  mentions: mentionsColumn,
  notice: noticeColumn,
  joined: joinedColumn,
  confirm: confirmColumn,
  confirmation: confirmationColumn,
  task: taskColumn,
});
const historyRow = Schema.Struct({
  plan: M.HistoryPlan,
  days: M.Count,
  archived: Schema.Literals([0, 1]).pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transform((n) => n === 1),
      encode: SchemaGetter.transform((b) => (b ? 1 : 0)),
    }),
  ),
  throughAt: timestamp,
  throughSequence: M.Count,
  capped: Schema.Literals([0, 1]).pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transform((n) => n === 1),
      encode: SchemaGetter.transform((b) => (b ? 1 : 0)),
    }),
  ),
});
const transferRow = Schema.Struct({
  ...Transfers.TransferRecord.fields,
  createdAt: timestamp,
  uploadExpiresAt: timestamp,
  expiresAt: timestamp,
});
const transferEntryRow = Schema.Struct({
  ...Transfers.TransferEntry.fields,
  createdAt: timestamp,
  expiresAt: timestamp,
});
const transferFetchRow = Schema.Struct({
  participantId: M.ParticipantId,
  firstFetchedAt: timestamp,
});
/** The raw `file_repository` row; whether it is a repository is decided when it is read. */
const repositoryRow = Schema.Struct({ remote: Schema.String, defaultBranch: Schema.String });
const tokenRow = Schema.Struct({
  ...Files.TokenRecord.fields,
  issuedAt: timestamp,
  expiresAt: Schema.NullOr(timestamp),
  revokedAt: Schema.NullOr(timestamp),
});
const grantRow = Schema.Struct({
  ...Access.Grant.fields,
  createdAt: timestamp,
  revokedAt: Schema.NullOr(timestamp),
});
const serverRow = Schema.Struct({ ...M.Server.fields, createdAt: timestamp });
const creationMeta = { grantId: M.GrantId, requestKey: M.RequestKey };
const participantCreationRow = Schema.Struct({ ...participantRow.fields, ...creationMeta });
const channelCreationRow = Schema.Struct({ ...channelRow.fields, ...creationMeta });
const messageCreationRow = Schema.Struct({ ...messageRow.fields, ...creationMeta });

const participantColumns = `id, name, agent_type AS agentType, working_directory AS workingDirectory,
 joined_note AS joinedNote, created_at AS createdAt, message_count AS messageCount, last_message_at AS lastMessageAt, kind,
 (SELECT cadence FROM participant_wake_cadence WHERE participant_id=participants.id) AS wakeCadence,
 (SELECT json_object('name',plugin,'version',version,'seenAt',seen_at) FROM participant_plugins
   WHERE participant_id=participants.id) AS plugin,
 (SELECT lineage FROM invited_agents WHERE participant_id=participants.id) AS invite,
 (SELECT removed_at FROM participant_removals WHERE participant_id=participants.id) AS removedAt`;
const conversationColumns = `id, kind, created_by_participant_id AS createdByParticipantId,
 created_at AS createdAt, message_count AS messageCount, last_message_at AS lastMessageAt,
 (SELECT json_object('id',m.id,'sequence',m.seq,'senderId',m.sender_id,'createdAt',m.created_at,
   'excerpt',substr(m.body,1,${M.messagePreviewLength}),
   'truncated',json(CASE WHEN length(m.body)>${M.messagePreviewLength} THEN 'true' ELSE 'false' END))
 FROM messages m WHERE m.seq=conversations.last_message_seq) AS latestMessage`;
const channelColumns = `${conversationColumns}, name, description, is_general AS isGeneral,
 archived_at AS archivedAt, revision`;
const directColumns = `${conversationColumns}, json_array(participant_low_id, participant_high_id) AS participantIds`;
// Every message reader shares this projection, so a share can never be dropped by one path.
const messageColumns = `id, seq AS sequence, conversation_id AS conversationId, sender_id AS senderId, body, created_at AS createdAt,
 (SELECT CASE WHEN s.bytes IS NULL THEN json_object('path',s.path,'commit',s.commit_hash,'ref',s.ref)
   ELSE json_object('path',s.path,'commit',s.commit_hash,'ref',s.ref,'bytes',s.bytes) END
  FROM message_shares s WHERE s.message_id=messages.id) AS share,
 (SELECT json_object('id',t.id,'name',t.name,'kind',t.kind,'bytes',t.bytes,'sha256',t.sha256,'fileCount',t.file_count,
   'expiresAt',strftime('%Y-%m-%dT%H:%M:%fZ',t.expires_at/1000.0,'unixepoch'))
  FROM file_transfers t WHERE t.message_id=messages.id) AS transfer,
 (SELECT p.priority FROM message_priority p WHERE p.message_id=messages.id) AS priority,
 CASE WHEN EXISTS (SELECT 1 FROM message_mentions WHERE seq=messages.seq) THEN
  (SELECT json_group_array(x.participant_id) FROM (SELECT participant_id FROM message_mentions
   WHERE seq=messages.seq ORDER BY position) x) END AS mentions,
 (SELECT json_object('kind',n.kind,'channelId',n.channel_id,'channelName',k.name)
  FROM message_notices n JOIN conversations k ON k.id=n.channel_id WHERE n.message_id=messages.id) AS notice,
 (SELECT json_object('participantId',j.participant_id) FROM join_notices j WHERE j.message_id=messages.id) AS joined,
 CASE WHEN EXISTS (SELECT 1 FROM message_confirms WHERE seq=messages.seq) THEN json_object(
  'asked',json((SELECT json_group_array(x.participant_id) FROM (SELECT participant_id FROM message_confirms
   WHERE seq=messages.seq ORDER BY position) x)),
  'confirmed',json((SELECT json_group_array(json_object('participantId',x.participant_id,
   'at',strftime('%Y-%m-%dT%H:%M:%fZ',x.confirmed_at/1000.0,'unixepoch'))) FROM (SELECT participant_id,confirmed_at
   FROM message_confirms WHERE seq=messages.seq AND confirmed_at IS NOT NULL ORDER BY confirmed_at,position) x))) END AS confirm,
 (SELECT json_object('messageId',f.confirmed_message_id) FROM confirm_notices f WHERE f.message_id=messages.id) AS confirmation,
 (SELECT json_object('id',tm.task_id,'number',tk.number,'kind',tm.kind)
  FROM task_messages tm JOIN tasks tk ON tk.id=tm.task_id WHERE tm.message_id=messages.id) AS task`;
const transferColumns = `id, sender_id AS senderId, grant_id AS grantId, request_key AS requestKey, name, kind, bytes,
 sha256, file_count AS fileCount, manifest_bytes AS manifestBytes, created_at AS createdAt,
 upload_expires_at AS uploadExpiresAt, expires_at AS expiresAt, message_id AS messageId, pool_state AS poolState`;
const tokenColumns = `id, token_id AS tokenId, participant_id AS participantId, grant_id AS grantId, scope,
 issued_at AS issuedAt, expires_at AS expiresAt, revoked_at AS revokedAt`;
const creationColumns = `created_by_grant_id AS grantId, request_key AS requestKey`;

/**
 * The incoming rule get_updates reads with: a selected channel, or one of the reader's own direct
 * chats, never the reader's own send. Signal counts use this same rule. Expects `m` and `c`.
 * `mentioned` below completes it: with directChats "own", messages that @mention the reader too.
 */
const incoming = (selection: U.Selection & { readonly participantId: M.ParticipantId }) => ({
  sql: `m.sender_id<>? AND ((c.kind='channel' AND c.id IN (SELECT value FROM json_each(?)))
    OR (?='own' AND c.kind='direct' AND (c.participant_low_id=? OR c.participant_high_id=?)))`,
  bindings: [
    selection.participantId,
    JSON.stringify(selection.channelIds),
    selection.directChats,
    selection.participantId,
    selection.participantId,
  ],
});
/**
 * Thread messages delivered to the reader through its task selection (task_message_recipients):
 * every selection but `tasks: "none"`, which old checkpoints without the field read as `mine`.
 * Expects `m`.
 */
const threaded = (selection: U.Selection & { readonly participantId: M.ParticipantId }) => ({
  sql: `?<>'none' AND EXISTS (SELECT 1 FROM task_message_recipients tr WHERE tr.participant_id=? AND tr.seq=m.seq)`,
  bindings: [selection.tasks ?? "mine", selection.participantId],
});
/** Channel messages that @mention the reader reach it the way its own direct chats do. Expects `m`. */
const mentioned = (selection: U.Selection & { readonly participantId: M.ParticipantId }) => ({
  sql: `?='own' AND EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.participant_id=? AND mm.seq=m.seq)`,
  bindings: [selection.directChats, selection.participantId],
});
const signalRow = Schema.Struct({
  id: S.SignalId,
  participantId: M.ParticipantId,
  grantId: M.GrantId,
  secretHash: Schema.String,
  selection: Schema.fromJsonString(U.Selection),
  generation: U.Generation,
  boundary: M.Count,
  createdAt: timestamp,
  expiresAt: timestamp,
});
const removalEventRow = Schema.Struct({
  ...Removals.Event.fields,
  by: Schema.fromJsonString(Removals.Event.fields.by),
  at: timestamp,
});
const renameRow = Schema.Struct({
  ...R.Rename.fields,
  renamedAt: timestamp,
  renamedBy: Schema.fromJsonString(R.RenamedBy),
});
// The actor's current name: a deleted person's participant shows only its neutral name.
const renameColumns = `r.id, r.seq AS sequence, r.participant_id AS participantId, r.previous_name AS previousName,
 r.name, r.created_at AS renamedAt,
 CASE WHEN r.renamed_by_participant_id=r.participant_id THEN json_object('kind','self')
   ELSE json_object('kind','person','participantId',a.id,'name',a.name) END AS renamedBy`;
const renameSource = `participant_renames r JOIN participants a ON a.id=r.renamed_by_participant_id`;
const signalColumns = `id, participant_id AS participantId, grant_id AS grantId, secret_hash AS secretHash,
 json_object('channelIds',json(channel_ids),'directChats',direct_chats) AS selection, generation, boundary,
 created_at AS createdAt, expires_at AS expiresAt`;

const unavailable = (operation: string) =>
  new StorageUnavailable({ operation, message: "Server storage is temporarily unavailable." });

const RuntimeFlags = Schema.Struct({
  retryable: Schema.optionalKey(Schema.Boolean),
  overloaded: Schema.optionalKey(Schema.Boolean),
});
/**
 * Contention, a full disk, an overloaded object, or an error the runtime marks `retryable`: the
 * caller can retry, so it is `StorageUnavailable` rather than a defect.
 */
const transient = (cause: unknown) => {
  if (!Predicate.isError(cause)) return false;
  if (
    /SQLITE_(BUSY|LOCKED|FULL|IOERR)|database (?:is locked|or disk is full)|overloaded/i.test(
      cause.message,
    )
  )
    return true;
  const flags = Schema.decodeUnknownOption(RuntimeFlags)(cause);
  return (
    flags._tag === "Some" && (flags.value.retryable === true || flags.value.overloaded === true)
  );
};

/** Initial configured server state; IDs and authority are generated at the composition boundary. */
export interface Bootstrap {
  readonly serverId: M.ServerId;
  readonly name: typeof M.ServerName.Type;
  readonly generalId: M.ConversationId;
  readonly grantId: M.GrantId | null;
  readonly principalKey: Access.PrincipalKey | null;
  readonly now: M.Timestamp;
  /**
   * Created as a swarm server: the board starts switched on. Its channel needs a creator, so the
   * first create_tasks call (or the person switching the board on) creates it.
   */
  readonly board?: boolean;
  /** The swarm server's starting claim cap (`board_settings.claim_cap`); absent or null is none. */
  readonly claimCap?: number | null;
}
const hasSchema = (storage: DurableObjectStorage) =>
  storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .toArray().length > 0;

const upgradeSchema = (storage: DurableObjectStorage, now: M.Timestamp) => {
  const applied = new Set(
    Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ version: Schema.Int })))(
      storage.sql.exec("SELECT version FROM schema_migrations").toArray(),
    ).map((row) => row.version),
  );
  for (const [version, sql] of upgrades) {
    if (applied.has(version)) continue;
    storage.sql.exec(sql);
    storage.sql.exec(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
      version,
      epoch(now),
    );
  }
  for (const sql of extensions) storage.sql.exec(sql);
  const state = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        id: M.ServerId,
        version: Schema.Literal(latestVersion),
        generalCount: Schema.Literal(1),
        generation: U.Generation,
      }),
    ),
  )(
    storage.sql
      .exec(`SELECT s.id, (SELECT MAX(version) FROM schema_migrations) AS version,
      (SELECT COUNT(*) FROM conversations WHERE is_general=1 AND archived_at IS NULL) AS generalCount,
      (SELECT generation FROM updates_identity WHERE singleton=1) AS generation FROM server s`)
      .toArray(),
  );
  const server = state[0];
  if (state.length !== 1 || server === undefined) throw new Error("Invalid stored server identity");
  return server.id;
};

/** Upgrade an existing hosted server before requests; unknown objects remain empty. */
export const upgrade = Effect.fn("Sqlite.upgrade")(function* (
  storage: DurableObjectStorage,
  now: M.Timestamp,
) {
  yield* Effect.try({
    try: () =>
      storage.transactionSync(() => {
        if (hasSchema(storage)) upgradeSchema(storage, now);
      }),
    catch: () => unavailable("upgrade: check migration version and database integrity"),
  });
});
/** Initialize an empty SQLite database, or verify its identity and supported migration version. */
export const initialize = Effect.fn("Sqlite.initialize")(function* (
  storage: DurableObjectStorage,
  seed: Bootstrap,
) {
  return yield* Effect.try({
    try: () =>
      storage.transactionSync(() => {
        const fresh = !hasSchema(storage);
        if (fresh) {
          storage.sql.exec(migration);
          storage.sql.exec(
            "INSERT INTO server(singleton,id,name,created_at) VALUES(1,?,?,?)",
            seed.serverId,
            seed.name,
            epoch(seed.now),
          );
          if (seed.grantId !== null && seed.principalKey !== null)
            storage.sql.exec(
              "INSERT INTO server_grants(id,principal_key,created_at) VALUES(?,?,?)",
              seed.grantId,
              seed.principalKey,
              epoch(seed.now),
            );
          storage.sql.exec(
            "INSERT INTO conversations(id,kind,name,is_general,created_at) VALUES(?,'channel','General',1,?)",
            seed.generalId,
            epoch(seed.now),
          );
          storage.sql.exec(
            "INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)",
            epoch(seed.now),
          );
        }
        if (upgradeSchema(storage, seed.now) !== seed.serverId)
          throw new Error("Configured server identity does not match stored server");
        if (fresh && seed.board === true)
          storage.sql.exec(
            "INSERT INTO board_settings(singleton,enabled,channel_id,claim_cap,changed_at) VALUES(1,1,NULL,?,?)",
            seed.claimCap ?? null,
            epoch(seed.now),
          );
      }),
    catch: () =>
      unavailable("initialize: check configuration, migration version, and database integrity"),
  });
});

/**
 * Resolve verified caller authority locally. Unknown objects remain empty and inaccessible.
 * `schemaKnown` is true when the caller already knows the server table exists, as a server object
 * does once initialized; the lookup otherwise scans `sqlite_master`, about 90 rows.
 */
export const resolveAccess = Effect.fn("Sqlite.resolveAccess")(function* (
  storage: DurableObjectStorage,
  principalKey: Access.PrincipalKey,
  schemaKnown = false,
) {
  return yield* Effect.try({
    try: () => {
      if (
        !schemaKnown &&
        storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='server'")
          .toArray().length === 0
      )
        return null;
      // An invited agent's key arrives as its hash (Access.invitedKey). It resolves to its own
      // principal only while its one participant is not removed: a removed agent's key stops at once.
      const hash = Access.invitedKeyHash(principalKey);
      const principal =
        hash === null
          ? principalKey
          : (storage.sql
              .exec<{ id: string }>(
                "SELECT i.id FROM invited_agents i WHERE i.key_hash=? AND NOT EXISTS (SELECT 1 FROM participant_removals r WHERE r.participant_id=i.participant_id)",
                hash,
              )
              .toArray()
              .map((row) => Access.invitedPrincipal(row.id))[0] ?? null);
      if (principal === null) return null;
      const rows = storage.sql
        .exec(
          "SELECT s.id AS serverId,g.id AS grantId,g.principal_key AS principalKey FROM server s JOIN server_grants g ON g.principal_key=? AND g.revoked_at IS NULL",
          principal,
        )
        .toArray();
      return Schema.decodeUnknownSync(Schema.Array(Access.AccessContext))(rows)[0] ?? null;
    },
    catch: () => unavailable("resolveAccess"),
  });
});

/** Monotonic delivery prevents a delayed allow command from undoing a revocation. */
export const applyAccess = Effect.fn("Sqlite.applyAccess")(function* (
  storage: DurableObjectStorage,
  command: Platform.AccessCommand,
) {
  yield* Effect.try({
    try: () =>
      storage.transactionSync(() => {
        const server = storage.sql.exec("SELECT id FROM server").one();
        if (server.id !== command.serverId) throw new Error("Wrong server binding");
        const previous = storage.sql
          .exec<{ revision: number }>(
            "SELECT revision FROM platform_access_versions WHERE principal_key=?",
            command.principalKey,
          )
          .toArray()[0];
        if (previous !== undefined && previous.revision >= command.revision) return;
        storage.sql.exec(
          "UPDATE server_grants SET revoked_at=MAX(created_at,?) WHERE principal_key=? AND revoked_at IS NULL AND id<>?",
          epoch(command.revokedAt ?? command.createdAt),
          command.principalKey,
          command.id,
        );
        storage.sql.exec(
          "INSERT INTO server_grants(id,principal_key,created_at,revoked_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
          command.id,
          command.principalKey,
          epoch(command.createdAt),
          command.revokedAt === null ? null : epoch(command.revokedAt),
        );
        if (command.revokedAt !== null)
          storage.sql.exec(
            "UPDATE server_grants SET revoked_at=MAX(created_at,?) WHERE id=? AND revoked_at IS NULL",
            epoch(command.revokedAt),
            command.id,
          );
        // A revoked grant's signal links and wake keys can never be used again; remove them now
        // rather than at their next attempt, so a departed or deleted person leaves no secrets.
        for (const table of ["participant_signals", "wake_targets"])
          storage.sql.exec(
            `DELETE FROM ${table} WHERE grant_id IN (SELECT id FROM server_grants WHERE principal_key=? AND revoked_at IS NOT NULL)`,
            command.principalKey,
          );
        storage.sql.exec(
          "INSERT INTO platform_access_versions(principal_key,revision) VALUES(?,?) ON CONFLICT(principal_key) DO UPDATE SET revision=excluded.revision",
          command.principalKey,
          command.revision,
        );
      }),
    catch: () => unavailable("applyAccess"),
  });
});

/**
 * Take the server's new name from the platform directory. A revision no newer than the one held
 * changes nothing, so deliveries may repeat or arrive out of order. A server not yet initialized
 * has nothing to rename: provisioning stores the directory's current name.
 */
export const renameServer = Effect.fn("Sqlite.renameServer")(function* (
  storage: DurableObjectStorage,
  change: Platform.ServerName,
) {
  yield* Effect.try({
    try: () =>
      storage.transactionSync(() => {
        if (!hasSchema(storage)) return;
        const server = storage.sql.exec("SELECT id FROM server").one();
        if (server.id !== change.serverId) throw new Error("Wrong server binding");
        const held = storage.sql
          .exec<{ revision: number }>("SELECT revision FROM server_name_revision WHERE singleton=1")
          .toArray()[0];
        if (held !== undefined && held.revision >= change.revision) return;
        storage.sql.exec("UPDATE server SET name=? WHERE singleton=1", change.name);
        storage.sql.exec(
          "INSERT INTO server_name_revision(singleton,revision) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision",
          change.revision,
        );
      }),
    catch: () => unavailable("renameServer"),
  });
});

/** The neutral names a deleted person's participant takes: `former-person`, then `-2`, `-3`… */
const formerName = (n: number) => (n === 1 ? "former-person" : `former-person-${n}`);
/**
 * After a person deletes their TalkTo account, rename their participant here, if they have one,
 * to the first free neutral name. The participant and its messages stay in the server's history.
 * Applying it again changes nothing.
 */
export const forgetPerson = Effect.fn("Sqlite.forgetPerson")(function* (
  storage: DurableObjectStorage,
  command: Platform.AccessCommand,
) {
  const { principalKey, revokedAt } = command;
  if (revokedAt === null) return yield* unavailable("forgetPerson");
  yield* Effect.try({
    try: () =>
      storage.transactionSync(() => {
        const server = storage.sql.exec("SELECT id FROM server").one();
        if (server.id !== command.serverId) throw new Error("Wrong server binding");
        const person = storage.sql
          .exec<{ id: string }>(
            "SELECT participant_id AS id FROM person_participants WHERE principal_key=? AND forgotten_at IS NULL",
            principalKey,
          )
          .toArray()[0];
        if (person === undefined) return;
        let n = 1;
        while (
          storage.sql
            .exec("SELECT 1 FROM participants WHERE name=? COLLATE NOCASE", formerName(n))
            .toArray().length > 0
        )
          n += 1;
        storage.sql.exec("UPDATE participants SET name=? WHERE id=?", formerName(n), person.id);
        storage.sql.exec(
          "UPDATE person_participants SET forgotten_at=MAX(created_at,?) WHERE principal_key=?",
          epoch(revokedAt),
          principalKey,
        );
      }),
    catch: () => unavailable("forgetPerson"),
  });
});

/** Adapt Cloudflare's synchronous SQLite storage to the application-owned transaction port. */
export function layer(storage: DurableObjectStorage) {
  return Layer.sync(Persistence.Persistence, () => {
    const execute = Effect.fnUntraced(function* (
      query: string,
      bindings: ReadonlyArray<SqlStorageValue> = [],
    ) {
      return yield* Effect.try({
        try: () => storage.sql.exec(query, ...bindings).toArray(),
        catch: (cause) => {
          if (transient(cause)) return unavailable("query");
          // Constraint failures after application guards, malformed SQL, and bad stored rows are defects.
          throw cause;
        },
      });
    });
    const all = Effect.fnUntraced(function* <A>(
      schema: Schema.Decoder<A>,
      query: string,
      bindings: ReadonlyArray<SqlStorageValue> = [],
    ) {
      const rows = yield* execute(query, bindings);
      return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.orDie);
    });
    const one = Effect.fnUntraced(function* <A>(
      schema: Schema.Decoder<A>,
      query: string,
      bindings: ReadonlyArray<SqlStorageValue> = [],
    ) {
      const rows = yield* all(schema, query, bindings);
      return rows[0] ?? null;
    });
    const creation = <A extends { readonly grantId: M.GrantId; readonly requestKey: M.RequestKey }>(
      row: A | null,
    ) => {
      if (row === null) return null;
      const { grantId, requestKey, ...item } = row;
      return { item, grantId, requestKey };
    };
    /**
     * Take `count` numbers from the messages AUTOINCREMENT sequence and return the last; the range is
     * `last - count + 1 … last`. Renames and task events number themselves this way, so one
     * get_updates checkpoint orders them with messages, and the next message is numbered after
     * them. sqlite_sequence has no row before the first message.
     */
    const allocateSequence = Effect.fnUntraced(function* (count: number) {
      yield* execute(
        "INSERT INTO sqlite_sequence(name,seq) SELECT 'messages',0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='messages')",
      );
      const allocated = yield* one(
        Schema.Struct({ seq: M.Count }),
        `UPDATE sqlite_sequence SET seq=MAX(seq,
           COALESCE((SELECT seq FROM messages ORDER BY seq DESC LIMIT 1),0),
           COALESCE((SELECT seq FROM participant_renames ORDER BY seq DESC LIMIT 1),0),
           COALESCE((SELECT seq FROM task_events ORDER BY seq DESC LIMIT 1),0))+?
         WHERE name='messages' RETURNING seq`,
        [count],
      );
      if (allocated === null) return yield* Effect.die("The message sequence is missing");
      return allocated.seq;
    });
    const participant = (id: M.ParticipantId) =>
      one(participantRow, `SELECT ${participantColumns} FROM participants WHERE id=?`, [id]);
    const channel = (id: M.ConversationId) =>
      one(channelRow, `SELECT ${channelColumns} FROM conversations WHERE kind='channel' AND id=?`, [
        id,
      ]);
    const session: Persistence.Session = {
      board: Board.make({ execute, all, one, allocateSequence }),
      memory: Memory.make({ execute, all, one }),
      // The head is the sequence's high-water mark, not the newest stored row: pruning removes
      // finished tasks' events (and old messages), and a head that fell back would refuse every
      // checkpoint saved after them. sqlite_sequence never goes down; the rows cover a server
      // whose sequence row does not exist yet.
      updatesHead: () =>
        one(
          Schema.Struct({ generation: U.Generation, sequence: M.Count }),
          `SELECT generation,MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='messages'),0),
           COALESCE((SELECT seq FROM messages ORDER BY seq DESC LIMIT 1),0),
           COALESCE((SELECT seq FROM participant_renames ORDER BY seq DESC LIMIT 1),0),
           COALESCE((SELECT seq FROM task_events ORDER BY seq DESC LIMIT 1),0)) AS sequence
           FROM updates_identity WHERE singleton=1`,
        ).pipe(
          Effect.flatMap((row) =>
            row === null ? Effect.die("Missing updates storage identity") : Effect.succeed(row),
          ),
        ),
      updateCandidates: (selection) => {
        const rule = incoming(selection);
        const mention = mentioned(selection);
        const thread = threaded(selection);
        return all(
          Schema.Struct({ id: M.MessageId }),
          `SELECT m.id FROM messages m NOT INDEXED CROSS JOIN conversations c ON c.id=m.conversation_id
          WHERE m.seq>? AND m.seq<=? AND (${rule.sql} OR (m.sender_id<>? AND (${mention.sql} OR ${thread.sql})))
          ORDER BY m.seq LIMIT ?`,
          [
            selection.boundary,
            selection.ceiling,
            ...rule.bindings,
            selection.participantId,
            ...mention.bindings,
            ...thread.bindings,
            selection.limit,
          ],
        ).pipe(Effect.map((rows) => rows.map((row) => row.id)));
      },
      signalTally: Effect.fn("Sqlite.signalTally")(function* (selection) {
        const rule = incoming(selection);
        const row = Schema.Struct({ id: M.MessageId, seq: M.Count });
        // Conversations first, then each one's (conversation_id, seq) index from the boundary on.
        const selected = yield* all(
          row,
          `SELECT m.id, m.seq FROM conversations c CROSS JOIN messages m INDEXED BY messages_conversation_seq
          ON m.conversation_id=c.id WHERE m.seq>? AND ${rule.sql} ORDER BY m.seq DESC LIMIT ?`,
          [selection.boundary, ...rule.bindings, selection.limit],
        );
        // Mentions walk the reader's own (participant_id, seq) key, so other traffic costs nothing.
        const mentions =
          selection.directChats === "own"
            ? yield* all(
                row,
                `SELECT m.id, m.seq FROM message_mentions mm JOIN messages m ON m.seq=mm.seq
                WHERE mm.participant_id=? AND mm.seq>? AND m.sender_id<>? ORDER BY mm.seq DESC LIMIT ?`,
                [
                  selection.participantId,
                  selection.boundary,
                  selection.participantId,
                  selection.limit,
                ],
              )
            : [];
        // Task readers also count their thread messages and task events (board.sql's recipient
        // rows), or, following every task, every event others caused.
        const tasks = selection.tasks ?? "mine";
        const threads =
          tasks === "none"
            ? []
            : yield* all(
                row,
                `SELECT m.id, m.seq FROM task_message_recipients tr JOIN messages m ON m.seq=tr.seq
                WHERE tr.participant_id=? AND tr.seq>? ORDER BY tr.seq DESC LIMIT ?`,
                [selection.participantId, selection.boundary, selection.limit],
              );
        const events =
          tasks === "none"
            ? []
            : tasks === "all"
              ? yield* all(
                  row,
                  `SELECT id, seq FROM task_events WHERE seq>? AND (actor_participant_id IS NULL
                  OR actor_participant_id<>?) ORDER BY seq DESC LIMIT ?`,
                  [selection.boundary, selection.participantId, selection.limit],
                )
              : yield* all(
                  row,
                  `SELECT e.id, e.seq FROM task_event_recipients r JOIN task_events e ON e.seq=r.seq
                  WHERE r.participant_id=? AND r.seq>? ORDER BY r.seq DESC LIMIT ?`,
                  [selection.participantId, selection.boundary, selection.limit],
                );
        const seen = new Set(selected.map((item) => item.id));
        const newest = [
          ...selected,
          ...[...mentions, ...threads].filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          }),
          ...events,
        ]
          .toSorted((a, b) => b.seq - a.seq)
          .slice(0, selection.limit);
        // Urgent rows are rare and indexed by sequence, so this walks only urgent messages.
        const urgent = yield* one(
          Schema.Struct({ count: M.Count }),
          `SELECT COUNT(*) AS count FROM (SELECT 1 FROM message_priority p
          JOIN messages m ON m.seq=p.seq JOIN conversations c ON c.id=m.conversation_id
          WHERE p.seq>? AND ${rule.sql} LIMIT ?)`,
          [selection.boundary, ...rule.bindings, selection.limit],
        );
        return { newest: newest.map((row) => row.id), urgent: urgent?.count ?? 0 };
      }),
      signalWaking: Effect.fn("Sqlite.signalWaking")(function* (selection) {
        const row = Schema.Struct({ id: M.MessageId });
        const reader = selection.participantId;
        const own = selection.directChats === "own";
        // The reader's own direct chats, each walked on its (conversation_id, seq) index.
        const direct = own
          ? yield* all(
              row,
              `SELECT m.id FROM conversations c CROSS JOIN messages m INDEXED BY messages_conversation_seq
              ON m.conversation_id=c.id WHERE m.seq>? AND m.sender_id<>? AND c.kind='direct'
              AND (c.participant_low_id=? OR c.participant_high_id=?) ORDER BY m.seq DESC LIMIT ?`,
              [selection.boundary, reader, reader, reader, selection.limit],
            )
          : [];
        // Mentions walk the reader's own (participant_id, seq) key.
        const mentions = own
          ? yield* all(
              row,
              `SELECT m.id FROM message_mentions mm JOIN messages m ON m.seq=mm.seq
              WHERE mm.participant_id=? AND mm.seq>? AND m.sender_id<>? ORDER BY mm.seq DESC LIMIT ?`,
              [reader, selection.boundary, reader, selection.limit],
            )
          : [];
        // TalkTo's notices are rare and keyed by sequence, so this walks only notices.
        const notices =
          selection.channelIds.length > 0
            ? yield* all(
                row,
                `SELECT m.id FROM message_notices n JOIN messages m ON m.seq=n.seq
                WHERE n.seq>? AND m.sender_id<>? AND m.conversation_id IN (SELECT value FROM json_each(?))
                ORDER BY n.seq DESC LIMIT ?`,
                [selection.boundary, reader, JSON.stringify(selection.channelIds), selection.limit],
              )
            : [];
        // Task events and thread messages that wake the reader (recipient rows with wakes = 1).
        const tasks =
          (selection.tasks ?? "mine") === "none"
            ? []
            : [
                ...(yield* all(
                  row,
                  `SELECT e.id FROM task_event_recipients r JOIN task_events e ON e.seq=r.seq
                  WHERE r.participant_id=? AND r.seq>? AND r.wakes=1 ORDER BY r.seq DESC LIMIT ?`,
                  [reader, selection.boundary, selection.limit],
                )),
                ...(yield* all(
                  row,
                  `SELECT m.id FROM task_message_recipients tr JOIN messages m ON m.seq=tr.seq
                  WHERE tr.participant_id=? AND tr.seq>? AND tr.wakes=1 ORDER BY tr.seq DESC LIMIT ?`,
                  [reader, selection.boundary, selection.limit],
                )),
              ];
        const waking = new Set(
          [...direct, ...mentions, ...notices, ...tasks].map((item) => item.id),
        );
        return Math.min(waking.size, selection.limit);
      }),
      putSignal: (signal) =>
        execute(
          `INSERT INTO participant_signals(id,participant_id,grant_id,secret_hash,channel_ids,direct_chats,generation,boundary,created_at,expires_at)
           VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(participant_id) DO UPDATE SET id=excluded.id,
           grant_id=excluded.grant_id,secret_hash=excluded.secret_hash,channel_ids=excluded.channel_ids,
           direct_chats=excluded.direct_chats,generation=excluded.generation,boundary=excluded.boundary,
           created_at=excluded.created_at,expires_at=excluded.expires_at`,
          [
            signal.id,
            signal.participantId,
            signal.grantId,
            signal.secretHash,
            JSON.stringify(signal.selection.channelIds),
            signal.selection.directChats,
            signal.generation,
            signal.boundary,
            epoch(signal.createdAt),
            epoch(signal.expiresAt),
          ],
        ).pipe(Effect.asVoid),
      signal: (id) =>
        one(signalRow, `SELECT ${signalColumns} FROM participant_signals WHERE id=?`, [id]),
      removeSignals: (participantId, id) =>
        all(
          Schema.Struct({ id: S.SignalId }),
          "DELETE FROM participant_signals WHERE participant_id=? AND (? IS NULL OR id=?) RETURNING id",
          [participantId, id, id],
        ).pipe(Effect.map((rows) => rows.length)),
      removeExpiredSignals: (at) =>
        execute("DELETE FROM participant_signals WHERE expires_at<=?", [epoch(at)]).pipe(
          Effect.asVoid,
        ),
      wakeCadence: (participantId) =>
        one(
          Schema.Struct({ cadence: M.WakeCadence }),
          "SELECT cadence FROM participant_wake_cadence WHERE participant_id=?",
          [participantId],
        ).pipe(Effect.map((row) => row?.cadence ?? M.defaultWakeCadence)),
      setWakeCadence: (participantId, cadence, at) =>
        (cadence === M.defaultWakeCadence
          ? execute("DELETE FROM participant_wake_cadence WHERE participant_id=?", [participantId])
          : execute(
              `INSERT INTO participant_wake_cadence(participant_id,cadence,updated_at) VALUES(?,?,?)
               ON CONFLICT(participant_id) DO UPDATE SET cadence=excluded.cadence,updated_at=excluded.updated_at`,
              [participantId, cadence, epoch(at)],
            )
        ).pipe(Effect.asVoid),
      pluginReport: (participantId) =>
        one(
          pluginReport,
          "SELECT plugin AS name, version, seen_at AS seenAt FROM participant_plugins WHERE participant_id=?",
          [participantId],
        ),
      notePlugin: (participantId, report, at) =>
        execute(
          `INSERT INTO participant_plugins(participant_id,plugin,version,seen_at) VALUES(?,?,?,?)
           ON CONFLICT(participant_id) DO UPDATE SET plugin=excluded.plugin,version=excluded.version,seen_at=excluded.seen_at`,
          [participantId, report.name, report.version, epoch(at)],
        ).pipe(Effect.asVoid),
      updateParticipants: (ids) =>
        all(
          updateParticipantRow,
          "SELECT id,name,agent_type AS agentType,kind FROM participants WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
          [JSON.stringify(ids)],
        ),
      updateConversations: (ids) =>
        all(
          Schema.Union([
            Schema.Struct({
              ...U.Conversation.members[0].fields,
              archivedAt: Schema.NullOr(timestamp),
            }),
            Schema.Struct({
              ...U.Conversation.members[1].fields,
              participantIds: Schema.fromJsonString(M.DirectConversation.fields.participantIds),
            }),
          ]),
          "SELECT kind,id,name,archived_at AS archivedAt,json_array(participant_low_id,participant_high_id) AS participantIds FROM conversations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
          [JSON.stringify(ids)],
        ),
      serverIdentity: () =>
        one(Schema.Struct({ id: M.ServerId }), "SELECT id FROM server WHERE singleton=1").pipe(
          Effect.flatMap((row) =>
            row === null ? Effect.die("Initialized server is missing") : Effect.succeed(row.id),
          ),
        ),
      server: Effect.fn("Sqlite.server")(function* () {
        const value = yield* one(
          serverRow,
          `SELECT id,name,created_at AS createdAt,
          (SELECT id FROM conversations WHERE is_general=1) AS generalConversationId,
          (SELECT COUNT(*) FROM participants WHERE ${agentsOnly}) AS participantCount,
          (SELECT COUNT(*) FROM conversations WHERE kind='channel') AS channelCount,
          (SELECT COUNT(*) FROM conversations WHERE kind='direct') AS directConversationCount,
          (SELECT COALESCE(SUM(message_count),0) FROM conversations) AS messageCount FROM server WHERE singleton=1`,
        );
        if (value === null) return yield* Effect.die("Initialized server is missing its singleton");
        return value;
      }),
      grant: (id) =>
        one(
          grantRow,
          "SELECT id,principal_key AS principalKey,created_at AS createdAt,revoked_at AS revokedAt FROM server_grants WHERE id=?",
          [id],
        ),
      participant,
      participantsByIds: (ids) =>
        all(
          participantRow,
          `SELECT ${participantColumns} FROM participants WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          [JSON.stringify(ids)],
        ),
      conversationsByIds: (ids) =>
        all(
          Schema.Union([channelRow, directRow]),
          `SELECT ${channelColumns},json_array(participant_low_id,participant_high_id) AS participantIds FROM conversations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          [JSON.stringify(ids)],
        ),
      participantNamed: (name) =>
        one(
          participantRow,
          `SELECT ${participantColumns} FROM participants WHERE name=? COLLATE NOCASE`,
          [name],
        ),
      // Walk grants using the existing (created_by_grant_id, request_key) unique index.
      // This avoids scanning every participant or introducing a schema migration.
      participantRegistered: (key) =>
        one(
          participantRow,
          `SELECT ${participantColumns} FROM participants WHERE id=(
            SELECT p.id FROM server_grants g CROSS JOIN participants p
            ON p.created_by_grant_id=g.id AND p.request_key=?
            ORDER BY p.created_at,p.id LIMIT 1
          )`,
          [key],
        ),
      agentsRegisteredBy: (principal, since, limit) =>
        all(
          participantRow,
          `SELECT ${participantColumns} FROM participants WHERE ${agentsOnly}
           AND created_by_grant_id IN (SELECT id FROM server_grants WHERE principal_key=?)
           AND created_at>=? ORDER BY created_at, id LIMIT ?`,
          [principal, epoch(since), limit],
        ),
      registration: (grant, key) =>
        one(
          participantCreationRow,
          `SELECT ${participantColumns},${creationColumns} FROM participants WHERE created_by_grant_id=? AND request_key=?`,
          [grant, key],
        ).pipe(Effect.map(creation)),
      addParticipant: ({ item, grantId, requestKey }) =>
        execute(
          `INSERT INTO participants(id,name,agent_type,working_directory,joined_note,created_at,created_by_grant_id,request_key)
        VALUES(?,?,?,?,?,?,?,?)`,
          [
            item.id,
            item.name,
            item.agentType,
            item.workingDirectory,
            item.joinedNote,
            epoch(item.createdAt),
            grantId,
            requestKey,
          ],
        ).pipe(Effect.asVoid),
      registeredName: (id) =>
        one(
          Schema.Struct({ name: M.Name }),
          "SELECT previous_name AS name FROM participant_renames WHERE participant_id=? ORDER BY seq LIMIT 1",
          [id],
        ).pipe(Effect.map((row) => row?.name ?? null)),
      registeredBy: (id) =>
        one(
          Schema.Struct({ principalKey: Access.PrincipalKey }),
          `SELECT g.principal_key AS principalKey FROM participants p
           JOIN server_grants g ON g.id=p.created_by_grant_id WHERE p.id=?`,
          [id],
        ).pipe(Effect.map((row) => row?.principalKey ?? null)),
      registrants: (ids) =>
        all(
          Schema.Struct({ id: M.ParticipantId, principalKey: Access.PrincipalKey }),
          `SELECT p.id AS id, g.principal_key AS principalKey FROM participants p
           JOIN server_grants g ON g.id=p.created_by_grant_id
           WHERE p.id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(ids)],
        ),
      renameRequest: (grant, key) =>
        one(
          renameRow,
          `SELECT ${renameColumns} FROM ${renameSource} WHERE r.created_by_grant_id=? AND r.request_key=?`,
          [grant, key],
        ),
      addRename: Effect.fn("Sqlite.addRename")(function* (record) {
        // Take the next message sequence: messages, renames and task events then share one order,
        // and the next message is numbered after this rename.
        const allocated = { seq: yield* allocateSequence(1) };
        yield* execute(
          `INSERT INTO participant_renames(seq,id,participant_id,previous_name,name,renamed_by_participant_id,created_by_grant_id,request_key,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
          [
            allocated.seq,
            record.id,
            record.participantId,
            record.previousName,
            record.name,
            record.renamedById,
            record.grantId,
            record.requestKey,
            epoch(record.createdAt),
          ],
        );
        yield* execute("UPDATE participants SET name=? WHERE id=?", [
          record.name,
          record.participantId,
        ]);
        const stored = yield* one(
          renameRow,
          `SELECT ${renameColumns} FROM ${renameSource} WHERE r.seq=?`,
          [allocated.seq],
        );
        if (stored === null) return yield* Effect.die("Inserted rename is missing");
        return stored;
      }),
      renamesBetween: (after, through, limit) =>
        all(
          renameRow,
          `SELECT ${renameColumns} FROM ${renameSource} WHERE r.seq>? AND r.seq<=? ORDER BY r.seq LIMIT ?`,
          [after, through, limit],
        ),
      recentRenames: (participantId, limit) =>
        all(
          renameRow,
          `SELECT ${renameColumns} FROM ${renameSource} WHERE (? IS NULL OR r.participant_id=?)
           ORDER BY r.seq DESC LIMIT ?`,
          [participantId, participantId, limit],
        ),
      person: (principalKey) =>
        one(
          participantRow,
          `SELECT ${participantColumns} FROM participants WHERE id=(
            SELECT participant_id FROM person_participants WHERE principal_key=?)`,
          [principalKey],
        ),
      addPerson: Effect.fn("Sqlite.addPerson")(function* ({ item, principalKey, grantId }) {
        // The request key holds a slash, which no agent's RequestKey can, so no registration
        // retry can ever replay as a person.
        yield* execute(
          `INSERT INTO participants(id,name,agent_type,working_directory,joined_note,created_at,created_by_grant_id,request_key,kind)
          VALUES(?,?,?,NULL,NULL,?,?,?,'person')`,
          [item.id, item.name, item.agentType, epoch(item.createdAt), grantId, `person/${item.id}`],
        );
        yield* execute(
          "INSERT INTO person_participants(principal_key,participant_id,created_at) VALUES(?,?,?)",
          [principalKey, item.id, epoch(item.createdAt)],
        );
      }),
      personRequest: (personId, key) =>
        one(
          personRequestRow,
          `SELECT agent_id AS agentId, conversation_id AS conversationId, created
           FROM person_requests WHERE participant_id=? AND request_key=?`,
          [personId, key],
        ).pipe(Effect.map((row) => (row === null ? null : { ...row, created: row.created === 1 }))),
      addPersonRequest: (personId, key, request) =>
        execute(
          "INSERT INTO person_requests(participant_id,request_key,agent_id,conversation_id,created) VALUES(?,?,?,?,?)",
          [personId, key, request.agentId, request.conversationId, request.created ? 1 : 0],
        ).pipe(Effect.asVoid),
      recentSends: (senderId, limit, since) =>
        one(
          Schema.Struct({ count: M.Count, oldest: Schema.NullOr(timestamp) }),
          `SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM (
             SELECT created_at FROM messages INDEXED BY messages_sender_seq
             WHERE sender_id=? ORDER BY seq DESC LIMIT ?) WHERE created_at>?`,
          [senderId, limit, epoch(since)],
        ).pipe(Effect.map((row) => row ?? { count: 0, oldest: null })),
      participants: (name, after, limit, query = "", state = "all") =>
        all(
          participantRow,
          `SELECT ${participantColumns} FROM participants
        WHERE (? IS NULL OR name=? COLLATE NOCASE) AND (? IS NULL OR name>? COLLATE NOCASE) AND instr(lower(name || ' ' || agent_type || ' ' || COALESCE(working_directory,'')),lower(?))>0
        AND ${participantStates[state]} ORDER BY name COLLATE NOCASE LIMIT ?`,
          [name, name, after, after, query, limit],
        ),
      setRemoved: Effect.fn("Sqlite.setRemoved")(function* (change) {
        const at = epoch(change.at);
        if (change.action === "removed")
          yield* execute(
            "INSERT INTO participant_removals(participant_id,removed_by_participant_id,removed_at) VALUES(?,?,?)",
            [change.participantId, change.byId, at],
          );
        else
          yield* execute("DELETE FROM participant_removals WHERE participant_id=?", [
            change.participantId,
          ]);
        yield* execute(
          "INSERT INTO participant_removal_events(participant_id,action,by_participant_id,created_at) VALUES(?,?,?,?)",
          [change.participantId, change.action, change.byId, at],
        );
      }),
      recentRemovals: (limit) =>
        all(
          removalEventRow,
          `SELECT e.seq AS sequence, e.action, e.participant_id AS participantId, p.name,
             json_object('participantId',b.id,'name',b.name) AS "by", e.created_at AS at
           FROM participant_removal_events e
           JOIN participants p ON p.id=e.participant_id
           JOIN participants b ON b.id=e.by_participant_id
           ORDER BY e.seq DESC LIMIT ?`,
          [limit],
        ),
      recentParticipants: (limit) =>
        all(
          participantRow,
          `SELECT ${participantColumns} FROM participants WHERE ${agentsOnly}
           ORDER BY last_message_at DESC, name COLLATE NOCASE, id LIMIT ?`,
          [limit],
        ),
      conversation: Effect.fn("Sqlite.conversation")(function* (id) {
        const found = yield* channel(id);
        return (
          found ??
          (yield* one(
            directRow,
            `SELECT ${directColumns} FROM conversations WHERE kind='direct' AND id=?`,
            [id],
          ))
        );
      }),
      channelNamed: (name) =>
        one(
          channelRow,
          `SELECT ${channelColumns} FROM conversations WHERE kind='channel' AND name=? COLLATE NOCASE`,
          [name],
        ),
      channelCreation: (grant, key) =>
        one(
          channelCreationRow,
          `SELECT ${channelColumns},${creationColumns} FROM conversations WHERE kind='channel' AND created_by_grant_id=? AND request_key=?`,
          [grant, key],
        ).pipe(Effect.map(creation)),
      addChannel: ({ item, grantId, requestKey }) =>
        execute(
          `INSERT INTO conversations(id,kind,name,description,created_by_participant_id,created_by_grant_id,request_key,created_at)
        VALUES(?,'channel',?,?,?,?,?,?)`,
          [
            item.id,
            item.name,
            item.description,
            item.createdByParticipantId,
            grantId,
            requestKey,
            epoch(item.createdAt),
          ],
        ).pipe(Effect.asVoid),
      channels: (state, after, limit, query = "") =>
        all(
          channelRow,
          `SELECT ${channelColumns} FROM conversations WHERE kind='channel'
        AND (?='all' OR (?='active' AND archived_at IS NULL) OR (?='archived' AND archived_at IS NOT NULL))
        AND (? IS NULL OR name>? COLLATE NOCASE) AND instr(lower(name),lower(?))>0 ORDER BY name COLLATE NOCASE LIMIT ?`,
          [state, state, state, after, after, query, limit],
        ),
      direct: (low, high) =>
        one(
          directRow,
          `SELECT ${directColumns} FROM conversations WHERE kind='direct' AND participant_low_id=? AND participant_high_id=?`,
          [low, high],
        ),
      addDirect: (item, grantId) =>
        execute(
          `INSERT INTO conversations(id,kind,participant_low_id,participant_high_id,created_by_participant_id,created_by_grant_id,created_at)
        VALUES(?,'direct',?,?,?,?,?)`,
          [
            item.id,
            ...item.participantIds,
            item.createdByParticipantId,
            grantId,
            epoch(item.createdAt),
          ],
        ).pipe(Effect.asVoid),
      directs: (withParticipant, after, limit) =>
        all(
          directRow,
          `SELECT ${directColumns} FROM conversations WHERE kind='direct'
        AND (? IS NULL OR participant_low_id=? OR participant_high_id=?) AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`,
          [withParticipant, withParticipant, withParticipant, after, after, limit],
        ),
      archive: (id, archivedAt, revision) =>
        execute("UPDATE conversations SET archived_at=?,revision=? WHERE id=?", [
          archivedAt === null ? null : epoch(archivedAt),
          revision,
          id,
        ]).pipe(Effect.asVoid),
      message: (id) => one(messageRow, `SELECT ${messageColumns} FROM messages WHERE id=?`, [id]),
      messageCreation: (grant, key) =>
        one(
          messageCreationRow,
          `SELECT ${messageColumns},${creationColumns} FROM messages WHERE created_by_grant_id=? AND request_key=?`,
          [grant, key],
        ).pipe(Effect.map(creation)),
      append: Effect.fn("Sqlite.append")(function* (item) {
        yield* execute(
          `INSERT INTO messages(id,conversation_id,sender_id,created_by_grant_id,request_key,body,created_at) VALUES(?,?,?,?,?,?,?)`,
          [
            item.id,
            item.conversationId,
            item.senderId,
            item.grantId,
            item.requestKey,
            item.body,
            epoch(item.createdAt),
          ],
        );
        const message = yield* session.message(item.id);
        if (message === null) return yield* Effect.die("Inserted message is missing");
        return message;
      }),
      activityBuckets: (start, end, bucketMillis) =>
        all(
          Schema.Struct({ bucket: M.Count, messageCount: M.Count, participantCount: M.Count }),
          `SELECT CAST((created_at-?-1)/? AS INTEGER) AS bucket, COUNT(*) AS messageCount,
           COUNT(DISTINCT CASE WHEN ${notPerson("sender_id")} THEN sender_id END) AS participantCount
           FROM messages WHERE created_at>? AND created_at<=? GROUP BY bucket ORDER BY bucket`,
          [epoch(start), bucketMillis, epoch(start), epoch(end)],
        ),
      activityTotals: (start, end) =>
        one(
          Schema.Struct({
            messageCount: M.Count,
            participantCount: M.Count,
            firstMessageAt: Schema.NullOr(timestamp),
            lastMessageAt: Schema.NullOr(timestamp),
          }),
          `SELECT COUNT(*) AS messageCount,
           COUNT(DISTINCT CASE WHEN ${notPerson("sender_id")} THEN sender_id END) AS participantCount,
           MIN(created_at) AS firstMessageAt, MAX(created_at) AS lastMessageAt
           FROM messages WHERE created_at>? AND created_at<=?`,
          [epoch(start), epoch(end)],
        ).pipe(
          Effect.map(
            (row) =>
              row ?? {
                messageCount: 0,
                participantCount: 0,
                firstMessageAt: null,
                lastMessageAt: null,
              },
          ),
        ),
      activitySenders: (start, end, options) =>
        all(
          D.TimelineSender,
          `SELECT p.id, p.name, p.agent_type AS agentType, ranked.messageCount
           FROM (SELECT sender_id, COUNT(*) AS messageCount FROM messages
             WHERE created_at>? AND created_at<=? AND (? IS NULL OR seq<=?)
             GROUP BY sender_id) ranked
           JOIN participants p ON p.id=ranked.sender_id
           WHERE p.kind IS NULL AND (? IS NULL OR ranked.messageCount<? OR (ranked.messageCount=? AND p.id>?))
           ORDER BY ranked.messageCount DESC, p.id LIMIT ?`,
          [
            epoch(start),
            epoch(end),
            options.ceiling ?? null,
            options.ceiling ?? null,
            options.after?.messageCount ?? null,
            options.after?.messageCount ?? null,
            options.after?.messageCount ?? null,
            options.after?.id ?? null,
            options.limit,
          ],
        ),
      activityCount: (start, end) =>
        one(
          Schema.Struct({ count: M.Count }),
          "SELECT COUNT(*) AS count FROM messages WHERE created_at>? AND created_at<=?",
          [epoch(start), epoch(end)],
        ).pipe(Effect.map((row) => row?.count ?? 0)),
      messagesByIds: (ids) =>
        all(
          messageRow,
          `SELECT ${messageColumns} FROM messages WHERE id IN (SELECT value FROM json_each(?)) ORDER BY seq`,
          [JSON.stringify(ids)],
        ),
      latestMessage: () =>
        one(messageRow, `SELECT ${messageColumns} FROM messages ORDER BY seq DESC LIMIT 1`),
      messages: (selection) => {
        const conditions = ["seq<=?", selection.direction === "older" ? "seq<?" : "seq>?"];
        const bindings: SqlStorageValue[] = [selection.ceiling, selection.boundary];
        if (selection.conversationId !== null) {
          conditions.push("conversation_id=?");
          bindings.push(selection.conversationId);
        }
        if (selection.senderId !== null) {
          conditions.push("sender_id=?");
          bindings.push(selection.senderId);
        }
        if (selection.afterTime !== null) {
          conditions.push("created_at>?");
          bindings.push(epoch(selection.afterTime));
        }
        if (selection.beforeTime !== null) {
          conditions.push("created_at<?");
          bindings.push(epoch(selection.beforeTime));
        }
        if (selection.throughTime != null) {
          conditions.push("created_at<=?");
          bindings.push(epoch(selection.throughTime));
        }
        if (selection.fromTime != null) {
          conditions.push("created_at>=?");
          bindings.push(epoch(selection.fromTime));
        }
        if (selection.search !== null) {
          conditions.push("seq IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
          bindings.push(selection.search);
        }
        bindings.push(selection.limit);
        const direction = selection.direction === "older" ? "DESC" : "ASC";
        return all(
          messageRow,
          `SELECT ${messageColumns} FROM messages WHERE ${conditions.join(" AND ")} ORDER BY seq ${direction} LIMIT ?`,
          bindings,
        );
      },
      revokeGrant: (id, at) =>
        execute(
          "UPDATE server_grants SET revoked_at=MAX(created_at,?) WHERE id=? AND revoked_at IS NULL",
          [epoch(at), id],
        ).pipe(Effect.asVoid),
      fileRepository: () =>
        one(
          repositoryRow,
          "SELECT remote,default_branch AS defaultBranch FROM file_repository WHERE singleton=1",
        ).pipe(
          // A row that no longer parses as a repository (a provider stub once stringified into
          // it) reads as missing, so the next access or view re-ensures and rewrites it.
          Effect.map((row) =>
            row === null
              ? null
              : Result.getOrNull(Schema.decodeUnknownResult(Files.Repository)(row)),
          ),
        ),
      setFileRepository: (repository, createdAt) =>
        execute(
          "INSERT INTO file_repository(singleton,remote,default_branch,created_at) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET remote=excluded.remote,default_branch=excluded.default_branch",
          [repository.remote, repository.defaultBranch, epoch(createdAt)],
        ).pipe(Effect.asVoid),
      addFileToken: (token) =>
        execute(
          "INSERT INTO file_tokens(id,token_id,participant_id,grant_id,scope,issued_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)",
          [
            token.id,
            token.tokenId,
            token.participantId,
            token.grantId,
            token.scope,
            epoch(token.issuedAt),
            token.expiresAt === null ? null : epoch(token.expiresAt),
            token.revokedAt === null ? null : epoch(token.revokedAt),
          ],
        ).pipe(Effect.asVoid),
      revocableFileTokens: (at) =>
        all(
          tokenRow,
          `SELECT ${tokenColumns} FROM file_tokens WHERE revoked_at IS NULL
           AND grant_id IN (SELECT id FROM server_grants WHERE revoked_at IS NOT NULL)
           AND (expires_at IS NULL OR expires_at>?) ORDER BY issued_at, id`,
          [epoch(at)],
        ),
      revokeFileToken: (id, at) =>
        execute(
          "UPDATE file_tokens SET revoked_at=MAX(issued_at,?) WHERE id=? AND revoked_at IS NULL",
          [epoch(at), id],
        ).pipe(Effect.asVoid),
      addShare: (message, share) =>
        execute(
          "INSERT INTO message_shares(message_id,seq,path,commit_hash,ref,bytes) VALUES(?,?,?,?,?,?)",
          [message.id, message.sequence, share.path, share.commit, share.ref, share.bytes ?? null],
        ).pipe(Effect.asVoid),
      addTransfer: (transfer) =>
        execute(
          `INSERT INTO file_transfers(id,sender_id,grant_id,request_key,name,kind,bytes,sha256,file_count,manifest_bytes,created_at,upload_expires_at,expires_at,pool_state)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            transfer.id,
            transfer.senderId,
            transfer.grantId,
            transfer.requestKey,
            transfer.name,
            transfer.kind,
            transfer.bytes,
            transfer.sha256,
            transfer.fileCount,
            transfer.manifestBytes,
            epoch(transfer.createdAt),
            epoch(transfer.uploadExpiresAt),
            epoch(transfer.expiresAt),
            transfer.poolState,
          ],
        ).pipe(Effect.asVoid),
      transfer: (id) =>
        one(transferRow, `SELECT ${transferColumns} FROM file_transfers WHERE id=?`, [id]),
      transferCreation: (grantId, requestKey) =>
        one(
          transferRow,
          `SELECT ${transferColumns} FROM file_transfers WHERE grant_id=? AND request_key=?`,
          [grantId, requestKey],
        ),
      renewTransferUpload: (id, uploadExpiresAt) =>
        execute("UPDATE file_transfers SET upload_expires_at=? WHERE id=?", [
          epoch(uploadExpiresAt),
          id,
        ]).pipe(Effect.asVoid),
      confirmTransferPool: (id) =>
        execute(
          "UPDATE file_transfers SET pool_state='reserved' WHERE id=? AND pool_state='pending'",
          [id],
        ).pipe(Effect.asVoid),
      forgetPendingTransfer: (id) =>
        execute(
          "DELETE FROM file_transfers WHERE id=? AND pool_state='pending' AND message_id IS NULL",
          [id],
        ).pipe(Effect.asVoid),
      attachTransfer: (id, messageId) =>
        execute("UPDATE file_transfers SET message_id=? WHERE id=? AND message_id IS NULL", [
          messageId,
          id,
        ]).pipe(Effect.asVoid),
      addTransferFetch: (id, participantId, at) =>
        execute(
          "INSERT INTO file_transfer_fetches(transfer_id,participant_id,first_fetched_at) VALUES(?,?,?) ON CONFLICT DO NOTHING",
          [id, participantId, epoch(at)],
        ).pipe(Effect.asVoid),
      transferFetches: (id) =>
        all(
          transferFetchRow,
          `SELECT participant_id AS participantId, first_fetched_at AS firstFetchedAt FROM file_transfer_fetches
           WHERE transfer_id=? ORDER BY first_fetched_at, participant_id LIMIT 100`,
          [id],
        ),
      // The expiry index orders the listing; ties on expiry fall back to the ID.
      transfers: (before, limit) =>
        all(
          transferEntryRow,
          `SELECT t.id, t.name, t.kind, t.bytes, t.file_count AS fileCount, t.sender_id AS senderId,
            t.message_id AS messageId, m.conversation_id AS conversationId, m.seq AS messageSequence,
            t.created_at AS createdAt, t.expires_at AS expiresAt
           FROM file_transfers t LEFT JOIN messages m ON m.id=t.message_id
           WHERE t.expires_at<? OR (t.expires_at=? AND t.id<?)
           ORDER BY t.expires_at DESC, t.id DESC LIMIT ?`,
          before === null
            ? [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "", limit]
            : [epoch(before.expiresAt), epoch(before.expiresAt), before.id, limit],
        ),
      addNotice: (message, notice) =>
        execute("INSERT INTO message_notices(message_id,seq,kind,channel_id) VALUES(?,?,?,?)", [
          message.id,
          message.sequence,
          notice.kind,
          notice.channelId,
        ]).pipe(Effect.asVoid),
      addJoinNotice: (message, participantId) =>
        execute("INSERT INTO join_notices(message_id,seq,participant_id) VALUES(?,?,?)", [
          message.id,
          message.sequence,
          participantId,
        ]).pipe(Effect.asVoid),
      addMentions: Effect.fn("Sqlite.addMentions")(function* (message, participantIds) {
        for (const [position, participantId] of participantIds.entries())
          yield* execute(
            "INSERT INTO message_mentions(participant_id,seq,position) VALUES(?,?,?)",
            [participantId, message.sequence, position],
          );
      }),
      addPriority: (message) =>
        execute("INSERT INTO message_priority(message_id,seq,priority) VALUES(?,?,'urgent')", [
          message.id,
          message.sequence,
        ]).pipe(Effect.asVoid),
      addConfirms: Effect.fn("Sqlite.addConfirms")(function* (message, participantIds) {
        for (const [position, participantId] of participantIds.entries())
          yield* execute(
            "INSERT INTO message_confirms(seq,participant_id,position) VALUES(?,?,?)",
            [message.sequence, participantId, position],
          );
      }),
      markConfirmed: (message, participantId, at) =>
        execute(
          "UPDATE message_confirms SET confirmed_at=? WHERE seq=? AND participant_id=? AND confirmed_at IS NULL",
          [epoch(at), message.sequence, participantId],
        ).pipe(Effect.asVoid),
      addConfirmNotice: (message, confirmedId) =>
        execute("INSERT INTO confirm_notices(message_id,seq,confirmed_message_id) VALUES(?,?,?)", [
          message.id,
          message.sequence,
          confirmedId,
        ]).pipe(Effect.asVoid),
      shares: (boundary, limit) =>
        all(
          messageRow,
          `SELECT ${messageColumns} FROM messages WHERE seq IN
           (SELECT seq FROM message_shares WHERE seq<? ORDER BY seq DESC LIMIT ?) ORDER BY seq DESC`,
          [boundary, limit],
        ),
      historyLimit: () =>
        one(
          historyRow,
          `SELECT r.plan, r.days, r.archived, r.pruned_through_at AS throughAt,
           r.pruned_through_seq AS throughSequence, COALESCE(z.capped,0) AS capped
           FROM history_retention r LEFT JOIN history_size z ON z.singleton=1
           WHERE r.singleton=1 AND r.pruned_through_seq IS NOT NULL AND r.plan IS NOT NULL`,
        ),
    };
    return Persistence.Persistence.of({
      transaction: <A, E>(
        operation: string,
        body: (tx: Persistence.Session) => Effect.Effect<A, E>,
      ) =>
        Effect.withFiber<A, E | StorageUnavailable, never>((fiber) => {
          let failure: Cause.Cause<E> | undefined;
          const rollback = new Error("Roll back failed synchronous application operation");
          try {
            const value = storage.transactionSync(() => {
              // This boundary deliberately runs only synchronous local effects. An async effect is a defect.
              const context =
                fiber.currentSpan === undefined
                  ? fiber.context
                  : Context.add(fiber.context, Tracer.ParentSpan, fiber.currentSpan);
              const exit = Effect.runSyncExitWith(context)(body(session));
              if (Exit.isFailure(exit)) {
                failure = exit.cause;
                throw rollback;
              }
              return exit.value;
            });
            return Effect.succeed(value);
          } catch (cause) {
            if (failure !== undefined) {
              for (const reason of failure.reasons) {
                if (Cause.isDieReason(reason) && Predicate.isError(reason.defect))
                  Telemetry.storageDefect(operation, reason.defect);
              }
              return Effect.failCause(failure);
            }
            if (transient(cause)) return Effect.fail(unavailable(operation));
            if (Predicate.isError(cause)) Telemetry.storageDefect(operation, cause);
            return Effect.die(cause);
          }
        }),
    });
  });
}

/**
 * Give an invited agent its one grant (docs/agent-invites.md): the grant's ID is the invited
 * agent's, under `invited:<id>`. Repeating it changes nothing.
 */
export const grantInvited = Effect.fn("Sqlite.grantInvited")(function* (
  storage: DurableObjectStorage,
  id: string,
  at: number,
) {
  yield* Effect.try({
    try: () =>
      storage.sql.exec(
        "INSERT INTO server_grants(id,principal_key,created_at,revoked_at) VALUES(?,?,?,NULL) ON CONFLICT(id) DO NOTHING",
        id,
        Access.invitedPrincipal(id),
        at,
      ),
    catch: () => unavailable("grantInvited"),
  });
});

/**
 * Record an admitted agent: its one participant, its key's hash and its lineage. Picking the key up
 * again replaces the hash, so only the newest key works.
 */
export const recordInvited = Effect.fn("Sqlite.recordInvited")(function* (
  storage: DurableObjectStorage,
  row: {
    readonly id: string;
    readonly participantId: M.ParticipantId;
    readonly keyHash: string;
    readonly lineage: string;
    readonly at: number;
  },
) {
  yield* Effect.try({
    try: () =>
      storage.sql.exec(
        "INSERT INTO invited_agents(id,participant_id,key_hash,lineage,admitted_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash",
        row.id,
        row.participantId,
        row.keyHash,
        row.lineage,
        row.at,
      ),
    catch: () => unavailable("recordInvited"),
  });
});

/** Invited agents' lineage JSON by participant, for the participants listed. */
/** The name and ID an invite chain shows once the person it began with deleted their account. */
export const deletedOrigin = { userId: "deleted", name: "Deleted person" } as const;
/** Invited agents whose chain began with this person stop naming them. */
export const forgetInviteOrigin = Effect.fn("Sqlite.forgetInviteOrigin")(function* (
  storage: DurableObjectStorage,
  userId: string,
) {
  yield* Effect.try({
    try: () =>
      storage.sql.exec(
        "UPDATE invited_agents SET lineage=json_set(lineage,'$.origin',?,'$.originUserId',?) WHERE json_extract(lineage,'$.originUserId')=?",
        deletedOrigin.name,
        deletedOrigin.userId,
        userId,
      ),
    catch: () => unavailable("forgetInviteOrigin"),
  });
});
/** Whether a participant on the server already has this name (any case), removed ones included. */
export const nameTaken = Effect.fn("Sqlite.nameTaken")(function* (
  storage: DurableObjectStorage,
  name: string,
) {
  return yield* Effect.try({
    try: () =>
      storage.sql.exec("SELECT 1 FROM participants WHERE name=? COLLATE NOCASE", name).toArray()
        .length > 0,
    catch: () => unavailable("nameTaken"),
  });
});
/** Whether a participant was removed from the server. */
export const isRemoved = Effect.fn("Sqlite.isRemoved")(function* (
  storage: DurableObjectStorage,
  participantId: string,
) {
  return yield* Effect.try({
    try: () =>
      storage.sql
        .exec("SELECT 1 FROM participant_removals WHERE participant_id=?", participantId)
        .toArray().length > 0,
    catch: () => unavailable("isRemoved"),
  });
});
/** Whether an invited agent was already admitted (a second pickup rotates its key). */
export const isAdmitted = Effect.fn("Sqlite.isAdmitted")(function* (
  storage: DurableObjectStorage,
  id: string,
) {
  return yield* Effect.try({
    try: () => storage.sql.exec("SELECT 1 FROM invited_agents WHERE id=?", id).toArray().length > 0,
    catch: () => unavailable("isAdmitted"),
  });
});
/** The agents one agent invited directly that are still on the server. */
export const invitedBy = Effect.fn("Sqlite.invitedBy")(function* (
  storage: DurableObjectStorage,
  participantId: string,
) {
  return yield* Effect.try({
    try: () =>
      storage.sql
        .exec<{ participant_id: string }>(
          `SELECT i.participant_id FROM invited_agents i
           WHERE json_extract(i.lineage,'$.invitedBy.participantId')=?
           AND NOT EXISTS (SELECT 1 FROM participant_removals r WHERE r.participant_id=i.participant_id)
           ORDER BY i.admitted_at`,
          participantId,
        )
        .toArray()
        .map((row) => M.ParticipantId.make(row.participant_id)),
    catch: () => unavailable("invitedBy"),
  });
});
export const invitedLineage = Effect.fn("Sqlite.invitedLineage")(function* (
  storage: DurableObjectStorage,
) {
  return yield* Effect.try({
    try: () =>
      new Map(
        storage.sql
          .exec<{ participant_id: string; lineage: string }>(
            "SELECT participant_id,lineage FROM invited_agents",
          )
          .toArray()
          .map((row) => [row.participant_id, row.lineage] as const),
      ),
    catch: () => unavailable("invitedLineage"),
  });
});

/**
 * The agent making an invite, if the caller may act as it: an agent (not a person's participant),
 * not removed, registered through the caller's own principal (an invited agent only ever matches
 * its own participant). Its stored lineage too when it was itself invited.
 */
export const inviter = Effect.fn("Sqlite.inviter")(function* (
  storage: DurableObjectStorage,
  principalKey: Access.PrincipalKey,
  participantId: string,
) {
  return yield* Effect.try({
    try: () => {
      const row = storage.sql
        .exec<{ id: string; name: string; principal: string | null; lineage: string | null }>(
          `SELECT p.id,p.name,g.principal_key AS principal,i.lineage FROM participants p
           LEFT JOIN server_grants g ON g.id=p.created_by_grant_id
           LEFT JOIN invited_agents i ON i.participant_id=p.id
           WHERE p.id=? AND p.kind IS NULL
           AND NOT EXISTS (SELECT 1 FROM participant_removals r WHERE r.participant_id=p.id)`,
          participantId,
        )
        .toArray()[0];
      if (row === undefined) return null;
      // Only the agent's own registrant invites as it; an agent with none recorded invites for
      // nobody (its person invites as themselves instead).
      const own = row.principal === principalKey;
      return { id: row.id, name: row.name, own, lineage: row.lineage };
    },
    catch: () => unavailable("inviter"),
  });
});
