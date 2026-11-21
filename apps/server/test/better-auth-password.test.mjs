import assert from "node:assert/strict";
import { test } from "node:test";
import * as Native from "better-auth/crypto";
import * as Password from "../src/better-auth-password.ts";

/*
  Passwords on a runtime without `node:crypto` scrypt (celld). Better Auth's own Node build is the
  oracle: a hash from either side must verify on the other, so a copy can move between Cloudflare
  and celld without anyone resetting a password.
*/
const secret = "correct horse battery staple";

const refusal = () =>
  Object.assign(new Error("The scrypt method is not implemented"), {
    code: "ERR_METHOD_NOT_IMPLEMENTED",
  });

test("the portable hash and Better Auth's native hash verify each other", async () => {
  const portableHash = await Password.portable.hash(secret);
  assert.equal(await Native.verifyPassword({ hash: portableHash, password: secret }), true);
  assert.equal(await Native.verifyPassword({ hash: portableHash, password: "wrong one" }), false);

  const nativeHash = await Native.hashPassword(secret);
  assert.equal(await Password.portable.verify({ hash: nativeHash, password: secret }), true);
  assert.equal(await Password.portable.verify({ hash: nativeHash, password: "wrong one" }), false);
});

test("by default the runtime's own scrypt hashes and verifies", async () => {
  const passwords = Password.make();
  const hash = await passwords.hash(secret);
  assert.equal(await Native.verifyPassword({ hash, password: secret }), true);
  assert.equal(await passwords.verify({ hash, password: secret }), true);
  assert.equal(await passwords.verify({ hash, password: "wrong one" }), false);
});

test("a runtime that refuses scrypt switches to the portable hash", async () => {
  let nativeCalls = 0;
  const refusing = {
    hash: async () => {
      nativeCalls += 1;
      throw refusal();
    },
    verify: async () => {
      nativeCalls += 1;
      throw refusal();
    },
  };
  const passwords = Password.make(refusing);
  const hash = await passwords.hash(secret);
  assert.equal(await Native.verifyPassword({ hash, password: secret }), true);
  assert.equal(await passwords.verify({ hash, password: secret }), true);
  assert.equal(nativeCalls, 1, "after the first refusal the isolate stops asking the native side");
});

test("other native failures are not hidden by the fallback", async () => {
  const failing = {
    hash: async () => {
      throw new Error("out of memory");
    },
    verify: async () => false,
  };
  await assert.rejects(Password.make(failing).hash(secret), /out of memory/);
});
