# Snack-O 89 editor Worker

The Cloudflare Worker that holds the GitHub credential so `admin.html` never has to. The editor sends a password and a menu; this Worker checks the password, re-validates the menu, and commits `menu.json` to `D-Pretzel/snacko-89`.

Deployed as **`snacko-89`**, serving `https://snacko-89.petzoldavid02.workers.dev`.

> **This is not the `snacko` Worker.** The separate `snacko` project has its own Worker, its own token, and its own password. The target repository is set in `wrangler.toml` as `GH_REPO` and is never sent by the browser, so a Worker can only ever write to the one repository it was deployed with. That is the safeguard that keeps the two stands apart — get `WORKER_URL` in `admin.html` wrong and you will quietly publish this stand's menu over the other one's.

---

## First-time setup

You need the `wrangler` CLI and access to the Cloudflare account.

```bash
npm install -g wrangler
wrangler login
```

### 1. Mint the GitHub token

On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.

- **Repository access:** Only select repositories → **`D-Pretzel/snacko-89`**. Not `snacko`, and not "all repositories" — this token should be able to touch nothing else.
- **Permissions:** Repository permissions → **Contents: Read and write**. Nothing else is needed.
- **Expiration:** set one explicitly, and write the date somewhere you will actually see it. When it lapses, saving breaks and the editor cannot tell you why on its own.

Copy the token now; GitHub will not show it again.

### 2. Set the two secrets

Both commands are run from this `worker/` directory, and both prompt for the value. Type or paste at the prompt rather than passing the value as an argument, so it stays out of your shell history.

```bash
cd worker
wrangler secret put GH_TOKEN        # paste the fine-grained PAT from step 1
wrangler secret put EDIT_PASSWORD   # the password you hand to the snacko
```

Give this project a **different** `EDIT_PASSWORD` from the `snacko` project. The two editors are served from the same origin and the same people may use both; one password across both means whoever can edit either can edit both.

### 3. Deploy

```bash
wrangler deploy
```

The `name` in `wrangler.toml` must match the Worker's name on the Cloudflare account exactly. If it does not, `wrangler secret put` fails with:

```
This Worker does not exist on your account. [code: 10007]
```

That is a name mismatch, not an authentication problem.

### 4. Confirm the wiring

`admin.html` must point at this Worker:

```js
const WORKER_URL = "https://snacko-89.petzoldavid02.workers.dev";
```

Then open the live editor, sign in, change something small, and save. The commit should appear at <https://github.com/D-Pretzel/snacko-89/commits/main/menu.json>.

---

## Configuration

| Binding | Type | Value |
| :--- | :--- | :--- |
| `GH_TOKEN` | secret | Fine-grained PAT, `D-Pretzel/snacko-89` only, Contents read and write. |
| `EDIT_PASSWORD` | secret | Shared password issued to the snacko. |
| `ALLOWED_ORIGIN` | var | `https://d-pretzel.github.io` |
| `GH_REPO` | var | `D-Pretzel/snacko-89` |
| `GH_BRANCH` | var | `main` |

`ALLOWED_ORIGIN` is one origin for every GitHub Pages project on the account, so it cannot distinguish this project from `snacko`. It keeps unrelated sites out; `GH_REPO` and a distinct password are what separate the two stands.

---

## Endpoints

**`POST /verify`** — `{ "pass": string }` → `200 {"ok":true}` on match, `401` otherwise. The login screen calls this so a wrong password fails before any editing begins.

**`POST /save`** — `{ "pass": string, "menu": object, "summary": string }` → `200 {"commit": "<sha>"}`.

Both reject anything but `POST` (and the `OPTIONS` preflight), and every response carries CORS headers — including the error responses, which is the easiest thing to get wrong here. When they are missing, the browser reports an opaque network failure and the real message never reaches the page.

---

## How `/save` behaves

- The password is checked first, in constant time, before the body is examined.
- The menu is re-validated against the full schema. The client is a page we wrote, which is exactly why it is not trusted — anyone can post here with the password.
- The response is **rebuilt** from validated fields rather than passed through, so any key the client invented is dropped by construction and can never land in the committed file.
- The file's `sha` is read immediately before the write. On a `409` the sha is re-read once and the write retried, which covers a save that races a hand edit on GitHub.
- `summary` is treated as untrusted: newlines stripped, whitespace collapsed, truncated, then used as the commit subject — `Menu update: Red Bull 20% off`.
- Failed `/verify` and `/save` attempts are rate limited per IP: 8 failures buys a 60-second lockout. This is in-memory and per-isolate, so it is a speed bump against online guessing rather than a guarantee. Making it exact needs a Durable Object, which this project does not otherwise require.

---

## Routine maintenance

**Rotating the password** — when the job changes hands, or you think it got out. One command, no redeploy, effective immediately:

```bash
wrangler secret put EDIT_PASSWORD
```

Anyone still signed in on the old password is returned to the login screen the next time they save, with their unsaved edits intact.

**Replacing the expired GitHub token** — saving starts failing and the editor now says so explicitly ("GitHub rejected the credential — the access token has likely expired"). Mint a new fine-grained token with the same scope, then:

```bash
wrangler secret put GH_TOKEN
```

Revoke the old one afterwards.

**Changing the code** — `wrangler deploy` from this directory. Secrets survive a deploy; you do not re-enter them.

**Watching it run:**

```bash
wrangler tail
```

---

## Testing the editor locally

The Worker only accepts requests from `ALLOWED_ORIGIN`, so `admin.html` served from `localhost` is refused. That is the origin check working, not a bug.

To work against a local page, point `ALLOWED_ORIGIN` at your local server temporarily:

```bash
wrangler dev --var ALLOWED_ORIGIN:http://localhost:8000
```

and set `WORKER_URL` in `admin.html` to the URL `wrangler dev` prints. `wrangler dev` reads secrets from a local `.dev.vars` file (gitignored):

```
GH_TOKEN=ghp_...
EDIT_PASSWORD=whatever
```

Be aware that `/save` in `wrangler dev` commits for real. Point `GH_REPO` at a scratch repository if you do not want that.

Never leave a localhost origin in the deployed `wrangler.toml`.
