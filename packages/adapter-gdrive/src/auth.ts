import { runPkceOAuth, type TokenResponse } from "@folderstore/core";

export interface GoogleAuthOptions {
  clientId: string;
  /** Google's "Desktop app" OAuth client type doesn't need one; "Web application" does. */
  clientSecret?: string;
}

/**
 * Runs Google's PKCE flow for one contributor's own account (spec section 3)
 * after they've accepted the moderator's native Drive share. Uses the narrow
 * drive.file scope per spec section 6 — whether that scope alone sees a
 * folder shared by someone else, or needs the contributor to pick it once
 * via the Drive UI/picker first, is the open question in docs/spec.md section 11.
 */
export async function authorizeGoogleDrive(opts: GoogleAuthOptions): Promise<TokenResponse> {
  return runPkceOAuth({
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scope: "https://www.googleapis.com/auth/drive.file",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  });
}
