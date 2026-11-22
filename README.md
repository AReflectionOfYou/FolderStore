# FolderStore

A small, open-source library that lets small collaborative apps use a shared
folder in Dropbox, Google Drive, or a local folder as their data store, with
no database backend. First customer: the
[Photo Stories](https://github.com/AReflectionOfYou/PhotoStories) app.

See [docs/spec.md](docs/spec.md) for the full design.

Part of the [A Reflection of You](https://github.com/AReflectionOfYou)
collection.

## Status

Early prototype. The storage contract, a local-folder adapter, a Dropbox
adapter, and a Google Drive adapter exist; the cloud adapters are structurally
complete but not yet exercised against real accounts (see docs/spec.md,
section 11, for the open questions that prototyping is meant to answer).

## Layout

- `packages/core` — the storage contract, types, and the shared logic (hash,
  naming/collision handling, merge rules, OAuth helper, credential storage).
  Adapters are deliberately dumb; this is where the smart part lives.
- `packages/adapter-local` — local-folder adapter. No external dependencies.
- `packages/adapter-dropbox` — Dropbox adapter.
- `packages/adapter-gdrive` — Google Drive adapter.
- `apps/cli` — a command-line tool for exercising list/read/write/delete/changes
  against any adapter, and for running the OAuth flows.
- `apps/web` — a minimal local web app with the same operations, for a more
  visual way to poke at an adapter.

## Getting started

See [docs/setup.md](docs/setup.md) for registering a Dropbox app or a Google
Drive OAuth client before connecting those adapters.

```sh
npm install

# Local adapter — no account needed
npm run cli -- --provider local --root ./sandbox list
npm run cli -- --provider local --root ./sandbox write hello.txt ./README.md
npm run cli -- --provider local --root ./sandbox list

# Dropbox — see docs/setup.md for how to register an app and get an app key
npm run cli -- auth-dropbox --app-key <your-app-key>
npm run cli -- --provider dropbox --root /FolderStoreTest list

# Google Drive — see docs/setup.md for how to register an OAuth client
npm run cli -- auth-gdrive --client-id <your-client-id> --client-secret <your-client-secret>
npm run cli -- --provider gdrive --root-folder-id <a-drive-folder-id> list

# Web prototype
npm run web
# then open http://localhost:4848
```

Tokens from `auth-dropbox` / `auth-gdrive` are saved to `.folderstore/credentials.json`
in the current directory (gitignored) and used by both the CLI and the web app.

## License

Code is under the [MIT License](LICENSE). The spec and other written content
are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); see
[LICENSE-CONTENT](LICENSE-CONTENT). © 2026 Michael A. Heroux.
