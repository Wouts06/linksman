# Linksman API

A small PHP backend that gives the Linksman app (the React/Vite site on Vercel)
a real account system and server-side backup of your data, running on your
own `tarakona.co.za` hosting (InterWorx + MySQL/phpMyAdmin).

**This folder is NOT part of the Vite app's build.** It's a separate thing
that gets uploaded straight to your web hosting — Vercel never sees it, and
it doesn't matter that it lives inside the same local project folder as the
app. Think of it as two separate deployments from one folder: the React app
goes to Vercel (via `git push`, as before), and this `linksman-api` folder
goes to your InterWorx hosting (by uploading the files directly — not via
git/Vercel).

## What it does

- Lets someone create an account (email + password) and log in.
- Once logged in, the app's data — courses, players, round history, and a
  couple of small settings — is saved to a MySQL database on your hosting,
  in addition to the browser's own local storage. That means: clearing your
  browser data, switching phones, or reinstalling doesn't lose your rounds
  anymore, and (eventually) the same account could be the hook a
  subscription/paywall attaches to.
- It does **not** yet sync the round you're actively in the middle of playing
  — only completed rounds (history), your course list, your player list, and
  your settings. That keeps network traffic light while you're actually out
  on the course; in-progress scoring still lives only on the one device
  you're using, same as before.

## One-time setup on tarakona.co.za

### 1. Create the database

In InterWorx (SiteWorx panel), under MySQL: create a new database and a new
MySQL user with full privileges on that database. Note down the database
name, username, and password you chose — you'll need them in step 3.

### 2. Run the schema

Open phpMyAdmin (InterWorx usually links to it from the MySQL section), select
the database you just created, go to its **SQL** tab, and paste in the
contents of `schema.sql` from this folder, then run it. This creates three
empty tables: `users`, `sessions`, and `user_data`. You can also use
phpMyAdmin's **Import** tab and upload `schema.sql` as a file instead of
pasting it — either way works.

### 3. Upload these PHP files

Using InterWorx's File Manager (or an FTP client, if you'd rather) upload
every `.php` file in this folder — `common.php`, `register.php`, `login.php`,
`logout.php`, `data.php` — into a folder that's reachable at
`https://tarakona.co.za/linksman-api/`. On most InterWorx accounts that means
uploading them into a `linksman-api` folder inside your site's `public_html`
(or whatever your domain's document root is called — check SiteWorx's
"Website" section if unsure).

**Do not upload `config.php` from this local folder if it has real
credentials in it** — see the next step for the right way to create it.

### 4. Create config.php directly on the server

In InterWorx's File Manager, duplicate `config.example.php` (which you did
upload) and rename the copy to `config.php`, in the same `linksman-api`
folder on the server. Edit it there (File Manager has an in-browser text
editor) and fill in:

- `DB_HOST` — almost always `localhost`
- `DB_NAME` / `DB_USER` / `DB_PASS` — whatever you chose in step 1
- `ALLOWED_ORIGIN` — leave as `https://linksman-six.vercel.app` unless your
  Vercel URL is different

Keeping `config.php` on the server only (never in git, never round-tripped
through this local folder) means your database password never ends up in
GitHub or anywhere else it doesn't need to be.

### 5. Confirm it's live

Once uploaded, `https://tarakona.co.za/linksman-api/data.php` visited
directly in a browser should show:

```json
{"error":"Missing or malformed Authorization header"}
```

That "error" is actually the correct, expected response — it means the PHP
file is running and correctly rejecting a request with no login token. If you
see a blank page, a 404, or a raw PHP error instead, something's off in
steps 1–4 (wrong file location, or `config.php` missing/wrong).

## Files in this folder

| File | Purpose |
|---|---|
| `schema.sql` | Run once in phpMyAdmin to create the database tables. |
| `config.example.php` | Template — copy to `config.php` on the server and fill in real values. |
| `common.php` | Shared helpers (DB connection, auth check, CORS, JSON responses). Not called directly. |
| `register.php` | `POST` `{email, password, name}` → creates an account, returns a login token. |
| `login.php` | `POST` `{email, password}` → returns a login token. |
| `logout.php` | `POST` with `Authorization: Bearer <token>` → invalidates that token. |
| `data.php` | `GET`/`POST` with `Authorization: Bearer <token>` → reads/writes the account's saved app data. |
| `forgot-password.php` | `POST` `{email}` → always returns the same generic "if an account exists..." message; emails a reset link if it does. |
| `reset-password.php` | `POST` `{token, password}` → sets a new password from a reset link, logs the account in, and returns a login token. |

## Adding password reset to an already-deployed install

If you set up `linksman-api` before this feature existed, two things need to
happen — both safe to do even though real accounts already exist:

1. Re-run `schema.sql` in phpMyAdmin's SQL tab (paste the whole file again).
   Every table is created with `IF NOT EXISTS`, so your existing `users`,
   `sessions`, and `user_data` tables and their data are left untouched —
   this just adds the new `password_resets` table.
2. Upload the two new files, `forgot-password.php` and `reset-password.php`,
   into the same `linksman-api` folder as the others. No changes to
   `config.php` are needed — the reset email's link is built from
   `ALLOWED_ORIGIN`, which is already set.

Password reset emails are sent with PHP's built-in `mail()` function, using
whatever mail setup your InterWorx hosting already has — no extra
credentials or config needed. The tradeoff is that a brand-new sending
address (`noreply@tarakona.co.za`) can land in spam the first few times,
especially at Gmail/Outlook, until it builds up a sending reputation. If a
reset email doesn't show up within a minute or two, check spam before
assuming something's broken.

## Security notes

- Passwords are hashed with PHP's `password_hash()` (bcrypt) — never stored
  or logged in plain text.
- Every database query uses parameterized/prepared statements, so there's no
  SQL-injection risk from user input.
- `data.php` only accepts a fixed whitelist of data keys (`courses`,
  `players`, `rounds`, `settings`, `mePlayerId`, `rangefinderDefault`) —
  nothing else can be written into that table.
- CORS is locked to `ALLOWED_ORIGIN` in `config.php`, so only your actual app
  (not some other website) can call these endpoints from a browser.
- Login tokens expire after 30 days (`SESSION_DAYS` in config) and are
  checked against the database on every request; logging out deletes the
  token server-side immediately.

This has been tested end-to-end locally (a local MySQL + PHP server standing
in for InterWorx) — register, login, logout, wrong-password handling, the
data whitelist rejecting unknown keys, and a full "log in on a second
device" round trip all pass. What hasn't been tested is your actual InterWorx
environment, since I don't have access to it — that's the part steps 1–5
above walk through.
