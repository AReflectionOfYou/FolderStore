import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";

export interface PkceOAuthOptions {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
  port?: number;
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  [key: string]: unknown;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tryOpenBrowser(url: string): void {
  if (process.platform !== "darwin") return;
  exec(`open "${url}"`, () => {
    // best-effort only; the URL is printed either way
  });
}

/**
 * Runs an OAuth 2.0 Authorization Code + PKCE flow against a localhost
 * redirect, for a one-time, moderator- or contributor-driven sign-in (spec
 * section 3). Prints the authorization URL and also tries to open it.
 */
export async function runPkceOAuth(opts: PkceOAuthOptions): Promise<TokenResponse> {
  const port = opts.port ?? 53682;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authUrl = new URL(opts.authUrl);
  authUrl.searchParams.set("client_id", opts.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", opts.scope);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  for (const [key, value] of Object.entries(opts.extraAuthParams ?? {})) {
    authUrl.searchParams.set(key, value);
  }

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        error
          ? `<p>Authorization failed: ${error}. You can close this tab.</p>`
          : "<p>Authorization complete. You can close this tab.</p>",
      );
      server.close();
      if (error) {
        reject(new Error(`OAuth error: ${error}`));
      } else if (returnedState !== state || !returnedCode) {
        reject(new Error("OAuth state mismatch or missing code"));
      } else {
        resolve(returnedCode);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Open this URL to authorize (opening it for you if possible):\n${authUrl.toString()}\n`);
      tryOpenBrowser(authUrl.toString());
    });
  });

  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: opts.clientId,
    code_verifier: verifier,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
    ...(opts.extraTokenParams ?? {}),
  });

  const response = await fetch(opts.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}
