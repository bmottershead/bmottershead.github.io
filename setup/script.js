import { pkcs1ToPkcs8Pem } from "pem.js";

const STATE_KEY = "cp_setup_state";

const $ = (id)=>document.getElementById(id);

function setStatus(msg, kind) {
    const s = $("status");
    s.textContent = msg || " ";
    s.className = kind || "";
}

function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({
	"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"
    }[c]));
}

function randHex(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

$("createBtn").addEventListener("click", () => {
    const here = location.origin + location.pathname;
    const state = randHex(16);
    const org = $("org").value.trim();
    const actionBase = org
	  ? `organizations/${encodeURIComponent(org)}`
	  : `settings/apps`;
    const input = document.createElement("input");

    sessionStorage.setItem(STATE_KEY, state);
    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify({
	name: ${"appName").value.trim();
	url: $("siteUrl").value.trim() || here,
	hook_attributes: { url: siteUrl || here, active: false },
	redirect_url: here,
	callback_urls: [$("callbackUrl").value.trim()],
	public: false,
	default_permissions: { contents: "write" },
	default_events: []
    });
    const form = document.createElement("form");
    form.method = "POST";
    form.action =`https://github.com/${actionBase}/settings/apps/new?state=${state}`;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
});

function genSessionSecret() {
    const a = new Uint8Array(32);
    crypto.getRandomValues(a);
    let s = "";
    for (const b of a)
	s += String.fromCharCode(b);
    return btoa(s);
}

// ---- Init ----
(function init() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (code) {
	// Drop the code from the URL so a refresh doesn't retry a spent code.
	history.replaceState(null, "", location.pathname);
	$("createStep").hidden = true;
	handleCallback(code, state);
    }
})();

async function handleCallback(code, state) {
    const expected = sessionStorage.getItem(STATE_KEY);
    if (expected && state && expected !== state) {
	setStatus("Security check failed (state mismatch). Please start over.", "error");
	return;
    }
    setStatus("Finalizing your App with GitHub…");
    const ghApi = `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`;
    try {
	const resp = await fetch(githubApi, {
	    method: "POST",
	    headers: {
		"Accept": "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28"
	    }
	});
	if (!resp.ok)
	    throw new Error("GitHub returned HTTP " + resp.status);
	renderResult(await resp.json());
    } catch (e) {
	setStatus("Couldn't finish App creation in the browser: " + e.message);
    }
}

function field(label, hint, value, opts = {}) {
    const big = opts.big;
    const tag = big
	  ? `<textarea class="val" readonly>${esc(value)}</textarea>`
	  : `<div class="val">${esc(value)}</div>`;
    return `<div class="field">
    <label>${esc(label)}</label>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}
    <div class="row">${tag}<button class="copy" data-copy="${esc(value)}">Copy</button></div>
    </div>`;
}

function renderResult(app) {
    $("creds").innerHTML = [
	field("GITHUB_APP_ID", "Worker var — your App's numeric ID", String(app.id)),
	field("GITHUB_CLIENT_ID", "Worker var — OAuth client id", app.client_id),
	field("GITHUB_CLIENT_SECRET", "Worker secret — OAuth client secret", app.client_secret),
	field("GITHUB_APP_PRIVATE_KEY", "Worker secret", pkcs1ToPkcs8Pem(app.pem),
	      { big: true }),
	field("SESSION_SECRET", "Worker secret — freshly generated random key",
	      genSessionSecret()),
    ].join("");
    $("installLink").href = app.html_url + "/installations/new";
    $("createStep").hidden = true;
    $("resultStep").hidden = false;
    setStatus(`App "${app.slug}" created in your account. Copy the values, then deploy.`, "ok");
}

$("creds")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".copy"); if (!btn) return;
    navigator.clipboard.writeText(btn.dataset.copy).then(
	() => { btn.textContent = "Copied";
		setTimeout(() => btn.textContent = "Copy", 1200);
	      },
	() => setStatus("Couldn't copy — select and copy manually.", "error")
    );
});

