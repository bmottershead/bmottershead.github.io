/**
 * GitHub OAuth + commit proxy
 *
 * A generic, content-blind backend for static sites: it logs users in with
 * GitHub and lets an authorized user commit arbitrary files to one configured
 * repo. It knows nothing about any particular application's file format — the
 * caller supplies the path, content, and commit message.
 *
 * Routes:
 *   GET  /auth/login     -> redirect to GitHub's OAuth authorize page
 *   GET  /auth/callback  -> exchange code, mint a signed session JWT, redirect to site
 *   GET  /auth/me        -> return the signed-in user (Bearer session) or 401
 *   GET  /installed      -> is the App installed on ?owner=&repo= (public read)
 *   POST /commit         -> commit a file (requires a valid, allowed session)
 *
 * Modes: single-tenant (default) commits to the one repo in [vars]. Multi-tenant
 * (MULTI_TENANT=true) is the shared-operator model — one Worker + one public App;
 * each user commits to their OWN repo (owner === login), under data/<login>/.
 *
 * Auth model: "Login with GitHub" via the GitHub App's user-to-server OAuth.
 * The Worker holds the client secret and signs its own session token (HS256);
 * the browser stores that session and sends it as `Authorization: Bearer`.
 * The commit itself is made as the App (installation token), scoped to
 * contents:write on the one configured repo, gated on a valid session whose
 * login is in ALLOWED_LOGINS. The git commit author is stamped with the
 * authenticated user's identity, so attribution doesn't depend on file content.
 *
 * Secrets (wrangler secret put): GITHUB_APP_PRIVATE_KEY, GITHUB_CLIENT_SECRET,
 * SESSION_SECRET. Non-secret config lives in wrangler.toml [vars].
 */

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const STATE_COOKIE = "cd_state";
const RETURN_COOKIE = "cd_return";

// Single-tenant (default): commits go to the one repo in [vars]. Multi-tenant
// (MULTI_TENANT=true): the operator runs ONE Worker + ONE public App; each
// signed-in user commits to their OWN repo (gated on owner === login), under a
// data/<login>/ path prefix. See docs/PLAN-shared.md.
function multiTenant(env) {
  const v = String(env.MULTI_TENANT || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// Accept only github.io subdomains (and localhost for dev) as OAuth return
// targets, stripped to origin+path — prevents open-redirect via ?site=.
function validatedReturn(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  const okHost = /^[a-z0-9-]+\.github\.io$/.test(host) || local;
  const okScheme = u.protocol === "https:" || (u.protocol === "http:" && local);
  return okHost && okScheme ? u.origin + u.pathname : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const cors = corsHeaders(request.headers.get("Origin"), env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method === "GET" && path === "/auth/login") {
      return handleLogin(request, env);
    }
    if (request.method === "GET" && path === "/auth/callback") {
      return handleCallback(request, env);
    }
    if (request.method === "GET" && path === "/auth/me") {
      return handleMe(request, env, cors);
    }
    if (request.method === "GET" && path === "/installed") {
      return handleInstalled(request, env, cors);
    }
    if (request.method === "POST" && path === "/commit") {
      return handleCommit(request, env, cors);
    }
    return json({ error: "not found" }, 404, cors);
  },
};

// ---- OAuth: login ---------------------------------------------------------

function handleLogin(request, env) {
  const url = new URL(request.url);
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  authUrl.searchParams.set("state", state);

  // SameSite=Lax so the cookies survive GitHub's top-level redirect back here.
  const headers = new Headers({ Location: authUrl.toString() });
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );
  // Multi-tenant: remember which (validated) site to send the browser back to,
  // since SITE_URL can't be one fixed value when many forks share us.
  if (multiTenant(env)) {
    const ret = validatedReturn(url.searchParams.get("site"));
    if (ret) {
      headers.append(
        "Set-Cookie",
        `${RETURN_COOKIE}=${encodeURIComponent(ret)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
      );
    }
  }
  return new Response(null, { status: 302, headers });
}

// ---- OAuth: callback ------------------------------------------------------

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.get("Cookie"));
  const clearState = [
    `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    `${RETURN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  ];
  const returnTarget = multiTenant(env)
    ? validatedReturn(cookies[RETURN_COOKIE] && decodeURIComponent(cookies[RETURN_COOKIE]))
    : null;

  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    return redirectToSite(env, { error: "bad_state" }, clearState, returnTarget);
  }

  // Exchange the code for a user access token (server-to-server, holds secret).
  const tokResp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "countdown-worker",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  const tok = await tokResp.json().catch(() => ({}));
  if (!tok.access_token) {
    return redirectToSite(env, { error: "oauth_failed" }, clearState, returnTarget);
  }

  // Identify the user.
  const userResp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "countdown-worker",
    },
  });
  if (!userResp.ok) {
    return redirectToSite(env, { error: "user_lookup_failed" }, clearState, returnTarget);
  }
  const user = await userResp.json();

  const session = await makeSessionJwt(env, {
    sub: String(user.id),
    login: user.login,
    name: user.name || user.login,
    avatar: user.avatar_url,
  });
  return redirectToSite(env, { session }, clearState, returnTarget);
}

function redirectToSite(env, params, clearCookies, returnTarget) {
  const frag = new URLSearchParams(params).toString();
  const base = returnTarget || env.SITE_URL;
  const loc = base.endsWith("/") ? `${base}#${frag}` : `${base}/#${frag}`;
  const headers = new Headers({ Location: loc });
  for (const c of [].concat(clearCookies || [])) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

// ---- /installed -----------------------------------------------------------

// Is the App installed on owner/repo? Lets the front-end decide whether to show
// an "Install" prompt. Public read using the App JWT (no session needed).
async function handleInstalled(request, env, cors) {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  if (!owner || !repo) {
    return json({ error: "owner and repo query params are required" }, 400, cors);
  }
  try {
    const jwt = await makeAppJwt(env);
    const resp = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      {
        headers: {
          "User-Agent": "github-commit-proxy",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${jwt}`,
        },
      }
    );
    return json({ installed: resp.ok, owner, repo }, 200, cors);
  } catch (err) {
    return json({ installed: false, error: String(err.message || err) }, 200, cors);
  }
}

// ---- /auth/me -------------------------------------------------------------

async function handleMe(request, env, cors) {
  const session = await sessionFromRequest(request, env);
  if (!session) return json({ error: "unauthenticated" }, 401, cors);
  return json(
    {
      login: session.login,
      name: session.name,
      avatar: session.avatar,
      allowed: isAllowed(env, session.login),
    },
    200,
    cors
  );
}

// ---- Commit (generic, content-blind, gated) -------------------------------

async function handleCommit(request, env, cors) {
  const session = await sessionFromRequest(request, env);
  if (!session) {
    return json({ error: "Sign in with GitHub first." }, 401, cors);
  }
  if (!isAllowed(env, session.login)) {
    return json({ error: `@${session.login} is not authorized.` }, 403, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }
  const path = body && body.path;
  const content = body && body.content;
  const branch = (body && body.branch) || env.REPO_BRANCH;
  const message = (body && body.message) || `Update ${path}`;

  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("..")) {
    return json({ error: "body.path must be a repo-relative file path" }, 400, cors);
  }
  if (typeof content !== "string") {
    return json({ error: "body.content must be a string" }, 400, cors);
  }

  // Resolve the target repo and authorize per mode.
  let owner, repo;
  if (multiTenant(env)) {
    // Each user writes only to their own repo, under data/<login>/.
    owner = body && body.owner;
    repo = body && body.repo;
    if (typeof owner !== "string" || !owner || typeof repo !== "string" || !repo) {
      return json({ error: "body.owner and body.repo are required" }, 400, cors);
    }
    if (owner.toLowerCase() !== String(session.login).toLowerCase()) {
      return json({ error: `you can only write to your own repos (@${session.login})` }, 403, cors);
    }
    const prefix = `data/${session.login}/`.toLowerCase();
    if (!path.toLowerCase().startsWith(prefix)) {
      return json({ error: `path must start with data/${session.login}/` }, 403, cors);
    }
  } else {
    owner = env.REPO_OWNER;
    repo = env.REPO_NAME;
  }

  // Authoritative attribution at the git level — independent of file content.
  const author = {
    name: session.login,
    email: `${session.sub}+${session.login}@users.noreply.github.com`,
  };

  try {
    const token = await getInstallationToken(env, owner, repo);

    // Auto-manage sha (create or update); retry if it moves under us.
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = await getFileSha(token, owner, repo, path, branch);
      const res = await putContent(token, owner, repo, { path, content, message, branch, sha, author });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return json(
          {
            ok: true,
            path,
            by: session.login,
            commit: data.commit && data.commit.html_url,
            file: data.content && data.content.html_url,
          },
          200,
          cors
        );
      }
      if (res.status !== 409) {
        return json({ ok: false, error: `commit failed: ${res.status} ${await res.text()}` }, 502, cors);
      }
      // 409 => sha moved; loop and retry with a fresh read.
    }
    return json({ ok: false, error: "file kept changing; please retry" }, 409, cors);
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502, cors);
  }
}

// ---- Sessions (HS256 JWT signed with SESSION_SECRET) ----------------------

async function makeSessionJwt(env, claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { ...claims, iat: now, exp: now + SESSION_TTL_SECONDS };
  const enc = (o) => base64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

async function verifySessionJwt(env, token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await hmacKey(env.SESSION_SECRET);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function sessionFromRequest(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer (.+)$/);
  if (!m) return Promise.resolve(null);
  return verifySessionJwt(env, m[1]);
}

function isAllowed(env, login) {
  const list = (env.ALLOWED_LOGINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return true; // empty = any authenticated GitHub user
  return list.includes(String(login).toLowerCase());
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

// ---- GitHub App auth (installation token) ---------------------------------

async function getInstallationToken(env, owner, repo) {
  const jwt = await makeAppJwt(env);
  const appHeaders = {
    "User-Agent": "countdown-worker",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${jwt}`,
  };

  const instUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`;
  const instResp = await fetch(instUrl, { headers: appHeaders });
  if (!instResp.ok) {
    throw new Error(`installation lookup failed: ${instResp.status} ${await instResp.text()}`);
  }
  const installationId = (await instResp.json()).id;

  const tokUrl = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const tokResp = await fetch(tokUrl, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      repositories: [repo],
      permissions: { contents: "write" },
    }),
  });
  if (!tokResp.ok) {
    throw new Error(`token creation failed: ${tokResp.status} ${await tokResp.text()}`);
  }
  return (await tokResp.json()).token;
}

async function makeAppJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: env.GITHUB_APP_ID };
  const enc = (obj) => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

async function importPrivateKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (!b64) throw new Error("GITHUB_APP_PRIVATE_KEY is empty or not PKCS#8 PEM");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// ---- GitHub Contents API --------------------------------------------------

function ghHeaders(token) {
  return {
    "User-Agent": "github-commit-proxy",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  };
}

function contentsUrl(owner, repo, path) {
  // Keep slashes; encode each segment so paths like "data/x.json" work.
  const safe = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${safe}`;
}

// Current blob sha for a file, or null if it doesn't exist yet.
async function getFileSha(token, owner, repo, path, branch) {
  const resp = await fetch(`${contentsUrl(owner, repo, path)}?ref=${encodeURIComponent(branch)}`, {
    headers: ghHeaders(token),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GET ${path} failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()).sha;
}

// PUT a file's content. Returns the raw Response (caller checks .ok/.status).
function putContent(token, owner, repo, { path, content, message, branch, sha, author }) {
  const body = { message, content: base64encodeUtf8(content), branch };
  if (sha) body.sha = sha;
  if (author) {
    body.author = author;
    body.committer = author;
  }
  return fetch(contentsUrl(owner, repo, path), {
    method: "PUT",
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
}

// ---- Helpers --------------------------------------------------------------

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const h = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
