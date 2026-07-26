/* =====================================================================
   Snack-O 89 menu editor Worker.

   Holds the GitHub credential so admin.html never has to. The editor only
   ever sends a password and a menu; this Worker checks the password,
   re-validates the menu, and makes the commit.

   Endpoints:
     POST /verify  { pass }                  -> 200 | 401
     POST /save    { pass, menu, summary }   -> 200 { commit } | 4xx | 5xx

   This Worker is bound to one repository, GH_REPO. The client cannot choose
   the target. A sibling deployment (the separate `snacko` project) has its
   own GH_REPO, so the two can never write to each other's menu.
   ===================================================================== */

const GH_API = "https://api.github.com";
const FILE_PATH = "menu.json";

/* GitHub rejects requests with no User-Agent. Workers do not set one
   automatically, and the omission surfaces as a confusing 403. */
const USER_AGENT = "snacko-89-menu-editor";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_NAME = 60;
const MAX_DESC = 200;
const MAX_SUMMARY = 120;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = env.ALLOWED_ORIGIN || "";

    /* Every response below, including every error, goes through json() or
       text-free helpers that attach these. Dropping CORS on the error path is
       the classic failure in this design — the browser then reports an opaque
       network error and hides the real message. */
    const cors = corsHeaders(allowed);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    /* Browsers always send Origin on a cross-origin POST. A missing Origin
       means a non-browser client (curl, a health check), which the password
       still gates — this check is defence in depth, not the lock. */
    if (origin && allowed && origin !== allowed) {
      return json({ error: "Origin not allowed." }, 403, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405, cors);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    let body;
    try {
      body = await readJson(request);
    } catch (err) {
      return json({ error: err.message }, 400, cors);
    }

    if (path === "/verify") return handleVerify(body, env, request, cors);
    if (path === "/save") return handleSave(body, env, request, cors);
    return json({ error: "Not found." }, 404, cors);
  },
};

/* ---------------- endpoints -------------------------------------- */

async function handleVerify(body, env, request, cors) {
  const client = clientKey(request);

  if (isLockedOut(client)) {
    return json({ error: "Too many attempts. Wait a minute and try again." }, 429, cors);
  }
  if (!env.EDIT_PASSWORD) {
    return json({ error: "Editor is not configured yet (no password set)." }, 500, cors);
  }
  if (typeof body.pass !== "string" || !timingSafeEqual(body.pass, env.EDIT_PASSWORD)) {
    recordFailure(client);
    return json({ error: "Incorrect password." }, 401, cors);
  }
  clearFailures(client);
  return json({ ok: true }, 200, cors);
}

async function handleSave(body, env, request, cors) {
  const client = clientKey(request);

  /* The password is checked before anything else is even looked at. */
  if (isLockedOut(client)) {
    return json({ error: "Too many attempts. Wait a minute and try again." }, 429, cors);
  }
  if (!env.EDIT_PASSWORD || !env.GH_TOKEN) {
    return json({ error: "Editor is not configured yet (missing secrets)." }, 500, cors);
  }
  if (typeof body.pass !== "string" || !timingSafeEqual(body.pass, env.EDIT_PASSWORD)) {
    recordFailure(client);
    return json({ error: "Incorrect password." }, 401, cors);
  }
  clearFailures(client);

  /* The client is a page we wrote, which is exactly why it still is not
     trusted — anyone can post here with the password. */
  let menu;
  try {
    menu = validateMenu(body.menu);
  } catch (err) {
    return json({ error: err.message }, 400, cors);
  }

  const json2 = JSON.stringify(menu, null, 2) + "\n";
  const content = base64Utf8(json2);
  const message = commitMessage(body.summary);

  try {
    const commit = await commitFile(env, content, message);
    return json({ commit }, 200, cors);
  } catch (err) {
    return json({ error: err.message }, err.status || 502, cors);
  }
}

/* ---------------- GitHub ------------------------------------------ */

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
  };
}

async function fetchSha(env) {
  const branch = env.GH_BRANCH || "main";
  const url = `${GH_API}/repos/${env.GH_REPO}/contents/${FILE_PATH}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: ghHeaders(env) });

  /* A repository with no menu.json yet is a valid starting point: the first
     save creates the file, which needs no sha. */
  if (res.status === 404) return null;
  if (!res.ok) throw ghError(res.status, await res.text(), "read");
  const data = await res.json();
  return data.sha || null;
}

async function putFile(env, content, message, sha) {
  const url = `${GH_API}/repos/${env.GH_REPO}/contents/${FILE_PATH}`;
  const payload = { message, content, branch: env.GH_BRANCH || "main" };
  if (sha) payload.sha = sha;

  return fetch(url, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(payload),
  });
}

async function commitFile(env, content, message) {
  /* Read the sha immediately before writing, so the window in which someone
     else's commit could invalidate it is as small as possible. */
  let sha = await fetchSha(env);
  let res = await putFile(env, content, message, sha);

  /* 409 means the file moved under us — another save, or a hand edit on
     GitHub. Re-read the sha once and try again before giving up. */
  if (res.status === 409) {
    sha = await fetchSha(env);
    res = await putFile(env, content, message, sha);
  }

  if (!res.ok) throw ghError(res.status, await res.text(), "write");
  const data = await res.json();
  return (data.commit && data.commit.sha) || "";
}

function ghError(status, text, phase) {
  let detail = "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.message) detail = " " + parsed.message;
  } catch { /* body was not JSON; the status carries enough */ }

  /* 401 and 403 from GitHub almost always mean the token expired or was
     revoked. Saying so beats surfacing a bare status the snacko cannot act on. */
  if (status === 401 || status === 403) {
    const err = new Error("GitHub rejected the credential — the access token has likely expired." + detail);
    err.status = 502;
    return err;
  }
  const err = new Error(`GitHub ${phase} failed (HTTP ${status}).${detail}`);
  err.status = 502;
  return err;
}

/* ---------------- validation -------------------------------------- */

/* Returns a freshly built object rather than the input. Anything the client
   sent that is not in the schema is dropped by construction, so no unexpected
   key can ever reach the committed file. */
function validateMenu(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("Menu must be an object.");
  }

  const name = str(raw.name, "name").trim();
  if (name === "") fail("The stand needs a name.");
  if (name.length > MAX_NAME) fail(`Stand name must be ${MAX_NAME} characters or fewer.`);

  const venmoUsername = str(raw.venmoUsername, "venmoUsername").trim();
  if (venmoUsername === "") fail("A Venmo username is required.");
  if (venmoUsername.length > MAX_NAME) fail("Venmo username is too long.");

  /* Optional, and absent from menus written before the field existed, so a
     missing value is empty rather than an error. Empty hides the PayPal
     button on the customer page. */
  let paypalHandle = "";
  if (raw.paypalHandle !== undefined && raw.paypalHandle !== null) {
    paypalHandle = str(raw.paypalHandle, "paypalHandle").trim();
    if (paypalHandle.length > MAX_NAME) fail("PayPal username is too long.");
    /* The handle is interpolated into a paypal.me path. A slash would let it
       reach a different path entirely, and whitespace makes a dead link. */
    if (/[\/\s]/.test(paypalHandle)) {
      fail("PayPal username must be just the username, with no slashes or spaces.");
    }
    if (paypalHandle.startsWith("@")) fail("PayPal username must not start with @.");
  }

  if (!Array.isArray(raw.categories)) fail("categories must be an array.");
  if (raw.categories.length === 0) fail("At least one category is required.");

  const seen = new Set();
  const categories = raw.categories.map((cat, ci) => {
    if (!cat || typeof cat !== "object" || Array.isArray(cat)) {
      fail(`Category ${ci + 1} is malformed.`);
    }
    const label = str(cat.label, `categories[${ci}].label`).trim();
    if (label === "") fail(`Category ${ci + 1} needs a name.`);
    if (label.length > MAX_NAME) fail(`Category "${label}" name is too long.`);

    const key = label.toLowerCase();
    if (seen.has(key)) fail(`Two categories are both called "${label}".`);
    seen.add(key);

    if (!Array.isArray(cat.items)) fail(`Category "${label}" has a malformed item list.`);
    const items = cat.items.map((item, ii) => validateItem(item, label, ii));

    return { label, items };
  });

  return { name, venmoUsername, paypalHandle, categories };
}

function validateItem(item, catLabel, ii) {
  const where = `Item ${ii + 1} in "${catLabel}"`;
  if (!item || typeof item !== "object" || Array.isArray(item)) fail(`${where} is malformed.`);

  const name = str(item.name, `${where} name`).trim();
  if (name === "") fail(`${where} needs a name.`);
  if (name.length > MAX_NAME) fail(`${where} has a name longer than ${MAX_NAME} characters.`);

  const price = item.price;
  if (typeof price !== "number" || !Number.isFinite(price)) fail(`${where} needs a price.`);
  if (price < 0) fail(`${where} has a negative price.`);
  /* Two decimal places, tested with a tolerance because 1.15 * 100 is
     114.99999999999999 in binary floating point. */
  if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) {
    fail(`${where} has more than two decimal places.`);
  }

  const out = { name, price: Math.round(price * 100) / 100 };

  if (item.description !== undefined && item.description !== null && item.description !== "") {
    const description = str(item.description, `${where} description`).trim();
    if (description.length > MAX_DESC) {
      fail(`${where} has a description longer than ${MAX_DESC} characters.`);
    }
    if (description) out.description = description;
  }

  if (item.sale !== undefined && item.sale !== null) {
    const sale = item.sale;
    if (typeof sale !== "object" || Array.isArray(sale)) fail(`${where} has a malformed sale.`);
    const pct = sale.percentOff;
    if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
      fail(`${where} has a sale percentage outside 1–99.`);
    }
    out.sale = { percentOff: pct };
    if (sale.until !== undefined && sale.until !== null && sale.until !== "") {
      const until = str(sale.until, `${where} sale end date`);
      if (!isCalendarDate(until)) fail(`${where} has a sale end date that is not YYYY-MM-DD.`);
      out.sale.until = until;
    }
  }

  if (item.hidden === true) out.hidden = true;

  return out;
}

/* Shape alone is not enough — "2026-02-31" matches the pattern and is not a
   day. Round-tripping through Date catches that. */
function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function str(value, field) {
  if (typeof value !== "string") fail(`${field} must be text.`);
  return value;
}

function fail(message) {
  throw new Error(message);
}

/* ---------------- commit message ---------------------------------- */

/* The summary is client text and goes into a git commit message, so newlines
   are stripped (they would forge a commit body) and the length is capped. */
function commitMessage(summary) {
  if (typeof summary !== "string") return "Menu update";
  const clean = summary.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "Menu update";
  const trimmed = clean.length > MAX_SUMMARY ? clean.slice(0, MAX_SUMMARY - 1) + "…" : clean;
  return `Menu update: ${trimmed}`;
}

/* ---------------- rate limiting ----------------------------------- */

/* Per-isolate and in-memory, so it is a speed bump rather than a guarantee:
   Cloudflare may run several isolates and may evict this one at any time.
   Blunting online guessing is all it is for. Durable Objects would make it
   exact, at the cost of a paid binding this project does not otherwise need. */
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 60 * 1000;

function clientKey(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function isLockedOut(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() > rec.until) { attempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.until) {
    attempts.set(key, { count: 1, until: now + LOCKOUT_MS });
  } else {
    rec.count += 1;
    rec.until = now + LOCKOUT_MS;
  }
  /* Unbounded growth under a distributed flood would be the only leak here. */
  if (attempts.size > 10000) attempts.clear();
}

function clearFailures(key) {
  attempts.delete(key);
}

/* ---------------- helpers ----------------------------------------- */

function corsHeaders(allowed) {
  return {
    "Access-Control-Allow-Origin": allowed || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new Error("Request body is too large.");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw new Error("Request body was not valid JSON.");
  }
}

/* A bare btoa() throws on any character outside Latin-1, which an item name
   will eventually contain. Encode to UTF-8 bytes first, and chunk the walk —
   String.fromCharCode(...bytes) overflows the stack on a large array. */
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* Compares in time proportional to the candidate's length only, so neither the
   password's length nor how far a guess matched leaks through timing. */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i % (bb.length || 1)];
  }
  return diff === 0;
}
