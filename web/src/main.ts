import QRCode from "qrcode";

type Msg = { id: string; text: string; device: string; createdAt: number };

const app = document.getElementById("app")!;
const path = location.pathname;

function deviceName(): string {
  const ua = navigator.userAgent.toLowerCase();
  const os = ua.includes("iphone") ? "iphone" : ua.includes("android") ? "android" : ua.includes("mac") ? "mac" : ua.includes("win") ? "windows" : ua.includes("linux") ? "linux" : "web";
  const br = ua.includes("safari") && !ua.includes("chrome") ? "safari" : ua.includes("firefox") ? "firefox" : "chrome";
  return `${os}-${br}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function linkify(s: string): string {
  const e = esc(s);
  return e.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

if (path === "/" || path === "/index.html") {
  app.innerHTML = `
    <header class="top"><div class="brand">clip<span>drop</span></div><div class="badge">12h sessions · no login</div></header>
    <div class="card">
      <h2 style="margin:0 0 8px">Share text between computer & phone</h2>
      <p class="hint">Create a session, open the link on your other device, paste → copy. Blazing fast via Cloudflare edge.</p>
      <div class="row"><button id="new">＋ New session</button></div>
      <div style="height:12px"></div>
      <div class="row"><input id="code" placeholder="enter code e.g. k7xq2p" maxlength="16" /><button id="join" class="ghost">Join</button></div>
      <p class="hint" id="err"></p>
    </div>`;
  (document.getElementById("new") as HTMLButtonElement).onclick = async (e) => {
    (e.target as HTMLButtonElement).textContent = "Creating…";
    try {
      const { id } = await api<{ id: string }>("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ttlHours: 12 }) });
      location.href = `/s/${id}`;
    } catch (err) {
      (document.getElementById("err") as HTMLParagraphElement).textContent = String(err);
    }
  };
  const go = () => {
    const v = (document.getElementById("code") as HTMLInputElement).value.trim().toLowerCase();
    if (v) location.href = `/s/${v}`;
  };
  (document.getElementById("join") as HTMLButtonElement).onclick = go;
  (document.getElementById("code") as HTMLInputElement).onkeydown = (ev) => { if (ev.key === "Enter") go(); };
} else {
  const m = path.match(/^\/s\/([a-z0-9]{4,16})/i);
  const id = (m?.[1] ?? "").toLowerCase();
  if (!id) location.href = "/";

  let messages: Msg[] = [];
  let ws: WebSocket | null = null;
  let expiresAt = 0;

  app.innerHTML = `
    <header class="top">
      <div class="brand"><a href="/" style="color:inherit;text-decoration:none">clip<span>drop</span></a> <span style="color:#94a3b8;font-weight:400">/s/${esc(id)}</span></div>
      <div class="badge" id="peers">• connecting</div>
    </header>
    <div class="card">
      <div class="row">
        <input id="link" readonly value="${location.origin}/s/${esc(id)}" />
        <button id="copylink" class="ghost" style="flex:0 0 90px">Copy</button>
      </div>
      <div style="height:10px"></div>
      <div><canvas id="qr"></canvas></div>
      <div class="status" id="exp"></div>
    </div>
    <div id="list"></div>
    <div class="composer"><div class="composer-inner">
      <textarea id="box" placeholder="paste or type, Enter to send (Shift+Enter newline)"></textarea>
      <button id="send" style="flex:0 0 90px">Send</button>
    </div></div>`;

  const list = document.getElementById("list")!;
  const box = document.getElementById("box") as HTMLTextAreaElement;

  function render() {
    list.innerHTML = messages.map((msg) => `
      <div class="msg" data-id="${msg.id}">
        <div>${linkify(msg.text)}</div>
        <div class="meta"><span>${esc(msg.device)}</span><span>·</span><span>${new Date(msg.createdAt).toLocaleTimeString()}</span>
        <span style="flex:1"></span><button class="copy ghost" data-copy="${esc(msg.text).slice(0, 0)}" data-id2="${msg.id}">Copy</button></div>
      </div>`).join("") || `<p class="hint">No clips yet — paste something below.</p>`;
    list.querySelectorAll<HTMLButtonElement>("button.copy").forEach((b) => {
      b.onclick = async () => {
        const div = b.closest(".msg");
        const mid = div?.getAttribute("data-id");
        const msg = messages.find((x) => x.id === mid);
        if (msg) {
          await navigator.clipboard.writeText(msg.text).catch(() => {});
          b.textContent = "Copied ✓";
          setTimeout(() => (b.textContent = "Copy"), 1200);
        }
      };
    });
    window.scrollTo({ top: document.body.scrollHeight });
  }

  function tickExp() {
    const el = document.getElementById("exp")!;
    if (!expiresAt) { el.textContent = ""; return; }
    const ms = expiresAt - Date.now();
    if (ms <= 0) { el.textContent = "expired"; return; }
    const h = Math.floor(ms / 3600000), mi = Math.floor((ms % 3600000) / 60000);
    el.textContent = `expires in ${h}h ${mi}m · ${messages.length} clips`;
  }
  setInterval(tickExp, 30000);

  (document.getElementById("copylink") as HTMLButtonElement).onclick = async (e) => {
    await navigator.clipboard.writeText(`${location.origin}/s/${id}`).catch(() => {});
    (e.target as HTMLButtonElement).textContent = "Copied ✓";
    setTimeout(() => ((e.target as HTMLButtonElement).textContent = "Copy"), 1200);
  };

  QRCode.toCanvas(document.getElementById("qr") as HTMLCanvasElement, `${location.origin}/s/${id}`, { width: 160, margin: 1 });

  async function load() {
    try {
      const data = await api<{ messages: Msg[]; expiresAt: number }>(`/api/s/${id}/history`);
      messages = data.messages;
      expiresAt = data.expiresAt;
      render(); tickExp();
    } catch (err) {
      list.innerHTML = `<div class="card"><b>Session not found or expired.</b><p class="hint">${esc(String(err))}</p><p><a class="link" href="/">Create a new one →</a></p></div>`;
      document.querySelector(".composer")?.remove();
      throw err;
    }
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/s/${id}/ws?device=${encodeURIComponent(deviceName())}`);
    const peers = document.getElementById("peers")!;
    ws.onopen = () => { peers.textContent = "● live"; };
    ws.onclose = () => { peers.textContent = "○ reconnecting…"; setTimeout(connect, 1500); };
    ws.onerror = () => { try { ws?.close(); } catch {} };
    ws.onmessage = (ev) => {
      try {
        const o = JSON.parse(ev.data);
        if (o.type === "msg" && o.msg) {
          if (!messages.some((x) => x.id === o.msg.id)) {
            messages.push(o.msg); render(); tickExp();
          }
        } else if (o.type === "hello") {
          messages = o.messages ?? messages;
          expiresAt = o.expiresAt ?? expiresAt;
          render(); tickExp();
          peers.textContent = `● live · ${o.peers ?? 1}`;
        } else if (o.type === "peers") {
          peers.textContent = `● live · ${o.peers}`;
        }
      } catch {}
    };
  }

  async function send() {
    const text = box.value.trim();
    if (!text) return;
    box.value = "";
    // optimistic via WS if open, else REST
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ text, device: deviceName() }));
    } else {
      const { msg } = await api<{ msg: Msg }>(`/api/s/${id}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, device: deviceName() }),
      });
      messages.push(msg); render(); tickExp();
    }
  }

  (document.getElementById("send") as HTMLButtonElement).onclick = send;
  box.onkeydown = (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send(); } };

  load().then(() => connect()).catch(() => {});
}
