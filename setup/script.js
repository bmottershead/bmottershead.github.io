import { pkcs1ToPkcs8Pem } from "pem.js";

const STATE_KEY = "cp_setup_state";
const $ = (id)=>document.getElementById(id);

$("createBtn").addEventListener("click", () => {
    const randHex = crypto.getRandomValues(new Uint8Array(16));
    const state = [...randHex].map(b => b.toString(16).padStart(2, "0")).join("");

    sessionStorage.setItem(STATE_KEY, state);

    const input = document.createElement("input");
    const here = location.origin + location.pathname;

    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify({
	name: ${"appName").value.trim()},
	url: here,
	redirect_url: here,
	callback_urls: [""],
	public: false,
	default_permissions: {  contents: "write" },
	default_events: []
    });

    const form = document.createElement("form");

    form.method = "POST";
    form.action =`https://github.com/settings/apps/new?state=${state}`;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
});


// ---- Init ----
(function init() {
    const params = new URLSearchParams(location.search);
    if (params.get("code")) {
	history.replaceState(null, "", location.pathname);
	$("createStep").hidden = true;
	handleCallback(params);
    }
})();

async function handleCallback(params) {
    setStatus("Received callback");
    const expectedState = sessionStorage.getItem(STATE_KEY);
    const state = params.get("state")
    if (expectedState && state && expected !== state) {
	setStatus("Security check failed (state mismatch). Please start over.", "error");
	return;
    }
}

function setStatus(msg, kind) {
    const s = $("status");
    s.textContent = msg || " ";
    s.className = kind || "";
}
