// Password hashing (auth PRD Assumption 1): PBKDF2-HMAC-SHA256 via WebCrypto —
// zero new dependencies. Encoding `pbkdf2$<iterations>$<salt b64>$<hash b64>`
// self-describes its cost so iterations can be raised later while old hashes
// keep verifying. Verification is constant-time over the derived bytes.

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
  // A syntactically valid encoding that matches no password. Verifying against
  // it costs a full KDF run, so unknown-username logins take as long as real
  // ones (no timing oracle for user enumeration — auth PRD §8).
  dummyEncoded(): Promise<string>;
}

// OWASP 2024 baseline for PBKDF2-HMAC-SHA256.
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;

const SALT_BYTES = 16;
const KEY_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class Pbkdf2PasswordHasher implements PasswordHasher {
  #dummy: Promise<string> | undefined;

  constructor(
    private readonly iterations: number = DEFAULT_PBKDF2_ITERATIONS,
  ) {}

  async hash(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await deriveKey(password, salt, this.iterations);
    return `pbkdf2$${this.iterations}$${toBase64(salt)}$${toBase64(key)}`;
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parts = encoded.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations <= 0) return false;
    const salt = fromBase64(parts[2]);
    const expected = fromBase64(parts[3]);
    if (!salt || !expected) return false;
    const actual = await deriveKey(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  }

  // Memoized: one KDF run at first use, then a fixed decoy encoding.
  dummyEncoded(): Promise<string> {
    this.#dummy ??= this.hash(crypto.randomUUID()).then((encoded) =>
      // Flip the final hash bytes so not even the decoy password verifies.
      encoded.slice(0, -8) + "AAAAAAA="
    );
    return this.#dummy;
  }
}
