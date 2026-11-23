# FolderStore

A small, open-source storage layer that lets small collaborative apps keep
their content in one organizer's Dropbox or Google Drive folder. A tiny
serverless gateway, which the organizer deploys once, holds the only key to
that storage. Contributors use only a shared link: no account, no sign-in,
no install.

First customers: [Photo Stories](https://github.com/AReflectionOfYou/PhotoStories)
and a wedding-memories app. See [docs/spec.md](docs/spec.md) for the full design
and [docs/setup.md](docs/setup.md) for the organizer's setup recipe.

Part of the [A Reflection of You](https://github.com/AReflectionOfYou)
collection.

## How it works

```
 contributor's browser ──link token──▶  gateway (Cloudflare Worker)  ──owner token──▶  Dropbox / Google Drive
        │                                  verifies link, path, size, type                     ▲
        └──────────── large files go straight to storage via a one-time upload URL ───────────┘
```

- **Links** are signed tokens carrying a campaign, a contributor ID, and
  permissions (`upload`, `list`, `read`). The gateway checks the signature;
  there is no database.
- **Each contributor writes only in their own folder**, and **nothing is ever
  overwritten**. Deleting is organizer-only and goes to trash.
- **The folder is the database**: plain files and JSON sidecars that outlive any app.

## Status

Prototype, being rebuilt around the gateway (spec revision, November 2026).
Working and verified against a real Dropbox account on Cloudflare Workers:
the gateway, signed links, proxied and direct uploads, never-overwrite, and
the browser client. Google Drive is written but not yet tested against a
real account. Next: wiring Photo Stories and the wedding uploader to the
client, and the Supabase-to-bundle migration (spec section 15).

## Layout

- `packages/core`: the storage contract, path safety, signed link tokens,
  naming and collision handling, merge rules. Web-standard APIs only; runs
  anywhere.
- `packages/gateway`: the HTTP handler, configuration, the organizer setup
  page, a minimal contributor page, and the Cloudflare Workers entry.
- `packages/adapter-dropbox`, `packages/adapter-gdrive`: fetch-based
  adapters plus each provider's Connect flow.
- `packages/client`: the browser client apps use to talk to a gateway.
- `packages/adapter-local`: local-folder adapter for tests and development.
- `apps/dev-gateway`: runs the gateway on your machine with Node.
- `apps/cli`: makes secrets, mints and checks links, and drives the local adapter.
- `deploy/cloudflare`: `wrangler.toml` for deploying the gateway.
- `tests`: `npm test`.

## Getting started

```sh
npm install
npm test
npm run dev          # gateway on http://localhost:8787, files in ./sandbox
```

Open http://localhost:8787 and enter the admin secret the dev server prints.
Then make a link and open it to upload. To deploy for real, follow
[docs/setup.md](docs/setup.md).

## Using it from an app

Apps talk to the gateway through `@folderstore/client`. A TypeScript app
(such as Photo Stories) imports it. A plain static site (such as the
wedding uploader) uses the prebuilt file from `npm run build:client`,
`packages/client/dist/folderstore-client.js`, which is about 2.5 KB gzipped.

```js
import { FolderStoreClient, readLinkToken, timestampedName } from "./folderstore-client.js";

const token = readLinkToken();            // from the link's #fs=..., then kept in sessionStorage
const client = new FolderStoreClient({ gatewayUrl: "https://your-gateway.workers.dev", token });

const session = await client.session();   // campaign, contributor, permissions, limits

// Upload into this contributor's own folder; large files go straight to storage.
const { file, sidecar } = await client.uploadWithSidecar(
  photo,                                  // a File or Blob
  `media/${timestampedName(photo.name)}`,
  { guestName: "Aunt Rose", note: "At the reception" },
  { onProgress: (f) => (bar.value = f) },
);

if (session.permissions.includes("list")) {
  for (const entry of await client.listAll()) {
    img.src = await client.mediaUrl(entry.path);
  }
}
```

Upload paths are relative to the contributor's own folder. Paths for
listing and reading are relative to the campaign, as `list()` returns them.
Nothing is ever overwritten: when a name is taken, the file is saved under
a new name, and the result says which.

## License

Code is under the [MIT License](LICENSE). The spec and other written content
are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); see
[LICENSE-CONTENT](LICENSE-CONTENT). © 2026 Michael A. Heroux.
