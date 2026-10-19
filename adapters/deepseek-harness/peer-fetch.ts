/** Per-client proxy transport for public HTTPS peers. */
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { isPrivateAddress } from "./peer-protocol.js";

export type PeerFetch = typeof globalThis.fetch;
export type PeerFetchEnv = Readonly<Record<string, string | undefined>>;

export function peerFetchFailure(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    const code = typeof value.code === "string" ? value.code.toUpperCase() : "";
    if (code.includes("TIMEOUT") || value.name === "TimeoutError") return "Remote peer timed out (PEER_PROXY_TIMEOUT)";
    if (/CERT|TLS|SSL/.test(code)) return "Remote peer TLS failed (PEER_PROXY_TLS)";
    if (/PROXY/.test(code)) return "Remote proxy rejected the request (PEER_PROXY_REJECTED)";
    if (/ECONN|ENOTFOUND|EAI_AGAIN|EHOST|ENET|UND_ERR_CONNECT|UND_ERR_SOCKET/.test(code)) {
      return "Remote peer network unavailable (PEER_PROXY_CONNECT)";
    }
    current = value.cause ?? (Array.isArray(value.errors) ? value.errors[0] : undefined);
  }
  return "Remote peer unavailable or timed out (PEER_PROXY_NETWORK)";
}

function proxySettings(env: PeerFetchEnv): { httpsProxy?: string; noProxy?: string } {
  const httpsProxy = (env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY)?.trim();
  const noProxy = (env.no_proxy ?? env.NO_PROXY ?? "")?.trim();
  return httpsProxy ? { httpsProxy, noProxy } : {};
}

/**
 * Creates request-local proxy ownership. LAN peers always use the direct
 * fetch. Public HTTPS uses undici's env-aware dispatcher only when a proxy is
 * configured. Injected fetches stay usable in deterministic tests.
 */
export function createPeerFetch(options: { fetch?: PeerFetch; env?: PeerFetchEnv } = {}): {
  fetch: PeerFetch;
  close(): Promise<void>;
} {
  const direct = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const config = proxySettings(env);
  if (options.fetch || !config.httpsProxy) return { fetch: direct, close: async () => {} };

  let proxy: EnvHttpProxyAgent | undefined;
  const fallback = undiciFetch as unknown as PeerFetch;
  return {
    fetch: (async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.protocol !== "https:" || isPrivateAddress(target.hostname) || target.hostname === "localhost") {
        return direct(input, init);
      }
      proxy ??= new EnvHttpProxyAgent(config);
      return fallback(input, { ...init, dispatcher: proxy } as RequestInit & { dispatcher: EnvHttpProxyAgent });
    }) as PeerFetch,
    close: async () => { const owned = proxy; proxy = undefined; await owned?.destroy(); },
  };
}
