/**
 * Countdown Worker
 *
 * Routes:
 *   GET  /auth/login     -> redirect to GitHub's OAuth authorize page
 *   GET  /auth/callback  -> exchange code, mint a signed session JWT, redirect to site
 *   GET  /auth/me        -> return the signed-in user (Bearer session) or 401
 *   POST /               -> commit the timestamps file (requires a valid, allowed session)
 *   POST /clear          -> remove the caller's own rows from the log (allowed session)
 *
 * Auth model: "Login with GitHub" via the GitHub App's user-to-server OAuth.
 * The Worker holds the client secret and signs its own session token (HS256);
 * the browser stores that session and sends it as `Authorization: Bearer`.
 * The commit itself is still made as the App (installation token), gated on a
 * valid session whose login is in ALLOWED_LOGINS.
 *
 * Secrets (wrangler secret put): GITHUB_APP_PRIVATE_KEY, GITHUB_CLIENT_SECRET,
 * SESSION_SECRET. Non-secret config lives in wrangler.toml [vars].
 */

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const STATE_COOKIE = "cd_state";

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
    if (request.method === "POST" && path === "/") {
      return handleCountdown(request, env, cors);
    }
    if (request.method === "POST" && path === "/clear") {
      return handleClear(request, env, cors);
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

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      // SameSite=Lax so it survives GitHub's top-level redirect back here.
      "Set-Cookie": `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}

// ---- OAuth: callback ------------------------------------------------------

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.get("Cookie"));
  const clearState = `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    return redirectToSite(env, { error: "bad_state" }, clearState);
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
    return redirectToSite(env, { error: "oauth_failed" }, clearState);
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
    return redirectToSite(env, { error: "user_lookup_failed" }, clearState);
  }
  const user = await userResp.json();

  const session = await makeSessionJwt(env, {
    sub: String(user.id),
    login: user.login,
    name: user.name || user.login,
    avatar: user.avatar_url,
  });
  return redirectToSite(env, { session }, clearState);
}

function redirectToSite(env, params, clearCookie) {
  const frag = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: `${env.SITE_URL}/#${frag}`, "Set-Cookie": clearCookie },
  });
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

// ---- Commit (gated) -------------------------------------------------------

async function handleCountdown(request, env, cors) {
  const session = await sessionFromRequest(request, env);
  if (!session) {
    return json({ error: "Sign in with GitHub first." }, 401, cors);
  }
  if (!isAllowed(env, session.login)) {
    return json({ error: `@${session.login} is not authorized to save.` }, 403, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }
  const timestamps = body && body.timestamps;
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    return json({ error: "body.timestamps must be a non-empty array" }, 400, cors);
  }
  if (!timestamps.every((t) => typeof t === "string")) {
    return json({ error: "timestamp entries must be strings" }, 400, cors);
  }

  try {
    const token = await getInstallationToken(env);
    const result = await commitFile(
      env,
      token,
      { timestamps, by: session.login },
      `Save timestamps by @${session.login}`
    );
    return json(
      {
        ok: true,
        by: session.login,
        commit: result.commit && result.commit.html_url,
        file: result.content && result.content.html_url,
      },
      200,
      cors
    );
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502, cors);
  }
}

// ---- Clear the caller's own rows from the log -----------------------------

async function handleClear(request, env, cors) {
  const session = await sessionFromRequest(request, env);
  if (!session) {
    return json({ error: "Sign in with GitHub first." }, 401, cors);
  }
  if (!isAllowed(env, session.login)) {
    return json({ error: `@${session.login} is not authorized.` }, 403, cors);
  }

  const path = env.LOG_FILE_PATH;
  const login = String(session.login).toLowerCase();

  try {
    const token = await getInstallationToken(env);

    // Retry on 409: the Action may append to the log between our GET and PUT.
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await getFileText(env, token, path);
      if (!existing) return json({ ok: true, removed: 0 }, 200, cors); // no log yet

      const lines = existing.text.split("\n").map((l) => l.trim()).filter(Boolean);
      const kept = lines.filter((line) => {
        try {
          return String(JSON.parse(line).by || "").toLowerCase() !== login;
        } catch {
          return true; // leave any unparseable line untouched
        }
      });
      const removed = lines.length - kept.length;
      if (removed === 0) return json({ ok: true, removed: 0 }, 200, cors);

      const newContent = kept.length ? kept.join("\n") + "\n" : "";
      const res = await putFileText(
        env,
        token,
        path,
        newContent,
        existing.sha,
        `Clear @${session.login}'s history (${removed} run${removed === 1 ? "" : "s"})`
      );
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        return json(
          { ok: true, removed, commit: body.commit && body.commit.html_url },
          200,
          cors
        );
      }
      if (res.status !== 409) {
        return json({ ok: false, error: `PUT failed: ${res.status} ${await res.text()}` }, 502, cors);
      }
      // 409 => sha moved; loop and retry with a fresh read.
    }
    return json({ ok: false, error: "log kept changing; please try again" }, 409, cors);
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

async function getInstallationToken(env) {
  const jwt = await makeAppJwt(env);
  const appHeaders = {
    "User-Agent": "countdown-worker",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${jwt}`,
  };

  const instUrl = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/installation`;
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
      repositories: [env.REPO_NAME],
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

// ---- Generic contents helpers (used by /clear) ----------------------------

function ghHeaders(token) {
  return {
    "User-Agent": "countdown-worker",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  };
}

// Returns { sha, text } for a repo file, or null if it doesn't exist.
async function getFileText(env, token, path) {
  const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}?ref=${env.REPO_BRANCH}`;
  const resp = await fetch(url, { headers: ghHeaders(token) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GET ${path} failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return { sha: data.sha, text: base64decodeUtf8(data.content || "") };
}

// PUTs raw string content. Returns the raw Response (caller checks .ok/.status).
function putFileText(env, token, path, contentString, sha, message) {
  const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`;
  const body = { message, content: base64encodeUtf8(contentString), branch: env.REPO_BRANCH };
  if (sha) body.sha = sha;
  return fetch(url, { method: "PUT", headers: ghHeaders(token), body: JSON.stringify(body) });
}

// ---- Commit ---------------------------------------------------------------

async function commitFile(env, token, payloadObj, message) {
  const apiBase = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${env.FILE_PATH}`;
  const headers = {
    "User-Agent": "countdown-worker",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  };

  let sha;
  const getResp = await fetch(`${apiBase}?ref=${env.REPO_BRANCH}`, { headers });
  if (getResp.ok) {
    sha = (await getResp.json()).sha;
  } else if (getResp.status !== 404) {
    throw new Error(`GET failed: ${getResp.status} ${await getResp.text()}`);
  }

  const content = base64encodeUtf8(JSON.stringify(payloadObj, null, 2) + "\n");
  const putBody = { message, content, branch: env.REPO_BRANCH };
  if (sha) putBody.sha = sha;

  const putResp = await fetch(apiBase, {
    method: "PUT",
    headers,
    body: JSON.stringify(putBody),
  });
  if (!putResp.ok) {
    throw new Error(`PUT failed: ${putResp.status} ${await putResp.text()}`);
  }
  return putResp.json();
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

function base64decodeUtf8(b64) {
  // GitHub returns base64 with embedded newlines; atob can't handle whitespace.
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
