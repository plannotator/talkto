// Deploy a self-hosted TalkTo to celld, Deno's self-hosted Workers runtime, or apply its D1
// migrations. Run from the repository root after `pnpm build:selfhost`:
//
//   pnpm celld deploy    # build the celld config, `celld deploy`, then delete the config
//   pnpm celld migrate   # build the celld config, `celld d1 migrations apply`, then delete it
//
// It reads the same environment variables as `pnpm selfhost:config` (with Better Auth), plus the
// fleet bucket (CELLD_BUCKET, S3_ENDPOINT, AWS_REGION and the AWS credentials, as celld reads
// them) and the values Cloudflare keeps as Worker secrets. celld has no secret store: those values
// become Worker variables inside the fleet bucket, so protect the bucket like the secrets.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const server = here("..");
const selfhost = join(server, "wrangler.selfhost.jsonc");
const output = join(server, "wrangler.celld.json");
const assets = join(server, "celld-assets");

const command = process.argv[2];
if (command !== "deploy" && command !== "migrate") {
  console.error("Usage: pnpm celld deploy | pnpm celld migrate");
  process.exit(2);
}
if (process.env.TALKTO_AUTH_PROVIDER?.trim() !== "better-auth") {
  console.error(
    "celld needs TALKTO_AUTH_PROVIDER=better-auth: Cloudflare Access and WorkOS need Cloudflare.",
  );
  process.exit(1);
}
const missing = ["BETTER_AUTH_SECRET", "CELLD_BUCKET"].filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Not set: ${missing.join(", ")}.`);
  process.exit(1);
}

// The Cloudflare account and D1 database IDs mean nothing to celld; the template still wants them.
const generated = spawnSync(process.execPath, [here("selfhost-config.mjs")], {
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    TALKTO_D1_DATABASE_ID: "00000000-0000-4000-8000-000000000000",
  },
});
if (generated.status !== 0) process.exit(generated.status ?? 1);

const { rawConfig: config } = experimental_readRawConfig({ config: selfhost });
rmSync(selfhost);

// Keys celld rejects. Each is optional to TalkTo: no rate-limit bindings, no version metadata,
// and the address comes from the proxy in front of celld instead of a Cloudflare route.
for (const key of [
  "account_id",
  "ratelimits",
  "version_metadata",
  "workers_dev",
  "preview_urls",
  "observability",
  "routes",
])
  delete config[key];
for (const rule of config.rules ?? []) delete rule.fallthrough;
// Without a database_id celld names the database by database_name, which stays stable.
for (const database of config.d1_databases ?? []) delete database.database_id;

// celld serves assets only from inside the project, and has no `.assetsignore`.
const built = join(server, "../web/dist");
if (command === "deploy") {
  if (!existsSync(built)) {
    console.error("Build the dashboard first: pnpm build:selfhost");
    process.exit(1);
  }
  rmSync(assets, { recursive: true, force: true });
  cpSync(built, assets, {
    recursive: true,
    filter: (path) => !path.endsWith(".map") && !path.endsWith(".assetsignore"),
  });
}
config.assets.directory = "celld-assets";

// Signed transfer links reach the binding's objects in the fleet bucket, where celld keeps them
// under r2/<bucket_name>/. Transfers stay off until the store's address and keys are all set.
delete config.vars.TALKTO_R2_ACCOUNT_ID;
for (const name of [
  "BETTER_AUTH_SECRET",
  "TALKTO_SIGNAL_KEY",
  "TALKTO_R2_OBJECT_BASE",
  "TALKTO_R2_ACCESS_KEY_ID",
  "TALKTO_R2_SECRET_ACCESS_KEY",
]) {
  const value = process.env[name]?.trim();
  if (value) config.vars[name] = value;
}

writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
const celld = process.env.CELLD ?? "celld";
// celld bundles the Worker with the esbuild on PATH; use the one Wrangler already installed.
const esbuild = dirname(
  createRequire(createRequire(import.meta.url).resolve("wrangler")).resolve("esbuild/bin/esbuild"),
);
const args =
  command === "deploy"
    ? ["deploy", output]
    : ["d1", "migrations", "apply", config.d1_databases[0].database_name, output];
const result = spawnSync(celld, [...args, "--bucket", process.env.CELLD_BUCKET], {
  cwd: server,
  stdio: "inherit",
  env: { ...process.env, PATH: `${esbuild}${delimiter}${process.env.PATH}` },
});
rmSync(output);
process.exit(result.status ?? 1);
