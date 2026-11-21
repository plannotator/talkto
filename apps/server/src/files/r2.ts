import { AwsClient } from "aws4fetch";
import { Effect } from "effect";
import type { R2Settings } from "../configuration.js";
import * as Model from "./model.js";
import * as Transfers from "./transfers.js";

const provider = "r2";
const failure = (operation: string) => () =>
  new Model.FileStoreFailure({
    message: "The transfer store could not complete the operation.",
    operation,
    provider,
    code: null,
  });

/**
 * Cloudflare R2: a Worker binding reads and deletes, and signed links move the bytes directly
 * between the agents and the bucket. The binding cannot sign, so the S3 keys are Worker secrets
 * limited to this bucket. An upload link signs the size and `If-None-Match: *`, so it writes
 * only the declared size, and only once.
 */
export const make = (settings: R2Settings) => {
  const { bucket, objectBase, accessKeyId, secretAccessKey } = settings;
  const client = new AwsClient({ service: "s3", region: "auto", accessKeyId, secretAccessKey });
  const link = (key: string, query: string, seconds: number = Transfers.linkSeconds) =>
    `${objectBase}/${key}?X-Amz-Expires=${seconds}${query}`;
  const sign = (operation: string, url: string, init: RequestInit) =>
    Effect.tryPromise({
      try: () =>
        client
          .sign(url, { ...init, aws: { signQuery: true, allHeaders: true } })
          .then((signed) => signed.url),
      catch: failure(operation),
    });
  const removeKeys = (operation: string, keys: ReadonlyArray<string>) =>
    Effect.tryPromise({ try: () => bucket.delete([...keys]), catch: failure(operation) });
  return Transfers.TransferStore.of({
    uploadUrl: (key, bytes) =>
      sign("uploadUrl", link(key, ""), {
        method: "PUT",
        headers: { "content-length": String(bytes), "if-none-match": "*" },
      }),
    // `attachment` keeps a leaked link from ever rendering as a hosted page.
    downloadUrl: (key, options = {}) =>
      sign(
        "downloadUrl",
        link(
          key,
          `&response-content-disposition=${encodeURIComponent(
            options.fileName === undefined ? "attachment" : Transfers.attachment(options.fileName),
          )}`,
          options.seconds,
        ),
        { method: "GET" },
      ),
    size: (key) =>
      Effect.tryPromise({
        try: () => bucket.head(key).then((object) => object?.size ?? null),
        catch: failure("size"),
      }),
    remove: (keys) => removeKeys("remove", keys),
    removePrefix: Effect.fn("R2.removePrefix")(function* (prefix) {
      let cursor: string | undefined;
      do {
        const page: R2Objects = yield* Effect.tryPromise({
          try: () => bucket.list(cursor === undefined ? { prefix } : { prefix, cursor }),
          catch: failure("list"),
        });
        if (page.objects.length > 0)
          yield* removeKeys(
            "removePrefix",
            page.objects.map((object) => object.key),
          );
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    }),
  });
};
