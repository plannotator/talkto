import { scryptAsync } from "@noble/hashes/scrypt.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import * as Native from "better-auth/crypto";
import { Schema } from "effect";

/** Better Auth's own password functions: `node:crypto` scrypt where the runtime has it. */
export interface PasswordFunctions {
  readonly hash: (password: string) => Promise<string>;
  readonly verify: (input: {
    readonly hash: string;
    readonly password: string;
  }) => Promise<boolean>;
}

// Better Auth's parameters and `salt:key` hex format, so either side verifies the other's hashes.
const parameters = { N: 16384, r: 16, p: 1, dkLen: 64, maxmem: 128 * 16384 * 16 * 2 };

const derive = async (password: string, salt: string) =>
  bytesToHex(await scryptAsync(password.normalize("NFKC"), salt, parameters));

/** The same scrypt in plain JavaScript, for a runtime whose `node:crypto` has no scrypt. */
export const portable: PasswordFunctions = {
  hash: async (password) => {
    const salt = bytesToHex(randomBytes(16));
    return `${salt}:${await derive(password, salt)}`;
  },
  verify: async ({ hash, password }) => {
    const [salt, key] = hash.split(":");
    if (salt === undefined || key === undefined) throw new Error("Invalid password hash");
    const derived = await derive(password, salt);
    let difference = derived.length ^ key.length;
    for (let index = 0; index < derived.length; index += 1)
      difference |= derived.charCodeAt(index) ^ key.charCodeAt(index);
    return difference === 0;
  },
};

/** Node's refusal of an API the runtime does not provide. */
const notImplemented = Schema.is(
  Schema.Struct({ code: Schema.Literal("ERR_METHOD_NOT_IMPLEMENTED") }),
);

const builtIn: PasswordFunctions = { hash: Native.hashPassword, verify: Native.verifyPassword };

/**
 * Better Auth picks `node:crypto` scrypt through the `workerd` and `node` export conditions.
 * Cloudflare implements it; celld, a self-hosted Workers runtime, matches the same conditions but
 * throws ERR_METHOD_NOT_IMPLEMENTED. The first such refusal switches this isolate to `portable`.
 */
export const make = (native: PasswordFunctions = builtIn): PasswordFunctions => {
  let current = native;
  const withFallback =
    <A, R>(call: (functions: PasswordFunctions, argument: A) => Promise<R>) =>
    async (argument: A) => {
      try {
        return await call(current, argument);
      } catch (error) {
        if (current === portable || !notImplemented(error)) throw error;
        current = portable;
        return call(current, argument);
      }
    };
  return {
    hash: withFallback((functions, password: string) => functions.hash(password)),
    verify: withFallback((functions, input: { hash: string; password: string }) =>
      functions.verify(input),
    ),
  };
};
