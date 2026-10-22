import { DurableObject } from "cloudflare:workers";

export interface ChatMessage {
  id: string;
  text: string;
  device: string;
  createdAt: number;
}

export interface FileMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  device: string;
  createdAt: number;
}

interface Env {
  ROOM: DurableObjectNamespace<SessionRoom>;
  FILES: R2Bucket;
}

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const DEFAULT_TTL_HOURS = 12;
const MAX_MESSAGES = 200;
const MAX_TEXT_LEN = 64 * 1024;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_FILES = 50;
const MAX_FILES_BYTES = 200 * 1024 * 1024;

function genId(len = 6): string {
  const buf = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (let i = 0; i < len; i++) s += ID_ALPHABET[buf[i] % ID_ALPHABET.length];
  return s;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function getStub(env: Env, id: string) {
  return env.ROOM.get(env.ROOM.idFromName(`clip-${id.toLowerCase()}`));
}

function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "file";
  const clean = base.replace(/[\0-\x1f\x7f]/g, "").trim().slice(0, 180);
  return clean || "file";
}

function fileKey(sessionId: string, fileId: string, name: string): string {
  return `s/${sessionId}/${fileId}-${safeFileName(name).slice(0, 100)}`;
}

async function handleFileUpload(request: Request, env: Env, id: string): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "bad upload" }, 400);
  }
  const f = form.get("file");
  if (!f || typeof f === "string") return json({ error: "no file" }, 400);
  const file = f as unknown as File;
  const name = safeFileName((file as File & { name?: string }).name || "file");
  const size = file.size ?? 0;
  if (!size) return json({ error: "empty" }, 400);
  if (size > MAX_FILE_SIZE) return json({ error: "too large", max: MAX_FILE_SIZE }, 413);
  const device = String(form.get("device") ?? "web").slice(0, 64) || "web";
  const mime = (file.type || "application/octet-stream").slice(0, 128);

  const stub = getStub(env, id);
  const quotaRes = await stub.fetch(new Request(`https://do/quota?size=${size}`));
  if (!quotaRes.ok) {
    const txt = await quotaRes.text().catch(() => '{"error":"session not found"}');
    return new Response(txt, {
      status: quotaRes.status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  const fileId = genId(12);
  const key = fileKey(id, fileId, name);
  try {
    await env.FILES.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: mime },
      customMetadata: { session: id, device },
    });
  } catch {
    return json({ error: "storage failed" }, 500);
  }

  const meta: FileMeta = { id: fileId, name, mime, size, device, createdAt: Date.now() };
  const addRes = await stub.fetch(
    new Request("https://do/add-file", { method: "POST", body: JSON.stringify(meta) })
  );
  if (!addRes.ok) {
    await env.FILES.delete(key).catch(() => {});
    const txt = await addRes.text().catch(() => '{"error":"rejected"}');
    return new Response(txt, {
      status: addRes.status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }
  const { file: saved } = (await addRes.json()) as { file: FileMeta };
  return json({ file: saved }, 201);
}

async function handleFileDownload(
  request: Request,
  env: Env,
  id: string,
  fileId: string
): Promise<Response> {
  const stub = getStub(env, id);
  const metaRes = await stub.fetch(new Request(`https://do/file/${fileId}`));
  if (!metaRes.ok) {
    const txt = await metaRes.text().catch(() => '{"error":"not found"}');
    return new Response(txt, {
      status: metaRes.status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }
  const { file } = (await metaRes.json()) as { file: FileMeta };
  const key = fileKey(id, file.id, file.name);
  // only pass Range through when the client asked for one: local + edge R2
  // report obj.range as the full object span when headers are forwarded blindly
  const obj = request.headers.has("range")
    ? await env.FILES.get(key, { range: request.headers })
    : await env.FILES.get(key);
  if (!obj) return json({ error: "gone" }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // download-only: force attachment, block sniffing, avoid inline HTML/SVG XSS
  const ct = (file.mime || "").toLowerCase();
  if (ct.startsWith("text/html") || ct.includes("svg")) {
    headers.set("content-type", "application/octet-stream");
  } else if (!headers.get("content-type")) {
    headers.set("content-type", file.mime || "application/octet-stream");
  }
  headers.set("content-disposition", `attachment; filename="${file.name.replace(/["\r\n]/g, "")}"`);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "private, max-age=3600");
  headers.set("access-control-allow-origin", "*");
  headers.set("accept-ranges", "bytes");
  // miniflare/local R2 reports obj.range even for full gets — only honor 206
  // when the client actually sent Range
  if (request.headers.has("range") && obj.range) {
    const start = (obj.range as { offset?: number }).offset ?? 0;
    const end = start + obj.size - 1;
    headers.set("content-range", `bytes ${start}-${end}/${(obj as { size: number }).size}`);
    return new Response((obj as R2ObjectBody).body, { status: 206, headers });
  }
  return new Response((obj as R2ObjectBody).body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,range",
        },
      });
    }

    // POST /api/sessions -> create
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      let ttlHours = DEFAULT_TTL_HOURS;
      try {
        const body = (await request.json().catch(() => ({}))) as { ttlHours?: number };
        if (body.ttlHours && body.ttlHours > 0 && body.ttlHours <= 24 * 7) ttlHours = body.ttlHours;
      } catch {}
      const id = genId(6);
      const stub = getStub(env, id);
      const expiresAt = Date.now() + ttlHours * 3600_000;
      await stub.fetch(
        new Request("https://do/init", {
          method: "POST",
          body: JSON.stringify({ expiresAt, id }),
        })
      );
      return json({ id, url: `/s/${id}`, expiresAt });
    }

    // POST /api/s/:id/files -> upload
    const up = url.pathname.match(/^\/api\/s\/([a-z0-9]{4,16})\/files$/i);
    if (up && request.method === "POST") {
      return handleFileUpload(request, env, up[1].toLowerCase());
    }

    // GET /api/s/:id/files/:fileId -> download
    const dl = url.pathname.match(/^\/api\/s\/([a-z0-9]{4,16})\/files\/([a-z0-9]{6,32})$/i);
    if (dl && request.method === "GET") {
      return handleFileDownload(request, env, dl[1].toLowerCase(), dl[2].toLowerCase());
    }

    // Session sub-routes: /api/s/:id/history, /messages, /ws
    const m = url.pathname.match(/^\/api\/s\/([a-z0-9]{4,16})\/(history|messages|ws)$/i);
    if (m) {
      const [, rawId, action] = m;
      const id = rawId.toLowerCase();
      const stub = getStub(env, id);

      if (action === "ws") {
        const upgrade = request.headers.get("Upgrade");
        if (upgrade !== "websocket") return new Response("Expected websocket", { status: 426 });
        const device = (url.searchParams.get("device") || "unknown").slice(0, 64);
        // forward device via header so DO can attach it
        const headers = new Headers(request.headers);
        headers.set("x-device", device);
        return stub.fetch(new Request(request.url, { method: "GET", headers }));
      }

      // proxy REST to DO (keeps storage logic in one place)
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      };
      return stub.fetch(new Request(`https://do/${action}`, init));
    }

    // GET /api/health
    if (url.pathname === "/api/health") return json({ ok: true, ts: Date.now() });

    // Everything else -> static assets (SPA). cf/workers assets binding handles it.
    // If no asset found, return SPA fallback hint.
    return new Response("Not found — web UI is served from / via static assets", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---- Durable Object ----

export class SessionRoom extends DurableObject<Env> {
  sessions = new Map<WebSocket, { device: string }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { device: string } | null;
      if (att) this.sessions.set(ws, att);
    }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async meta(): Promise<{ expiresAt: number }> {
    const expiresAt = ((await this.ctx.storage.get<number>("meta:expiresAt")) ?? 0) as number;
    return { expiresAt };
  }

  private async ensureInit(expiresAt: number, id?: string) {
    const cur = await this.ctx.storage.get<number>("meta:expiresAt");
    if (!cur) {
      await this.ctx.storage.put("meta:expiresAt", expiresAt);
      await this.ctx.storage.setAlarm(expiresAt);
    }
    if (id && !(await this.ctx.storage.get<string>("meta:id"))) {
      await this.ctx.storage.put("meta:id", id.toLowerCase());
    }
  }

  private async listMessages(): Promise<ChatMessage[]> {
    const all = await this.ctx.storage.list<ChatMessage>({ prefix: "msg:" });
    return [...all.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_MESSAGES);
  }

  private async listFiles(): Promise<FileMeta[]> {
    const all = await this.ctx.storage.list<FileMeta>({ prefix: "file:" });
    return [...all.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_FILES);
  }

  private async quota(size: number): Promise<{ ok: boolean; count: number; bytes: number }> {
    const files = await this.listFiles();
    const bytes = files.reduce((n, f) => n + f.size, 0);
    const ok = files.length < MAX_FILES && bytes + size <= MAX_FILES_BYTES && size <= MAX_FILE_SIZE;
    return { ok, count: files.length, bytes };
  }

  private async addMessage(text: string, device: string): Promise<ChatMessage> {
    const msg: ChatMessage = {
      id: crypto.randomUUID().slice(0, 8),
      text: text.slice(0, MAX_TEXT_LEN),
      device: device.slice(0, 64) || "unknown",
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(`msg:${msg.createdAt}:${msg.id}`, msg);
    // trim
    const all = await this.ctx.storage.list({ prefix: "msg:" });
    if (all.size > MAX_MESSAGES) {
      const keys = [...all.keys()].sort().slice(0, all.size - MAX_MESSAGES);
      await Promise.all(keys.map((k) => this.ctx.storage.delete(k)));
    }
    return msg;
  }

  private async addFile(meta: FileMeta): Promise<FileMeta> {
    const file: FileMeta = {
      id: meta.id,
      name: safeFileName(meta.name).slice(0, 180),
      mime: (meta.mime || "application/octet-stream").slice(0, 128),
      size: meta.size,
      device: (meta.device || "unknown").slice(0, 64),
      createdAt: meta.createdAt || Date.now(),
    };
    await this.ctx.storage.put(`file:${file.id}`, file);
    return file;
  }

  private async cleanupFiles() {
    try {
      const id = await this.ctx.storage.get<string>("meta:id");
      if (!id || !this.env.FILES) return;
      let cursor: string | undefined;
      do {
        const page = await this.env.FILES.list({ prefix: `s/${id}/`, cursor });
        if (page.objects.length) {
          await this.env.FILES.delete(page.objects.map((o) => o.key));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    } catch {}
  }

  private broadcast(obj: unknown, except?: WebSocket) {
    const data = JSON.stringify(obj);
    for (const [ws] of this.sessions) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {}
    }
  }

  private async expiredResponse(): Promise<Response | null> {
    const { expiresAt } = await this.meta();
    if (!expiresAt)
      return new Response(JSON.stringify({ error: "session not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    if (Date.now() > expiresAt) {
      await this.ctx.storage.deleteAll();
      await this.cleanupFiles();
      return new Response(JSON.stringify({ error: "session expired" }), {
        status: 410,
        headers: { "content-type": "application/json" },
      });
    }
    return null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^https?:\/\/[^/]+/, "") || "/";

    // DO-internal init
    if (request.method === "POST" && (path === "/init" || path === "init" || url.pathname === "/init")) {
      const { expiresAt, id } = (await request.json().catch(() => ({}))) as {
        expiresAt?: number;
        id?: string;
      };
      await this.ensureInit(expiresAt ?? Date.now() + DEFAULT_TTL_HOURS * 3600_000, id);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // WS upgrade forwarded from Worker
    if (request.headers.get("Upgrade") === "websocket") {
      const device = (request.headers.get("x-device") || "unknown").slice(0, 64);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ device });
      this.sessions.set(server, { device });
      // send current history + presence on connect
      const messages = await this.listMessages();
      const files = await this.listFiles();
      const { expiresAt } = await this.meta();
      server.send(JSON.stringify({ type: "hello", messages, files, expiresAt, peers: this.sessions.size }));
      this.broadcast({ type: "peers", peers: this.sessions.size });
      return new Response(null, { status: 101, webSocket: client });
    }

    // GET /quota?size=N -> upload pre-check
    if (path === "/quota") {
      const expired = await this.expiredResponse();
      if (expired) return expired;
      const size = Number(url.searchParams.get("size") ?? 0);
      if (!size || size > MAX_FILE_SIZE)
        return new Response(JSON.stringify({ error: "too large", max: MAX_FILE_SIZE }), {
          status: 413,
          headers: { "content-type": "application/json" },
        });
      const q = await this.quota(size);
      if (!q.ok)
        return new Response(JSON.stringify({ error: "session quota exceeded" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify({ ...q, ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // POST /add-file -> register uploaded file meta + broadcast
    if (path === "/add-file" && request.method === "POST") {
      const expired = await this.expiredResponse();
      if (expired) return expired;
      const body = (await request.json().catch(() => ({}))) as Partial<FileMeta>;
      if (
        !body.id ||
        !/^[a-z0-9]{6,32}$/.test(body.id) ||
        !body.name ||
        !body.size ||
        body.size > MAX_FILE_SIZE
      ) {
        return new Response(JSON.stringify({ error: "bad file meta" }), { status: 400 });
      }
      const q = await this.quota(body.size);
      if (!q.ok)
        return new Response(JSON.stringify({ error: "session quota exceeded" }), { status: 409 });
      const file = await this.addFile(body as FileMeta);
      this.broadcast({ type: "file", file });
      return new Response(JSON.stringify({ file }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    // GET /file/:id -> single file meta (Worker resolves bytes from R2)
    {
      const fm = path.match(/^\/?file\/([a-z0-9]{6,32})$/);
      if (fm && request.method === "GET") {
        const expired = await this.expiredResponse();
        if (expired) return expired;
        const file = await this.ctx.storage.get<FileMeta>(`file:${fm[1]}`);
        if (!file)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify({ file }), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // GET /files -> list file metas
    if ((path === "/files" || path.endsWith("/files")) && request.method === "GET") {
      const expired = await this.expiredResponse();
      if (expired) return expired;
      return new Response(JSON.stringify({ files: await this.listFiles() }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (path.endsWith("/history") || path === "/history") {
      const messages = await this.listMessages();
      const files = await this.listFiles();
      const { expiresAt } = await this.meta();
      if (!expiresAt) return new Response(JSON.stringify({ error: "session not found" }), { status: 404, headers: { "content-type": "application/json" } });
      if (Date.now() > expiresAt) {
        await this.ctx.storage.deleteAll();
        await this.cleanupFiles();
        return new Response(JSON.stringify({ error: "session expired" }), { status: 410, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ messages, files, expiresAt, peers: this.sessions.size }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (path.endsWith("/messages") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { text?: string; device?: string };
      const text = (body.text ?? "").trim();
      if (!text) return new Response(JSON.stringify({ error: "empty" }), { status: 400 });
      if (text.length > MAX_TEXT_LEN) return new Response(JSON.stringify({ error: "too large" }), { status: 413 });
      const { expiresAt } = await this.meta();
      if (!expiresAt) return new Response(JSON.stringify({ error: "session not found" }), { status: 404 });
      const msg = await this.addMessage(text, body.device || "rest");
      this.broadcast({ type: "msg", msg });
      return new Response(JSON.stringify({ msg }), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const sess = this.sessions.get(ws) ?? { device: "unknown" };
    let data: { text?: string; device?: string };
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    const text = (data.text ?? "").trim();
    if (!text || text.length > MAX_TEXT_LEN) return;
    const msg = await this.addMessage(text, data.device || sess.device);
    this.broadcast({ type: "msg", msg });
  }

  async webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
    this.broadcast({ type: "peers", peers: this.sessions.size });
  }

  async webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  async alarm() {
    await this.cleanupFiles();
    await this.ctx.storage.deleteAll();
  }
}
