// End-to-end encryption helpers — AES-256-GCM, key carried in the URL fragment (#<key>).
// The fragment never leaves the browser: it is not sent to the server and does not
// appear in request logs. The server only ever sees opaque ciphertext.
//
// Envelope format (text + file metadata):
//   enc.v1.<iv b64url>.<ct b64url>   — ct includes the 16-byte GCM tag (WebCrypto layout)
// File bodies are raw binary: iv(12) || ct || tag(16).

const KEY_LEN = 32; // 256-bit AES
const IV_LEN = 12;
const TAG_LEN = 16;
export const ENVELOPE_PREFIX = "enc.v1.";
// 32 bytes -> 43 base64url chars, no padding
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function isEnvelope(s: string): boolean {
  return typeof s === "string" && s.startsWith(ENVELOPE_PREFIX);
}

export function validKey(s: string): boolean {
  return KEY_RE.test(s);
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let rawKey: string | null = null;
let imported: Promise<CryptoKey> | null = null;

/** Arm the session key (sync — the actual WebCrypto import happens lazily). */
export function setKey(raw: string): void {
  if (!validKey(raw)) throw new Error("invalid session key");
  rawKey = raw;
  imported = null;
}

export function hasKey(): boolean {
  return rawKey !== null;
}

function getKey(): Promise<CryptoKey> {
  if (!rawKey) return Promise.reject(new Error("no session key"));
  imported ??= crypto.subtle.importKey("raw", b64urlDecode(rawKey), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return imported;
}

/** Generate a fresh 256-bit key, base64url-encoded for the URL fragment. */
export function generateKey(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(KEY_LEN)));
}

/** Encrypt a string into an `enc.v1.` envelope. Throws if no key is armed. */
export async function encryptText(plain: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return ENVELOPE_PREFIX + b64urlEncode(iv) + "." + b64urlEncode(new Uint8Array(ct));
}

/**
 * Decrypt an `enc.v1.` envelope. Returns null for anything else — including
 * legacy plaintext messages from before E2EE, or envelopes that fail
 * authentication (wrong key / tampered) — so callers can fall back gracefully.
 */
export async function decryptText(s: string): Promise<string | null> {
  if (!rawKey || !isEnvelope(s)) return null;
  const parts = s.slice(ENVELOPE_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await getKey();
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(parts[0]) },
      key,
      b64urlDecode(parts[1])
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Encrypt bytes into the raw file-body layout: iv(12) || ct || tag(16). */
export async function encryptBytes(data: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  const out = new Uint8Array(IV_LEN + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_LEN);
  return out;
}

/** Decrypt a raw file body. Returns null when it can't be authenticated. */
export async function decryptBytes(data: ArrayBuffer): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!rawKey || data.byteLength < IV_LEN + TAG_LEN) return null;
  try {
    const key = await getKey();
    const buf = new Uint8Array(data);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf.subarray(0, IV_LEN) },
      key,
      buf.subarray(IV_LEN)
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}
