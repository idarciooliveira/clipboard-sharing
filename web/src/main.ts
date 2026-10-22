import QRCode from "qrcode";

type Msg = { id: string; text: string; device: string; createdAt: number };

const app = document.getElementById("app")!;
const path = location.pathname;

if ("serviceWorker" in navigator && location.protocol === "https:") {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

const ICON = {
  paste: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg>`,
  send: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  qr: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v7M14 20h3"/></svg>`,
  close: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
};

// logo mark (two squares + cut triangle); colours follow the theme through CSS variables
function mark(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="160 128 224 224" aria-hidden="true"><defs><linearGradient id="mg" x1="128" y1="128" x2="384" y2="384" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFAE00"/><stop offset="1" stop-color="#FF8C00"/></linearGradient></defs><path fill="var(--mark-gray)" d="M160 128h128v128h-128z"/><path fill="url(#mg)" d="M224 192h160v160h-160z"/><path fill="var(--bg)" d="M224 192l80 80-80 80z"/></svg>`;
}

function deviceName(): string {
  const ua = navigator.userAgent.toLowerCase();
  const os = ua.includes("iphone") || ua.includes("ipad") ? "iphone" : ua.includes("android") ? "android" : ua.includes("mac") ? "mac" : ua.includes("win") ? "windows" : ua.includes("linux") ? "linux" : "web";
  const br = ua.includes("safari") && !ua.includes("chrome") ? "safari" : ua.includes("firefox") ? "firefox" : "chrome";
  return `${os}-${br}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function linkify(s: string): string {
  return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}
const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim());
const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // fallback for insecure contexts / older iOS
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

let toastTimer: number | undefined;
function toast(text: string) {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = text;
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), 1400);
}

/* ---------------- home ---------------- */
if (path === "/" || path === "/index.html") {
  app.classList.add("home");
  app.innerHTML = `
    <header class="top"><a class="brand" href="/">${mark(26)}<span>clip<b>drop</b></span></a></header>
    <main class="hero">
      ${mark(72)}
      <h1>Share text between<br />your devices.</h1>
      <p>Open a session, scan the code on your other device, paste. Gone after 12 hours. No login.</p>
      <div class="actions">
        <button id="new" class="btn primary">New session</button>
        <div class="divider">or join</div>
        <div class="join">
          <input id="code" class="field" placeholder="code" maxlength="16" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go" inputmode="text" aria-label="Session code" />
          <button id="join" class="btn">Join</button>
        </div>
        <p class="err" id="err" role="alert"></p>
      </div>
    </main>
    <div class="foot">Live over WebSocket · Cloudflare edge</div>`;
  const newBtn = document.getElementById("new") as HTMLButtonElement;
  const codeEl = document.getElementById("code") as HTMLInputElement;
  const errEl = document.getElementById("err") as HTMLParagraphElement;
  newBtn.onclick = async () => {
    newBtn.disabled = true; newBtn.textContent = "Creating…"; errEl.textContent = "";
    try {
      const { id } = await api<{ id: string }>("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ttlHours: 12 }) });
      location.href = `/s/${id}`;
    } catch (err) {
      errEl.textContent = String(err);
      newBtn.disabled = false; newBtn.textContent = "New session";
    }
  };
  const go = () => {
    // accept a bare code or a pasted full link
    const raw = codeEl.value.trim().toLowerCase();
    const v = raw.match(/\/s\/([a-z0-9]{4,16})/)?.[1] ?? raw;
    if (/^[a-z0-9]{4,16}$/.test(v)) location.href = `/s/${v}`;
    else errEl.textContent = "Enter a valid session code";
  };
  (document.getElementById("join") as HTMLButtonElement).onclick = go;
  codeEl.onkeydown = (ev) => { if (ev.key === "Enter") go(); };
  codeEl.oninput = () => { errEl.textContent = ""; };

/* ---------------- room ---------------- */
} else {
  const m = path.match(/^\/s\/([a-z0-9]{4,16})/i);
  const id = (m?.[1] ?? "").toLowerCase();
  if (!id) location.href = "/";

  const link = `${location.origin}/s/${id}`;
  let messages: Msg[] = [];
  let ws: WebSocket | null = null;
  let expiresAt = 0;
  let qrReady = false;

  app.innerHTML = `
    <header class="top">
      <a class="brand" href="/" aria-label="clipdrop home">${mark(26)}<span>clip<b>drop</b></span></a>
      <div class="head-right"><span class="live" id="peers"><i></i><span>connecting</span></span><span class="code">${esc(id)}</span></div>
    </header>
    <section class="share" id="share">
      <div class="share-row">
        <input class="field" id="link" readonly value="${esc(link)}" aria-label="Session link" />
        <button class="btn sm" id="copylink">Copy</button>
        <button class="btn sm icon-btn" id="qrbtn" aria-label="Show QR code" aria-expanded="false">${ICON.qr}</button>
      </div>
      <div class="qr-panel"><div class="qr-box"><canvas id="qr"></canvas></div><p class="qr-hint">Scan with your phone camera</p></div>
    </section>
    <div class="bar"><span><b id="count">0</b> clips</span><span id="exp"></span></div>
    <div class="grid" id="list"></div>
    <div class="composer"><div class="composer-inner">
      <button class="btn icon-btn paste" id="paste" aria-label="Paste from clipboard">${ICON.paste}</button>
      <textarea id="box" rows="1" placeholder="Paste or type…" enterkeyhint="send" aria-label="Message" autocomplete="off" autocapitalize="sentences"></textarea>
      <button class="btn primary icon-btn send" id="send" aria-label="Send" disabled>${ICON.send}</button>
    </div></div>
    <dialog class="sheet" id="sheet" aria-label="Clip">
      <div class="sheet-head"><span id="sheet-meta"></span><button class="btn sm icon-btn" id="sheet-x" aria-label="Close">${ICON.close}</button></div>
      <div class="sheet-body" id="sheet-body"></div>
      <div class="sheet-foot"><button class="btn primary" id="sheet-copy">Copy</button></div>
    </dialog>`;

  const list = document.getElementById("list")!;
  const box = document.getElementById("box") as HTMLTextAreaElement;
  const sendBtn = document.getElementById("send") as HTMLButtonElement;
  const sheet = document.getElementById("sheet") as HTMLDialogElement;
  const sheetCopy = document.getElementById("sheet-copy") as HTMLButtonElement;
  const peersEl = document.getElementById("peers")!;
  let openId = "";

  const coarse = matchMedia("(pointer: coarse)").matches;

  function setLive(on: boolean, label: string) {
    peersEl.classList.toggle("on", on);
    peersEl.lastElementChild!.textContent = label;
  }

  function render() {
    document.getElementById("count")!.textContent = String(messages.length);
    if (!messages.length) {
      list.innerHTML = `<div class="empty">Nothing here yet.<br />Paste something below.</div>`;
      return;
    }
    // newest first
    list.innerHTML = [...messages].reverse().map((msg) => {
      const url = isUrl(msg.text);
      return `
      <div class="clip${url ? " link" : ""}" role="button" tabindex="0" data-id="${msg.id}" aria-label="Open clip">
        <div class="body">${esc(msg.text)}</div>
        <div class="foot-row">
          ${url ? `<span class="tag">link</span>` : ""}
          <span class="grow"><span class="dev">${esc(msg.device)} · </span>${fmtTime(msg.createdAt)}</span>
          <button class="btn sm" data-copy="${msg.id}">Copy</button>
        </div>
      </div>`;
    }).join("");
  }

  function tickExp() {
    const el = document.getElementById("exp")!;
    if (!expiresAt) { el.textContent = ""; return; }
    const ms = expiresAt - Date.now();
    if (ms <= 0) { el.textContent = "expired"; return; }
    const h = Math.floor(ms / 3600000), mi = Math.floor((ms % 3600000) / 60000);
    el.textContent = `expires in ${h}h ${mi}m`;
  }
  setInterval(tickExp, 30000);

  /* copy */
  async function copyClip(msg: Msg, btn?: HTMLButtonElement) {
    const ok = await copyText(msg.text);
    buzz();
    if (btn) { const old = btn.textContent; btn.textContent = ok ? "Copied ✓" : "Failed"; setTimeout(() => (btn.textContent = old), 1100); }
    if (!sheet.open) toast(ok ? "Copied" : "Couldn't copy");
  }
  const byId = (mid: string | null | undefined) => messages.find((x) => x.id === mid);

  /* open/close expanded clip */
  function openClip(msg: Msg) {
    openId = msg.id;
    document.getElementById("sheet-meta")!.textContent = `${msg.device} · ${fmtTime(msg.createdAt)} · ${msg.text.length.toLocaleString()} chars`;
    document.getElementById("sheet-body")!.innerHTML = linkify(msg.text);
    sheetCopy.textContent = "Copy";
    sheet.showModal();
  }
  list.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const cbtn = t.closest<HTMLButtonElement>("button[data-copy]");
    if (cbtn) { ev.stopPropagation(); const msg = byId(cbtn.dataset.copy); if (msg) copyClip(msg, cbtn); return; }
    const msg = byId(t.closest<HTMLElement>(".clip")?.dataset.id);
    if (msg) openClip(msg);
  });
  list.addEventListener("keydown", (ev) => {
    const el = ev.target as HTMLElement;
    if ((ev.key === "Enter" || ev.key === " ") && el.classList.contains("clip")) { ev.preventDefault(); const msg = byId(el.dataset.id); if (msg) openClip(msg); }
  });
  sheet.addEventListener("click", (ev) => { if (ev.target === sheet) sheet.close(); }); // backdrop
  document.getElementById("sheet-x")!.onclick = () => sheet.close();
  sheetCopy.onclick = async () => {
    const msg = byId(openId);
    if (!msg) return;
    const ok = await copyText(msg.text);
    buzz();
    sheetCopy.textContent = ok ? "Copied ✓" : "Couldn't copy";
    if (ok) setTimeout(() => sheet.open && sheet.close(), 650);
  };

  /* share strip */
  (document.getElementById("copylink") as HTMLButtonElement).onclick = async () => {
    const ok = await copyText(link);
    toast(ok ? "Link copied" : "Couldn't copy");
    buzz();
  };
  const shareEl = document.getElementById("share")!;
  const qrBtn = document.getElementById("qrbtn") as HTMLButtonElement;
  qrBtn.onclick = () => {
    const open = shareEl.classList.toggle("open");
    qrBtn.setAttribute("aria-expanded", String(open));
    if (open && !qrReady) {
      qrReady = true;
      QRCode.toCanvas(document.getElementById("qr") as HTMLCanvasElement, link, { width: 336, margin: 0, color: { dark: "#0a0a0a", light: "#ffffff" } });
    }
  };
  (document.getElementById("link") as HTMLInputElement).onfocus = (e) => (e.target as HTMLInputElement).select();

  /* data */
  async function load() {
    try {
      const data = await api<{ messages: Msg[]; expiresAt: number }>(`/api/s/${id}/history`);
      messages = data.messages;
      expiresAt = data.expiresAt;
      render(); tickExp();
    } catch (err) {
      document.getElementById("share")!.remove();
      document.querySelector(".bar")?.remove();
      document.querySelector(".composer")?.remove();
      list.className = "";
      list.innerHTML = `<div class="hero" style="min-height:50dvh"><h1>Session not found</h1><p>It may have expired or the code is wrong.</p><div class="actions"><a class="btn primary" href="/">Start a new session</a></div></div>`;
      throw err;
    }
  }

  let retry: number | undefined;
  function connect() {
    clearTimeout(retry);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/s/${id}/ws?device=${encodeURIComponent(deviceName())}`);
    ws.onopen = () => setLive(true, "live");
    ws.onclose = () => { setLive(false, "reconnecting"); retry = window.setTimeout(connect, 1500); };
    ws.onerror = () => { try { ws?.close(); } catch {} };
    ws.onmessage = (ev) => {
      try {
        const o = JSON.parse(ev.data);
        if (o.type === "msg" && o.msg) {
          if (!messages.some((x) => x.id === o.msg.id)) { messages.push(o.msg); render(); tickExp(); }
        } else if (o.type === "hello") {
          messages = o.messages ?? messages;
          expiresAt = o.expiresAt ?? expiresAt;
          render(); tickExp();
          setLive(true, `live · ${o.peers ?? 1}`);
        } else if (o.type === "peers") {
          setLive(true, `live · ${o.peers}`);
        }
      } catch {}
    };
  }
  // phones suspend sockets in the background: reconnect + refresh on return
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    api<{ messages: Msg[]; expiresAt: number }>(`/api/s/${id}/history`).then((d) => { messages = d.messages; expiresAt = d.expiresAt; render(); tickExp(); }).catch(() => {});
  });

  /* composer */
  function fit() {
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 144)}px`;
    sendBtn.disabled = !box.value.trim();
  }
  box.addEventListener("input", fit);

  async function send() {
    const text = box.value.trim();
    if (!text) return;
    box.value = ""; fit();
    buzz(12);
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text, device: deviceName() }));
      } else {
        const { msg } = await api<{ msg: Msg }>(`/api/s/${id}/messages`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, device: deviceName() }),
        });
        messages.push(msg); render(); tickExp();
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      box.value = text; fit(); toast("Send failed");
    }
    // keep the keyboard open for quick consecutive clips
    box.focus({ preventScroll: true });
  }
  sendBtn.onmousedown = (e) => e.preventDefault(); // don't steal focus from the textarea
  sendBtn.onclick = send;
  box.onkeydown = (ev) => {
    if (ev.key !== "Enter" || ev.isComposing) return;
    // desktop: Enter sends, Shift+Enter newline. touch: Enter is newline, button sends. Ctrl/Cmd+Enter always sends.
    if (ev.ctrlKey || ev.metaKey || (!coarse && !ev.shiftKey)) { ev.preventDefault(); send(); }
  };

  const pasteBtn = document.getElementById("paste") as HTMLButtonElement;
  pasteBtn.onmousedown = (e) => e.preventDefault();
  pasteBtn.onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { toast("Clipboard is empty"); return; }
      box.value = box.value ? `${box.value}\n${t}` : t;
      fit(); box.focus({ preventScroll: true });
      buzz();
    } catch {
      toast("Allow clipboard access, or long-press to paste");
      box.focus();
    }
  };

  fit();
  load().then(() => { connect(); if (!coarse) box.focus({ preventScroll: true }); }).catch(() => {});
}
