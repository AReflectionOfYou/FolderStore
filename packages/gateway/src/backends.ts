// Builds the storage adapter and the moderator's Connect flow from
// configuration. Only fetch-based adapters live here, so this module runs on
// Cloudflare Workers and Vercel. The local-folder adapter is wired in by the
// Node dev server instead (apps/dev-gateway).

import { DropboxAdapter, dropboxAuthorizeUrl, dropboxExchangeCode, dropboxRefreshTokenSource } from "@folderstore/adapter-dropbox";
import { GDriveAdapter, googleAuthorizeUrl, googleExchangeCode, googleRefreshTokenSource } from "@folderstore/adapter-gdrive";
import type { StorageAdapter } from "@folderstore/core";
import { ConfigError, type Env } from "./config.js";

export interface ConnectFlow {
  /** Provider name shown to the moderator. */
  provider: string;
  authorizeUrl(redirectUri: string, state: string): string;
  exchange(code: string, redirectUri: string): Promise<{ refreshToken: string }>;
  /** Name of the secret the moderator pastes the refresh token into. */
  secretName: string;
}

export interface Backend {
  /** Null until the moderator has connected the storage account. */
  adapter: StorageAdapter | null;
  connect: ConnectFlow | null;
}

export function buildBackend(env: Env): Backend {
  const backend = env.STORAGE_BACKEND ?? "dropbox";
  if (backend === "dropbox") {
    const appKey = env.DROPBOX_APP_KEY;
    const appSecret = env.DROPBOX_APP_SECRET;
    if (!appKey || !appSecret) return { adapter: null, connect: null };
    const app = { appKey, appSecret };
    const connect: ConnectFlow = {
      provider: "Dropbox",
      secretName: "DROPBOX_REFRESH_TOKEN",
      authorizeUrl: (redirectUri, state) => dropboxAuthorizeUrl(app, redirectUri, state),
      exchange: (code, redirectUri) => dropboxExchangeCode(app, code, redirectUri),
    };
    const refreshToken = env.DROPBOX_REFRESH_TOKEN;
    const adapter = refreshToken
      ? new DropboxAdapter({ tokens: dropboxRefreshTokenSource({ ...app, refreshToken }), root: env.STORAGE_ROOT ?? "" })
      : null;
    return { adapter, connect };
  }
  if (backend === "gdrive") {
    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return { adapter: null, connect: null };
    const client = { clientId, clientSecret };
    const connect: ConnectFlow = {
      provider: "Google Drive",
      secretName: "GOOGLE_REFRESH_TOKEN",
      authorizeUrl: (redirectUri, state) => googleAuthorizeUrl(client, redirectUri, state),
      exchange: (code, redirectUri) => googleExchangeCode(client, code, redirectUri),
    };
    const refreshToken = env.GOOGLE_REFRESH_TOKEN;
    const adapter = refreshToken
      ? new GDriveAdapter({
          tokens: googleRefreshTokenSource({ ...client, refreshToken }),
          rootFolderName: env.STORAGE_ROOT || "FolderStore",
        })
      : null;
    return { adapter, connect };
  }
  if (backend === "local") {
    throw new ConfigError("STORAGE_BACKEND=local is only available from the Node dev server (npm run dev)");
  }
  throw new ConfigError(`Unknown STORAGE_BACKEND: ${backend}`);
}
