// Registers the GitHub App from a manifest, then converts the temporary code
// into the app's credentials (App ID, private key, client id, client secret).
//
// Flow: serve a one-button page -> you click -> GitHub confirm -> redirect back
// here with ?code -> POST /app-manifests/{code}/conversions -> save creds.
//
// Driven by env vars (set by setup.sh): APP_NAME, SITE_URL, CALLBACK_URL, ORG.
// (OWNER/REPO just supply defaults.) Writes credentials into committer-proxy/.app/.

import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (typeof fetch !== "function") {
  console.error("This script needs Node 18+ (global fetch).");
  process.exit(1);
}

const PORT = Number(process.env.BOOTSTRAP_PORT || 8765);
const OWNER = process.env.OWNER || "bmottershead";
const REPO = process.env.REPO || `${OWNER}.github.io`;
const APP_NAME = process.env.APP_NAME || "committer-proxy";
const SITE_URL = process.env.SITE_URL || `https://${OWNER}.github.io`;
const CALLBACK_URL = process.env.CALLBACK_URL || "";
const ORG = process.env.ORG || "";

if (!CALLBACK_URL) {
  console.error(
    "CALLBACK_URL is required — the OAuth client's callback URL to register on the App."
  );
  process.exit(1);
}

const APPDIR = join(dirname(fileURLToPath(import.meta.url)), ".app");
mkdirSync(APPDIR, { recursive: true });

const state = randomBytes(8).toString("hex");

const manifest = {
  name: APP_NAME,
  url: SITE_URL,
  hook_attributes: { active: false },
  redirect_url: `http://localhost:${PORT}/callback`,
  callback_urls: [CALLBACK_URL],
  public: false,
  default_permissions: { contents: "write" },
  default_events: [],
};

const newAppUrl = ORG
  ? `https://github.com/organizations/${ORG}/settings/apps/new?state=${state}`
  : `https://github.com/settings/apps/new?state=${state}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(formPage(newAppUrl, manifest));
    return;
  }

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing ?code");
      return;
    }
    if (returnedState && returnedState !== state) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("State mismatch — aborting.");
      console.error("State mismatch; aborting.");
      server.close(() => process.exit(1));
      return;
    }
    try {
      const resp = await fetch(
        `https://api.github.com/app-manifests/${code}/conversions`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "committer-app-setup",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );
      if (!resp.ok) {
        throw new Error(`conversion failed: ${resp.status} ${await resp.text()}`);
      }
      const app = await resp.json();
      const installUrl = `${app.html_url}/installations/new`;

      writeFileSync(join(APPDIR, "private-key.pem"), app.pem);
      writeFileSync(join(APPDIR, "client-secret.txt"), app.client_secret); // no newline
      writeFileSync(
        join(APPDIR, "app.env"),
        [
          `APP_ID=${app.id}`,
          `CLIENT_ID=${app.client_id}`,
          `APP_SLUG=${app.slug}`,
          `INSTALL_URL=${installUrl}`,
          "",
        ].join("\n")
      );

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(successPage(app, installUrl));

      console.log(`\n✅ App created: ${app.slug} (App ID ${app.id})`);
      console.log(`   Saved private key, client secret, and app.env to ${APPDIR}`);
      console.log(`\n👉 You'll install it on the repo at the end.\n`);
      setTimeout(() => server.close(() => process.exit(0)), 300);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e));
      console.error(String(e));
      server.close(() => process.exit(1));
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  const localUrl = `http://localhost:${PORT}`;
  console.log(`\nOpen ${localUrl} and click "Create GitHub App".`);
  console.log("(Trying to open your browser automatically…)\n");
  openBrowser(localUrl);
});

function formPage(actionUrl, manifestObj) {
  const json = JSON.stringify(manifestObj);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Create GitHub App</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;line-height:1.5">
  <h1>Create the ${escapeHtml(manifestObj.name)} GitHub App</h1>
  <p>This registers a GitHub App named <b>${escapeHtml(manifestObj.name)}</b> with
     <b>Contents: write</b> on your repo and the OAuth callback for login.
     You'll confirm on GitHub, then land back here.</p>
  <form action="${actionUrl}" method="post">
    <input type="hidden" name="manifest" id="manifest">
    <button type="submit" style="font-size:1.1rem;padding:.6rem 1.4rem;cursor:pointer">
      Create GitHub App
    </button>
  </form>
  <script>document.getElementById('manifest').value = ${JSON.stringify(json)};</script>
</body></html>`;
}

function successPage(app, installUrl) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>App created</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;line-height:1.5">
  <h1>✅ Created ${escapeHtml(app.slug)}</h1>
  <p>Credentials saved locally. Configure your OAuth client with them, then install the App.</p>
  <p>The last step is installing the app on your repo — the script prints this link,
     or use it now:</p>
  <p><a href="${installUrl}">${installUrl}</a></p>
  <p>You can close this tab and return to the terminal.</p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort; the URL is printed above */
  }
}
