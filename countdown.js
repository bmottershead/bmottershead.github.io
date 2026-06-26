const WORKER_URL = "https://countdown.riverscape.workers.dev";
const START = 10;
let   count = START;
const timestamps = [];   // collected as the user counts down
const numberEl    = document.getElementById("number");
const timestampEl = document.getElementById("timestamp");
const btn         = document.getElementById("countdownBtn");
const statusEl    = document.getElementById("status");

function setStatus(msg, kind) {
    statusEl.textContent = msg || " ";
    statusEl.className = kind || "";
}

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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ countdown: timestamps })
        });
        const data = await resp.json().catch(() => ({}));
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
