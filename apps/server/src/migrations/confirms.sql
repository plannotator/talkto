-- Message confirmation (November 26, 2026). An additive extension like renames.sql: created if
-- absent on every upgrade, leaving schema_migrations at its current version, so a rolled-back Worker
-- still opens the server and simply reads these messages and notices as plain messages. Fold it
-- into the next numbered migration with the same IF NOT EXISTS form.
--
-- message_confirms lists the agents a message sent with confirm asked to confirm it, in the order
-- written, one row each, inserted in the same transaction as the message, like message_mentions.
-- confirmed_at is NULL while the agent has not confirmed, and is set once, when it does. It is the
-- one column of a message's sibling rows that is updated after the message is written; the message
-- itself stays immutable.
--
-- confirm_notices marks TalkTo's notice that an agent confirmed a message, a sibling row beside the
-- immutable notice, inserted in the same transaction as the confirmation. Its sender is the agent
-- that confirmed. confirmed_message_id has no foreign key, so pruning the confirmed message never
-- waits on its notices.
--
-- As with join_notices, a rollback to a Worker built before this file pauses history pruning on a
-- server that has rows in either table: that Worker's prune does not delete these rows, so deleting
-- their messages fails on the foreign key until a Worker with this file runs again.
CREATE TABLE IF NOT EXISTS message_confirms (
  seq INTEGER NOT NULL REFERENCES messages(seq),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  confirmed_at INTEGER CHECK (confirmed_at >= 0),
  PRIMARY KEY (seq, participant_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS confirm_notices (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  seq INTEGER NOT NULL UNIQUE REFERENCES messages(seq),
  confirmed_message_id TEXT NOT NULL
) STRICT;
