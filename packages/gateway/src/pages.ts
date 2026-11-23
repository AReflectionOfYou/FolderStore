// HTML pages served by the gateway itself. The setup page holds no secrets:
// the moderator types the admin secret into it, and it is kept only in that
// browser tab's sessionStorage.

const STYLE = `
  :root { --bg:#faf8f5; --fg:#1f1d1a; --muted:#6b665e; --card:#fff; --line:#e4dfd6; --accent:#2f5d8a; --bad:#a33; --good:#2c6e3f; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#ece8e1; --muted:#a29c92; --card:#201f1c; --line:#35322d; --accent:#7fb0e0; --bad:#e08080; --good:#7cc493; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 0 0 12px; }
  p.lede, .muted { color: var(--muted); }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px; margin: 16px 0; }
  label { display:block; font-weight: 600; margin: 10px 0 4px; }
  input[type=text], input[type=password], input[type=number], textarea { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font: inherit; }
  textarea { font-family: ui-monospace, Menlo, monospace; font-size: 13px; min-height: 84px; }
  .row { display:flex; gap:12px; flex-wrap: wrap; } .row > div { flex: 1 1 200px; }
  .checks label { display:inline-flex; gap:6px; align-items:center; font-weight:400; margin-right:16px; }
  button { margin-top: 12px; padding: 9px 16px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--line); }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 0.92em; overflow-wrap: anywhere; }
  .status { padding: 8px 12px; border-radius: 8px; border:1px solid var(--line); }
  .ok { color: var(--good); } .bad { color: var(--bad); }
  table { width:100%; border-collapse: collapse; font-size: 14px; } td, th { text-align:left; padding:6px 4px; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
  [hidden] { display:none !important; }
`;

export function setupPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Storage Gateway Setup</title><style>${STYLE}</style></head>
<body><main>
<h1>Storage gateway</h1>
<p class="lede">Organizer setup for this gateway. Contributors never see this page; they only use the links you make here.</p>

<section id="unlock">
  <h2>1. Sign in as organizer</h2>
  <label for="secret">Admin secret (the <code>ADMIN_SECRET</code> you set when deploying)</label>
  <input id="secret" type="password" autocomplete="off">
  <button id="unlockBtn">Continue</button>
  <p id="unlockMsg" class="bad"></p>
</section>

<div id="panel" hidden>
<section>
  <h2>2. Connect storage</h2>
  <div id="status" class="status">Checking…</div>
  <div id="connectBox" hidden>
    <p>First, add this exact address as a <b>Redirect URI</b> in your <span class="provider"></span> app settings:</p>
    <p><code id="redirectUri"></code></p>
    <button id="connectBtn">Connect <span class="provider"></span></button>
  </div>
</section>

<section>
  <h2>3. Make a contributor link</h2>
  <div class="row">
    <div><label for="campaign">Campaign</label><input id="campaign" type="text" placeholder="smith-family"></div>
    <div><label for="contributor">Contributor ID</label><input id="contributor" type="text" placeholder="aunt-rose or guests"></div>
  </div>
  <label for="label">Label (optional, for your own reference)</label><input id="label" type="text" placeholder="Aunt Rose">
  <label>What the link allows</label>
  <div class="checks">
    <label><input type="checkbox" id="pUpload" checked> Add files</label>
    <label><input type="checkbox" id="pList" checked> See the list of files</label>
    <label><input type="checkbox" id="pRead" checked> Open others' files</label>
  </div>
  <label for="expires">Expires after (days, blank for never)</label><input id="expires" type="number" min="1">
  <button id="linkBtn">Make link</button>
  <p id="linkMsg" class="bad"></p>
  <div id="linkOut" hidden>
    <label for="linkText">Share this link</label>
    <textarea id="linkText" readonly></textarea>
    <button class="secondary" id="copyBtn">Copy</button>
    <p class="muted">Anyone with this link can do what you checked above, until it expires or you revoke it.
    To revoke every link for one campaign, raise its number in <code>LINK_GENERATIONS</code>
    (for example <code>{"smith-family": 2}</code>) and make new links. Rotating <code>SIGNING_KEY</code> revokes all links everywhere.</p>
  </div>
</section>

<section>
  <h2>Browse a campaign</h2>
  <div class="row"><div><label for="browseCampaign">Campaign</label><input id="browseCampaign" type="text"></div>
  <div><label for="browsePath">Folder</label><input id="browsePath" type="text" placeholder="(top)"></div></div>
  <button id="browseBtn">List</button>
  <p id="browseMsg" class="bad"></p>
  <table id="files" hidden><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody></tbody></table>
</section>
</div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  let secret = "";
  try { secret = sessionStorage.getItem("fsAdmin") || ""; } catch {}

  async function api(path, init = {}) {
    const res = await fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + secret, ...(init.body ? { "Content-Type": "application/json" } : {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    return body;
  }

  async function unlock() {
    secret = $("secret").value.trim() || secret;
    try {
      const s = await api("/api/admin/status");
      try { sessionStorage.setItem("fsAdmin", secret); } catch {}
      $("unlock").hidden = true; $("panel").hidden = false;
      render(s);
    } catch (e) { $("unlockMsg").textContent = e.message; }
  }

  function render(s) {
    document.querySelectorAll(".provider").forEach((el) => el.textContent = s.connectProvider || "storage");
    $("redirectUri").textContent = s.redirectUri;
    if (s.connected) {
      $("status").innerHTML = '<span class="ok">Connected</span> to ' + (s.connectProvider || s.backend) + '. You can make links now.';
      $("connectBox").hidden = true;
    } else if (s.canConnect) {
      $("status").innerHTML = '<span class="bad">Not connected yet.</span>';
      $("connectBox").hidden = false;
    } else {
      $("status").innerHTML = '<span class="bad">Not configured.</span> Add the storage app key and secret to the gateway\\'s secrets, then reload.';
    }
  }

  $("unlockBtn").onclick = unlock;
  $("secret").onkeydown = (e) => { if (e.key === "Enter") unlock(); };
  $("connectBtn").onclick = async () => {
    try { const r = await api("/api/admin/connect", { method: "POST" }); location.href = r.authorizeUrl; }
    catch (e) { $("status").textContent = e.message; }
  };
  $("linkBtn").onclick = async () => {
    $("linkMsg").textContent = "";
    const permissions = [["pUpload","upload"],["pList","list"],["pRead","read"]].filter(([id]) => $(id).checked).map(([,p]) => p);
    try {
      const r = await api("/api/admin/links", { method: "POST", body: JSON.stringify({
        campaign: $("campaign").value.trim(), contributor: $("contributor").value.trim(),
        label: $("label").value.trim() || undefined, permissions,
        expiresInDays: $("expires").value ? Number($("expires").value) : undefined }) });
      $("linkText").value = r.url || r.token;
      $("linkOut").hidden = false;
      if (!$("browseCampaign").value) $("browseCampaign").value = r.campaign;
    } catch (e) { $("linkMsg").textContent = e.message; }
  };
  $("copyBtn").onclick = () => { navigator.clipboard?.writeText($("linkText").value); $("copyBtn").textContent = "Copied"; setTimeout(() => $("copyBtn").textContent = "Copy", 1500); };

  async function browse() {
    $("browseMsg").textContent = "";
    const campaign = $("browseCampaign").value.trim(), path = $("browsePath").value.trim();
    try {
      const r = await api("/api/admin/files?campaign=" + encodeURIComponent(campaign) + "&path=" + encodeURIComponent(path));
      const tbody = $("files").querySelector("tbody"); tbody.textContent = "";
      for (const e of r.entries) {
        const tr = document.createElement("tr");
        const name = document.createElement("td"); name.textContent = e.path + (e.type === "folder" ? "/" : "");
        if (e.type === "folder") { name.style.cursor = "pointer"; name.style.color = "var(--accent)"; name.onclick = () => { $("browsePath").value = e.path; browse(); }; }
        const size = document.createElement("td"); size.textContent = e.type === "file" ? (e.size / 1048576).toFixed(2) + " MB" : "";
        const mod = document.createElement("td"); mod.textContent = e.type === "file" ? new Date(e.modifiedAt).toLocaleString() : "";
        const act = document.createElement("td");
        if (e.type === "file") {
          const del = document.createElement("button"); del.className = "secondary"; del.textContent = "Move to trash"; del.style.marginTop = "0";
          del.onclick = async () => { try { await api("/api/admin/files?campaign=" + encodeURIComponent(campaign) + "&path=" + encodeURIComponent(e.path), { method: "DELETE" }); browse(); } catch (err) { $("browseMsg").textContent = err.message; } };
          act.append(del);
        }
        tr.append(name, size, mod, act); tbody.append(tr);
      }
      $("files").hidden = r.entries.length === 0;
      if (r.entries.length === 0) $("browseMsg").textContent = "Nothing here yet.";
    } catch (e) { $("browseMsg").textContent = e.message; }
  }
  $("browseBtn").onclick = browse;

  if (secret) unlock();
})();
</script>
</main></body></html>`;
}

export type ConnectResult =
  | { ok: true; provider: string; secretName: string; refreshToken: string }
  | { ok: false; message: string };

export function connectResultPage(result: ConnectResult): string {
  const body = result.ok
    ? `<h1>${escapeHtml(result.provider)} connected</h1>
<section>
  <h2>One last step: save this as a secret</h2>
  <p>The gateway cannot save secrets by itself, so copy this value into the gateway's secret store under the name
  <code>${escapeHtml(result.secretName)}</code>. It is shown only once; treat it like a password.</p>
  <textarea readonly onclick="this.select()">${escapeHtml(result.refreshToken)}</textarea>
  <p><b>Cloudflare:</b> Workers &amp; Pages → your gateway → Settings → Variables and Secrets → Add → type <i>Secret</i>,
  name <code>${escapeHtml(result.secretName)}</code>. Or from a terminal: <code>npx wrangler secret put ${escapeHtml(result.secretName)}</code>.</p>
  <p><b>Vercel:</b> Project → Settings → Environment Variables → add <code>${escapeHtml(result.secretName)}</code>, then redeploy.</p>
  <p>Then go back to the <a href="/">setup page</a> and reload. It should say <i>Connected</i>.</p>
</section>`
    : `<h1>Connection did not finish</h1><section><p class="bad">${escapeHtml(result.message)}</p><p><a href="/">Back to setup</a></p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Storage Connected</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * A minimal contributor page, served at /c. Apps normally use their own
 * front end; this one exists so a fresh gateway can be tested end to end, and
 * so a moderator without an app can still collect uploads.
 */
export function contributorPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Share Photos</title><style>${STYLE}
  .drop { border: 2px dashed var(--line); border-radius: 12px; padding: 28px 16px; text-align: center; }
  progress { width: 100%; }
  li { margin: 4px 0; overflow-wrap: anywhere; }
</style></head>
<body><main>
<h1 id="title">Share photos</h1>
<p id="who" class="lede">Checking your link…</p>
<p id="err" class="bad"></p>

<section id="uploadBox" hidden>
  <h2>Add photos or videos</h2>
  <div class="drop"><input id="files" type="file" multiple accept="image/*,video/*,audio/*"></div>
  <label for="note">A note to go with them (optional)</label>
  <input id="note" type="text" maxlength="300">
  <button id="send">Upload</button>
  <ul id="progress"></ul>
</section>

<section id="listBox" hidden>
  <h2>Already shared</h2>
  <button class="secondary" id="refresh">Refresh</button>
  <ul id="list"></ul>
</section>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const hash = new URLSearchParams(location.hash.slice(1));
  let token = hash.get("fs") || "";
  try { if (token) sessionStorage.setItem("fsLink", token); else token = sessionStorage.getItem("fsLink") || ""; } catch {}
  if (hash.get("fs")) history.replaceState(null, "", location.pathname + location.search);
  const auth = { Authorization: "Bearer " + token };
  let session = null;

  async function api(path, init = {}) {
    const res = await fetch(path, { ...init, headers: { ...auth, ...(init.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body.error || ("HTTP " + res.status)); e.status = res.status; throw e; }
    return body;
  }

  function stamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\\.\\d+Z$/, "Z"); }
  function rand() { return Math.random().toString(36).slice(2, 8); }
  function clean(name) { return name.normalize("NFC").replace(/[\\u0000-\\u001f\\u007f<>:"|?*\\\\/]/g, "_").replace(/^\\.+/, "").slice(0, 100) || "file"; }

  function send(method, url, headers, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(body);
    });
  }

  async function uploadOne(file, base, onProgress) {
    const type = file.type || "application/octet-stream";
    for (let attempt = 0; attempt < 4; attempt++) {
      const name = attempt === 0 ? base : base.replace(/(\\.[^.]*)?$/, "." + rand() + "$1");
      const path = session.writePrefix + "/media/" + name;
      const plan = await api("/api/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, size: file.size, contentType: type }) });
      const res = plan.mode === "proxy"
        ? await send("PUT", plan.url, { ...auth, "Content-Type": type }, file, onProgress)
        : await send(plan.method, plan.url, plan.headers, file, onProgress);
      if (res.status >= 200 && res.status < 300) {
        if (plan.mode === "proxy") { try { return JSON.parse(res.text).path; } catch {} }
        return plan.path;
      }
      if (res.status !== 409) throw new Error("Upload failed (" + res.status + ")");
    }
    throw new Error("Could not find a free file name");
  }

  async function start() {
    if (!token) { $("who").textContent = ""; $("err").textContent = "This page needs a link from the organizer."; return; }
    try { session = await api("/api/session"); }
    catch (e) { $("who").textContent = ""; $("err").textContent = e.message; return; }
    $("who").textContent = (session.label ? session.label + " · " : "") + "Campaign: " + session.campaign;
    $("uploadBox").hidden = !session.permissions.includes("upload");
    $("listBox").hidden = !session.permissions.includes("list");
    if (!session.connected) $("err").textContent = "The organizer has not finished connecting storage yet.";
    if (!$("listBox").hidden) refresh();
  }

  async function refresh() {
    const ul = $("list"); ul.textContent = "";
    try {
      const walk = async (path, depth) => {
        const r = await api("/api/files?path=" + encodeURIComponent(path));
        for (const e of r.entries) {
          if (e.type === "folder") { if (depth < 4) await walk(e.path, depth + 1); continue; }
          const li = document.createElement("li"); li.textContent = e.path; ul.append(li);
        }
      };
      await walk("", 0);
      if (!ul.children.length) ul.innerHTML = "<li class=muted>Nothing yet.</li>";
    } catch (e) { $("err").textContent = e.message; }
  }

  $("refresh").onclick = refresh;
  $("send").onclick = async () => {
    const files = [...$("files").files];
    if (!files.length) return;
    $("send").disabled = true; $("err").textContent = "";
    const note = $("note").value.trim();
    for (const file of files) {
      const li = document.createElement("li"); const bar = document.createElement("progress"); bar.max = 1; bar.value = 0;
      li.textContent = file.name + " "; li.append(bar); $("progress").append(li);
      try {
        const base = stamp() + "_" + clean(file.name);
        const saved = await uploadOne(file, base, (p) => bar.value = p);
        const sidecar = { originalName: file.name, type: file.type, size: file.size, lastModified: new Date(file.lastModified).toISOString(), note: note || undefined, uploadedAt: new Date().toISOString() };
        const sidecarPath = saved.replace(/\\.[^./]*$/, "") + ".json";
        await fetch("/api/files/" + sidecarPath.split("/").map(encodeURIComponent).join("/"), { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(sidecar, null, 2) });
        bar.value = 1; li.append(" ✓");
      } catch (e) { li.append(" — " + e.message); li.className = "bad"; }
    }
    $("send").disabled = false; $("files").value = "";
    if (!$("listBox").hidden) refresh();
  };
  start();
})();
</script>
</main></body></html>`;
}
