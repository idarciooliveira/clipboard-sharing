#!/usr/bin/env node
// clipdrop CLI — minimal, no deps. Works on linux/mac/win with Node 20+.
// Usage:
//   clipdrop new [--host URL] [--ttl 12]
//   clipdrop push "text" -s <id> [--host URL] | echo hi | clipdrop push -s <id>
//   clipdrop push --file ./photo.png -s <id> [--host URL]
//   clipdrop pull -s <id> [--host URL] [--watch]
//   clipdrop get <fileId> -s <id> [--host URL] [-o out]
//   clipdrop open -s <id> [--host URL]

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, basename } from "node:path";

const CONFIG_PATH = join(homedir(), ".config", "clipdrop", "config.json");

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
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : "true";
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
  return (flags.host || flags.h || cfg.host || process.env.CLIPDROP_HOST || "http://localhost:8787").replace(/\/$/, "");
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
  const cfg = loadConfig();
  cfg.host = host;
  cfg.session = id;
  saveConfig(cfg);
  console.log(id);
  console.error(`session: ${id}`);
  console.error(`url: ${host}/s/${id}`);
  console.error(`expires: ${new Date(expiresAt).toISOString()}`);
}

async function cmdPush(flags, positional) {
  const host = hostOf(flags);
  const cfg = loadConfig();
  const session = flags.s || positional[0] || cfg.session;
  if (!session) throw new Error("no session: use -s <id> or `clipdrop new` first");
  if (flags.file) {
    const p = String(flags.file);
    if (!existsSync(p)) throw new Error(`file not found: ${p}`);
    const st = statSync(p);
    if (st.size > 25 * 1024 * 1024) throw new Error("file too big (max 25MB)");
    const buf = readFileSync(p);
    const fd = new FormData();
    fd.append("file", new Blob([buf]), basename(p));
    fd.append("device", device());
    const r = await fetch(`${host}/api/s/${session}/files`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
    const { file } = await r.json();
    console.error(`uploaded ${file.name} (${file.size} bytes) to ${session} [${file.id}]`);
    return;
  }
  const stdinText = await readStdin();
  const text = [positional.slice(1).join(" "), positional.length <= 1 ? positional[0] && flags.s ? "" : "" : "", stdinText].filter(Boolean).join("\n").trim()
    || (flags.s ? positional.join(" ") : positional.slice(1).join(" "));
  // simpler: if -s given, all positionals are text; else first positional is session
  let finalText = flags.s ? positional.join(" ") : positional.slice(1).join(" ");
  if (stdinText) finalText = finalText ? `${finalText}\n${stdinText}` : stdinText;
  if (!finalText) throw new Error("nothing to push: pass text arg or pipe stdin");
  const r = await fetch(`${host}/api/s/${session}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: finalText, device: device() }),
  });
  if (!r.ok) throw new Error(`push failed: ${r.status} ${await r.text()}`);
  console.error(`pushed ${finalText.length} chars to ${session}`);
}

async function cmdPull(flags, positional) {
  const host = hostOf(flags);
  const cfg = loadConfig();
  const session = flags.s || positional[0] || cfg.session;
  if (!session) throw new Error("no session: use -s <id>");
  if (flags.watch) {
    const proto = host.startsWith("https") ? "wss" : "ws";
    const base = host.replace(/^https?/, proto);
    const { WebSocket } = await import("node:https").catch(() => ({ WebSocket: globalThis.WebSocket }));
    // Node 22 has global WebSocket
    const WS = globalThis.WebSocket;
    if (!WS) throw new Error("watch requires Node 22+ with global WebSocket");
    const ws = new WS(`${base}/api/s/${session}/ws?device=${encodeURIComponent(device())}`);
    ws.onmessage = (ev) => {
      try {
        const o = JSON.parse(ev.data);
        if (o.type === "msg") console.log(`[${o.msg.device} ${new Date(o.msg.createdAt).toLocaleTimeString()}] ${o.msg.text}\n---`);
        if (o.type === "file") console.log(`[file ${o.file.device} ${new Date(o.file.createdAt).toLocaleTimeString()}] ${o.file.name} (${o.file.size} bytes) id:${o.file.id}\n---`);
        if (o.type === "hello") {
          o.messages.forEach((m) => console.log(`[${m.device} ${new Date(m.createdAt).toLocaleTimeString()}] ${m.text}\n---`));
          (o.files || []).forEach((f) => console.log(`[file ${f.device} ${new Date(f.createdAt).toLocaleTimeString()}] ${f.name} (${f.size} bytes) id:${f.id}\n---`));
        }
      } catch {}
    };
    ws.onerror = (e) => console.error("ws error", e);
    await new Promise(() => {});
  } else {
    const r = await fetch(`${host}/api/s/${session}/history`);
    if (!r.ok) throw new Error(`pull failed: ${r.status} ${await r.text()}`);
    const { messages, files } = await r.json();
    for (const m of messages) console.log(`[${m.device} ${new Date(m.createdAt).toLocaleTimeString()}] ${m.text}\n---`);
    for (const f of files || []) console.log(`[file ${f.device} ${new Date(f.createdAt).toLocaleTimeString()}] ${f.name} (${f.size} bytes) id:${f.id}\n---`);
  }
}

async function cmdGet(flags, positional) {
  const host = hostOf(flags);
  const cfg = loadConfig();
  const session = flags.s || cfg.session;
  const fileId = flags.f || positional[0];
  if (!session) throw new Error("no session: use -s <id>");
  if (!fileId) throw new Error("no file: use `clipdrop get <fileId> -s <id>`");
  const r = await fetch(`${host}/api/s/${session}/files/${fileId}`);
  if (!r.ok) throw new Error(`download failed: ${r.status} ${await r.text()}`);
  const disp = r.headers.get("content-disposition") || "";
  const hinted = disp.match(/filename="([^"]+)"/)?.[1];
  const out = flags.o || hinted || fileId;
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
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
      console.log(`${host}/s/${session}`);
    } else {
      console.log(`clipdrop — share text between devices
usage:
  clipdrop new [--host URL] [--ttl 12]
  clipdrop push "text" -s <id> [--host URL]
  clipdrop push --file ./photo.png -s <id> [--host URL]
  echo hi | clipdrop push -s <id>
  clipdrop pull -s <id> [--watch]
  clipdrop get <fileId> -s <id> [-o out]
  clipdrop open -s <id>`);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

main();
