const WORKER_URL = "https://countdown.riverscape.workers.dev";
const START = 10;
const SESSION_KEY = "cd_session";

let count = START;
const timestamps = [];   // collected as the user counts down
let session = null;      // signed session JWT from the Worker
let user = null;         // { login, name, avatar, allowed }

const numberEl    = document.getElementById("number");
const timestampEl = document.getElementById("timestamp");
const btn         = document.getElementById("countdownBtn");
const statusEl    = document.getElementById("status");
const loginBtn    = document.getElementById("loginBtn");
const logoutBtn   = document.getElementById("logoutBtn");
const userBox     = document.getElementById("userBox");
const avatarEl    = document.getElementById("avatar");
const userNameEl  = document.getElementById("userName");

function setStatus(msg, kind) {
    statusEl.textContent = msg || " ";
    statusEl.className = kind || "";
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
            btn.disabled = count <= 0;
            setStatus("Signed in as @" + user.login + " — ready to count down.", "ok");
        } else {
            btn.disabled = true;
            setStatus("Signed in as @" + user.login + ", but not authorized to run the countdown.", "error");
        }
    } else {
        loginBtn.hidden = false;
        userBox.hidden = true;
        btn.disabled = true;
        setStatus("Sign in with GitHub to run the countdown.");
    }
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

// ---- Countdown ------------------------------------------------------------

btn.addEventListener("click", () => {
    if (count <= 0) return;
    count -= 1;
    const ts = new Date().toISOString();
    timestamps.push(ts);
    timestampEl.textContent = ts;
    numberEl.textContent = count;

    if (count === 0) {
        btn.disabled = true;
        pushCountdown();
    }
});

async function pushCountdown() {
    setStatus("Reached zero — committing countdown.json…");
    try {
        const resp = await fetch(WORKER_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + session
            },
            body: JSON.stringify({ countdown: timestamps })
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401 || resp.status === 403) {
            setStatus(data.error || "Not authorized.", "error");
            if (resp.status === 401) signOut(); // session expired/invalid
            return;
        }
        if (!resp.ok || !data.ok) {
            throw new Error(data.error || ("HTTP " + resp.status));
        }
        setStatus("Committed countdown.json ✅ ", "ok");
        if (data.commit) {
            const a = document.createElement("a");
            a.href = data.commit;
            a.textContent = "view commit";
            a.target = "_blank";
            a.rel = "noopener";
            statusEl.appendChild(a);
        }
    } catch (err) {
        setStatus("Failed to commit: " + err.message, "error");
    }
}

// ---- Init -----------------------------------------------------------------

captureSessionFromHash();
loadSession();
