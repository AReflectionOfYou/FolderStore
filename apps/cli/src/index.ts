#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { LocalAdapter } from "@folderstore/adapter-local";
import { authorizeDropbox, DropboxAdapter } from "@folderstore/adapter-dropbox";
import { authorizeGoogleDrive, GDriveAdapter } from "@folderstore/adapter-gdrive";
import { loadCredentials, saveCredentials, writeNoOverwrite, type StorageAdapter } from "@folderstore/core";

const USAGE = `Usage:
  folderstore-cli auth-dropbox --app-key <key>
  folderstore-cli auth-gdrive --client-id <id> [--client-secret <secret>]

  folderstore-cli --provider local --root <dir> list [path]
  folderstore-cli --provider dropbox [--root <dropbox-path>] list [path]
  folderstore-cli --provider gdrive --root-folder-id <id> list [path]

  ... read <path>
  ... write <path> <local-file>
  ... delete <path>
  ... changes [cursor]`;

interface Flags {
  provider?: string;
  root?: string;
  "root-folder-id"?: string;
  "app-key"?: string;
  "client-id"?: string;
  "client-secret"?: string;
}

async function buildAdapter(flags: Flags): Promise<StorageAdapter> {
  switch (flags.provider) {
    case "local": {
      if (!flags.root) throw new Error("--root is required for --provider local");
      return new LocalAdapter(flags.root);
    }
    case "dropbox": {
      const creds = await loadCredentials();
      const token = creds.dropbox?.access_token as string | undefined;
      if (!token) throw new Error("No Dropbox token. Run: auth-dropbox --app-key <key>");
      return new DropboxAdapter({ accessToken: token, root: flags.root ?? "" });
    }
    case "gdrive": {
      const creds = await loadCredentials();
      const token = creds.gdrive?.access_token as string | undefined;
      if (!token) throw new Error("No Google token. Run: auth-gdrive --client-id <id>");
      if (!flags["root-folder-id"]) throw new Error("--root-folder-id is required for --provider gdrive");
      return new GDriveAdapter({ accessToken: token, rootFolderId: flags["root-folder-id"] });
    }
    default:
      throw new Error(`Unknown or missing --provider: ${flags.provider ?? "(none)"}`);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      root: { type: "string" },
      "root-folder-id": { type: "string" },
      "app-key": { type: "string" },
      "client-id": { type: "string" },
      "client-secret": { type: "string" },
    },
  });
  const flags = values as Flags;
  const [command, ...rest] = positionals;

  if (command === "auth-dropbox") {
    if (!flags["app-key"]) throw new Error("--app-key is required");
    const token = await authorizeDropbox({ appKey: flags["app-key"] });
    const creds = await loadCredentials();
    creds.dropbox = token;
    await saveCredentials(creds);
    console.log("Dropbox authorized. Saved to .folderstore/credentials.json");
    return;
  }

  if (command === "auth-gdrive") {
    if (!flags["client-id"]) throw new Error("--client-id is required");
    const token = await authorizeGoogleDrive({
      clientId: flags["client-id"],
      clientSecret: flags["client-secret"],
    });
    const creds = await loadCredentials();
    creds.gdrive = token;
    await saveCredentials(creds);
    console.log("Google Drive authorized. Saved to .folderstore/credentials.json");
    return;
  }

  if (!command) {
    console.log(USAGE);
    return;
  }

  const adapter = await buildAdapter(flags);

  switch (command) {
    case "list": {
      const [path = ""] = rest;
      const entries = await adapter.list(path);
      for (const e of entries) {
        console.log(`${e.type === "folder" ? "d" : "-"}  ${String(e.size).padStart(10)}  ${e.modifiedAt}  ${e.path}`);
      }
      return;
    }
    case "read": {
      const [path] = rest;
      if (!path) throw new Error("usage: read <path>");
      process.stdout.write(await adapter.read(path));
      return;
    }
    case "write": {
      const [path, localFile] = rest;
      if (!path || !localFile) throw new Error("usage: write <path> <local-file>");
      const bytes = await readFile(localFile);
      const entry = await writeNoOverwrite(adapter, path, bytes);
      console.log(`Wrote ${entry.path} (${entry.size} bytes, hash ${entry.contentHash.slice(0, 12)}...)`);
      return;
    }
    case "delete": {
      const [path] = rest;
      if (!path) throw new Error("usage: delete <path>");
      await adapter.delete(path);
      console.log(`Deleted (trashed) ${path}`);
      return;
    }
    case "changes": {
      const [cursor] = rest;
      const result = await adapter.changes(cursor ?? null);
      for (const e of result.entries) console.log(`${e.modifiedAt}  ${e.path}`);
      console.log(`\ncursor: ${result.cursor}`);
      return;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
