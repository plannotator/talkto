// `wrangler types` reads the default wrangler.jsonc, which declares no transfer store: the bucket
// lives only in the staging and production configurations, and the keys are Worker secrets. The
// generated Env therefore omits them, so they are declared optional here and probed at composition.
interface Env {
  readonly TRANSFERS?: R2Bucket;
  readonly TALKTO_R2_ACCOUNT_ID?: string;
  readonly TALKTO_R2_BUCKET?: string;
  /** Overrides the R2 address in signed links, for another S3-compatible store. */
  readonly TALKTO_R2_OBJECT_BASE?: string;
  readonly TALKTO_R2_ACCESS_KEY_ID?: string;
  readonly TALKTO_R2_SECRET_ACCESS_KEY?: string;
}
