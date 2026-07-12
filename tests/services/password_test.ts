// Password hasher tests (auth PRD §9.1, Assumption 1): PBKDF2-HMAC-SHA256 via
// WebCrypto, self-describing encoding so iterations can rise without
// invalidating stored hashes. Iteration counts are lowered here — the tests
// prove correctness, not KDF cost.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { Pbkdf2PasswordHasher } from "@/services/password.ts";

const hasher = new Pbkdf2PasswordHasher(1_000); // cheap iterations for tests

Deno.test("hash/verify roundtrip accepts the right password", async () => {
  const encoded = await hasher.hash("correct horse battery staple");
  assert(await hasher.verify("correct horse battery staple", encoded));
});

Deno.test("verify rejects a wrong password", async () => {
  const encoded = await hasher.hash("correct horse battery staple");
  assertEquals(await hasher.verify("Tr0ub4dor&3", encoded), false);
});

Deno.test("hashing the same password twice yields different encodings (random salt)", async () => {
  const a = await hasher.hash("same-password");
  const b = await hasher.hash("same-password");
  assertNotEquals(a, b);
  assert(await hasher.verify("same-password", a));
  assert(await hasher.verify("same-password", b));
});

Deno.test("encoding is self-describing: verify honors the embedded iteration count", async () => {
  const cheap = new Pbkdf2PasswordHasher(500);
  const encoded = await cheap.hash("password-at-500");
  // A hasher configured for far more iterations still verifies the old hash.
  const expensive = new Pbkdf2PasswordHasher(2_000);
  assert(await expensive.verify("password-at-500", encoded));
});

Deno.test("verify rejects malformed or tampered encodings without throwing", async () => {
  const encoded = await hasher.hash("victim");
  const tampered = encoded.slice(0, -4) + "AAAA";
  assertEquals(await hasher.verify("victim", tampered), false);
  for (
    const bad of [
      "",
      "not-a-hash",
      "pbkdf2$abc$salt$hash",
      "scrypt$1000$c2FsdA==$aGFzaA==",
      "pbkdf2$1000$c2FsdA==", // missing segment
    ]
  ) {
    assertEquals(await hasher.verify("anything", bad), false);
  }
});

Deno.test("dummyEncoded verifies false but exercises the full KDF (timing defense)", async () => {
  const dummy = await hasher.dummyEncoded();
  assertEquals(await hasher.verify("any password", dummy), false);
});
