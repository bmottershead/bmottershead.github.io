import { WORKER_URL } from "./config.js";
const SESSION_KEY = "cd_session";
const BATCHES_KEY = "cd_batches";   // local working store: array of batches

// The committer-proxy's public App slug, used only by the multi-tenant /
// shared-operator model to offer an "Install" link. Leave "" for the
// self-hosted model — setup.sh prints the install link instead.
const APP_SLUG = "";
const BRANCH = "main";

// Which repo this page belongs to. Auto-detected from the GitHub Pages URL so a
// fork "just works"; override with <meta name="repo" content="owner/name">.
function detectRepo() {
    const meta = document.querySelector('meta[name="repo"]');
    if (meta && meta.content && meta.content.includes("/")) {
        const [o, r] = meta.content.split("/");
        return { owner: o, repo: r };
    }
    const host = location.hostname;
    const owner = host.endsWith(".github.io") ? host.slice(0, -".github.io".length) : null;
    const seg = location.pathname.split("/").filter(Boolean)[0];
    let repo = null;
    if (owner && seg && !/\.html?$/i.test(seg)) repo = seg;   // project pages: /<repo>/
    else if (owner) repo = `${owner}.github.io`;              // user pages: served at root
    return { owner, repo };
}
const { owner: REPO_OWNER, repo: REPO_NAME } = detectRepo();
const REPO = REPO_OWNER && REPO_NAME ? `${REPO_OWNER}/${REPO_NAME}` : "";
const dataPath = (login) => `data/${login}/timestamps.json`;

// Commit a file through the proxy. Returns the parsed response.
// Throws on non-OK; signs out on 401 so the caller can stop.
async function commit(path, content, message) {
    const resp = await fetch(WORKER_URL + "/commit", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + session
        },
        body: JSON.stringify({ owner: REPO_OWNER, repo: REPO_NAME, path, content, message })
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 401) { signOut(); throw new Error(data.error || "Session expired."); }
    if (resp.status === 403) { throw new Error(data.error || "Not authorized."); }
    if (!resp.ok || !data.ok) { throw new Error(data.error || ("HTTP " + resp.status)); }
    return data;
}

let session = null;      // signed session JWT from the Worker
let user = null;         // { login, name, avatar, allowed }
let batches = [];        // [[iso, iso, …], …]; the current batch is the last one

const numberEl    = document.getElementById("number");
const timestampEl = document.getElementById("timestamp");
const countBtn    = document.getElementById("countBtn");
const newBatchBtn = document.getElementById("newBatchBtn");
const archiveBtn  = document.getElementById("archiveBtn");
const clearBtn    = document.getElementById("clearBtn");
const statusEl    = document.getElementById("status");
const historyEl   = document.getElementById("history");
const loginBtn    = document.getElementById("loginBtn");
const logoutBtn   = document.getElementById("logoutBtn");
const userBox     = document.getElementById("userBox");
const avatarEl    = document.getElementById("avatar");
const userNameEl  = document.getElementById("userName");

function setStatus(msg, kind) {
    statusEl.textContent = msg || " ";
    statusEl.className = kind || "";
}

function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- Local store ----------------------------------------------------------

function loadBatches() {
    try {
        const v = JSON.parse(localStorage.getItem(BATCHES_KEY));
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

function persistBatches() {
    localStorage.setItem(BATCHES_KEY, JSON.stringify(batches));
}

const currentBatch = () => (batches.length ? batches[batches.length - 1] : null);
const currentCount = () => (currentBatch() ? currentBatch().length : 0);
const totalClicks  = () => batches.reduce((n, b) => n + b.length, 0);

// ---- Auth -----------------------------------------------------------------

// The Worker redirects back to <site>/#session=<jwt> (or #error=...).
// Returns true if this load is a fresh sign-in (so we pull the archive).
function captureSessionFromHash() {
    if (location.hash.length < 2) return false;
    const params = new URLSearchParams(location.hash.slice(1));
    const s = params.get("session");
    const err = params.get("error");
    history.replaceState(null, "", location.pathname + location.search);
    if (err) setStatus("Sign-in failed: " + err, "error");
    if (s) {
        session = s;
        localStorage.setItem(SESSION_KEY, s);
        return true;
    }
    return false;
}

async function loadSession(justLoggedIn) {
    session = session || localStorage.getItem(SESSION_KEY);
    if (!session) { batches = []; renderAuth(); render(); return; }
    try {
        const resp = await fetch(WORKER_URL + "/auth/me", {
            headers: { Authorization: "Bearer " + session }
        });
        if (!resp.ok) throw new Error("invalid session");
        user = await resp.json();
    } catch {
        signOut();
        return;
    }
    // Fresh sign-in overwrites the local store with the archive; a plain reload
    // keeps whatever's in localStorage (multi-device divergence is out of scope).
    if (justLoggedIn) {
        await syncFromArchive();
    } else {
        batches = loadBatches();
    }
    renderAuth();
    render();
    maybePromptInstall();
}

// Pull data/<login>/timestamps.json from the public repo into the local store.
async function syncFromArchive() {
    setStatus("Syncing your archive…");
    try {
        const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${dataPath(user.login)}?t=${Date.now()}`;
        const resp = await fetch(url, { cache: "no-store" });
        if (resp.status === 404) {
            batches = [];                       // no archive yet
        } else if (resp.ok) {
            const archive = await resp.json().catch(() => ({}));
            batches = Array.isArray(archive.batches) ? archive.batches : [];
        } else {
            throw new Error("HTTP " + resp.status);
        }
        persistBatches();
        setStatus(`Synced ${totalClicks()} click${totalClicks() === 1 ? "" : "s"} from your archive.`, "ok");
    } catch (err) {
        batches = loadBatches();                // fall back to whatever's local
        setStatus("Couldn't read your archive (" + err.message + ") — using local data.", "error");
    }
}

function renderAuth() {
    if (user) {
        loginBtn.hidden = true;
        userBox.hidden = false;
        avatarEl.src = user.avatar || "";
        userNameEl.textContent = "@" + user.login;
        if (!user.allowed) {
            setStatus("Signed in as @" + user.login + ", but not authorized to count.", "error");
        }
    } else {
        loginBtn.hidden = false;
        userBox.hidden = true;
        setStatus("Sign in with GitHub to count. Your data lives at data/<you>/timestamps.json.");
    }
}

loginBtn.addEventListener("click", () => {
    // Tell the Worker which site to return to (needed in the shared-operator
    // model where one Worker serves many forks; harmless otherwise).
    const site = location.origin + location.pathname;
    window.location.href = WORKER_URL + "/auth/login?site=" + encodeURIComponent(site);
});

// Shared-operator model only: if the App isn't installed on this repo yet,
// surface a one-click install link. Inert when APP_SLUG is "".
async function maybePromptInstall() {
    if (!APP_SLUG || !user || !REPO_OWNER || !REPO_NAME) return;
    try {
        const url = `${WORKER_URL}/installed?owner=${encodeURIComponent(REPO_OWNER)}&repo=${encodeURIComponent(REPO_NAME)}`;
        const data = await (await fetch(url)).json().catch(() => ({}));
        if (data && data.installed) return;
    } catch {
        return;
    }
    setStatus("One more step — install the app on this repo so it can save: ");
    const a = document.createElement("a");
    a.href = `https://github.com/apps/${APP_SLUG}/installations/new`;
    a.textContent = "Install on " + REPO_NAME;
    a.target = "_blank";
    a.rel = "noopener";
    statusEl.appendChild(a);
}

logoutBtn.addEventListener("click", () => signOut());

function signOut() {
    localStorage.removeItem(SESSION_KEY);
    session = null;
    user = null;
    batches = [];
    renderAuth();
    render();
}

// ---- Counting -------------------------------------------------------------

countBtn.addEventListener("click", () => {
    if (!user || !user.allowed) return;
    if (!batches.length) batches.push([]);
    currentBatch().push(new Date().toISOString());
    persistBatches();
    render();
});

newBatchBtn.addEventListener("click", () => {
    if (!user || !user.allowed) return;
    if (currentCount() === 0) return;           // current batch already fresh
    batches.push([]);
    persistBatches();
    render();
});

// ---- Archive / Clear ------------------------------------------------------

archiveBtn.addEventListener("click", async () => {
    if (!user || !user.allowed || totalClicks() === 0) return;
    setStatus("Archiving…");
    try {
        const content = JSON.stringify({ by: user.login, batches }, null, 2) + "\n";
        const data = await commit(
            dataPath(user.login),
            content,
            `Archive @${user.login}'s timestamps (${totalClicks()} clicks, ${batches.length} batch${batches.length === 1 ? "" : "es"})`
        );
        setStatus("Archived ✅ ", "ok");
        if (data.commit) {
            const a = document.createElement("a");
            a.href = data.commit;
            a.textContent = "view commit";
            a.target = "_blank";
            a.rel = "noopener";
            statusEl.appendChild(a);
        }
    } catch (err) {
        setStatus("Failed to archive: " + err.message, "error");
    }
});

clearBtn.addEventListener("click", async () => {
    if (!user || !user.allowed) return;
    if (!confirm("Clear all your batches here and empty your archive in the repo? This can't be undone.")) {
        return;
    }
    setStatus("Clearing…");
    try {
        batches = [];
        persistBatches();
        render();
        const content = JSON.stringify({ by: user.login, batches: [] }, null, 2) + "\n";
        await commit(dataPath(user.login), content, `Clear @${user.login}'s archive`);
        setStatus("Cleared ✅", "ok");
    } catch (err) {
        setStatus("Cleared locally, but failed to empty the archive: " + err.message, "error");
    }
});

// ---- Render ---------------------------------------------------------------

function render() {
    numberEl.textContent = currentCount();
    const cur = currentBatch();
    timestampEl.textContent = (cur && cur.length) ? cur[cur.length - 1] : " ";
    renderBatches();
    updateButtons();
}

function updateButtons() {
    const allowed = !!(user && user.allowed);
    countBtn.disabled    = !allowed;
    newBatchBtn.disabled = !allowed || currentCount() === 0;
    archiveBtn.disabled  = !allowed || totalClicks() === 0;
    clearBtn.disabled    = !allowed || totalClicks() === 0;
}

function renderBatches() {
    if (!totalClicks()) {
        historyEl.innerHTML = "<p>No batches yet.</p>";
        return;
    }
    const last = batches.length - 1;
    const rows = batches.map((b, i) => {
        const mark = i === last ? " (current)" : "";
        return `<tr>
            <td>${i + 1}${mark}</td>
            <td>${b.length}</td>
            <td>${esc(b[0] || "")}</td>
            <td>${esc(b[b.length - 1] || "")}</td>
        </tr>`;
    }).join("");
    historyEl.innerHTML = `
        <table>
            <thead>
                <tr><th>Batch</th><th>Clicks</th><th>First</th><th>Last</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

// ---- Init -----------------------------------------------------------------

const justLoggedIn = captureSessionFromHash();
loadSession(justLoggedIn);
