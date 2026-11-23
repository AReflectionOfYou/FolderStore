#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { LocalAdapter } from "@folderstore/adapter-local";
import { normalizePath, randomId, signLink, verifyLink, writeNoOverwrite, type Permission } from "@folderstore/core";

const USAGE = `Usage:
  folderstore secrets
      Print a fresh SIGNING_KEY and ADMIN_SECRET to paste into the gateway's secrets.

  folderstore mint-link --campaign <slug> --contributor <slug>
                        [--perms upload,list,read] [--label <text>] [--expires-days <n>] [--app-url <url>]
      Sign a contributor link offline. Reads SIGNING_KEY and LINK_GENERATIONS from the environment.

  folderstore verify-link <token>
      Check a link token against SIGNING_KEY and print its claims.

  folderstore --root <dir> list [path] | read <path> | write <path> <local-file> | delete <path> | changes [cursor]
      Exercise the local-folder adapter directly.`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      campaign: { type: "string" },
      contributor: { type: "string" },
      perms: { type: "string" },
      label: { type: "string" },
      "expires-days": { type: "string" },
      "app-url": { type: "string" },
    },
  });
  const [command, ...rest] = positionals;

  switch (command) {
    case "secrets": {
      console.log(`SIGNING_KEY=${randomId(32)}`);
      console.log(`ADMIN_SECRET=${randomId(18)}`);
      return;
    }
    case "mint-link": {
      const key = requireEnv("SIGNING_KEY");
      const campaign = values.campaign ?? fail("--campaign is required");
      const contributor = values.contributor ?? fail("--contributor is required");
      const permissions = (values.perms ?? "upload").split(",").map((p) => p.trim()) as Permission[];
      const generations = process.env.LINK_GENERATIONS ? JSON.parse(process.env.LINK_GENERATIONS) : {};
      const days = values["expires-days"] ? Number(values["expires-days"]) : undefined;
      const token = await signLink(
        {
          campaign,
          contributor,
          permissions,
          generation: generations[campaign] ?? 1,
          label: values.label,
          expiresAt: days ? Math.floor(Date.now() / 1000) + Math.round(days * 86400) : undefined,
        },
        key,
      );
      console.log(values["app-url"] ? `${values["app-url"]}#fs=${token}` : token);
      return;
    }
    case "verify-link": {
      const [token] = rest;
      if (!token) fail("usage: verify-link <token>");
      const generations = process.env.LINK_GENERATIONS ? JSON.parse(process.env.LINK_GENERATIONS) : {};
      const result = await verifyLink(token.replace(/^.*#fs=/, ""), requireEnv("SIGNING_KEY"), { generations });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case undefined:
      console.log(USAGE);
      return;
  }

  if (!values.root) fail(`Unknown command "${command}". ${USAGE}`);
  const adapter = new LocalAdapter(values.root);
  switch (command) {
    case "list": {
      const path = normalizePath(rest[0] ?? "", { allowRoot: true });
      for (const e of await adapter.list(path)) {
        console.log(`${e.type === "folder" ? "d" : "-"}  ${String(e.size).padStart(10)}  ${e.modifiedAt}  ${e.path}`);
      }
      return;
    }
    case "read": {
      process.stdout.write(await adapter.read(normalizePath(rest[0] ?? fail("usage: read <path>"))));
      return;
    }
    case "write": {
      const [path, localFile] = rest;
      if (!path || !localFile) fail("usage: write <path> <local-file>");
      const entry = await writeNoOverwrite(adapter, normalizePath(path), await readFile(localFile));
      console.log(`Wrote ${entry.path} (${entry.size} bytes, sha256 ${entry.contentHash.slice(0, 12)}...)`);
      return;
    }
    case "delete": {
      const path = normalizePath(rest[0] ?? fail("usage: delete <path>"));
      await adapter.delete(path);
      console.log(`Moved to trash: ${path}`);
      return;
    }
    case "changes": {
      const result = await adapter.changes(rest[0] ?? null);
      for (const e of result.entries) console.log(`${e.modifiedAt}  ${e.path}`);
      console.log(`\ncursor: ${result.cursor}`);
      return;
    }
    default:
      fail(`Unknown command "${command}". ${USAGE}`);
  }
}

function requireEnv(name: string): string {
  return process.env[name] ?? fail(`${name} must be set in the environment`);
}

function fail(message: string): never {
  throw new Error(message);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
