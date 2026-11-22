# Shared Folder Storage Library — Spec

Working name: **FolderStore** (rename freely). A small, open-source, reusable library that lets small collaborative apps use a shared folder in Dropbox, Google Drive, or a local folder as their data store, with no database backend. First customer: the new Photo Stories app. Intended to serve other Reflection of You apps too.

Licensing: MIT for code, CC BY 4.0 for this document.

## 1. Goals and non-goals

**Goals**

- Replace a database backend like Supabase for small groups (tens of contributors at most).
- Make concurrent-edit conflicts between different contributors structurally impossible; make same-contributor, multi-device conflicts explicit and non-destructive rather than silently lost.
- Keep all data as plain, human-readable files that outlive the app: photos, JSON sidecars, audio.
- Make storage providers interchangeable behind one small contract.
- Grant a defined group secure access through each provider's own invitation/sharing mechanism, in a single action by a tech-savvy moderator.
- Preserve all content: nothing a contributor writes is ever silently lost or overwritten.

**Non-goals**

- Large groups, high write rates, real-time collaboration, or complex queries.
- Storing family content anywhere except the user's own Dropbox or Google Drive. GitHub holds code only.
- Anonymous, sign-in-free access. Every contributor has an identity on the chosen provider — see section 3.

## 2. Core design principles

1. **One writer per file, enforced by trust and convention, not by storage-level ACLs.** Every contributor writes only inside their own folder. The app never offers the affordance to write elsewhere. Dropbox and Drive sharing grant access to the whole shared folder, so nothing stops a member from writing elsewhere at the provider level — that gap is closed by mutual trust within the group, not by technical enforcement (section 3).
2. **Append-only, never-overwrite contributions.** `write()` never overwrites an existing file, for anyone, anywhere (section 5). A correction or addition is always a new file. Contributors add new revisions or retract their own entries; nothing is destroyed except through an explicit, recoverable retraction (moved to trash).
3. **The folder is the database.** Any index, manifest, or cache is derived and can be rebuilt by scanning the folders.
4. **Raw sources are preserved; derived products are regenerable.** Photos, audio, and human-confirmed metadata are sources. Thumbnails, indexes, PDFs, and bundles are derived and disposable.
5. **Adapters are dumb, the core is smart.** Providers implement a tiny, identity-agnostic file contract (list/read/write/delete/changes/getLink). All merge logic, path and identity policy, and conflict handling live in the core.

## 3. Identity and access model

- **Invitation uses each provider's own sharing.** The moderator creates the project root in their own Dropbox or Google Drive and shares it using that provider's native folder-sharing, inviting each contributor by account (email) — one action per person, once.
- **Identity comes from the provider, not from the library.** Each contributor accepts the share and connects the app with their own account (Dropbox or Google OAuth). `project.json`'s contributor list maps a contributor ID to a display name and that provider account's identity, filled in by the moderator during the same one-time setup.
- **Trust is the security boundary for write isolation.** Dropbox and Drive sharing both grant access to the whole shared folder tree on an ordinary account, not per-subfolder permissions. The library enforces "write only in your own folder" in application logic, not storage ACLs. This is sufficient because the group is small and its members trust each other. Stated plainly as a residual risk: any invited member could, using the provider's own tools outside this app, write or delete inside another member's folder. Two things already in the design limit the damage of an accident: writes never overwrite (section 5), and deletes always go to trash.
- **Revocation** removes a contributor from the provider's native share. Files they already wrote remain, as a historical record, consistent with the preservation principle in section 2. Whether anything further is needed app-side is an open question (section 11).
- **The optional AI proxy (section 8) is not part of this access-control model.** It plays no role in who can read or write the project folder.

## 4. Folder layout

The project owner creates one shared parent folder, the project root, with this structure:

- `project.json`: project name, creation date, declared end date (optional), schema version, and the contributor list — IDs, display names, and provider account identities.
- `contributors/<contributor-id>/`: one folder per person. By convention, only that person writes here (section 3).
  - `items/`: that person's contributions.
  - `media/`: photos, audio, and video that person uploaded.
- `derived/`: thumbnails, merged index, caches. Disposable and rebuildable. Written only as new, timestamped snapshots — never overwritten in place (section 7).
- `exports/`: finished export bundles.

**Naming.** Every contribution file is named with its subject, a kind, the contributor ID, and a UTC timestamp, for example `IMG_0412.story.amy.2026-11-16T105200Z.json`. Photos and their sidecars share a root name, as in the current Photo Stories app. If two writes from the same contributor collide on the same timestamp — for example, two devices writing at the same instant — the core library retries with a disambiguating suffix (section 5) rather than failing visibly or overwriting.

## 5. The storage contract

Every adapter implements exactly these operations. Paths are relative to the project root. Adapters carry no notion of contributor identity or folder ownership — that policy lives entirely in the core (section 2, principle 5).

- `list(path)`: returns entries (name, type, size, modified time, content hash). The hash is required, not optional: adapters without a native hash (e.g., local folder) have the core library compute SHA-256 on write, so import idempotency (section 12.4) always holds regardless of adapter.
- `read(path)`: returns bytes.
- `write(path, bytes)`: creates a new file; **always refuses to overwrite an existing file, with no exception.** On a path collision the core library retries with a disambiguated path (see Naming, section 4) rather than surfacing an error, except where the collision is a genuine duplicate write it can detect and skip via the content hash.
- `delete(path)`: allowed only inside the caller's own folder by convention (section 3); moves to a trash area rather than destroying.
- `changes(cursor)`: returns what is new or changed since the cursor, plus a new cursor. Adapters without native change feeds fall back to list-and-compare.
- `getLink(path)`: optional temporary link for media display.

The contract deliberately has no rename, move, lock, or transaction. If an adapter needs more, the design is drifting.

## 6. Adapters

- **Local folder:** for tests, development, and offline use. Required.
- **Dropbox:** each contributor connects their own Dropbox account (OAuth) after accepting the moderator's native shared-folder invite. There is no project-owned shared token for ordinary use (see section 8 for the narrower, optional AI-proxy case). Confirm in a prototype exactly which OAuth scope sees a folder shared into the contributor's own account this way.
- **Google Drive:** contributors sign in with their own Google accounts after accepting the moderator's share. The narrow `drive.file` scope may need each person to pick the shared folder once — verify in a prototype.
- **Future providers:** anything that can implement section 5.

## 7. Merge rules

The core library builds one logical view from all contributor folders. Adapters never merge.

- **Subject grouping.** Files sharing a subject root name (for example `IMG_0412`) form one item, no matter who wrote them.
- **Ordering.** Contributions to an item are ordered by their UTC timestamp, then by contributor ID to break ties.
- **Layering.** The original uploader's data is the base. Other people's notes, tags, and corrections layer on top and are shown with attribution. Nothing is overwritten.
- **Revisions.** A contributor adds a new timestamped file superseding their own prior one; the prior file stays on disk as visible history, not deleted. A contributor may also retract a file outright, which moves it to trash (recoverable).
- **Uncertainty.** A contribution may be marked uncertain, such as a guessed name or year. Later contributions can confirm or contradict it.
- **Rebuildable index, never overwritten.** The merged index in `derived/` is a cache keyed by the change cursor, written as a new timestamped snapshot on every rebuild rather than overwritten in place. Readers use the newest snapshot by name. Concurrent rebuilds from different app instances are harmless — redundant, not conflicting, since derived output is disposable (section 2) — and stale snapshots are garbage-collected periodically (open question, section 11).

## 8. Optional AI proxy

A small, optional serverless component, specified here but built and deployed separately from the library. It is not part of the access-control model (section 3 covers that); its only job is keeping AI service credentials server-side.

- **What it holds.** API keys for AI services (transcription, follow-up questions). These never reach the browser.
- **What it does.** Proxies calls to those AI services on the app's behalf.
- **Metering.** Per-project caps on AI usage, with an optional bring-your-own-keys setting.
- **Self-hosters.** Can skip this entirely and call AI services with their own keys.
- **Not required for storage access.** Storage access is granted by each provider's native sharing (section 3); this component plays no role in it.

## 9. First customer: Photo Stories

Photo Stories maps onto the library like this.

- **Project.** One "campaign" is one project root, with a beginning and a declared end.
- **Photos and metadata.** Each photo goes in its uploader's `media/` folder. Metadata is embedded in the image where possible, with the rest in a sidecar that shares the photo's root name. This matches the current app.
- **Stories and spoken descriptions.** Audio is kept as a source file next to its transcript. The transcript is derived and can be regenerated.
- **Corrections and additions.** Another family member's note about a photo, such as "this is actually Aunt Rose", is a new file in their own folder, layered on the original by the merge rules.
- **People list.** The shared family people list with aliases is a contribution file like any other. Changes are new files, and the merge picks the latest per person.
- **Face tags.** Confirmed tags are sources. Suggestions are derived.

## 10. Export bundle and succession

- **At the declared end,** the app writes one zipped BagIt bundle, as specified in section 12, to `exports/`: all photos, sidecars, audio, and stories, checksummed manifests, and a single browsable HTML file, with PDF export for printing available from that file.
- **The bundle needs nothing.** No app, no gateway, no account. Unzip, open the HTML file, and verify integrity against the manifests.
- **Ownership.** The bundle belongs to the group that commissioned the project. The project account can be handed over or closed.
- **Reimport.** A closed project can seed a new one through the import contract in section 12.4, which uses the metadata in the bundle to rebuild the folder structure.
- **Backups.** The project folder is copied to a second location periodically.

## 11. Open questions

- **Dropbox OAuth scope for shared folders.** Confirm which scope lets a contributor's own account see a folder the moderator shared into it via native Dropbox sharing.
- **Google Drive permissions.** Does the narrow `drive.file` scope let contributors see a folder another person shared with them, or must each person pick it once? Build a small prototype to find out.
- **Change feeds.** How reliable are the Dropbox cursor and the Drive changes feed for a folder of a few thousand small files?
- **Naming.** FolderStore is a placeholder. Choose a final name before the first public release.
- **Hosting the AI proxy.** Which serverless host, and who pays, if it's used at all.
- **Rotation and recovery.** What does the owner do if the project account or moderator access is lost? Define a minimum recovery checklist.
- **Revocation follow-through.** Whether removing a contributor's provider-level share access needs any additional app-side step, such as marking them inactive in `project.json`.
- **`derived/` garbage collection.** A simple rule for pruning stale index snapshots (age-based, or keep-newest-N) so the folder doesn't grow unbounded.

## 12. Import and export (bundle as hub)

Import and export are first-class operations of the library, usable by any app, not just Photo Stories. The bundle is the hub: every source exports to a bundle, and every destination imports from one. Moving content from Supabase to Dropbox is two steps, a Supabase exporter that writes a bundle and the library's importer that unpacks it.

### 12.1 Bundle format: zipped BagIt

The bundle is a [BagIt](https://www.rfc-editor.org/rfc/rfc8493) bag, the Library of Congress digital-preservation packaging format, delivered as a zip. This is the format the current Photo Stories app already uses.

- **Declaration.** `bagit.txt` at the top level states the BagIt version and encoding.
- **Payload.** A `data/` directory holds the content, laid out like the live project from section 4: contributor folders, media, sidecars, audio, and `project.json`.
- **Manifests.** `manifest-sha256.txt` lists a checksum for every payload file, so anyone can verify years later that nothing has changed or gone missing. A tag manifest covers the files outside `data/`.
- **Bag metadata.** `bag-info.txt` records the project name, source organization, dates, bundling software and version, and payload size.
- **Self-describing.** The bundle needs no app, no gateway, and no account.

### 12.2 Browsable HTML file

Every bundle includes one HTML file, `index.html`, at the top level beside `bagit.txt`, so it opens straight from the unzipped folder in any web browser.

- **Single file.** All code and styling are inline, with no external dependencies and no network access needed.
- **Embedded data.** The merged metadata, stories, captions, people list, and attributions are embedded in the file itself, so browsing works with nothing else.
- **Media by relative path.** Photos, audio, and video load from `data/` by relative path, so the HTML file stays small.
- **Features.** Browse by contributor, event, person, and date; view a photo with its story and everyone's layered contributions; export selected items to PDF for printing via the browser's own print-to-PDF, using a print stylesheet — no embedded PDF library, so the "no external dependencies, no network access" promise holds.
- **Derived.** The HTML file can always be regenerated from the payload. The payload is the source of truth, and the file is a convenience that must also keep working untouched for decades.
- **Integrity.** The file lists the bag's checksums so a viewer can flag a missing or altered file.

### 12.3 Export contract

An exporter reads from any source and writes a bag. Exporters are provider-specific; the bag they produce is not.

- Whole project, or a slice such as one contributor, one event, or one date range. Slices are valid bags and note their scope in `bag-info.txt`.
- Contributor attribution and original timestamps are written into the payload exactly as they stand in the source.
- Export is read-only against the source and can be repeated at any time.

### 12.4 Import contract

An importer reads a bag and writes into any storage adapter.

- **Verify first.** Check the manifests before writing anything, and report any mismatch.
- **Never overwrite.** Imported material lands in contributor folders as new files, so the append-only and one-writer rules hold from day one.
- **Preserve attribution and time.** Each person's material goes into their own folder with original timestamps, not the import date.
- **Safe to re-run.** Every file carries a content hash, guaranteed by every adapter (section 5), so running the same import twice creates no duplicates.
- **Merging into an existing project.** Contributor IDs are mapped explicitly, and the owner confirms the mapping before anything is written.
- **Reseeding.** A closed project's bag can seed a new project, carrying the metadata needed to rebuild the folder structure.

### 12.5 Outside importers

Importers for outside sources feed the same pipeline by first producing a bag.

- **Supabase exporter (first migration tool).** Reads the current Photo Stories data from Supabase, including photos, stories, audio, people, and contributor attributions, and writes a bag. The library's importer then unpacks it into Dropbox or Google Drive.
- **Plain folder importer.** Wraps a folder of already-scanned photos, with optional sidecars, into a bag.
- **Provider-to-provider moves.** Dropbox to Drive, or either to a local folder, run as export then import.

### 12.6 Open questions for import and export

- **Large media.** Zip limits and memory use for bags with tens of gigabytes. Consider splitting into several bags, with a parent index.
- **BagIt profile.** Whether to define a small BagIt profile so the library's bags are recognizable and strictly validated.
- **Slice bags and the HTML file.** Whether slice bags carry their own browsable HTML or only the full bag does.
- **Supabase schema coverage.** Confirm every table and storage bucket the current app uses is covered by the exporter before relying on it for the migration.
