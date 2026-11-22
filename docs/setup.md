# Setting up Dropbox or Google Drive

This is the one-time registration step a moderator does (spec section 3):
create an "app" with the provider, get an ID/key from it, and use that to
connect FolderStore to your own Dropbox or Google account. Nothing here
touches anyone's files yet — it just gets you a key you paste into a command.

Each contributor then runs their own `auth-dropbox` or `auth-gdrive` command
to connect *their own* account, after the moderator has shared the project
folder with them using Dropbox's or Drive's normal sharing feature. The app
registration below only needs to happen once per project (or once ever, if
you reuse the same app for multiple projects).

If you just want to try FolderStore without any of this, use the local
adapter — see the main [README](../README.md). No account needed.

## Before you start: the redirect address

FolderStore's sign-in flow runs a tiny, temporary web server on your own
computer to catch the response when you approve access, at:

```
http://127.0.0.1:53682/callback
```

Both setups below ask you to register this exact address with the provider.
If you ever see a "redirect_uri_mismatch" error, this is the first thing to
check — copy it exactly, including `http://` and the port number.

## Dropbox

1. Go to [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) and sign in with the account you'll use as moderator.
2. Click **Create app**.
3. Choose **Scoped access**.
4. Choose **Full Dropbox** as the access type, not "App folder." A shared
   folder someone else gives you can live anywhere in your own Dropbox, and
   an app-folder-scoped app can only see its own sandboxed folder — it won't
   see a folder shared into your account.
5. Give it a name (anything — e.g. "FolderStore"). Dropbox names must be
   globally unique, so add something distinctive if it's taken.
6. On the app's **Permissions** tab, enable:
   - `files.metadata.read`
   - `files.metadata.write`
   - `files.content.read`
   - `files.content.write`

   Click **Submit** at the bottom of that tab to save.
7. On the **Settings** tab, under **OAuth 2** → **Redirect URIs**, add
   `http://127.0.0.1:53682/callback` and press Enter to add it.
8. Still on **Settings**, copy the **App key** near the top.
9. Back in your FolderStore checkout:

   ```sh
   npm run cli -- auth-dropbox --app-key <the-app-key>
   ```

   This prints a URL and tries to open it in your browser. Log in (as the
   moderator for the first run, or as yourself if you're a contributor
   accepting an invite), approve access, and the CLI prints a confirmation
   once the token is saved.
10. Find the path to use as `--root`: whatever this folder is called in
    *your* Dropbox — if the moderator shared a folder named "Family Photos,"
    that's usually `/Family Photos` for everyone, but check the Dropbox app
    or website to be sure, since a contributor could have renamed their
    copy.

**A limit worth knowing about.** While a Dropbox app is in development
status (the default, before you submit it for Dropbox's app review), it can
only be used by a small number of Dropbox accounts — the developer's own,
plus whoever is added as a team member on the app's console page. For a
family-sized project this is usually enough, but if you hit a permission
error for a contributor, check the app's **Settings** tab for where to add
them, or look into applying for production status.

## Google Drive

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (or pick an existing one) — the project name is just
   a label, it can be anything.
2. Go to **APIs & Services → Library**, search for **Google Drive API**, and
   click **Enable**.
3. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External** (unless everyone in your family group has a
     Google Workspace account under the same organization, in which case
     **Internal** is simpler).
   - Fill in the required app name and contact fields — none of this is
     shown to anyone outside your group while the app is in testing.
   - Add the `drive.file` scope.
   - On the **Test users** page, add the Google account email of every
     contributor who will connect. While the app is unverified (the
     default), only accounts listed here can sign in, and Google expires
     their access after about 7 days, requiring them to sign in again —
     that's a real rough edge for now; see the open question on this in
     [spec.md, section 11](spec.md).
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Desktop app**. This pairs naturally with the
     localhost flow FolderStore uses and doesn't require registering the
     redirect address explicitly.
   - If a "Desktop app" client doesn't work in practice (some Google Cloud
     projects behave differently here — this is one of the things worth
     confirming, not something I've verified against a live account yet),
     create a **Web application** client instead and add
     `http://127.0.0.1:53682/callback` to its **Authorized redirect URIs**.
5. Copy the **Client ID** (and **Client secret**, if you created a Web
   application client — a Desktop app client doesn't need one, though
   FolderStore accepts one either way).
6. Back in your FolderStore checkout:

   ```sh
   npm run cli -- auth-gdrive --client-id <your-client-id>
   # or, if you created a Web application client:
   npm run cli -- auth-gdrive --client-id <your-client-id> --client-secret <your-client-secret>
   ```

7. Find the folder ID to use as `--root-folder-id`: open the shared folder in
   Google Drive in your browser, and copy the ID from the URL —
   `drive.google.com/drive/folders/`**`THIS_PART`**.

## Where the token goes

Both flows save to `.folderstore/credentials.json` in the directory you ran
the command from (already in `.gitignore` — never commit this file). Right
now that means the Dropbox/Drive sign-in is scoped to wherever you ran the
`auth-*` command; if another app on your machine (like Photo Stories) needs
the same sign-in, run the command again from that app's directory, or point
it at the same credentials file. We're considering moving this to a
single, machine-wide location so one sign-in covers every FolderStore-based
app automatically — not done yet.
