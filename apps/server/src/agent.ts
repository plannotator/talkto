import { Effect } from "effect";
import * as A from "@talkto/api/agent";
import type { Position } from "@talkto/api/inputs";
import * as M from "@talkto/api/models";
import * as E from "@talkto/api/errors";
import * as TalkTo from "./talkto.js";
import type { AccessContext } from "./access.js";
import * as Responses from "./responses.js";
import { agentGuide } from "./guide.js";
import { renderDocumentation } from "@talkto/api/documentation";
import * as U from "@talkto/api/updates";
import * as Monitoring from "./monitoring.js";
import * as Reads from "./reads.js";
import * as S from "@talkto/api/signal";
import * as Signals from "./signals.js";
import * as W from "@talkto/api/wake";
import * as Wakes from "./wakes/service.js";
import * as Actors from "./actors.js";
import * as R from "@talkto/api/renames";
import * as Capabilities from "./capabilities.js";
import * as T from "@talkto/api/tasks";
import * as Board from "./board/service.js";
import { present } from "./present.js";

const invalid = (message: string) => new E.InvalidInput({ message });
const merge = (...values: ReadonlyArray<M.Included>): M.Included => ({
  participants: [...new Map(values.flatMap((v) => v.participants).map((v) => [v.id, v])).values()],
  conversations: [
    ...new Map(values.flatMap((v) => v.conversations).map((v) => [v.id, v])).values(),
  ],
});
// Keep rich directories useful even when profiles contain long notes and paths.
const directory = Effect.fn("Agent.boundedDirectory")(function* <T, F>(
  read: (limit: number) => Effect.Effect<M.Outcome<M.Page<T>>, F>,
  maximum = 100,
) {
  let limit = maximum;
  for (;;) {
    const result = yield* read(limit);
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    if (bytes <= 32768 || limit === 1) return result;
    // Re-query at the smaller limit so the service supplies the correct continuation cursor.
    limit = Math.max(1, Math.floor(((limit * 32768) / bytes) * 0.9));
  }
});
const context = Effect.fn("Agent.context")(function* (
  access: AccessContext,
  input: A.GetContext,
  capabilities: ReadonlySet<A.Capability>,
) {
  const service = yield* TalkTo.Service;
  const server = yield* service.getServer(access);
  let self: M.Participant | null = null;
  if (input.participant !== undefined) {
    if ("id" in input.participant)
      self = (yield* service.getParticipant(access, input.participant.id)).data;
    else {
      const found = yield* service.listParticipants(access, {
        name: input.participant.name,
        limit: 1,
      });
      self = found.data.items[0] ?? null;
      if (self === null)
        return yield* new E.ParticipantNotFound({
          message:
            "No participant has that name. Register a new identity only if you have not already joined.",
        });
    }
  }
  // An agent recovers only its own agent identity; a person's participant is never one.
  if (self?.kind === "person") return yield* Actors.notAnAgent();
  // A removed agent recovering its identity learns that a person removed it.
  if (self?.removedAt !== undefined) return yield* Actors.removed(self);
  if (input.directChats === "own" && self === null)
    return yield* invalid("Select your participant by ID or exact name for your own chats.");
  // Present only on a server whose board was ever switched on, so other replies keep their shape.
  // Read first: it sets swarm memory up when it is not yet, and the lists below then show its
  // channel and the channel's notice in General.
  const boardContext = yield* (yield* Board.Board).context(access, self?.id ?? null);
  const participants = yield* directory((limit) => service.listParticipants(access, { limit }));
  const channels = yield* directory((limit) =>
    service.listChannels(access, { state: "all", limit }),
  );
  const general = yield* service.getConversation(access, server.data.generalConversationId);
  if (general.data.kind !== "channel") return yield* Effect.die("General must be a channel");
  const messages = yield* service.readMessages(access, general.data.id, { limit: 10 });
  const directs =
    input.directChats === "all"
      ? yield* directory((limit) => service.listDirectConversations(access, { limit }))
      : self === null
        ? null
        : yield* directory((limit) =>
            service.listDirectConversations(access, {
              withParticipantId: self.id,
              limit,
            }),
          );
  // The month's task operations: one quota call, made only on a board server.
  const taskOperations = boardContext === null ? null : yield* (yield* Reads.Reads).taskUsage();
  const board =
    boardContext === null
      ? null
      : { ...boardContext, ...present("taskOperations", taskOperations) };
  const data: A.Context = {
    server: server.data,
    self,
    participants: participants.data,
    channels: channels.data,
    directChats: directs?.data ?? null,
    general: { conversation: general.data, ...messages.data },
    capabilities: [...capabilities],
    ...present("board", board),
  };
  // Primary directories already contain most profiles. Only include missing references once.
  const all = merge(
    channels.included,
    messages.included,
    directs?.included ?? { participants: [], conversations: [] },
  );
  return {
    data,
    included: {
      participants: all.participants.filter(
        (p) => !participants.data.items.some((item) => item.id === p.id),
      ),
      conversations: [],
    },
  };
});
const directoryAction = (
  serverId: M.ServerId,
  section: "participants" | "channels" | "directChats",
  cursor: M.Cursor,
  limit?: number,
): A.NextAction => ({
  reason: `Continue ${section}.`,
  tool: "get_context",
  arguments: { serverId, page: { section, cursor, limit: limit ?? 100 } },
});
const historyAction = (
  serverId: M.ServerId,
  conversationId: M.ConversationId,
  position: Position = { kind: "latest" },
  limit?: number,
): A.NextAction => ({
  reason: "Read conversation history.",
  tool: "read_messages",
  arguments: {
    serverId,
    mode: "history",
    conversationId,
    position,
    limit: limit ?? 25,
  },
});
const previewActions = (
  serverId: M.ServerId,
  conversations: ReadonlyArray<M.Conversation>,
  fullMessages: ReadonlyArray<M.Message> = [],
): A.NextAction[] =>
  conversations
    .flatMap((conversation) => {
      const message = conversation.latestMessage;
      return message?.truncated && !fullMessages.some((item) => item.id === message.id)
        ? [{ conversationId: conversation.id, message }]
        : [];
    })
    .sort((a, b) => b.message.sequence - a.message.sequence)
    .slice(0, 3)
    .map(({ conversationId, message }) => ({
      reason: `Read the full previewed message in conversation ${conversationId}; this retrieves one message.`,
      tool: "read_messages",
      arguments: { serverId, mode: "around", messageId: message.id, before: 0, after: 0 },
    }));
const contextActions = (value: A.Context): A.NextAction[] => {
  const actions: A.NextAction[] = [];
  if (value.self !== null)
    actions.push({
      reason:
        "If you have no saved updates checkpoint, recover incoming General messages and own DMs. Choose your task's channel IDs before starting; resume saved checkpoints instead of resetting them.",
      tool: U.toolName,
      arguments: {
        serverId: value.server.id,
        participantId: value.self.id,
        mode: "start",
        channelIds: [value.general.conversation.id],
        directChats: "own",
        startAt: "beginning",
        limit: 25,
      },
    });
  for (const section of ["participants", "channels", "directChats"] as const) {
    const cursor = value[section]?.nextCursor;
    if (cursor !== null && cursor !== undefined)
      actions.push(directoryAction(value.server.id, section, cursor));
  }
  if (value.general.nextCursor !== null)
    actions.push(
      historyAction(
        value.server.id,
        value.general.conversation.id,
        {
          kind: "cursor",
          cursor: value.general.nextCursor,
        },
        10,
      ),
    );
  return [
    ...actions,
    ...previewActions(
      value.server.id,
      [...value.channels.items, ...(value.directChats?.items ?? [])],
      value.general.items,
    ),
  ];
};
const contextMetadata = (meta: A.Meta, value: A.Context): A.Meta => ({
  ...meta,
  nextActions: contextActions(value),
  instructions: {
    ...meta.instructions,
    text: `Server ${value.server.id}. ${value.self === null ? "Recover or register your own participant before monitoring." : `Use participantId=${value.self.id}; recover this identity with get_context and participant.name=${value.self.name}. Registration is attribution, not authentication.`} ${Monitoring.onboardingInstructions}`,
  },
});

/** Execute a validated command using the current server's grant and shared application service. */
export const execute = Effect.fn("Agent.execute")(function* (
  access: AccessContext,
  command: A.Command,
  metadata: A.Meta,
  capabilities: ReadonlySet<A.Capability>,
  /**
   * A get_updates read (or a claim for next) a Worker makes after a watch woke a waiting call. The
   * call that started the wait was admitted once, however often a wake makes it read again.
   */
  reread = false,
): Effect.fn.Return<A.Reply, E.Failure, TalkTo.Service | Reads.Reads | Wakes.Wakes | Board.Board> {
  const service = yield* TalkTo.Service;
  let meta: A.Meta = { ...metadata, serverId: access.serverId };
  const inputServer = command.input.serverId;
  if (inputServer !== access.serverId)
    return yield* new E.ServerAccessDenied({ message: "The server is unavailable." });
  // Catalogs omit these tools without the capability; any caller that still names them learns why.
  if (Capabilities.gitSharingTools.has(command.tool) && !capabilities.has("files"))
    return yield* Capabilities.gitSharingAbsent(capabilities);
  const reads = yield* Reads.Reads;
  const read = Reads.classify(command);
  if (read !== null && !(reread && command.tool === U.toolName)) yield* reads.admit(access, read);
  const admin = Reads.classifyAdmin(command);
  if (admin !== null) yield* reads.admin(access, admin);
  const task = Reads.classifyTask(command);
  if (task !== null && !(reread && command.tool === T.claimToolName))
    yield* reads.task(access, task);
  /** A send refused for its own reasons counts as one admin call (docs/plan-limits.md). */
  const counted = <A, F extends { readonly _tag: string }, R>(
    send: Effect.Effect<A, F, R>,
    participantId: M.ParticipantId,
  ) =>
    send.pipe(
      Effect.catch((error) =>
        Reads.transientFailures.has(error._tag)
          ? Effect.fail(error)
          : reads
              .refused(access, { operation: command.tool, transport: "mcp", participantId })
              .pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  switch (command.tool) {
    case U.toolName: {
      const input = command.input;
      const result = yield* service.getUpdates(access, input);
      const next = result.data.nextCursor;
      return {
        ...result,
        meta: {
          ...meta,
          instructions: { ...meta.instructions, text: Monitoring.updatesInstructions },
          nextActions: [
            {
              reason:
                next === null
                  ? "After accepting this batch, poll at your host's next check; do not busy-loop."
                  : "After accepting this batch, continue the snapshot, even if this page was empty.",
              tool: U.toolName,
              arguments:
                next === null
                  ? {
                      serverId: access.serverId,
                      participantId: input.participantId,
                      mode: "poll",
                      checkpoint: result.data.checkpoint,
                      limit: input.limit ?? 25,
                    }
                  : {
                      serverId: access.serverId,
                      participantId: input.participantId,
                      mode: "continue",
                      cursor: next,
                      limit: input.limit ?? 25,
                    },
            },
          ],
        },
      };
    }
    case "get_context": {
      const input = command.input;
      const page = input.page;
      if (input.includeInstructions)
        meta = {
          ...meta,
          instructionSheet: renderDocumentation(
            agentGuide((yield* Board.Board).memory),
            new URL(meta.instructions.url).origin,
          ),
        };
      if (page !== undefined) {
        if (input.participant !== undefined || input.directChats !== undefined)
          return yield* invalid(
            "Continue with only serverId and page; the cursor retains the original filters.",
          );
        const cursor = page.cursor;
        switch (page.section) {
          case "servers":
            return yield* invalid("Omit serverId when continuing the server directory.");
          case "participants": {
            const result = yield* directory(
              (limit) => service.listParticipants(access, { cursor, limit }),
              page.limit ?? 100,
            );
            return {
              ...result,
              data: { kind: "participants", ...result.data },
              meta: {
                ...meta,
                nextActions:
                  result.data.nextCursor === null
                    ? []
                    : [
                        directoryAction(
                          access.serverId,
                          page.section,
                          result.data.nextCursor,
                          page.limit,
                        ),
                      ],
              },
            };
          }
          case "channels": {
            const result = yield* directory(
              (limit) => service.listChannels(access, { cursor, limit }),
              page.limit ?? 100,
            );
            return {
              ...result,
              data: { kind: "channels", ...result.data },
              meta: {
                ...meta,
                nextActions: [
                  ...(result.data.nextCursor === null
                    ? []
                    : [
                        directoryAction(
                          access.serverId,
                          page.section,
                          result.data.nextCursor,
                          page.limit,
                        ),
                      ]),
                  ...previewActions(access.serverId, result.data.items),
                ],
              },
            };
          }
          case "directChats": {
            const result = yield* directory(
              (limit) => service.listDirectConversations(access, { cursor, limit }),
              page.limit ?? 100,
            );
            return {
              ...result,
              data: { kind: "directChats", ...result.data },
              meta: {
                ...meta,
                nextActions: [
                  ...(result.data.nextCursor === null
                    ? []
                    : [
                        directoryAction(
                          access.serverId,
                          page.section,
                          result.data.nextCursor,
                          page.limit,
                        ),
                      ]),
                  ...previewActions(access.serverId, result.data.items),
                ],
              },
            };
          }
        }
      }
      const result = yield* context(access, input, capabilities);
      return {
        ...result,
        data: { kind: "context", ...result.data },
        meta: contextMetadata(meta, result.data),
      };
    }
    case "register_participant": {
      const registered = yield* service.registerParticipant(access, command.input);
      const result = yield* context(
        access,
        { serverId: access.serverId, participant: { id: registered.data.item.id } },
        capabilities,
      );
      return {
        data: { ...registered.data, context: result.data },
        included: result.included,
        meta: contextMetadata(meta, result.data),
      };
    }
    case R.toolName: {
      const { serverId: _server, participantId, ...input } = command.input;
      return { ...(yield* service.renameSelf(access, participantId, input)), meta };
    }
    case "read_messages": {
      const input = command.input;
      switch (input.mode) {
        case "history": {
          const result = yield* service.readMessages(access, input.conversationId, input);
          const conversation = yield* service.getConversation(access, input.conversationId);
          return {
            ...result,
            data: { mode: "history", ...result.data },
            included: merge(result.included, {
              participants: conversation.included.participants,
              conversations: [conversation.data],
            }),
            meta: {
              ...meta,
              nextActions:
                result.data.nextCursor === null
                  ? []
                  : [
                      historyAction(
                        access.serverId,
                        input.conversationId,
                        {
                          kind: "cursor",
                          cursor: result.data.nextCursor,
                        },
                        input.limit,
                      ),
                    ],
            },
          };
        }
        case "search": {
          const result = yield* service.searchMessages(access, input);
          return {
            ...result,
            data: { mode: "search", ...result.data },
            meta: {
              ...meta,
              nextActions:
                result.data.nextCursor === null
                  ? []
                  : [
                      {
                        reason: "Continue this search.",
                        tool: "read_messages",
                        arguments: {
                          serverId: access.serverId,
                          mode: "search",
                          cursor: result.data.nextCursor,
                          limit: input.limit ?? 25,
                        },
                      },
                    ],
            },
          };
        }
        case "around": {
          const result = yield* service.getMessageContext(access, input.messageId, input);
          const actions: A.NextAction[] = [];
          if (result.data.hasMoreBefore)
            actions.push(
              historyAction(access.serverId, result.data.anchor.conversationId, {
                kind: "beforeMessage",
                messageId: result.data.before[0]?.id ?? result.data.anchor.id,
              }),
            );
          if (result.data.hasMoreAfter)
            actions.push(
              historyAction(access.serverId, result.data.anchor.conversationId, {
                kind: "afterMessage",
                messageId: result.data.after.at(-1)?.id ?? result.data.anchor.id,
              }),
            );
          return {
            ...result,
            data: { mode: "around", ...result.data },
            meta: { ...meta, nextActions: actions },
          };
        }
      }
    }
    case "send_message": {
      const result = yield* counted(
        service.sendTo(access, command.input),
        command.input.participantId,
      );
      return {
        ...result,
        meta: {
          ...meta,
          nextActions: [historyAction(access.serverId, result.data.item.conversationId)],
        },
      };
    }
    case "confirm_message":
      return { ...(yield* service.confirmMessage(access, command.input)), meta };
    case "share_file": {
      const result = yield* counted(
        service.shareFile(access, command.input),
        command.input.participantId,
      );
      return {
        ...result,
        meta: {
          ...meta,
          nextActions: [historyAction(access.serverId, result.data.item.conversationId)],
        },
      };
    }
    case "get_files_access":
      return { ...(yield* service.filesAccess(access, command.input)), meta };
    case "complete_transfer": {
      const result = yield* service.completeTransfer(access, command.input);
      return {
        ...result,
        meta: {
          ...meta,
          nextActions: [historyAction(access.serverId, result.data.item.conversationId)],
        },
      };
    }
    case "get_pack_command":
      return { ...(yield* service.getPackCommand(access)), meta };
    case "prepare_transfer":
      return { ...(yield* service.prepareTransfer(access, command.input)), meta };
    case "fetch_transfer":
      return { ...(yield* service.fetchTransfer(access, command.input)), meta };
    case "read_transfer":
      return { ...(yield* service.readTransfer(access, command.input)), meta };
    case "create_channel":
      return { ...(yield* service.createChannel(access, command.input)), meta };
    case "set_channel_archived":
      return {
        ...(yield* service.setChannelArchived(access, command.input.conversationId, command.input)),
        meta,
      };
    case S.createToolName: {
      const minted = yield* service.createSignal(access, command.input);
      const origin = new URL(meta.instructions.url).origin;
      return {
        ...minted,
        data: {
          signalId: minted.data.signalId,
          url: Signals.url(origin, access.serverId, minted.data.signalId, minted.data.secret),
          expiresAt: minted.data.expiresAt,
          selection: minted.data.selection,
          minIntervalSeconds: S.minIntervalSeconds,
          procedure: Signals.procedure,
        },
        meta,
      };
    }
    case S.revokeToolName:
      return { ...(yield* service.revokeSignal(access, command.input)), meta };
    case W.revokeToolName:
      return { ...(yield* (yield* Wakes.Wakes).revoke(access, command.input, "agent")), meta };
    case W.listToolName:
      return { ...(yield* (yield* Wakes.Wakes).list(access, command.input)), meta };
    case T.createToolName:
    case T.claimToolName:
    case T.updateToolName:
    case T.readToolName:
      return { ...(yield* tasks(access, command, new URL(meta.instructions.url).origin)), meta };
    case T.readMemoryToolName: {
      const { serverId: _server, ...input } = command.input;
      return { ...(yield* (yield* Board.Board).readMemory(access, input)), meta };
    }
    case T.memoryAccessToolName: {
      const { serverId: _server, ...input } = command.input;
      return { ...(yield* (yield* Board.Board).memoryAccess(access, input)), meta };
    }
  }
});
/** The task-board tools: thin calls into the board service, shared with the HTTP routes. */
const tasks = Effect.fn("Agent.tasks")(function* (
  access: AccessContext,
  command: Extract<
    A.Command,
    {
      readonly tool:
        | typeof T.createToolName
        | typeof T.claimToolName
        | typeof T.updateToolName
        | typeof T.readToolName;
    }
  >,
  origin: string,
): Effect.fn.Return<
  | M.Outcome<T.CreatedTasks>
  | M.Outcome<T.ClaimResult>
  | M.Outcome<T.UpdatedTask>
  | M.Outcome<T.ReadTasksData>,
  E.Failure,
  Board.Board
> {
  const board = yield* Board.Board;
  switch (command.tool) {
    case T.createToolName:
      return yield* board.createTasks(access, command.input, origin);
    case T.claimToolName:
      return yield* board.claimTask(access, command.input, origin);
    case T.updateToolName:
      return yield* board.updateTask(access, command.input, origin);
    case T.readToolName:
      return yield* board.readTasks(access, command.input, origin);
  }
});
/** Project expected failures into the same model-visible envelope as successful operations. */
export const failure = (error: E.Failure, meta: A.Meta): A.Reply => ({
  ...Responses.projectFailure(error, meta),
  meta,
});
