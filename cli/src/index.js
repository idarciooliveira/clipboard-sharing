#!/usr/bin/env node
// clipdrop CLI — minimal, no deps. Works on linux/mac/win with Node 20+.
// Usage:
//   clipdrop new [--host URL] [--ttl 12]
//   clipdrop push "text" -s <id> [--host URL] | echo hi | clipdrop push -s <id>
//   clipdrop push --file ./photo.png -s <id> [--host URL] [--key <key>]
//   clipdrop pull -s <id> [--host URL] [--watch] [--key <key>]
//   clipdrop get <fileId> -s <id> [--host URL] [-o out] [--key <key>]
//   clipdrop open -s <id> [--host URL]
//
// Sessions are end-to-end encrypted (AES-256-GCM). The key is the part after
// `#` in the session link; it is generated locally on `new` and saved to the
// config. The server only ever sees ciphertext.

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, basename } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = join(homedir(), ".config", "clipdrop", "config.json");

/* ---------------- E2EE (must match web/src/crypto.ts) ---------------- */

const ENC_PREFIX = "enc.v1.";
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

const isEnvelope = (s) => typeof s === "string" && s.startsWith(ENC_PREFIX);
export const validKey = (k) => typeof k === "string" && KEY_RE.test(k);
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const unb64url = (s) => new Uint8Array(Buffer.from(String(s), "base64url"));

export function genKey() {
  return b64url(randomBytes(32));
}

function keyBuf(k) {
  const b = unb64url(k);
  if (b.length !== 32) throw new Error("bad key: expected 32 bytes (the part after # in the link)");
  return b;
}

/** Encrypt a string into an `enc.v1.<iv>.<ct>` envelope (ct includes the GCM tag). */
export function encryptText(key, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyBuf(key), iv);
  const ct = Buffer.concat([c.update(Buffer.from(plain, "utf8")), c.final(), c.getAuthTag()]);
  return ENC_PREFIX + b64url(iv) + "." + b64url(ct);
}

/** Decrypt an envelope; null for legacy plaintext or failed authentication. */
export function decryptText(key, s) {
  if (!isEnvelope(s)) return null;
  const dot = s.indexOf(".", ENC_PREFIX.length);
  if (dot < 0) return null;
  try {
    const iv = unb64url(s.slice(ENC_PREFIX.length, dot));
    const ct = Buffer.from(s.slice(dot + 1), "base64url");
    if (iv.length !== 12 || ct.length < 16) return null;
    const d = createDecipheriv("aes-256-gcm", keyBuf(key), iv);
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Encrypt bytes into the raw file-body layout: iv(12) || ct || tag(16). */
export function encryptBytes(key, buf) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyBuf(key), iv);
  return Buffer.concat([iv, c.update(Buffer.from(buf)), c.final(), c.getAuthTag()]);
}

/** Decrypt a raw file body; null when it can't be authenticated. */
export function decryptBytes(key, buf) {
  const b = Buffer.from(buf);
  if (b.length < 12 + 16) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", keyBuf(key), b.subarray(0, 12));
    d.setAuthTag(b.subarray(b.length - 16));
    return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

/** File "names" may be encrypted {name,mime,size} metadata envelopes. */
function decMeta(key, name) {
  const s = decryptText(key, name);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function keyOf(flags, cfg) {
  const k = flags.key || cfg.key || process.env.CLIPDROP_KEY || "";
  if (!validKey(k)) {
    throw new Error("this session is end-to-end encrypted — pass --key <key> (the part after # in the session link), or run `clipdrop new`");
  }
  return k;
}

function maybeKey(flags, cfg) {
  const k = flags.key || cfg.key || process.env.CLIPDROP_KEY || "";
  return validKey(k) ? k : null;
}

/* ---------------- config / args ---------------- */

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  return {};
}
function saveConfig(c) {
  mkdirSync(join(homedir(), ".config", "clipdrop"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      // base64url keys can start with "-", so --key always consumes its value
      const takesNext = k === "key" ? i + 1 < argv.length : argv[i + 1] && !argv[i + 1].startsWith("-");
      const v = eq >= 0 ? a.slice(eq + 1) : takesNext ? argv[++i] : "true";
      out.flags[k] = v;
    } else if (a === "-s" || a === "-h" || a === "-o" || a === "-f") {
      out.flags[a.slice(1)] = argv[++i] ?? "";
    } else {
      out._.push(a);
    }
  }
  return out;
}

function hostOf(flags) {
  const cfg = loadConfig();
  const host = (flags.host || flags.h || cfg.host || process.env.CLIPDROP_HOST || "http://localhost:8787").replace(/\/$/, "");
  if (/^http:\/\//i.test(host) && !/^http:\/\/(localhost|127\.|0\.0\.0\.0|\[::)/i.test(host)) {
    console.error("warning: plain http host — clipboard content travels unencrypted; use https");
  }
  return host;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let s = "";
  for await (const c of process.stdin) s += c;
  return s.trim();
}

function device() {
  return `${platform()}-cli`;
}

/* ---------------- commands ---------------- */

async function cmdNew(flags) {
  const host = hostOf(flags);
  const ttl = Number(flags.ttl || 12);
  const r = await fetch(`${host}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ttlHours: ttl }),
  });
  if (!r.ok) throw new Error(`create failed: ${r.status} ${await r.text()}`);
  const { id, expiresAt } = await r.json();
  const key = genKey(); // E2EE: key stays local, travels only in the link fragment
  const cfg = loadConfig();
  cfg.host = host;
  cfg.session = id;
  cfg.key = key;
  saveConfig(cfg);
  console.log(id);
  console.error(`session: ${id}`);
  console.error(`url: ${host}/s/${id}#${key}`);
  console.error(`expires: ${new Date(expiresAt).toISOString()}`);
  console.error(`key: saved to ${CONFIG_PATH} (it is NOT sent to the server)`);
}

async function cmdPush(flags, positional) {
  const host = hostOf(flags);
  const cfg = loadConfig();
  const session = flags.s || positional[0] || cfg.session;
  if (!session) throw new Error("no session: use -s <id> or `clipdrop new` first");
  const key = keyOf(flags, cfg);
  if (flags.file) {
    const p = String(flags.file);
    if (!existsSync(p)) throw new Error(`file not found: ${p}`);
    const st = statSync(p);
    if (st.size > 25 * 1024 * 1024 - 1024) throw new Error("file too big (max 25MB)");
    const ct = encryptBytes(key, readFileSync(p));
    const metaEnv = encryptText(key, JSON.stringify({ name: basename(p), mime: "application/octet-stream", size: st.size }));
    const fd = new FormData();
    fd.append("file", new Blob([ct]), metaEnv);
    fd.append("device", device());
    const r = await fetch(`${host}/api/s/${session}/files`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
    const { file } = await r.json();
    console.error(`uploaded (encrypted) ${basename(p)} (${st.size} bytes) to ${session} [${file.id}]`);
    return;
  }
  const stdinText = await readStdin();
  let finalText = flags.s ? positional.join(" ") : positional.slice(1).join(" ");
  if (stdinText) finalText = finalText ? `${finalText}\n${stdinText}` : stdinText;
  if (!finalText) throw new Error("nothing to push: pass text arg or pipe stdin");
  const r = await fetch(`${host}/api/s/${session}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: encryptText(key, finalText), device: device() }),
  });
  if (!r.ok) throw new Error(`push failed: ${r.status} ${await r.text()}`);
  console.error(`pushed (encrypted) ${finalText.length} chars to ${session}`);
}

function printMsg(key, m) {
  const text = (key && decryptText(key, m.text)) ?? m.text;
  console.log(`[${m.device} ${new Date(m.createdAt).toLocaleTimeString()}] ${text}\n---`);
}
function printFile(key, f) {
  let name = f.name, size = f.size;
  if (key) {
    const meta = decMeta(key, f.name);
    if (meta) { name = meta.name ?? name; size = meta.size ?? size; }
  }
  console.log(`[file ${f.device} ${new Date(f.createdAt).toLocaleTimeString()}] ${name} (${size} bytes) id:${f.id}\n---`);
}

async function cmdPull(flags, positional) {
  const host = hostOf(flags);
  const cfg = loadConfig();
  const session = flags.s || positional[0] || cfg.session;
  if (!session) throw new Error("no session: use -s <id>");
  const key = maybeKey(flags, cfg);
  if (flags.watch) {
    const proto = host.startsWith("https") ? "wss" : "ws";
    const base = host.replace(/^https?/, proto);
    // Node 22 has global WebSocket
    const WS = globalThis.WebSocket;
    if (!WS) throw new Error("watch requires Node 22+ with global WebSocket");
    const ws = new WS(`${base}/api/s/${session}/ws?device=${encodeURIComponent(device())}`);
    ws.onmessage = (ev) => {
      try {
        const o = JSON.parse(ev.data);
        if (o.type === "msg") printMsg(key, o.msg);
        if (o.type === "file") printFile(key, o.file);
        if (o.type === "hello") {
          (o.messages || []).forEach((m) => printMsg(key, m));
          (o.files || []).forEach((f) => printFile(key, f));
        }
      } catch {}
    };
    ws.onerror = (e) => console.error("ws error", e);
    await new Promise(() => {});
  } else {
    const r = await fetch(`${host}/api/s/${session}/history`);
    if (!r.ok) throw new Error(`pull failed: ${r.status} ${await r.text()}`);
    const { messages, files } = await r.json();
    if (!key && (messages || []).some((m) => isEnvelope(m.text))) {
      throw new Error("this session is end-to-end encrypted — pass --key <key> (the part after # in the link)");
    }
    for (const m of messages) printMsg(key, m);
    for (const f of files || []) printFile(key, f);
  }
}

async function cmdGet(flags, positional) {
  const host = hostOf(flags);
  const cfg = loadConfig();
  const session = flags.s || cfg.session;
  const fileId = flags.f || positional[0];
  if (!session) throw new Error("no session: use -s <id>");
  if (!fileId) throw new Error("no file: use `clipdrop get <fileId> -s <id>`");
  const key = maybeKey(flags, cfg);
  let out = flags.o || null;
  let encrypted = false;
  // best-effort: resolve the real (decrypted) filename from history
  try {
    const h = await fetch(`${host}/api/s/${session}/history`);
    if (h.ok) {
      const { files = [] } = await h.json();
      const f = files.find((x) => x.id === fileId);
      if (f) {
        if (isEnvelope(f.name)) {
          encrypted = true;
          if (!key) throw new Error("this file is encrypted — pass --key <key> (the part after # in the link)");
          const meta = decMeta(key, f.name);
          if (meta?.name) out ||= basename(String(meta.name));
        } else out ||= basename(f.name);
      }
    }
  } catch (e) {
    if (String(e.message).startsWith("this file")) throw e;
  }
  const r = await fetch(`${host}/api/s/${session}/files/${fileId}`);
  if (!r.ok) throw new Error(`download failed: ${r.status} ${await r.text()}`);
  let buf = Buffer.from(await r.arrayBuffer());
  if (key) {
    const pt = decryptBytes(key, buf);
    if (pt) buf = pt;
    else if (encrypted) throw new Error("couldn't decrypt this file — wrong key?");
  }
  out ||= fileId;
  writeFileSync(out, buf);
  console.error(`saved ${out}`);
}

async function main() {
  const { _: pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  try {
    if (cmd === "new") await cmdNew(flags);
    else if (cmd === "push") await cmdPush(flags, pos.slice(1));
    else if (cmd === "pull") await cmdPull(flags, pos.slice(1));
    else if (cmd === "get") await cmdGet(flags, pos.slice(1));
    else if (cmd === "open") {
      const host = hostOf(flags);
      const cfg = loadConfig();
      const session = flags.s || pos[1] || cfg.session;
      const key = maybeKey(flags, cfg);
      console.log(`${host}/s/${session}${key ? `#${key}` : ""}`);
    } else {
      console.log(`clipdrop — share text between devices (end-to-end encrypted)
usage:
  clipdrop new [--host URL] [--ttl 12]
  clipdrop push "text" -s <id> [--host URL] [--key <key>]
  clipdrop push --file ./photo.png -s <id> [--host URL] [--key <key>]
  echo hi | clipdrop push -s <id>
  clipdrop pull -s <id> [--watch] [--key <key>]
  clipdrop get <fileId> -s <id> [-o out] [--key <key>]
  clipdrop open -s <id>

the key is the part after # in the session link; \`clipdrop new\` saves it locally`);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

// allow importing the crypto helpers (tests) without running the CLI
// (resolve symlinks so `npm link` / bin shims still count as direct invocation)
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isDirectRun()) main();
