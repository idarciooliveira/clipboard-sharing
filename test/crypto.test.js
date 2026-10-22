// E2EE contract tests: the browser implementation (WebCrypto, web/src/crypto.ts)
// and the CLI implementation (node:crypto, cli/src/index.js) must interoperate.
// The web side is re-implemented here against globalThis.crypto.subtle (Node 20+).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  genKey,
  validKey,
  encryptText,
  decryptText,
  encryptBytes,
  decryptBytes,
} from "../cli/src/index.js";

const PREFIX = "enc.v1.";

/* ---- independent WebCrypto (browser-side) implementation of the same contract ---- */

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64url = (s) => new Uint8Array(Buffer.from(String(s), "base64url"));

async function webImportKey(rawKey, usages) {
  return crypto.subtle.importKey("raw", unb64url(rawKey), "AES-GCM", false, usages);
}

async function webEncryptText(rawKey, plain) {
  const key = await webImportKey(rawKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return PREFIX + b64url(iv) + "." + b64url(new Uint8Array(ct));
}

async function webDecryptText(rawKey, s) {
  const parts = s.slice(PREFIX.length).split(".");
  assert.equal(parts.length, 2, "envelope must have exactly two dot-separated parts");
  const key = await webImportKey(rawKey, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64url(parts[0]) },
    key,
    unb64url(parts[1])
  );
  return new TextDecoder().decode(pt);
}

async function webEncryptBytes(rawKey, data) {
  const key = await webImportKey(rawKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

async function webDecryptBytes(rawKey, data) {
  const buf = new Uint8Array(data);
  const key = await webImportKey(rawKey, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12) }, key, buf.subarray(12));
  return new Uint8Array(pt);
}

/* ---- tests ---- */

test("generated keys use the shared format (32 bytes, base64url, 43 chars)", () => {
  for (let i = 0; i < 50; i++) {
    const k = genKey();
    assert.match(k, /^[A-Za-z0-9_-]{43}$/, "key must be 43 unpadded base64url chars");
    assert.ok(validKey(k));
  }
  assert.ok(!validKey("short"), "short keys are rejected");
  assert.ok(!validKey("a".repeat(44)), "wrong length is rejected");
});

test("text envelope has the documented shape", async () => {
  const key = genKey();
  const env = await encryptText(key, "hello");
  assert.ok(env.startsWith(PREFIX));
  const parts = env.slice(PREFIX.length).split(".");
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^[A-Za-z0-9_-]{16}$/, "12 IV bytes -> 16 base64url chars");
  assert.ok(parts[1].length >= 24, "ct (incl. 16-byte tag) is never empty");
});

test("node -> node text round-trip (unicode, newlines, 64KB)", async () => {
  const key = genKey();
  const samples = [
    "hello world",
    "multi\nline\twith 👋 emoji — çãé",
    "x".repeat(64 * 1024),
    "",
  ];
  for (const s of samples) {
    const env = encryptText(key, s);
    assert.equal(decryptText(key, env), s);
  }
});

test("web -> node: browser-encrypted text decrypts in the CLI", async () => {
  const key = genKey();
  const env = await webEncryptText(key, "pasted from the browser 🖥➡📱");
  assert.equal(decryptText(key, env), "pasted from the browser 🖥➡📱");
});

test("node -> web: CLI-encrypted text decrypts in the browser", async () => {
  const key = genKey();
  const env = encryptText(key, "piped from the CLI");
  assert.equal(await webDecryptText(key, env), "piped from the CLI");
});

test("wrong key fails authentication, legacy plaintext passes through", async () => {
  const key = genKey();
  const other = genKey();
  const env = encryptText(key, "secret");
  assert.equal(decryptText(other, env), null, "GCM tag must reject the wrong key");
  assert.equal(await webDecryptText(other, env).catch(() => "failed"), "failed");
  assert.equal(decryptText(key, "plain legacy message"), null, "non-envelopes are not touched");
});

test("tampered ciphertext fails authentication", async () => {
  const key = genKey();
  const env = encryptText(key, "secret");
  const parts = env.slice(PREFIX.length).split(".");
  const ct = Buffer.from(parts[1], "base64url");
  ct[ct.length - 1] ^= 0xff; // flip a byte inside the tag
  const tampered = PREFIX + parts[0] + "." + ct.toString("base64url");
  assert.equal(decryptText(key, tampered), null);
});

test("file bytes: web -> node and node -> web round-trips", async () => {
  const key = genKey();
  // getRandomValues caps at 64KB per call — build 1MB in chunks
  const data = new Uint8Array(1024 * 1024);
  for (let i = 0; i < data.length; i += 65536) {
    crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
  }

  const fromWeb = await webEncryptBytes(key, data);
  const decNode = decryptBytes(key, Buffer.from(fromWeb));
  assert.ok(decNode, "node must decrypt web-encrypted bytes");
  assert.deepEqual(new Uint8Array(decNode), new Uint8Array(data));

  const fromNode = encryptBytes(key, Buffer.from(data));
  const decWeb = await webDecryptBytes(key, fromNode);
  assert.deepEqual(decWeb, new Uint8Array(data));
});

test("file bytes: wrong key and short bodies are rejected, not thrown", () => {
  const key = genKey();
  const other = genKey();
  const enc = encryptBytes(key, Buffer.from("file-bytes"));
  assert.equal(decryptBytes(other, enc), null, "wrong key -> null");
  assert.equal(decryptBytes(key, Buffer.from(new Uint8Array(20))), null, "short body -> null");
  assert.equal(decryptBytes(key, Buffer.alloc(0)), null, "empty body -> null");
});

test("encrypted file metadata envelope round-trips as JSON", async () => {
  const key = genKey();
  const meta = { name: "photo of the beach.png", mime: "image/png", size: 123456 };
  const env = encryptText(key, JSON.stringify(meta));
  const dec = JSON.parse(decryptText(key, env));
  assert.deepEqual(dec, meta);
});
