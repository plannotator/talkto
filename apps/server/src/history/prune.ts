import { Schema } from "effect";
import * as M from "@talkto/api/models";
import type * as Model from "./model.js";

/** Messages one prune batch removes at most; small enough for a fraction of one request's CPU. */
export const batchSize = 250;
/** Batches one pass runs at most before leaving the rest to the next pass. */
export const batchesPerPass = 2;

const candidateRow = Schema.Struct({ seq: M.Count, id: M.MessageId, createdAt: M.Count });
const decodeCandidates = Schema.decodeUnknownSync(Schema.Array(candidateRow));
const decodeKept = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ seq: M.Count })));

/** One batch of messages older than the window, oldest first. */
export interface Batch {
  readonly ids: ReadonlyArray<M.MessageId>;
  readonly sequences: ReadonlyArray<number>;
  readonly throughSequence: number;
  /** The newest creation time in the batch, in epoch milliseconds. */
  readonly throughAt: number;
  readonly oldestAt: number;
}

/**
 * The oldest messages created before `cutoff`, at most `limit`. Three kinds stay: each
 * conversation's newest message, which the conversation's preview and counters point to, a
 * message whose file transfer has not expired yet, and a task's brief, question or result while
 * the task is kept (`removeTasks`). Reads at most `limit` rows plus one per kept
 * message on the creation-time index; the caller spaces passes out once nothing is left.
 */
export const select = (
  storage: DurableObjectStorage,
  cutoff: number,
  now: number,
  limit: number,
): Batch | null => {
  const kept = new Set(
    decodeKept(
      storage.sql
        .exec(
          "SELECT last_message_seq AS seq FROM conversations WHERE last_message_seq IS NOT NULL AND last_message_at<?",
          cutoff,
        )
        .toArray(),
    ).map((row) => row.seq),
  );
  const rows = decodeCandidates(
    storage.sql
      .exec(
        `SELECT m.seq, m.id, m.created_at AS createdAt FROM messages m INDEXED BY messages_created_at_seq
         WHERE m.created_at<? AND NOT EXISTS
           (SELECT 1 FROM file_transfers t WHERE t.message_id=m.id AND t.expires_at>?)
         AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.brief_message_id=m.id)
         AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.outcome_message_id=m.id)
         AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.block_message_id=m.id)
         ORDER BY m.created_at, m.seq LIMIT ?`,
        cutoff,
        now,
        limit + kept.size,
      )
      .toArray(),
  )
    .filter((row) => !kept.has(row.seq))
    .slice(0, limit);
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) return null;
  return {
    ids: rows.map((row) => row.id),
    sequences: rows.map((row) => row.seq),
    throughSequence: Math.max(...rows.map((row) => row.seq)),
    throughAt: Math.max(...rows.map((row) => row.createdAt)),
    oldestAt: first.createdAt,
  };
};

/**
 * Delete one selected batch and everything stored beside its messages, in one transaction. The
 * retention guard is raised to the batch's newest sequence only for this transaction, so every
 * other DELETE on messages still aborts. Search entries go with their rows (retention.sql).
 * Conversation and participant counters keep their lifetime totals.
 */
export const remove = (
  storage: DurableObjectStorage,
  batch: Batch,
  applied: Model.Policy,
  /** The storage cap chose this batch, not the time window (history-size.sql). */
  capped = false,
) => {
  if (applied.plan === null || applied.days === null) throw new Error("Nothing to prune");
  const sequences = JSON.stringify(batch.sequences);
  const ids = JSON.stringify(batch.ids);
  storage.transactionSync(() => {
    storage.sql.exec(
      "UPDATE history_retention SET deletable_through=? WHERE singleton=1",
      batch.throughSequence,
    );
    for (const table of [
      "message_priority",
      "message_mentions",
      "message_notices",
      "join_notices",
      "message_confirms",
      "confirm_notices",
      "message_shares",
      // A task's other thread messages (notes) go like any message; their thread rows first.
      "task_message_recipients",
      "task_messages",
    ])
      storage.sql.exec(
        `DELETE FROM ${table} WHERE seq IN (SELECT value FROM json_each(?))`,
        sequences,
      );
    storage.sql.exec(
      "DELETE FROM file_transfer_fetches WHERE transfer_id IN (SELECT id FROM file_transfers WHERE message_id IN (SELECT value FROM json_each(?)))",
      ids,
    );
    storage.sql.exec(
      "DELETE FROM file_transfers WHERE message_id IN (SELECT value FROM json_each(?))",
      ids,
    );
    storage.sql.exec(
      "DELETE FROM messages WHERE seq IN (SELECT value FROM json_each(?))",
      sequences,
    );
    storage.sql.exec(
      `UPDATE history_retention SET deletable_through=0,
       pruned_through_seq=MAX(COALESCE(pruned_through_seq,0),?),
       pruned_through_at=MAX(COALESCE(pruned_through_at,0),?),
       plan=?, days=?, archived=?, removed=removed+? WHERE singleton=1`,
      batch.throughSequence,
      batch.throughAt,
      applied.plan,
      applied.days,
      applied.archive ? 1 : 0,
      batch.sequences.length,
    );
    if (capped) storage.sql.exec("UPDATE history_size SET capped=1 WHERE singleton=1");
  });
};
/** What this server's history weighs, as the storage caps measure it (history-size.sql). */
export const size = (storage: DurableObjectStorage) =>
  Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ bytes: M.Count })))(
    storage.sql.exec("SELECT bytes FROM history_size WHERE singleton=1").toArray(),
  )[0]?.bytes ?? 0;

/** Finished tasks one prune transaction removes at most. */
export const taskBatchSize = 100;
const decodeIds = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })));
const decodeRange = Schema.decodeUnknownSync(
  Schema.Struct({ seq: Schema.NullOr(M.Count), at: Schema.NullOr(M.Count) }),
);
/**
 * Remove tasks that finished before `cutoff`, at most `limit`, with everything stored beside them,
 * except a failed or canceled task that an unfinished task still needs (its cascade is not done),
 * children first (board.sql's foreign keys), in one transaction. Their briefs and results then
 * leave with the next message batch. Unfinished tasks always stay, whatever their age. The newest
 * removed event raises `history_retention`'s pruned range, as a removed message does (spec 2.5);
 * the updates head does not fall with it (it is the sequence's high-water mark). Returns how many
 * tasks it removed.
 */
export const removeTasks = (
  storage: DurableObjectStorage,
  cutoff: number,
  limit: number,
  applied: Model.Policy,
) => {
  const selected = decodeIds(
    storage.sql
      .exec(
        `SELECT t.id FROM tasks t WHERE t.finished_at IS NOT NULL AND t.finished_at<?
         AND (t.state='completed' OR NOT EXISTS (SELECT 1 FROM task_needs n JOIN tasks d ON d.id=n.task_id
           WHERE n.need_id=t.id AND d.state IN ('waiting','ready','claimed','blocked')))
         ORDER BY t.finished_at LIMIT ?`,
        cutoff,
        limit,
      )
      .toArray(),
  ).map((row) => row.id);
  if (selected.length === 0) return 0;
  const ids = JSON.stringify(selected);
  storage.transactionSync(() => {
    const within = "(SELECT value FROM json_each(?))";
    const range = decodeRange(
      storage.sql
        .exec(
          `SELECT MAX(seq) AS seq, MAX(created_at) AS at FROM task_events WHERE task_id IN ${within}`,
          ids,
        )
        .one(),
    );
    if (range.seq !== null && range.at !== null && applied.plan !== null && applied.days !== null)
      storage.sql.exec(
        `UPDATE history_retention SET pruned_through_seq=MAX(COALESCE(pruned_through_seq,0),?),
         pruned_through_at=MAX(COALESCE(pruned_through_at,0),?), plan=?, days=?, archived=?
         WHERE singleton=1`,
        range.seq,
        range.at,
        applied.plan,
        applied.days,
        applied.archive ? 1 : 0,
      );
    storage.sql.exec(
      `DELETE FROM task_event_recipients WHERE seq IN (SELECT seq FROM task_events WHERE task_id IN ${within})`,
      ids,
    );
    storage.sql.exec(`DELETE FROM task_events WHERE task_id IN ${within}`, ids);
    storage.sql.exec(
      `DELETE FROM task_message_recipients WHERE seq IN (SELECT seq FROM task_messages WHERE task_id IN ${within})`,
      ids,
    );
    storage.sql.exec(`DELETE FROM task_messages WHERE task_id IN ${within}`, ids);
    // The removed tasks' own needs, and the edges to them from tasks that stay (the foreign key
    // needs both gone). A task that stays loses only an edge to a completed need, which no longer
    // counts, or to a failed or canceled one whose dependents all finished: the selection keeps a
    // failed or canceled task while any task needing it is unfinished, so its cascade still finds it.
    storage.sql.exec(
      `DELETE FROM task_needs WHERE task_id IN ${within} OR need_id IN ${within}`,
      ids,
      ids,
    );
    storage.sql.exec(`DELETE FROM task_labels WHERE task_id IN ${within}`, ids);
    storage.sql.exec(`DELETE FROM task_holders WHERE task_id IN ${within}`, ids);
    storage.sql.exec(`DELETE FROM task_finishers WHERE task_id IN ${within}`, ids);
    storage.sql.exec(`DELETE FROM task_requests WHERE task_id IN ${within}`, ids);
    storage.sql.exec(`DELETE FROM tasks WHERE id IN ${within}`, ids);
    storage.sql.exec(
      "DELETE FROM task_batches WHERE finished_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.batch_id=task_batches.id)",
    );
  });
  return selected.length;
};
