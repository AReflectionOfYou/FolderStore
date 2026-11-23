# FolderStore — Spec

A small, open-source storage layer that lets small collaborative apps keep their content in one organizer's Dropbox or Google Drive folder, through a tiny serverless gateway the organizer deploys once. Contributors use only a shared link: no account, no sign-in, no app install. First customers: [Photo Stories](https://github.com/AReflectionOfYou/PhotoStories) and a wedding-memories app (section 11).

Licensing: MIT for code, CC BY 4.0 for this document.

> **Revision note (November 2026).** The first version of this spec had each contributor connect their own Dropbox or Google account to a folder the moderator shared with them. That design was dropped: per-user OAuth scopes, folder-picking, and account requirements made setup too fragile for non-technical family members and wedding guests. This version keeps the storage contract, folder layout, merge rules, and export bundle, and replaces the access model with a gateway holding one owner credential.

## 1. Goals and non-goals

**Goals**

- Replace a database backend like Supabase for small groups (tens of contributors, a few thousand files).
- Setup an organizer can finish in under fifteen minutes: one deploy, one storage app, a few pasted values, one Connect click, one link copied.
- Contributors need nothing but a link in a browser. They never see credentials and never need a Dropbox or Google account.
- Keep all data as plain, human-readable files in storage the organizer owns: photos, JSON sidecars, audio, video.
- Make storage providers interchangeable behind one small contract; switching is configuration, not code.
- Preserve all content: nothing a contributor writes is ever silently lost or overwritten.

**Non-goals**

- Large groups, high write rates, real-time collaboration, or complex queries.
- Per-contributor accounts or identity verification. A link is a bearer credential; whoever holds it acts as that contributor.
- Storing family content anywhere except the organizer's own storage. GitHub holds code only.

## 2. Core design principles

1. **One writer per folder, enforced by the gateway.** Every link carries a contributor ID and may write only under `contributors/<id>/`. (The earlier design could only ask for this by convention; the gateway now enforces it.)
2. **Append-only, never overwrite.** `write()` never replaces an existing file, for anyone. A correction is a new file. Deletion is moderator-only and always moves to a recoverable trash.
3. **The folder is the database.** Any index, manifest, or cache is derived and can be rebuilt by scanning the folders.
4. **Raw sources are preserved; derived products are regenerable.** Photos, audio, and human-confirmed metadata are sources. Thumbnails, indexes, PDFs, and bundles are derived.
5. **Adapters are dumb, the gateway and core are smart.** Adapters implement a tiny, identity-agnostic file contract. Permissions, path policy, naming, and merging live above them.
6. **The export bundle is the long-term record.** The backend is replaceable by design; the bundle never depends on it (section 12).

## 3. Roles and architecture

**Roles**

- **Organizer (moderator).** One person per deployment, moderately tech-savvy. Deploys the gateway, owns the storage account, makes and shares links.
- **Contributors.** Family members, friends, wedding guests. Non-technical. Use only a link.

**Layers**

1. **Web app.** A static front end (GitHub Pages or similar), such as Photo Stories. It knows nothing about which backend is in use; it talks only to the gateway's HTTP API.
2. **Gateway.** One small serverless function the organizer deploys (Cloudflare Workers first; section 9). Holds the storage credential and signing key as platform secrets. Verifies the contributor link on every request and enforces permissions, paths, sizes, and types.
3. **Storage adapter.** One module per backend implementing the contract in section 5: Dropbox, Google Drive, a local folder (development), and later Supabase.

**Why a gateway.** Dropbox and Google APIs act on behalf of an account owner. A browser-only app has no safe place to hold the owner's token, so a small server-side piece is unavoidable. The design goal is to make that piece trivial to deploy and free to run.

## 4. Access model: contributor links

- **A link is a signed token in the URL fragment**: `https://app.example/#fs=<token>`. Browsers never send the fragment to servers, so tokens stay out of server logs and referrers. The app keeps the token in session storage and sends it as `Authorization: Bearer <token>`.
- **The token is self-verifying.** It holds its claims (campaign, contributor ID, permissions, generation, optional expiry, optional label) and an HMAC-SHA256 signature made with the gateway's `SIGNING_KEY`. The gateway needs no database to check it, which keeps Cloudflare and Vercel deployments identical.
- **Permissions** are any combination of:
  - `upload` — write new files under `contributors/<id>/`;
  - `list` — list files anywhere in the campaign;
  - `read` — open any file in the campaign.

  A contributor can always read back files under their own folder. Typical links: a family member gets `upload,list,read`; wedding guests share one `upload`-only link; a viewer-only relative gets `list,read`.
- **Shared links.** One link may be shared by many people (for example `contributor=guests`). They all write to the same folder; unique file names keep them from colliding, and a per-upload sidecar can record a self-reported name and note.
- **Revocation.**
  - *One campaign's links:* raise that campaign's number in `LINK_GENERATIONS` (for example `{"smith-family": 2}`). Every link minted at a lower generation stops working immediately; make new ones.
  - *Everything:* rotate `SIGNING_KEY`.
  - *Time-limited links:* set an expiry when minting; the link lapses on its own.
  - Revoking a single link without affecting its campaign's other links is not supported. Small campaigns can afford to reissue; see open questions.
- **Moderator access** uses a separate `ADMIN_SECRET`, sent as a bearer token by the gateway's setup page. Every `/api/admin/*` route requires it, except the OAuth callback, which is authenticated by a signed, ten-minute `state` value the gateway issued.

## 5. The storage contract

Every adapter implements exactly these operations. Paths are relative to the adapter's root, use `/`, and have been normalized by the caller. Adapters know nothing about campaigns, contributors, or permissions.

- `list(path)` — entries (name, type, size, modified time, content hash). The hash is the provider's native one where available (Dropbox `content_hash`, Drive `md5Checksum`), SHA-256 otherwise.
- `read(path)` — bytes.
- `write(path, bytes, {contentType})` — creates a new file; **always refuses to overwrite** (throws `PathExistsError`). The core's `writeNoOverwrite` retries with a disambiguating suffix.
- `delete(path)` — moves to trash (a `.trash/` folder, or the provider's own trash); never destroys.
- `changes(cursor)` — what is new since the cursor, plus a new cursor. Adapters without a native change feed use list-and-compare.
- `getLink(path)` — optional short-lived download link for media display; `null` if unsupported.
- `createUploadTarget(path, {size, contentType, origin})` — optional one-time URL for the browser to upload a large file directly to storage, still refusing to overwrite (section 6.3); `null` if unsupported.

No rename, move, lock, or transaction. If an adapter needs more, the design is drifting.

## 6. Gateway and adapters

The gateway is one web-standard handler (`Request → Response`) with thin per-platform entry files. Routes:

| Route | Who | What |
|---|---|---|
| `GET /` | anyone | Organizer setup page (holds no secrets; asks for `ADMIN_SECRET`) |
| `GET /c` | anyone | Minimal contributor page: upload with progress, optional listing |
| `GET /api/health` | anyone | Backend name and whether storage is connected |
| `GET /api/session` | link | The link's campaign, contributor, permissions, write prefix, limits |
| `POST /api/uploads` | link + upload | Plan an upload: `{path, size, contentType}` → proxy or direct target |
| `PUT /api/files/<path>` | link + upload | Write a small file through the gateway; returns the final path |
| `GET /api/files?path=` | link + list | List a folder in the campaign |
| `GET /api/files/<path>` | link + read | Read a file; `?link=1` returns a short-lived URL where supported |
| `GET /api/admin/status` | admin | Connection state, redirect URI, limits |
| `POST /api/admin/connect` | admin | Start the storage Connect flow |
| `GET /api/admin/connect/callback` | signed state | Finish Connect; shows the refresh token to save as a secret |
| `POST /api/admin/links` | admin | Mint a link: `{campaign, contributor, permissions, label?, expiresInDays?}` |
| `GET /api/admin/campaigns` | admin | List campaign folders |
| `GET`/`DELETE /api/admin/files?campaign=&path=` | admin | List, download (`download=1`), or trash a file |

Every request is checked for: a valid token or admin secret; the permission it needs; a normalized path with no `..`, hidden segments, backslashes, or control characters; writes confined to `contributors/<id>/`; the size limit (`MAX_UPLOAD_MB`); and an allowed MIME type (`ALLOWED_TYPES`). The gateway logs one small record per request (route, status, campaign, contributor, byte count) and never logs file contents or tokens.

### 6.1 Dropbox adapter (built first)

- A Dropbox app with **App folder** access, so the gateway can see only `Apps/<app name>/` in the organizer's Dropbox, never the whole account.
- OAuth with `token_access_type=offline`: one Connect click yields a long-lived refresh token; the adapter exchanges it for short-lived access tokens and refreshes once on a 401.
- Writes use `mode: add, autorename: false`, so Dropbox itself refuses to overwrite.
- Plain `fetch`, no SDK, so it runs on Workers. Non-ASCII file names are escaped in the `Dropbox-API-Arg` header as Dropbox requires.

### 6.2 Google Drive adapter (built second)

- **OAuth with the narrow `drive.file` scope**, publishing the OAuth client to **In production**. `drive.file` is a non-sensitive scope, so no Google verification is required, and refresh tokens do not expire after seven days the way they do in Testing mode.
- With `drive.file` the gateway sees only what it created. It creates one top-level folder (`STORAGE_ROOT`, default `FolderStore`) in the organizer's My Drive on first use and keeps everything inside it. Pointing at a pre-existing folder is not supported under this scope.
- **Why not a service account** (the earlier recommendation): service accounts have no Drive storage quota of their own, so uploads into an ordinary Gmail user's folder fail; working around that needs Shared Drives or domain-wide delegation, both Google Workspace features most families do not have.
- Drive permits duplicate names, so never-overwrite is check-then-create. Two simultaneous writes to the same new path could both land as same-named siblings: nothing is lost, and the naming scheme makes it vanishingly rare.
- Delete sets `trashed: true` (Drive's own recoverable trash).

### 6.3 Large files and direct upload

Platform request-body limits rule out sending big files through the gateway: about 4.5 MB on Vercel, 100 MB on Cloudflare's free plan. So:

- Files up to `MAX_PROXY_UPLOAD_MB` (default 4) go through the gateway (`PUT /api/files/...`), where size and type are checked exactly.
- Larger files get a **direct upload target** from `POST /api/uploads`: a Dropbox temporary upload link (POST, single use, up to 150 MB, commit mode `add`) or a Google Drive resumable session URL (PUT). The browser sends the bytes straight to storage; the gateway spends a few milliseconds of CPU no matter how big the file is.
- The gateway checks the declared size and type before issuing a target. It cannot see the actual bytes of a direct upload, so the declared size is trusted up to the provider's own limit.
- On a name collision a direct upload fails with 409; the client retries with a disambiguated name.
- Files over 150 MB on Dropbox need upload sessions, which are not supported yet.

### 6.4 Local adapter

For tests and for running the gateway on your own machine (`npm run dev`). Files land in a folder; trash is `.trash/`. No direct uploads.

### 6.5 Supabase adapter (planned)

Wraps a Supabase Storage bucket behind the same contract, using the service-role key held in the gateway. Existing Supabase apps (the current Photo Stories, the wedding uploader) migrate through the bundle importer (section 12.5) rather than by running the old schema behind the gateway.

## 7. Organizer setup experience

The README links a short, prescriptive recipe per backend ([setup.md](setup.md)). The shape is the same for each:

1. Generate a `SIGNING_KEY` and `ADMIN_SECRET` (`npm run cli -- secrets`).
2. Deploy the gateway (section 9) and paste those two values, plus the storage app's key and secret, into its secrets.
3. Create the storage app and register the gateway's redirect URI, `https://<gateway>/api/admin/connect/callback`, which the setup page displays.
4. Open the gateway, enter the admin secret, click **Connect**, approve once.
5. Paste the refresh token the gateway shows into its secrets (the gateway cannot write its own secrets on either platform), then reload.
6. Make a link and share it.

### 7.1 Dropbox Connect

Values: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, then `DROPBOX_REFRESH_TOKEN` after Connect.

### 7.2 Google Drive Connect

Values: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (a "Web application" OAuth client with the redirect URI above, published In production), then `GOOGLE_REFRESH_TOKEN` after Connect.

## 8. Configuration

All configuration is environment variables and secrets; switching backends changes configuration only.

| Name | Kind | Meaning |
|---|---|---|
| `STORAGE_BACKEND` | var | `dropbox`, `gdrive`, or `local` (dev server only) |
| `STORAGE_ROOT` | var | Folder inside the Dropbox app folder, or the Drive top-level folder name |
| `SIGNING_KEY` | secret | ≥ 32 characters; signs links and OAuth state |
| `ADMIN_SECRET` | secret | ≥ 16 characters; the organizer's password for the setup page |
| `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` | secret | Dropbox backend |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | secret | Drive backend |
| `APP_URL` | var | Front-end page links open; defaults to the gateway's own `/c` page |
| `ALLOWED_ORIGINS` | var | Comma-separated origins allowed by CORS; defaults to `APP_URL`'s origin, or `*` |
| `MAX_UPLOAD_MB` | var | Largest file accepted at all (default 150) |
| `MAX_PROXY_UPLOAD_MB` | var | Largest file sent through the gateway itself (default 4) |
| `ALLOWED_TYPES` | var | MIME patterns, default `image/*,video/*,audio/*,application/json,text/plain,text/vtt` |
| `LINK_GENERATIONS` | var | JSON map of campaign → current link generation, default `{}` |

## 9. Deployment targets

**One core, thin entry files.** All logic is in `packages/gateway/src/handler.ts`. Each platform has a small entry file that builds the handler from its environment.

- **Cloudflare Workers (first).** Entry `packages/gateway/src/cloudflare.ts`, config `deploy/cloudflare/wrangler.toml`. The free plan has no non-commercial restriction, so it suits organizers who receive paid setup help. Free-plan limits to document: about 100,000 requests per day and 10 ms of CPU per request (the gateway does little CPU work, since large bytes go direct to storage), with a 100 MB request body cap. The bundle is about 20 KB gzipped.
- **Vercel (later).** An easier first deploy and dashboard, but the free Hobby plan is for personal, non-commercial use only: an organizer deploying for their own family is fine, but a deployment done for pay is not. The README must say so plainly. Functions accept about 4.5 MB per request, which the default `MAX_PROXY_UPLOAD_MB` already respects.
- **Node (development).** `npm run dev` runs the same handler with the local adapter, or with a real backend via `.dev.vars`.
- **Verify limits before release.** Free-tier numbers change; check them when writing the setup recipes.

## 10. Folder layout, naming, and merge rules

### 10.1 Layout

Under the storage root, each campaign is one folder named by its slug:

- `<campaign>/project.json` — campaign name, dates, schema version, contributor display names (written by the app or the organizer).
- `<campaign>/contributors/<contributor-id>/` — one folder per link's contributor ID; only that link writes here.
  - `media/` — photos, audio, video.
  - `items/` — stories, notes, corrections, tags (JSON).
- `<campaign>/derived/` — thumbnails, merged indexes, caches; disposable, written as new timestamped snapshots. Written by the organizer's tools, not by contributor links.
- `<campaign>/exports/` — finished bundles.
- `.trash/` — at the storage root; trashed files, mirroring their original paths.

### 10.2 Naming

Each photo has a sidecar sharing its root name, holding metadata not written into the photo itself (as in the current Photo Stories app). Contribution files are named `<subject>.<kind>.<contributor>.<UTC timestamp>.<ext>`, for example `IMG_0412.story.amy.2026-11-16T105200Z.json`. On a collision the core retries with a short random suffix before the extension rather than failing or overwriting.

### 10.3 Merge rules

The core builds one logical view from all contributor folders; adapters never merge.

- **Subject grouping.** Files sharing a subject root name form one item, whoever wrote them.
- **Ordering.** By UTC timestamp, then contributor ID.
- **Layering.** The original uploader's data is the base; others' notes, tags, and corrections layer on top with attribution. Nothing is overwritten.
- **Revisions.** A new timestamped file supersedes the same contributor's earlier one; the earlier file stays as history.
- **Uncertainty.** A contribution may be marked uncertain; later contributions can confirm or contradict it.
- **Rebuildable index.** The merged index in `derived/` is a cache written as a new snapshot on each rebuild; readers use the newest.

## 11. Customers

### 11.1 Photo Stories

- One campaign per family project, with a beginning and a declared end.
- Each family member gets their own link (`upload,list,read`) with their own contributor ID, so attribution and the merge rules work unchanged.
- Photos go in the uploader's `media/`; metadata is embedded where possible, the rest in a sidecar sharing the photo's root name.
- Spoken stories are kept as audio source files beside their transcripts (derived).
- Corrections ("this is actually Aunt Rose") are new files in the corrector's folder, layered by the merge rules.
- AI transcription and suggestions stay outside the storage gateway (a separate optional proxy holding AI keys); they are not part of the access model.

### 11.2 Wedding memories

- One campaign per wedding (or per event in it).
- Guests share one `upload`-only link (contributor `guests`), shown as a QR code at the event. They cannot list or see anyone else's uploads, matching the current Supabase uploader's privacy model.
- Each upload gets a sidecar with the original file name, capture time if known, and an optional self-reported name and note.
- The couple gets a full link, or browses with the organizer page; the memories site is built from the campaign folder or its export bundle afterwards.
- Videos are the common large-file case, so this app exercises the direct-upload path (section 6.3) most.

## 12. Export bundle and import

Unchanged from the first spec in substance. The bundle is the hub: every source exports to one and every destination imports from one.

- **Format.** A zipped [BagIt](https://www.rfc-editor.org/rfc/rfc8493) bag: `bagit.txt`, a `data/` payload laid out like the live campaign (section 10.1), `manifest-sha256.txt`, a tag manifest, and `bag-info.txt` (campaign, organization, dates, bundling software, payload size).
- **Browsable HTML.** One self-contained `index.html` beside `bagit.txt`: inline code and styles, embedded metadata, media by relative path, browse by contributor/event/person/date, print-to-PDF via a print stylesheet. It must keep working untouched for decades and can always be regenerated from the payload.
- **The bundle needs nothing**: no app, gateway, or account. Unzip, open, verify against the manifests.
- **Export** reads any source and writes a bag, whole campaign or a slice (one contributor, event, or date range). Read-only and repeatable. Runs with the organizer's access (admin routes or a local tool), never through a contributor link.
- **Import** verifies manifests first, never overwrites, preserves attribution and original timestamps, is safe to re-run (content hashes), and asks the organizer to confirm contributor-ID mapping when merging into an existing campaign.
- **Outside importers** produce a bag first: a Supabase exporter (the migration path for the current Photo Stories and wedding uploader), a plain-folder importer, and provider-to-provider moves (export, then import).
- **Equivalence check.** Exporting the same campaign from two backends must produce identical `manifest-sha256.txt` payload entries. The zip files themselves will differ (timestamps inside the archive).

## 13. Security notes

- Storage credentials, the signing key, and the admin secret live only in the gateway's secret store, never in the front end or the repository.
- All paths are normalized and confined server-side; contributor writes are confined to their own folder.
- Links are scoped to one campaign, carry only the permissions minted into them, never grant delete, and travel in the URL fragment.
- The setup page and OAuth callback send `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and refuse framing.
- Rate limiting is limited to per-file size and type checks. Platform-wide request limits and link expiry are the main brakes on abuse of a leaked link. A leaked link is handled by bumping its campaign's generation.

## 14. Licensing and notices

- Code under MIT, documents and visual content under CC BY 4.0, with a footer line saying which license covers what.
- Apps built on FolderStore carry a small, plain notice on the main screen, "© 2026 Michael A. Heroux", linking to the MIT and CC BY 4.0 licenses, subtle enough not to draw attention.

## 15. Tracer bullet and build order

The tracer bullet is Dropbox, Cloudflare Workers, and signed links with no expiry.

1. Create a Dropbox app with App folder access; note its key and secret; register the gateway's redirect URI.
2. Deploy the gateway to Cloudflare Workers with `SIGNING_KEY`, `ADMIN_SECRET`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`.
3. Open the setup page, click Connect Dropbox, approve, and save the refresh token as `DROPBOX_REFRESH_TOKEN`.
4. Make a link; upload a photo through the gateway's `/c` page; confirm it lands in the app folder.
5. Upload a video over 4 MB; confirm it goes direct to Dropbox.
6. Point Photo Stories (or the wedding uploader) at the gateway with `APP_URL` and upload through it.

**Status (this branch):** the gateway, Dropbox and Drive adapters, local adapter, dev server, CLI, and tests exist. Steps 1–5 need a real Dropbox account and Cloudflare deploy to verify; the Drive adapter is untested against a real account.

**Then, in order:** the client library for apps; the Supabase-to-bag exporter and the importer; the Google Drive recipe; the Vercel entry file; the bundle exporter with the equivalence check; the Supabase adapter if still wanted.

## 16. Open questions

- **Browser CORS for direct uploads.** Confirm that Dropbox temporary upload links and Drive resumable session URLs accept a browser PUT/POST from the app's origin. If not, files over the proxy limit need a different path (chunked through the gateway on Cloudflare, or upload sessions).
- **Single-link revocation.** Whether per-campaign generations are enough, or a small revocation list (Cloudflare KV, or a `REVOKED_LINKS` variable of link IDs) is worth adding.
- **Free-tier headroom.** How much load the Cloudflare free plan carries for a large wedding with hundreds of guests uploading in an evening.
- **Size limits for the first release.** Proposed: 150 MB per file (Dropbox single-upload limit), with apps nudging guests toward short clips.
- **Multiple organizers.** Whether one campaign can have more than one organizer. Today the admin secret can be shared, which is all-or-nothing.
- **Deploy button.** Whether Cloudflare's deploy button works with this monorepo layout, or a small template repository is needed.
- **Naming.** FolderStore is a placeholder; choose a final name before the first public release.
- **`derived/` garbage collection.** A simple pruning rule (age-based, or keep newest N).
