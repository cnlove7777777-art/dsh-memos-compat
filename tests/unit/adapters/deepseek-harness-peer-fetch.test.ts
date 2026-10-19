import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPeerFetch, peerFetchFailure } from "../../../adapters/deepseek-harness/peer-fetch.js";

const cleanups: Array<() => unknown> = [];
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("peer fetch proxy boundary", () => {
  it("preserves injected fetch and does not touch a global dispatcher", async () => {
    const injected = vi.fn(async () => new Response("direct"));
    const transport = createPeerFetch({ fetch: injected, env: { HTTPS_PROXY: "invalid proxy" } });
    cleanups.push(() => transport.close());
    expect(await (await transport.fetch("https://public.example.test")).text()).toBe("direct");
    expect(injected).toHaveBeenCalledOnce();
  });

  it("keeps a real LAN request direct even with an unreachable proxy", async () => {
    const url = await listen(createServer((_req, res) => res.end("LAN")));
    const transport = createPeerFetch({ env: { HTTPS_PROXY: "http://127.0.0.1:9" } });
    cleanups.push(() => transport.close());
    expect(await (await transport.fetch(url, { signal: AbortSignal.timeout(1000) })).text()).toBe("LAN");
  });

  it("uses an actual CONNECT proxy for public HTTPS, and can reopen after stop", async () => {
    const seen: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      seen.push(request.url!);
      socket.end("HTTP/1.1 502 Synthetic proxy rejection\r\nConnection: close\r\n\r\n");
    });
    const url = await listen(proxy);
    const transport = createPeerFetch({ env: { HTTPS_PROXY: url, NO_PROXY: "" } });
    cleanups.push(() => transport.close());
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(transport.fetch("https://public.example.test/", { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
      await transport.close();
    }
    expect(seen).toEqual(["public.example.test:443", "public.example.test:443"]);
  });

  it("honors NO_PROXY for a public hostname", async () => {
    const seen = vi.fn();
    const proxy = createServer();
    proxy.on("connect", (_request, socket) => { seen(); socket.end(); });
    const transport = createPeerFetch({ env: { HTTPS_PROXY: await listen(proxy), NO_PROXY: "public.example.test" } });
    cleanups.push(() => transport.close());
    await expect(transport.fetch("https://public.example.test/", { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    expect(seen).not.toHaveBeenCalled();
  });

  it("reports safe error categories without leaking nested credentials", () => {
    const error = new Error("https://user:secret@example.test?token=secret", { cause: { code: "UND_ERR_PROXY_RESPONSE_ERROR" } });
    expect(peerFetchFailure(error)).toContain("PEER_PROXY_REJECTED");
    expect(peerFetchFailure(error)).not.toMatch(/secret|example/);
  });
});
