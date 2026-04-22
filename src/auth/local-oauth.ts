import { Notice } from "obsidian";
import type { OAuthSession } from "./oauth";

let httpModule: typeof import("http") | null = null;
try {
  httpModule = require("http");
} catch {
  // Node http not available (e.g. mobile, sandboxed)
}

export function isLocalServerAvailable(): boolean {
  return httpModule !== null;
}

export async function startLocalOAuthServer(
  decodeSession: (base64urlData: string) => OAuthSession,
  timeoutMs = 5 * 60 * 1000
): Promise<{
  url: string;
  waitForSession: () => Promise<OAuthSession>;
  cleanup: () => void;
}> {
  if (!httpModule) {
    throw new Error("Local HTTP server not available in this environment.");
  }

  const server = httpModule.createServer();
  let callbackResolver: ((session: OAuthSession) => void) | null = null;
  let callbackRejecter: ((reason: Error) => void) | null = null;
  let callbackTimer: ReturnType<typeof setTimeout> | null = null;
  let port = 0;

  const cleanup = () => {
    if (callbackTimer) {
      clearTimeout(callbackTimer);
      callbackTimer = null;
    }
    try {
      server.close();
    } catch {
      // ignore
    }
  };

  const waitForSession = (): Promise<OAuthSession> =>
    new Promise((resolve, reject) => {
      callbackResolver = resolve;
      callbackRejecter = reject;
    });

  server.on("request", (req, res) => {
    const reqUrl = req.url || "";

    // CORS preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (reqUrl.startsWith("/done")) {
      // Parse query params
      const query = new URL(reqUrl, `http://127.0.0.1:${port}`).searchParams;
      const oauthData = query.get("oauth");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authenticated</title>
<style>body{font-family:system-ui,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style>
</head><body><div style="text-align:center;"><h1>✅ Authenticated</h1><p>You can close this tab and return to Obsidian.</p></div></body></html>`);

      if (oauthData) {
        try {
          const session = decodeSession(oauthData);
          cleanup();
          callbackResolver?.(session);
        } catch (e) {
          cleanup();
          callbackRejecter?.(
            new Error(
              `Failed to decode session: ${e instanceof Error ? e.message : String(e)}`
            )
          );
        }
      } else {
        cleanup();
        callbackRejecter?.(new Error("No OAuth data received from callback."));
      }
      return;
    }

    if (reqUrl.startsWith("/callback")) {
      // Serve HTML page that reads hash and sends it back to /done
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>FreeQ OAuth</title>
<style>body{font-family:system-ui,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style>
</head><body>
<div style="text-align:center;"><h1>Connecting to Obsidian...</h1><div class="spinner" style="margin:2rem auto;width:40px;height:40px;border:4px solid #1e293b;border-top:4px solid #38bdf8;border-radius:50%;animation:spin 1s linear infinite;"></div>
<p style="color:#94a3b8;">Redirecting...</p></div>
<style>@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}</style>
<script>
(function(){
  try {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const oauth = params.get('oauth');
    if (!oauth) { document.body.innerHTML = '<div style="text-align:center;"><h1>Error</h1><p>No OAuth data found.</p></div>'; return; }
    fetch('/done?oauth=' + encodeURIComponent(oauth)).then(function(){
      document.body.innerHTML = '<div style="text-align:center;"><h1>Authenticated</h1><p style="color:#a6e3a1;">Return to Obsidian.</p></div>';
    }).catch(function(){
      document.body.innerHTML = '<div style="text-align:center;"><h1>Error</h1><p>Could not communicate with Obsidian.</p></div>';
    });
  } catch(e) {
    document.body.innerHTML = '<div style="text-align:center;"><h1>Error</h1><p>' + e.message + '</p></div>';
  }
})();
</script>
</body></html>`);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        cleanup();
        reject(new Error("Failed to bind to localhost"));
        return;
      }
      port = addr.port;
      const url = `http://127.0.0.1:${port}`;

      callbackTimer = setTimeout(() => {
        cleanup();
        callbackRejecter?.(
          new Error("OAuth callback timed out after 5 minutes")
        );
      }, timeoutMs);

      resolve({ url, waitForSession, cleanup });
    });

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}
