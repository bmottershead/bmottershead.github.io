const WORKER_URL = "https://countdown.riverscape.workers.dev";
const SESSION_KEY = "cd_session";

// Where the saved history lives (read directly from the repo via raw.githubusercontent).
const REPO = "bmottershead/bmottershead.github.io";
const BRANCH = "main";
const LOG_FILE = "timestamps.json";

let count = 0;
let timestamps = [];     // clicks accumulated since the last save (unsaved batch)
let session = null;      // signed session JWT from the Worker
let user = null;         // { login, name, avatar, allowed }

const numberEl    = document.getElementById("number");
const timestampEl = document.getElementById("timestamp");
const countBtn    = document.getElementById("countBtn");
const saveBtn     = document.getElementById("saveBtn");
const historyBtn  = document.getElementById("historyBtn");
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

// ---- Auth -----------------------------------------------------------------

// The Worker redirects back to <site>/#session=<jwt> (or #error=...).
function captureSessionFromHash() {
    if (location.hash.length < 2) return;
    const params = new URLSearchParams(location.hash.slice(1));
    const s = params.get("session");
    const err = params.get("error");
    history.replaceState(null, "", location.pathname + location.search);
    if (err) setStatus("Sign-in failed: " + err, "error");
    if (s) {
        session = s;
        localStorage.setItem(SESSION_KEY, s);
    }
}

async function loadSession() {
    session = session || localStorage.getItem(SESSION_KEY);
    if (!session) { renderAuth(); return; }
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
    renderAuth();
}

function renderAuth() {
    if (user) {
        loginBtn.hidden = true;
        userBox.hidden = false;
        avatarEl.src = user.avatar || "";
        userNameEl.textContent = "@" + user.login;
        if (user.allowed) {
            setStatus("Signed in as @" + user.login + " — start counting.", "ok");
        } else {
            setStatus("Signed in as @" + user.login + ", but not authorized to count or save.", "error");
        }
    } else {
        loginBtn.hidden = false;
        userBox.hidden = true;
        setStatus("Sign in with GitHub to count and save. (History is public.)");
    }
    updateButtons();
}

function updateButtons() {
    const allowed = !!(user && user.allowed);
    countBtn.disabled = !allowed;
    saveBtn.disabled = !allowed || timestamps.length === 0;
    // History is always available — it reads public repo data.
}

loginBtn.addEventListener("click", () => {
    window.location.href = WORKER_URL + "/auth/login";
});

logoutBtn.addEventListener("click", () => signOut());

function signOut() {
    localStorage.removeItem(SESSION_KEY);
    session = null;
    user = null;
    renderAuth();
}

// ---- Counting -------------------------------------------------------------

countBtn.addEventListener("click", () => {
    if (!user || !user.allowed) return;
    count += 1;
    const ts = new Date().toISOString();
    timestamps.push(ts);
    numberEl.textContent = count;
    timestampEl.textContent = ts;
    updateButtons();
});

// ---- Save -----------------------------------------------------------------

saveBtn.addEventListener("click", () => { save(); });

// Returns true on success (or when there's nothing to save), false on failure.
async function save() {
    if (timestamps.length === 0) return true;
    setStatus("Saving timestamps…");
    try {
        const resp = await fetch(WORKER_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + session
            },
            body: JSON.stringify({ timestamps })
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401 || resp.status === 403) {
            setStatus(data.error || "Not authorized.", "error");
            if (resp.status === 401) signOut(); // session expired/invalid
            return false;
        }
        if (!resp.ok || !data.ok) {
            throw new Error(data.error || ("HTTP " + resp.status));
        }
        setStatus("Saved ✅ ", "ok");
        if (data.commit) {
            const a = document.createElement("a");
            a.href = data.commit;
            a.textContent = "view commit";
            a.target = "_blank";
            a.rel = "noopener";
            statusEl.appendChild(a);
        }
        // Start a fresh batch.
        count = 0;
        timestamps = [];
        numberEl.textContent = count;
        updateButtons();
        return true;
    } catch (err) {
        setStatus("Failed to save: " + err.message, "error");
        return false;
    }
}

// ---- History --------------------------------------------------------------

historyBtn.addEventListener("click", async () => {
    // Save any unsaved timestamps first.
    if (timestamps.length > 0) {
        const ok = await save();
        if (!ok) return;
    }
    await showHistory();
});

async function showHistory() {
    setStatus("Loading history…");
    try {
        const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${LOG_FILE}?t=${Date.now()}`;
        const resp = await fetch(url, { cache: "no-store" });
        if (resp.status === 404) {
            renderHistory([]);
            setStatus("");
            return;
        }
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const text = await resp.text();
        const runs = text
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => JSON.parse(l));
        renderHistory(runs);
        setStatus("Newly saved runs may take a moment to appear.");
    } catch (err) {
        setStatus("Failed to load history: " + err.message, "error");
    }
}

function renderHistory(runs) {
    if (!runs.length) {
        historyEl.innerHTML = "<p>No saved runs yet.</p>";
        historyEl.hidden = false;
        return;
    }
    const rows = runs.map((r, i) => {
        // Older records used the "countdown" key; newer ones use "timestamps".
        const ts = r.timestamps || r.countdown || [];
        const by = r.by ? "@" + esc(r.by) : "—";
        return `<tr>
            <td>${i + 1}</td>
            <td>${by}</td>
            <td>${ts.length}</td>
            <td>${esc(ts[0] || "")}</td>
            <td>${esc(ts[ts.length - 1] || "")}</td>
        </tr>`;
    }).join("");
    historyEl.innerHTML = `
        <table>
            <thead>
                <tr><th>#</th><th>By</th><th>Clicks</th><th>First</th><th>Last</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
    historyEl.hidden = false;
}

// ---- Init -----------------------------------------------------------------

captureSessionFromHash();
loadSession();
