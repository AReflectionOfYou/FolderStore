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
Working and tested locally: the gateway, signed links, the local-folder
adapter, the dev server, and the CLI. The Dropbox adapter is tested against
a mocked API. Dropbox and Google Drive are not yet verified against real
accounts; spec section 15 lists the tracer-bullet steps that will do that.

## Layout

- `packages/core`: the storage contract, path safety, signed link tokens,
  naming and collision handling, merge rules. Web-standard APIs only; runs
  anywhere.
- `packages/gateway`: the HTTP handler, configuration, the organizer setup
  page, a minimal contributor page, and the Cloudflare Workers entry.
- `packages/adapter-dropbox`, `packages/adapter-gdrive`: fetch-based
  adapters plus each provider's Connect flow.
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

## License

Code is under the [MIT License](LICENSE). The spec and other written content
are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); see
[LICENSE-CONTENT](LICENSE-CONTENT). © 2026 Michael A. Heroux.
