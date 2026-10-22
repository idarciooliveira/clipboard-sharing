import { DurableObject } from "cloudflare:workers";

export interface ChatMessage {
  id: string;
  text: string;
  device: string;
  createdAt: number;
}

interface Env {
  ROOM: DurableObjectNamespace<SessionRoom>;
}

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const DEFAULT_TTL_HOURS = 12;
const MAX_MESSAGES = 200;
const MAX_TEXT_LEN = 64 * 1024;

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
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
          body: JSON.stringify({ expiresAt }),
        })
      );
      return json({ id, url: `/s/${id}`, expiresAt });
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

export { SessionRoom };

// ---- Durable Object ----

export class SessionRoom extends DurableObject {
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

  private async ensureInit(expiresAt: number) {
    const cur = await this.ctx.storage.get<number>("meta:expiresAt");
    if (!cur) {
      await this.ctx.storage.put("meta:expiresAt", expiresAt);
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  private async listMessages(): Promise<ChatMessage[]> {
    const all = await this.ctx.storage.list<ChatMessage>({ prefix: "msg:" });
    return [...all.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_MESSAGES);
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

  private broadcast(obj: unknown, except?: WebSocket) {
    const data = JSON.stringify(obj);
    for (const [ws] of this.sessions) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {}
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^https?:\/\/[^/]+/, "") || "/";

    // DO-internal init
    if (request.method === "POST" && (path === "/init" || path === "init" || url.pathname === "/init")) {
      const { expiresAt } = (await request.json().catch(() => ({}))) as { expiresAt?: number };
      await this.ensureInit(expiresAt ?? Date.now() + DEFAULT_TTL_HOURS * 3600_000);
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
      const { expiresAt } = await this.meta();
      server.send(JSON.stringify({ type: "hello", messages, expiresAt, peers: this.sessions.size }));
      this.broadcast({ type: "peers", peers: this.sessions.size });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path.endsWith("/history") || path === "/history") {
      const messages = await this.listMessages();
      const { expiresAt } = await this.meta();
      if (!expiresAt) return new Response(JSON.stringify({ error: "session not found" }), { status: 404, headers: { "content-type": "application/json" } });
      if (Date.now() > expiresAt) {
        await this.ctx.storage.deleteAll();
        return new Response(JSON.stringify({ error: "session expired" }), { status: 410, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ messages, expiresAt, peers: this.sessions.size }), {
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
    await this.ctx.storage.deleteAll();
  }
}
