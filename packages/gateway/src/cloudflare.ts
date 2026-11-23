// Cloudflare Workers entry (spec section 9). All logic lives in handler.ts;
// this file only builds the gateway from the Worker's env and caches it for
// the life of the isolate, so access tokens are reused between requests.

import { buildBackend } from "./backends.js";
import { ConfigError, loadConfig, type Env } from "./config.js";
import { createGateway, type Handler } from "./handler.js";

let cached: { env: Env; handler: Handler } | null = null;

function gatewayFor(env: Env): Handler {
  if (cached?.env === env) return cached.handler;
  const handler = createGateway({ config: loadConfig(env), backend: buildBackend(env) });
  cached = { env, handler };
  return handler;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await gatewayFor(env)(request);
    } catch (err) {
      if (err instanceof ConfigError) {
        return new Response(`Gateway is not configured: ${err.message}\n`, {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      throw err;
    }
  },
};
