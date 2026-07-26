# 🍿 A-Flight Snacko Store

A tap-to-pay honor-system snack stand. Customers tap an NFC tag, pick what they grabbed, and pay through Venmo in a single tap. No Square, no card reader, no monthly fees.

- **Live page:** https://d-pretzel.github.io/snacko-89/
- **Menu editor:** https://d-pretzel.github.io/snacko-89/admin.html

> **This is not the `snacko` repository.** A separate stand runs the same code out of `D-Pretzel/snacko`, with its own Worker, its own GitHub token, and its own password. The two are kept apart in three places, and all three have to stay right:
>
> | | this repo | the other one |
> | :--- | :--- | :--- |
> | `WORKER_URL` in `admin.html` | `snacko-89.petzoldavid02.workers.dev` | `snacko.petzoldavid02.workers.dev` |
> | `GH_REPO` in `worker/wrangler.toml` | `D-Pretzel/snacko-89` | `D-Pretzel/snacko` |
> | `PASS_KEY` in `admin.html` | `snacko89.editPass` | `snacko.editPass` |
>
> The target repository lives in the Worker and is never sent by the browser, so a Worker can only write to the repository it was deployed with. That is the real safeguard — but it also means a wrong `WORKER_URL` fails silently, publishing this stand's menu over the other stand's with no error anywhere. `PASS_KEY` is separate because GitHub Pages serves both projects from one origin and `localStorage` is scoped to the origin rather than the path; a shared key would let signing in to one editor hand the other a password that does not work there.

---

## How it works

1. A customer taps their phone on the tag stuck to the snack container.
2. Their phone opens the page, which loads the menu from `menu.json`.
3. They tap the items they took, and a running total builds itself. On a long menu there is a search box for finding an item by name.
4. One button hands off to Venmo with the amount and a plain-English itemized note already filled in. A second button does the same through PayPal, once a PayPal.me handle is set.

Because the tag only stores the page's URL, you never re-write a tag when prices change. You just change the menu.

The customer page has no server behind it: GitHub Pages hands out `index.html` and `menu.json`, and the browser does the rest. **Editing** the menu does depend on a small Cloudflare Worker, because something has to hold the GitHub credential. If Cloudflare is having a bad day, the snack stand keeps selling — only editing stops.

---

## Changing the menu

Open **https://d-pretzel.github.io/snacko-89/admin.html**, enter the editor password, and change what you need. There is no GitHub account, no code, and no file to find.

You can:

- Add, rename, reorder, and delete categories and items
- Set prices, and move an item from one category to another
- Change the Venmo username and the PayPal.me username, so a change of snacko needs no code change
- Add a short description under any item ("12 oz cans")
- Put an item on sale by a percentage, with an optional end date
- Hide an item without deleting it, for when you are out of stock
- Preview the customer view before you save

Press **Save changes**. The live page catches up within about a minute. If a field is wrong, it is highlighted with the reason and nothing is sent until it is fixed. If a save fails — bad signal, usually — every edit stays on screen, so nothing is lost; press Save again.

### Add to Home Screen

Worth doing on the first visit. The editor ships a `manifest.json` and an app icon, so this produces a real icon and opens without browser chrome, like an app. On iOS use Share → Add to Home Screen; on Android, the browser menu offers Install.

### Sales

A sale is stored as a percentage off, never as a second price. The discounted price is worked out when the page renders, so the original price is never lost. A sale with an end date stops applying the day after that date, judged by the phone's own clock, and the sale itself stays in the file until you clear it.

### Editing `menu.json` directly

`menu.json` is a plain data file in this repository, and it is the only place menu data lives. If the editor is ever unavailable, open `menu.json` on GitHub, click the pencil, and edit it by hand:

```json
{
  "name": "Snack-O",
  "venmoUsername": "your-venmo-username",
  "paypalHandle": "YourPayPalName",
  "categories": [
    {
      "label": "Drinks",
      "items": [
        { "name": "Red Bull", "price": 2.50, "description": "12 oz cans" },
        { "name": "Water", "price": 1.00, "sale": { "percentOff": 20, "until": "2026-08-01" } },
        { "name": "White Monster", "price": 3.00, "hidden": true }
      ]
    }
  ]
}
```

- `name` — what shows in the header and the browser tab.
- `venmoUsername` — the handle, without the `@`. Required.
- `paypalHandle` — the part after `paypal.me/` in your link, with no `@` and no slashes. Optional: empty or absent hides the PayPal button and leaves Venmo as the only way to pay.
- `price` — dollars, at most two decimal places.
- `description` — optional. Leave it out and the row looks exactly as it always has.
- `sale` — optional. `percentOff` is a whole number from 1 to 99; `until` is optional and formatted `YYYY-MM-DD`, and the last day counts.
- `hidden` — optional. `true` keeps the item in the file but off the customer page.

Every past version of the menu is in the repository's commit history, so a bad edit is always one revert away.

---

## Hosting

There is no build step. GitHub Pages serves this repository's root from the `main` branch, so anything committed to `main` is live at `https://d-pretzel.github.io/snacko-89/` within about a minute. The setting is under **Settings → Pages**: source **Deploy from a branch**, branch `main`, folder `/ (root)`. Confirm it is switched on for this repository — it is a per-repository setting, and having it on for `snacko` does nothing for `snacko-89`.

`index.html` and `menu.json` must stay in the repository root, since the page fetches `menu.json` as a relative path.

---

## The editor's plumbing

Full detail, including first-time setup, lives in [`worker/README.md`](worker/README.md).

The Worker is `snacko-89` on Cloudflare, serving `https://snacko-89.petzoldavid02.workers.dev`, and `admin.html` points at it. It holds two secrets: a GitHub fine-grained token scoped to **this** repository with Contents read and write, and the shared editor password. Give it a different password from the `snacko` stand — the two editors sit on the same origin and one password across both means whoever can edit either can edit both.

The token never touches the browser. The editor only ever sends the Worker a password and a menu; the Worker checks the password, re-validates the menu against the schema, and makes the commit.

**Changing the password**, when the job changes hands or you think it got out, is one command from `worker/`. No redeploy, effective immediately:

```bash
wrangler secret put EDIT_PASSWORD
```

Type it at the prompt rather than passing it as an argument, so it stays out of your shell history. Anyone still signed in on the old password gets returned to the login screen the next time they save, with their unsaved edits intact.

**The GitHub token expires.** When it does, saving fails — the Worker now says so in plain words ("GitHub rejected the credential — the access token has likely expired"). Mint a new fine-grained token with the same scope, run `wrangler secret put GH_TOKEN`, and revoke the old one. Keep the expiration date somewhere you will actually see it.

**Changing the Worker's code** means `wrangler deploy` from `worker/`. The `name` in `wrangler.toml` must match the Worker's name on the Cloudflare account exactly; if it does not, `wrangler secret put` fails with `This Worker does not exist on your account. [code: 10007]`, which is a name mismatch and not an authentication problem.

---

## Writing the NFC tag

1. Buy blank NTAG213 or NTAG215 stickers. They are inexpensive and widely available.
2. Install a free app like **NFC Tools** (iOS or Android).
3. Choose **Write → Add a record → URL**, and enter `https://d-pretzel.github.io/snacko-89/`.
4. Hold the sticker to your phone to write it, then stick it on the container.

Add a small "Tap to pay 📱" label near the tag so customers know what it is.

---

## Testing before you launch

**Both payment handles are set**, and both live in `menu.json` where the editor can reach them: Venmo is `Thomas-Calabrese-8`, PayPal is `ThomasCalabrese797`. Neither one needs a code change to alter, so a change of snacko does not need a developer.

Send yourself a real payment of a dollar or two through each button before the tags go out. A handle that does not exist does not throw an error — Venmo and PayPal both just open a page that goes nowhere, or worse, to someone else with a similar handle.

Then test on **both an iPhone and an Android** before sticking tags on anything. The browser-to-Venmo handoff behaves a little differently across phones, so confirm that the pay button opens Venmo with the correct amount already filled in, going to the right person.

To test locally, note that `index.html` now fetches `menu.json`, and browsers block `fetch` from `file://`. Opening the file by double-clicking it will show the error state. Serve the folder instead:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

The **editor** cannot be tested this way. The Worker only accepts requests from `https://d-pretzel.github.io`, so `admin.html` served from localhost is refused — that is the origin check doing its job, not a bug. Test the editor at its live URL, or see [`worker/README.md`](worker/README.md) for temporarily pointing `ALLOWED_ORIGIN` at a local server.

Because both stands share that origin, the origin check cannot tell this editor from the other one. Whether a save lands in the right repository is decided entirely by `WORKER_URL` in `admin.html`, so verify the commit shows up under **`snacko-89`** the first time you save.

---

## Good to know

- **Both pages adapt to light and dark mode** automatically.
- **The menu has a search box once it passes 15 items**, and none below that, where scrolling is quicker than reaching for a keyboard. It matches on item name only, ignoring case and accents, and every word you type has to appear somewhere in the name — so "bar protein" finds "Ready Protein Bar". Results filter as you type.
- **Search never touches the cart.** An item you have already added stays in the total and in the Venmo note even while the search is hiding it, and clearing the search brings every quantity back exactly as it was. The totals bar is always the truth about what is being bought, which is why it is worth a glance before paying.
- **The pay buttons stay disabled** until at least one item is added, so nobody sends a zero payment.
- **The PayPal button is off until you set a handle.** Clear the "PayPal.me username" field in the editor and the button is hidden entirely, leaving Venmo as the only way to pay. Fill it back in and it returns. The value is the part after `paypal.me/` in your link — the editor will stop you if you paste the whole URL or put an `@` on the front, because either produces a link that fails silently.
- **PayPal payments arrive without the itemized note.** PayPal.me links carry an amount and nothing else, so the note only rides along on Venmo. That is a PayPal limitation, not a bug here.
- **The payment note is itemized** and written to read like a sentence, for example `E-Flight SNACKO: 2x Cookie and Soda`, so you can see what each sale was. It is prefixed with the stand name from `menu.json`, drops the `1x` for single items, and is trimmed at Venmo's 280-character limit.
- **Sale prices are what customers are charged** — the total and the Venmo amount both use the discounted price.
- **Item names are treated as plain text.** An apostrophe, an accent, or a stray `<` in a name shows up literally and cannot break the page.
- **The Venmo link is built with `encodeURIComponent`, not `URLSearchParams`.** `URLSearchParams` encodes spaces as `+`, and Venmo prints the note exactly as given — plus signs and all. If the note ever comes back full of `+`, that is why.
- **Venmo's amount-prefill through links is undocumented** and has changed over the years. It works today, but if it ever breaks, the fix is on this page, not on the physical tags.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | The customer page. Renders the menu, totals, and the Venmo and PayPal handoffs. |
| `menu.json` | The menu itself. The only place menu data lives. |
| `admin.html` | Password-protected menu editor. |
| `manifest.json` | Makes the editor installable to a phone home screen. |
| `worker/wrangler.toml` | Worker configuration: name, `GH_REPO`, `ALLOWED_ORIGIN`. Secrets are never in here. |
| `worker/src/index.js` | The Worker itself. Checks the password, re-validates the menu, commits `menu.json`. |
| `worker/README.md` | Worker setup, secret rotation, and local testing. |
| `89th-Patch.jpeg` | Source art for every image below. Only 180×198, so the 512px icon is upscaled and a little soft; drop in a larger copy and regenerate if you get one. |
| `89th-logo.png` | The 89th FTS patch shown in the header of both pages. Transparent background, so it sits on the page in light and dark mode alike. |
| `favicon-64.png` | Browser-tab icon for both pages. Cropped tighter than the app icons so it still reads at the 16px a tab actually draws. |
| `icon-192.png`, `icon-512.png` | Home-screen icons for the editor, and the `apple-touch-icon` for both pages. |

The 459th FTS Twin Dragons patch that came over from the other project is gone — the 89th is now the only emblem anywhere on either page. The old file is still in history at `8aff04f` if it is ever wanted back.
| `venmo-logo.png` | Venmo mark shown on the pay button. |
| `paypal-mark.png` | PayPal monogram shown on the PayPal button, cropped square from `paypal_logo.png`. |
| `paypal_logo.png` | Original full PayPal lockup. Kept as the source art; the page does not load it. |
| `snacko-editor-spec.md` | The build specification the editor was written from. |
| `.gitignore` | Keeps wrangler's local cache, which holds the Cloudflare account id, out of the repository. |
| `README.md` | This document. |
