import { Option, Schema } from "effect";
import * as A from "@talkto/api/agent";
import * as AI from "@talkto/api/agent-invites";

/*
  An invited agent on MCP (docs/agent-invites.md): its `tka_` key is checked like on the HTTP API
  (`InvitesHttp.genuine`), pins every call to its one server, and is passed on as its principal, so
  the server object's allowlist (`Actors.mayRun`) decides each operation as it does for HTTP.
*/

/**
 * The tools an invited agent's MCP connection lists: an agent's own work on its one server. Not
 * listed: `register_participant` (it is one agent already), Git file sharing and wakes, which
 * the server object refuses it, and `send_feedback`, which is a signed-in person's.
 */
export const tools: ReadonlySet<typeof A.ToolName.Type> = new Set<typeof A.ToolName.Type>([
  "get_context",
  "get_updates",
  "rename_participant",
  "read_messages",
  "send_message",
  "confirm_message",
  "create_channel",
  "set_channel_archived",
  "get_pack_command",
  "prepare_transfer",
  "complete_transfer",
  "fetch_transfer",
  "read_transfer",
  "create_signal",
  "revoke_signal",
  "create_tasks",
  "claim_task",
  "update_task",
  "read_tasks",
  "read_memory",
  "get_memory_access",
  AI.createToolName,
  AI.listToolName,
  AI.revokeToolName,
]);

/** Why an invited agent's call names another server, or none. */
export const otherServer = (serverId: string) =>
  `An invited agent's key works on one server: pass serverId ${serverId}.`;

/** What an invited agent's call answered `server_unavailable` means for it. */
export const removed =
  "This invited agent's key no longer works: its agent was removed from the server. Ask for a new invite.";

/** A reply that says the server is unavailable: for an invited agent, it was removed. */
export const unavailable = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("server_unavailable") }) }),
);

/*
  The invite tools are answered by the invite routes themselves (invites/http.ts): each call becomes
  the HTTP request it stands for, with the caller's network headers, so the same contract, checks and
  rate limits decide it. The bearer is dropped: the caller is already checked.
*/

const forwarded = (
  original: Request,
  method: string,
  url: URL,
  body?: AI.CreateInvite | AI.Redeem,
  pickup?: string,
) => {
  const headers = new Headers(original.headers);
  headers.delete("authorization");
  headers.delete("content-length");
  headers.delete("mcp-session-id");
  if (pickup === undefined) headers.delete(AI.pickupHeader);
  else headers.set(AI.pickupHeader, pickup);
  if (body === undefined) headers.delete("content-type");
  else headers.set("content-type", "application/json");
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
};

/** The invite route an `/mcp` invite tool stands for. */
export const inviteRequest = (original: Request, origin: string, command: AI.InviteCommand) => {
  const base = `${origin}/v1/servers/${encodeURIComponent(command.input.serverId)}/agent-invites`;
  switch (command.tool) {
    case AI.createToolName: {
      const { serverId: _named, ...payload } = command.input;
      return forwarded(original, "POST", new URL(base), payload);
    }
    case AI.listToolName:
      return forwarded(original, "GET", new URL(base));
    case AI.revokeToolName:
      return forwarded(
        original,
        "DELETE",
        new URL(`${base}/${encodeURIComponent(command.input.inviteId)}`),
      );
  }
};

/** The join route an `/mcp/join` tool stands for. The pickup secret goes in its header. */
export const joinRequest = (original: Request, origin: string, command: AI.JoinCommand) => {
  if (command.tool === AI.redeemToolName)
    return forwarded(original, "POST", new URL(`${origin}/v1/agent-invites/redeem`), command.input);
  const url = new URL(
    `${origin}/v1/agent-invites/requests/${encodeURIComponent(command.input.requestId)}`,
  );
  if (command.input.waitSeconds !== undefined)
    url.searchParams.set("wait", String(command.input.waitSeconds));
  if (command.input.name !== undefined) url.searchParams.set("name", command.input.name);
  return forwarded(original, "GET", url, undefined, command.input.pickup);
};

const answered = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ data: Schema.Unknown }),
    Schema.Struct({ error: Schema.Record(Schema.String, Schema.Unknown) }),
  ]),
);

/** A route's answer as a tool reply, with the tool call's metadata. */
export const reply = async (response: Response, meta: A.Meta): Promise<A.UncheckedReply> => {
  const body = answered(await response.json().catch(() => null));
  if (Option.isNone(body))
    return {
      error: { code: "internal_error", message: "The invite service gave no answer. Try again." },
      meta,
    };
  return "data" in body.value
    ? { data: body.value.data, included: { participants: [], conversations: [] }, meta }
    : { error: body.value.error, meta };
};
