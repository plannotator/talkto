import { Config, ConfigProvider, Effect, Option, Schema } from "effect";
import * as M from "@talkto/api/models";
import * as Access from "./access.js";

const Origin = Schema.String.check(
  Schema.makeFilter((s) => {
    if (!URL.canParse(s)) return false;
    const url = new URL(s);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === s;
  }),
);
/** Public service origin, also available before a server has been provisioned. */
export const readOrigin = (env: Env) =>
  Config.schema(Origin, "TALKTO_SERVICE_ORIGIN").pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(() => new ConfigurationUnavailable({ message: "Set a valid service origin." })),
  );
/** Safe startup failure; never contains raw credentials or environment contents. */
export class ConfigurationUnavailable extends Schema.TaggedError<ConfigurationUnavailable>()(
  "ConfigurationUnavailable",
  { message: Schema.String },
) {}
/** Parse explicitly bound Worker configuration at the composition root. */
export const read = Effect.fn("Configuration.read")(function* (env: Env) {
  return yield* Config.all({
    serverId: Config.schema(M.ServerId, "TALKTO_SERVER_ID"),
    name: Config.schema(M.ServerName, "TALKTO_SERVER_NAME"),
    grantId: Config.schema(M.GrantId, "TALKTO_GRANT_ID"),
    principalKey: Config.schema(Access.PrincipalKey, "TALKTO_PRINCIPAL_KEY"),
    origin: Config.schema(Origin, "TALKTO_SERVICE_ORIGIN"),
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(
      () =>
        new ConfigurationUnavailable({
          message: "Set valid TalkTo server, grant, principal, and origin configuration.",
        }),
    ),
  );
});
const FilesRemote = Schema.String.check(
  Schema.makeFilter((s) => URL.canParse(s) && new URL(s).protocol === "file:"),
);
/**
 * The unparsed local file remote, or null when the variable is unset or empty. Capability
 * reporting and store composition share this one predicate so they never disagree.
 */
export const localRemote = (env: Env) =>
  "TALKTO_FILES_REMOTE" in env && env.TALKTO_FILES_REMOTE !== "" ? env.TALKTO_FILES_REMOTE : null;
/** Optional bare repository on this machine, written by `pnpm setup:local`; absent means no local file store. */
export const readFilesRemote = Effect.fn("Configuration.readFilesRemote")(function* (env: Env) {
  const remote = localRemote(env);
  if (remote === null) return Option.none<string>();
  return yield* Schema.decodeUnknownEffect(FilesRemote)(remote).pipe(
    Effect.mapBoth({
      onSuccess: Option.some,
      onFailure: () =>
        new ConfigurationUnavailable({
          message: "Set TALKTO_FILES_REMOTE to a file:// URL or remove it.",
        }),
    }),
  );
});
/** What signing an R2 link and reading its objects need. */
export interface R2Settings {
  readonly bucket: R2Bucket;
  /** The https address before each object key in a signed link, with no trailing slash. */
  readonly objectBase: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}
/**
 * R2's own S3 address, unless `TALKTO_R2_OBJECT_BASE` names another S3-compatible store that
 * holds the binding's objects, as a self-hosted Workers runtime does.
 */
const objectBase = (env: Env): string | undefined => {
  const {
    TALKTO_R2_OBJECT_BASE: base,
    TALKTO_R2_ACCOUNT_ID: accountId,
    TALKTO_R2_BUCKET: name,
  } = env;
  if (base !== undefined)
    return URL.canParse(base) && base.startsWith("https://") && !base.endsWith("/")
      ? base
      : undefined;
  return accountId && name ? `https://${accountId}.r2.cloudflarestorage.com/${name}` : undefined;
};
/**
 * The R2 store's settings, or null until the binding and every value are present. Capability
 * reporting and store composition share this one predicate, so a half-configured deployment
 * simply does not offer transfers and every other feature keeps working.
 */
export const r2Settings = (env: Env): R2Settings | null => {
  const {
    TRANSFERS: bucket,
    TALKTO_R2_ACCESS_KEY_ID: accessKeyId,
    TALKTO_R2_SECRET_ACCESS_KEY: secretAccessKey,
  } = env;
  const base = objectBase(env);
  return bucket && base && accessKeyId && secretAccessKey
    ? { bucket, objectBase: base, accessKeyId, secretAccessKey }
    : null;
};
const ArtifactsRemoteBase = Schema.String.check(
  Schema.makeFilter(
    (s) => {
      if (!URL.canParse(s)) return false;
      const url = new URL(s);
      return url.protocol === "https:" && url.href === s && !s.endsWith("/");
    },
    { title: "ArtifactsRemoteBase" },
  ),
).pipe(Schema.brand("ArtifactsRemoteBase"));
/** The Git base of the bound Artifacts namespace, `https://<account>.artifacts.cloudflare.net/git/<namespace>`. */
export type ArtifactsRemoteBase = typeof ArtifactsRemoteBase.Type;
/**
 * Required beside the `ARTIFACTS` binding. The binding's `get` handle exposes `remote` as an RPC
 * property rather than data, so the remote of an existing repository is derived from this base
 * (`<base>/srv-<serverId>.git`) instead of read from the provider.
 */
export const readArtifactsRemoteBase = Effect.fn("Configuration.readArtifactsRemoteBase")(
  function* (env: Env) {
    return yield* Config.schema(ArtifactsRemoteBase, "TALKTO_ARTIFACTS_REMOTE_BASE").pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.mapError(
        () =>
          new ConfigurationUnavailable({
            message:
              "Set TALKTO_ARTIFACTS_REMOTE_BASE to the Artifacts namespace's https:// Git base without a trailing slash.",
          }),
      ),
    );
  },
);
/** Explicit local development credential, read only by the local entry point. */
export const readLocalToken = Effect.fn("Configuration.readLocalToken")(function* (env: Env) {
  return yield* Config.redacted("TALKTO_LOCAL_TOKEN").pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Effect.mapError(
      () =>
        new ConfigurationUnavailable({
          message: "Run pnpm setup:local to create a local development credential.",
        }),
    ),
  );
});
