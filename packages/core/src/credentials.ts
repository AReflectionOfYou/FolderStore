import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type StoredCredentials = Record<string, Record<string, unknown>>;

const DEFAULT_PATH = join(process.cwd(), ".folderstore", "credentials.json");

export async function loadCredentials(path: string = DEFAULT_PATH): Promise<StoredCredentials> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return {};
  }
}

export async function saveCredentials(
  creds: StoredCredentials,
  path: string = DEFAULT_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2), "utf8");
}
