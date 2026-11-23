# Organizer setup

This is the one-time setup an organizer does (spec section 7). When it is
done you have a private web address, your gateway, that holds the only key
to your storage. Then you hand out links. Contributors never see any of
this, and never need a Dropbox or Google account.

You need:

- a Dropbox account or a Google account (the storage, and you own it);
- a free Cloudflare account (to run the gateway);
- Node.js 22 or newer and a clone of this repository (to deploy).

Plan on about fifteen minutes. If you'd like to try everything on your own
computer first, skip to [Try it locally](#try-it-locally).

## 1. Make two secrets

```sh
npm install
npm run cli -- secrets
```

This prints two lines, `SIGNING_KEY=...` and `ADMIN_SECRET=...`. Keep them
somewhere safe, such as a password manager. `ADMIN_SECRET` is your password
for the gateway's setup page. `SIGNING_KEY` signs every link you make;
changing it later cancels every link at once.

## 2. Deploy the gateway to Cloudflare

```sh
npx wrangler login                 # opens a browser; sign in to Cloudflare
npm run deploy:cloudflare          # prints your gateway address, e.g. https://folderstore-gateway.<you>.workers.dev
```

Then add the two secrets from step 1:

```sh
cd deploy/cloudflare
npx wrangler secret put SIGNING_KEY      # paste the value when asked
npx wrangler secret put ADMIN_SECRET
```

You can also add secrets in the Cloudflare dashboard: **Workers & Pages →
folderstore-gateway → Settings → Variables and Secrets → Add**, type
**Secret**.

Open your gateway address in a browser. You should see the setup page. It
will say storage is not configured yet; that's the next step.

## 3a. Dropbox

1. Go to [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps), signed in as the account that will hold the files, and click **Create app**.
2. Choose **Scoped access**, then **App folder**. The gateway will only ever see
   one folder, `Apps/<your app name>/`, never the rest of your Dropbox.
3. Name it (names are global, so add something distinctive, e.g. "Smith Family Photos").
4. **Permissions** tab: enable `files.metadata.read`, `files.metadata.write`,
   `files.content.read`, `files.content.write`, then click **Save changes**
   (upper right). Do this before connecting; permissions are fixed when you
   approve access.
5. **Settings** tab, **OAuth 2 → Redirect URIs**: add
   `https://<your gateway>/api/admin/connect/callback` exactly. The setup page shows this address so you can copy it.
6. Still on **Settings**, copy the **App key** and **App secret**, and add them to the gateway:

   ```sh
   npx wrangler secret put DROPBOX_APP_KEY
   npx wrangler secret put DROPBOX_APP_SECRET
   ```

7. Reload the setup page, enter your admin secret, and click **Connect Dropbox**. Approve.
8. The gateway shows a long refresh token once. Save it as one more secret:

   ```sh
   npx wrangler secret put DROPBOX_REFRESH_TOKEN
   ```

   (The gateway can't save secrets by itself, which is why this step is manual.)
9. Reload the setup page. It should say **Connected**.

Dropbox apps start in "development" status, which limits how many Dropbox
accounts can connect. That doesn't matter here: only your account ever
connects.

## 3b. Google Drive

First change the backend: in `deploy/cloudflare/wrangler.toml` set
`STORAGE_BACKEND = "gdrive"` and redeploy (`npm run deploy:cloudflare`).

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project (any name).
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - **Branding**: app name and your contact email.
   - **Audience**: user type **External**; then **Publish app** so its status is **In production**.
     This matters. In "Testing" status Google cancels access every seven days.
   - **Data Access**: add the scope `.../auth/drive.file` only. It is a
     non-sensitive scope, so publishing needs no Google review. The gateway
     sees only files it creates itself.
4. **Clients → Create client**: type **Web application**. Under **Authorized
   redirect URIs** add `https://<your gateway>/api/admin/connect/callback`.
   Copy the **Client ID** and **Client secret**:

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

5. Reload the setup page, click **Connect Google Drive**, and approve. Google
   may warn that the app is unverified; since it's your own app, continue.
6. Save the refresh token it shows: `npx wrangler secret put GOOGLE_REFRESH_TOKEN`.
7. Reload. It should say **Connected**. The first upload creates a folder
   called `FolderStore` (or your `STORAGE_ROOT`) in your My Drive; everything lives inside it.

Why not a Google service account? Service accounts have no storage of their
own on ordinary Gmail accounts, so uploads fail (spec section 6.2).

## 4. Make a link

On the setup page, under **Make a contributor link**:

- **Campaign**: a short name for the project, lowercase with hyphens, e.g. `smith-family` or `jordan-alex-wedding`. Each campaign is one folder.
- **Contributor ID**: who this link is for, e.g. `aunt-rose`. For a link many people share, such as wedding guests, use something like `guests`.
- **What the link allows**: family members usually get all three. Wedding guests usually get **Add files** only, so they can't see each other's uploads.

Copy the link and send it. It opens your app if you set `APP_URL` (step 5),
or the gateway's own simple upload page if not.

**Cancelling links.** To cancel every link for one campaign, set
`LINK_GENERATIONS` in `wrangler.toml` to raise that campaign's number, e.g.
`{"smith-family": 2}`, redeploy, and make new links. To cancel every link
everywhere, replace `SIGNING_KEY`.

## 5. Point your app at the gateway (optional)

In `deploy/cloudflare/wrangler.toml`:

- `APP_URL`: your app's address, e.g. `https://you.github.io/PhotoStories/`. Links will open it.
- `ALLOWED_ORIGINS`: leave empty to allow just `APP_URL`'s site.

Redeploy with `npm run deploy:cloudflare`.

## Limits worth knowing

- Files up to `MAX_PROXY_UPLOAD_MB` (4 MB) pass through the gateway. Bigger
  files go straight from the browser to Dropbox or Drive, up to
  `MAX_UPLOAD_MB` (150 MB).
- Cloudflare's free plan allows about 100,000 requests a day. That's plenty
  for a family or a wedding, but check the current numbers on Cloudflare's
  pricing page.

## Try it locally

No accounts needed. Files go into `./sandbox`:

```sh
npm install
npm run dev
```

The dev server prints an admin secret for this run. Open
http://localhost:8787, enter it, make a link, and open the link to upload.

To try real Dropbox from your computer, create a `.dev.vars` file
(git-ignored) with `STORAGE_BACKEND=dropbox`, `SIGNING_KEY`, `ADMIN_SECRET`,
`DROPBOX_APP_KEY`, and `DROPBOX_APP_SECRET`. Add
`http://localhost:8787/api/admin/connect/callback` as a second redirect URI
in the Dropbox app. Then run `npm run dev` and connect as above. Put the
refresh token in `.dev.vars` as `DROPBOX_REFRESH_TOKEN` and restart.
