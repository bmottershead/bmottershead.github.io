
const STATE_KEY = "cp_setup_state";
const $ = (id)=>document.getElementById(id);

$("createBtn").addEventListener("click", () => {
    const input = document.createElement("input");
    const here = location.origin + location.pathname;

    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify({
	name: $("appName").value.trim(),
	url: here,
	redirect_url: here,
	callback_urls: [""],
	public: false,
	default_permissions: {contents:"write"},
	default_events: []
    });

    const form = document.createElement("form");
    const randHex = crypto.getRandomValues(new Uint8Array(16));
    const state = [...randHex].map(b => b.toString(16).padStart(2, "0")).join("");

    form.method = "POST";
    form.action =`https://github.com/settings/apps/new?state=${state}`;
    form.appendChild(input);
    document.body.appendChild(form);
    sessionStorage.setItem(STATE_KEY, state);
    form.submit();
});


async function handleCallback(params) {
    history.replaceState(null, "", location.pathname);
    setStatus("Received callback");
    const expectedState = sessionStorage.getItem(STATE_KEY);
    const state = params.get("state")
    if (expectedState && state && expectedState !== state) {
	setStatus("Security check failed (state mismatch). Please start over.", "error");
	return;
    } else {
	const resp = await fetch("https://github.com{code}/conversions", {
	    method: 'POST',
	    headers: {
		'Accept': 'application/vnd.github+json',
		'User-Agent': 'Proxy-Committer-Setup'
	    }
	});
	if (!resp.ok)
	    setStatus('In callback, failed to get credentials');
	else {
	    const {id, client_id, client_secret, webhook_secret, pem} = resp.json();
	    console.log("APP_ID=",id);
	    console.log("CLIENT_ID=", client_id);
	    console.log("CLIENT_SECRET=", client_secret);
	    console.log("WEBHOOK_SECREAT=", webhook_secret);
	    console.log("PEM=", pem);
	}
    }	
}

function setStatus(msg, kind) {
    const s = $("status");
    s.textContent = msg || " ";
    s.className = kind || "";
}

(function init() {
    const params = new URLSearchParams(location.search);
    if (params.get("code")) 
	handleCallback(params);
    /* fall through to manifest form */
})();

