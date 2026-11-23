// The moderator's one-time Connect step (spec section 7.1), done through the
// gateway in a browser. Dropbox apps are confidential clients here: the app
// secret lives in the gateway's secret store, so no PKCE is needed.

import { ProviderError, type TokenSource } from "@folderstore/core";

export interface DropboxAppCredentials {
  appKey: string;
  appSecret: string;
}

export function dropboxAuthorizeUrl(app: DropboxAppCredentials, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: app.appKey,
    response_type: "code",
    token_access_type: "offline",
    redirect_uri: redirectUri,
    state,
  });
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

export interface DropboxConnectResult {
  refreshToken: string;
  accountId?: string;
}

export async function dropboxExchangeCode(
  app: DropboxAppCredentials,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DropboxConnectResult> {
  const res = await fetchImpl("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      client_id: app.appKey,
      client_secret: app.appSecret,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; account_id?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) {
    throw new ProviderError(`Dropbox did not return a refresh token: ${body.error_description ?? res.status}`, res.status);
  }
  return { refreshToken: body.refresh_token, accountId: body.account_id };
}

/**
 * Exchanges the long-lived refresh token for short-lived (about 4 hour)
 * access tokens, caching one in memory for as long as the runtime keeps
 * this object alive.
 */
export function dropboxRefreshTokenSource(
  app: DropboxAppCredentials & { refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): TokenSource {
  let cached: { token: string; expiresAt: number } | null = null;
  return {
    async getAccessToken(force = false) {
      if (!force && cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
      const res = await fetchImpl("https://api.dropboxapi.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: app.refreshToken,
          client_id: app.appKey,
          client_secret: app.appSecret,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
      if (!res.ok || !body.access_token) {
        cached = null;
        throw new ProviderError(`Dropbox token refresh failed: ${body.error_description ?? res.status}`, res.status);
      }
      cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 14400) * 1000 };
      return cached.token;
    },
  };
}
