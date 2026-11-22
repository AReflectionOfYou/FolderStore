import { runPkceOAuth, type TokenResponse } from "@folderstore/core";

export interface DropboxAuthOptions {
  /** The app key from https://www.dropbox.com/developers/apps — no app secret needed for PKCE. */
  appKey: string;
}

/**
 * Runs Dropbox's PKCE flow for one contributor's own account (spec section
 * 3) after they've accepted the moderator's native shared-folder invite.
 * `token_access_type: offline` asks for a refresh token too.
 */
export async function authorizeDropbox(opts: DropboxAuthOptions): Promise<TokenResponse> {
  return runPkceOAuth({
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    clientId: opts.appKey,
    scope: "files.metadata.read files.metadata.write files.content.read files.content.write",
    extraAuthParams: { token_access_type: "offline" },
  });
}
