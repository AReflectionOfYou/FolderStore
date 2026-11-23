// The moderator's one-time Google Connect step (spec section 7.2), done
// through the gateway. Uses the narrow drive.file scope: the gateway sees
// only files and folders it created. drive.file is a non-sensitive scope, so
// an OAuth client published "In production" needs no Google verification
// and its refresh tokens do not expire after seven days.

import { ProviderError, type TokenSource } from "@folderstore/core";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleClientCredentials {
  clientId: string;
  clientSecret: string;
}

export function googleAuthorizeUrl(client: GoogleClientCredentials, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_FILE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function googleExchangeCode(
  client: GoogleClientCredentials,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string }> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) {
    throw new ProviderError(`Google did not return a refresh token: ${body.error_description ?? res.status}`, res.status);
  }
  return { refreshToken: body.refresh_token };
}

export function googleRefreshTokenSource(
  client: GoogleClientCredentials & { refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): TokenSource {
  let cached: { token: string; expiresAt: number } | null = null;
  return {
    async getAccessToken(force = false) {
      if (!force && cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
      const res = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: client.refreshToken,
          grant_type: "refresh_token",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
      if (!res.ok || !body.access_token) {
        cached = null;
        throw new ProviderError(`Google token refresh failed: ${body.error_description ?? res.status}`, res.status);
      }
      cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
      return cached.token;
    },
  };
}
