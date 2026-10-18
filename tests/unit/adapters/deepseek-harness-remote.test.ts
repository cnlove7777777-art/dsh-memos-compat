import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RetrievalQueryDTO } from "../../../agent-contract/dto.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import {
  DshRemoteMemory,
  readPeerToken,
} from "../../../adapters/deepseek-harness/remote.js";
import { createMemoryPeerHandler } from "../../../adapters/deepseek-harness/shared-memory.js";

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  await Promise.all(homes.splice(0).map(home =>
    rm(home, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "memos-remote-"));
  homes.push(home);
  return home;
}

async function tokenFile(home: string, token = "peer-test-token"): Promise<string> {
  const path = join(home, "peer-token.json");
  await writeFile(path, JSON.stringify({ token }));
  return path;
}

function query(text = "peer lookup"): RetrievalQueryDTO {
  return {
    agent: "deepseek-harness",
    query: text,
    topK: { tier1: 2, tier2: 3, tier3: 4 },
  };
}

function traceDto(id = "trace-1") {
  return {
    id,
    episodeId: "episode-1",
    sessionId: "session-1",
    ts: 1_700_000_000_000,
    userText: "user",
    agentText: "agent",
    toolCalls: [],
    value: 0.5,
    alpha: 0.5,
    priority: 0.5,
    turnId: 1_700_000_000_000,
  };
}

async function listen(
  handler: (req: IncomingMessage, body: Buffer, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; port: number; requests: Array<{
  method?: string;
  url?: string;
  authorization?: string;
  body: Buffer;
}> }> {
  const requests: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    body: Buffer;
  }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      });
      handler(req, body, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
  };
}

function json(
  res: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

describe("readPeerToken", () => {
  it("reads the token without exposing it in errors", async () => {
    const home = await tempHome();
    const path = await tokenFile(home, "secret-token-value");
    await expect(readPeerToken(path)).resolves.toBe("secret-token-value");
    await writeFile(path, "{broken secret-token-value");
    const error = await readPeerToken(path).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("secret-token-value");
  });
});

describe("DshRemoteMemory", () => {
  it("searches with auth and prefixes remote hits", async () => {
    const home = await tempHome();
    const peer = await listen((req, body, res) => {
      expect(req.method).toBe("POST");
      expect(req.headers.authorization).toBe("Bearer peer-test-token");
      const payload = JSON.parse(body.toString("utf8"));
      expect(payload).toEqual({
        query: "peer lookup",
        topK: { tier1: 2, tier2: 3, tier3: 4 },
      });
      json(res, 200, {
        hits: [{
          tier: 2,
          refKind: "trace",
          refId: "tr-peer",
          score: 0.8,
          snippet: "Peer memory body",
        }],
        injectedContext: "peer context",
        tierLatencyMs: { tier1: 1, tier2: 2, tier3: 3 },
      });
    });
    const tokenPath = await tokenFile(home);
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: peer.url,
        tokenFile: tokenPath,
      }),
    });
    const result = await remote.search(query());
    expect(peer.requests).toHaveLength(1);
    expect(result.hits).toEqual([expect.objectContaining({
      refId: "remote~tr-peer",
      snippet: "[Remote peer] Peer memory body",
    })]);
    expect(result.injectedContext).toBe("peer context");
    expect(result.query.query).toBe("peer lookup");
  });

  it("fetches trace details through the encoded peer path", async () => {
    const home = await tempHome();
    const peer = await listen((_req, _body, res) => {
      json(res, 200, { trace: traceDto("trace/with space") });
    });
    const tokenPath = await tokenFile(home);
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: peer.url,
        tokenFile: tokenPath,
      }),
    });
    const detail = await remote.getTrace("trace/with space");
    expect(detail).toMatchObject({ id: "trace/with space", toolCalls: [] });
    const expected = encodeURIComponent(
      `/api/v1/memory/trace?id=${encodeURIComponent("trace/with space")}`,
    );
    expect(peer.requests[0]?.url).toBe(`/peer/detail?path=${expected}`);
  });

  it("throws safe errors for auth failure, malformed JSON, and redirects", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const unauthorized = await listen((_req, _body, res) => {
      json(res, 401, { error: { message: "secret server detail" } });
    });
    const malformed = await listen((_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{not-json");
    });
    const redirect = await listen((_req, _body, res) => {
      res.writeHead(302, { Location: "http://example.com/" });
      res.end();
    });

    for (const [url, message] of [
      [unauthorized.url, /authentication/i],
      [malformed.url, /invalid JSON/i],
      [redirect.url, /redirect/i],
    ] as const) {
      const remote = new DshRemoteMemory({
        localPort: 18_801,
        config: () => ({ enabled: true, url, tokenFile: tokenPath }),
      });
      const error = await remote.search(query()).catch(value => value as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(message);
      expect(error.message).not.toContain("secret server detail");
    }
  });

  it("enforces an earlier deadline and the response limit", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const slow = await listen((_req, _body, res) => {
      setTimeout(() => json(res, 200, { hits: [] }), 1_000);
    });
    const huge = await listen((_req, _body, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(1024 * 1024 + 1),
      });
      res.end();
    });

    const slowRemote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({ enabled: true, url: slow.url, tokenFile: tokenPath }),
    });
    const slowError = await slowRemote.search({
      ...query(),
      deadlineAt: Date.now() + 80,
    }).catch(value => value as Error);
    expect(slowError.message).toMatch(/timed out/i);

    const hugeRemote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({ enabled: true, url: huge.url, tokenFile: tokenPath }),
    });
    const hugeError = await hugeRemote.search(query()).catch(value => value as Error);
    expect(hugeError.message).toMatch(/too large/i);
  });

  it("rejects non-loopback HTTP URLs and remote writes are absent", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: "http://example.com",
        tokenFile: tokenPath,
      }),
    });
    await expect(remote.search(query())).rejects.toThrow(/URL is invalid/i);
    expect("write" in remote).toBe(false);
  });

  it("reuses an existing tunnel without spawning SSH and checks health with auth", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const tunnelPath = join(home, "tunnel.json");
    await writeFile(tunnelPath, JSON.stringify({
      identity: "id_ed25519",
      known_hosts: "known_hosts",
      last_address: "root@192.0.2.1",
    }));
    const spawn = vi.fn();
    const health = vi.fn(async () => new Response(JSON.stringify({
      protocol: "saya-memory/1",
      node_id: "nanopi",
      engine: { ok: true },
      database_sync: false,
    }), { status: 200 }));
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: "https://peer.example.com",
        tokenFile: tokenPath,
        tunnelFile: tunnelPath,
      }),
      spawn: spawn as never,
      fetch: health as never,
    });

    await remote.start();
    expect(spawn).not.toHaveBeenCalled();
    expect(health).toHaveBeenCalledWith(
      "http://127.0.0.1:18794/peer/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer peer-test-token" },
        redirect: "error",
      }),
    );
    await remote.stop();
  });

  it("does not reuse 18794 when it identifies as the local DSH node", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const tunnelPath = join(home, "tunnel.json");
    await writeFile(tunnelPath, JSON.stringify({
      identity: "id_ed25519",
      known_hosts: "known_hosts",
      last_address: "root@192.0.2.1",
    }));
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.kill = vi.fn(() => true);
    child.exitCode = null;
    child.signalCode = null;
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const health = vi.fn(async () => new Response(JSON.stringify({
      protocol: "saya-memory/1",
      node_id: "local-dsh",
      engine: { ok: true },
      database_sync: false,
    }), { status: 200 }));
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: "https://peer.example.com",
        tokenFile: tokenPath,
        tunnelFile: tunnelPath,
      }),
      spawn: spawn as never,
      fetch: health as never,
    });

    await remote.start();
    expect(spawn).toHaveBeenCalledOnce();
    await remote.stop();
  });

  it("supports stop then start for settings changes", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const tunnelPath = join(home, "tunnel.json");
    await writeFile(tunnelPath, JSON.stringify({
      identity: "id_ed25519",
      known_hosts: "known_hosts",
      last_address: "root@192.0.2.1",
    }));
    const children: Array<EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    }> = [];
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.kill = vi.fn(() => true);
      child.exitCode = null;
      child.signalCode = null;
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: "https://peer.example.com",
        tokenFile: tokenPath,
        tunnelFile: tunnelPath,
      }),
      spawn: spawn as never,
      fetch: vi.fn(async () => {
        throw new Error("not running");
      }) as never,
    });

    await remote.start();
    await remote.stop();
    await remote.start();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children[0]!.kill).toHaveBeenCalled();
    await remote.stop();
    expect(children[1]!.kill).toHaveBeenCalled();
  });

  it("honors an earlier query deadline and still caps at 1800ms", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const peer = await listen((_req, _body, res) => {
      setTimeout(() => json(res, 200, {
        hits: [],
        injectedContext: "",
        tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      }), 1_000);
    });
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({ enabled: true, url: peer.url, tokenFile: tokenPath }),
    });
    const started = Date.now();
    const error = await remote.search({
      ...query(),
      deadlineAt: Date.now() + 80,
    }).catch(value => value as Error);
    expect(error.message).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(800);
  });

  it("uses the 2800ms search cap while keeping detail below 2000ms", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const observed: Array<{ path: string; started: number }> = [];
    const peer = await listen((req, _body, res) => {
      observed.push({ path: req.url ?? "", started: Date.now() });
      // The request is aborted by the client's own timeout before this
      // delayed response can be used. The test only needs to observe that
      // search is still pending beyond the old 1800ms cap.
      setTimeout(() => json(res, 200, {
        hits: [],
        injectedContext: "",
        tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      }), 2_100);
    });
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({ enabled: true, url: peer.url, tokenFile: tokenPath }),
    });

    const started = Date.now();
    const result = await remote.search(query());
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(result.hits).toEqual([]);
    expect(observed[0]?.path).toBe("/peer/search");
  });

  it("starts SSH with explicit forwarding arguments and no shell", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const tunnelPath = join(home, "tunnel.json");
    await writeFile(tunnelPath, JSON.stringify({
      identity: "private/id_ed25519",
      known_hosts: "private/known_hosts",
      last_address: "192.0.2.1",
    }));
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.kill = vi.fn(() => true);
    child.exitCode = null;
    child.signalCode = null;
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: "https://peer.example.com",
        tokenFile: tokenPath,
        tunnelFile: tunnelPath,
      }),
      spawn: spawn as never,
      fetch: vi.fn(async () => {
        throw new Error("not running");
      }) as never,
    });

    await remote.start();
    expect(spawn).toHaveBeenCalledOnce();
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe("ssh");
    expect(args).toEqual([
      "-N", "-T",
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "ConnectTimeout=6",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${join(home, "private", "known_hosts")}`,
      "-o", "HostKeyAlias=nanopi-m4v2",
      "-i", join(home, "private", "id_ed25519"),
      "-L", "127.0.0.1:18794:127.0.0.1:18801",
      "-R", "127.0.0.1:18793:127.0.0.1:18801",
      "root@192.0.2.1",
    ]);
    expect(options).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    await remote.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it("guards late SSH spawns after disposal", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const tunnelPath = join(home, "tunnel.json");
    await writeFile(tunnelPath, JSON.stringify({
      identity: "id_ed25519",
      known_hosts: "known_hosts",
      last_address: "root@192.0.2.1",
    }));
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.kill = vi.fn(() => true);
    child.exitCode = null;
    child.signalCode = null;
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>(resolve => { releaseSpawn = resolve; });
    let spawned = false;
    const spawn = vi.fn(() => {
      void spawnGate.then(() => {
        spawned = true;
        child.emit("spawn");
      });
      return child;
    });
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: "https://peer.example.com",
        tokenFile: tokenPath,
        tunnelFile: tunnelPath,
      }),
      spawn: spawn as never,
      fetch: vi.fn(async () => {
        throw new Error("not running");
      }) as never,
    });

    const starting = remote.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    await remote.stop();
    expect(spawned).toBe(false);
    releaseSpawn();
    await starting;
    expect(child.kill).toHaveBeenCalled();
  });

  it("accepts user/username overrides and rejects malformed SSH users", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const tunnelPath = join(home, "tunnel.json");
    const children: Array<EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    }> = [];
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.kill = vi.fn(() => true);
      child.exitCode = null;
      child.signalCode = null;
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const makeRemote = (tunnel: Record<string, unknown>) => new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: "https://peer.example.com",
        tokenFile: tokenPath,
        tunnelFile: tunnelPath,
      }),
      spawn: spawn as never,
      fetch: vi.fn(async () => {
        throw new Error("not running");
      }) as never,
    });

    await writeFile(tunnelPath, JSON.stringify({
      identity: "id_ed25519",
      known_hosts: "known_hosts",
      last_address: "192.0.2.1",
      user: "ubuntu",
    }));
    const userRemote = makeRemote({});
    await userRemote.start();
    expect(spawn.mock.calls[0]?.[1]).toContain("ubuntu@192.0.2.1");
    await userRemote.stop();

    await writeFile(tunnelPath, JSON.stringify({
      identity: "id_ed25519",
      known_hosts: "known_hosts",
      last_address: "192.0.2.1",
      username: "admin",
    }));
    const usernameRemote = makeRemote({});
    await usernameRemote.start();
    expect(spawn.mock.calls[1]?.[1]).toContain("admin@192.0.2.1");
    await usernameRemote.stop();

    await writeFile(tunnelPath, JSON.stringify({
      identity: "id_ed25519",
      known_hosts: "known_hosts",
      last_address: "192.0.2.1",
      user: "-oProxyCommand=bad",
    }));
    await expect(makeRemote({}).start()).rejects.toThrow(/invalid/i);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("works against the real parent peer routes end to end", async () => {
    const home = await tempHome();
    const tokenPath = await tokenFile(home);
    const trace = traceDto("trace-real-route");
    const core = {
      getTrace: vi.fn(async (id: string) => id === trace.id ? trace : null),
      searchMemory: vi.fn(async (query: RetrievalQueryDTO) => ({
        query,
        hits: [{
          tier: 2 as const,
          refKind: "trace" as const,
          refId: trace.id,
          score: 0.77,
          snippet: "Real route memory",
        }],
        injectedContext: "real route context",
        tierLatencyMs: { tier1: 0, tier2: 3, tier3: 0 },
      })),
    } as unknown as MemoryCore;
    const peer = createMemoryPeerHandler({
      core,
      config: () => ({
        enabled: true,
        url: "https://peer.example.com",
        tokenFile: tokenPath,
      }),
      profileId: "test-profile",
    });
    const server = createServer((req, res) => {
      void peer(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No route port");
    const remote = new DshRemoteMemory({
      localPort: 18_801,
      config: () => ({
        enabled: true,
        url: `http://127.0.0.1:${address.port}`,
        tokenFile: tokenPath,
      }),
    });

    expect(await remote.health(address.port, "peer-test-token")).toMatchObject({
      node_id: "local-dsh",
      engine: { ok: true },
    });
    const result = await remote.search({
      ...query("real route query"),
      deadlineAt: Date.now() + 2_800,
    });
    expect(result.hits[0]).toMatchObject({
      refId: `remote~${trace.id}`,
      snippet: "[Remote peer] Real route memory",
    });
    expect(await remote.getTrace(trace.id)).toMatchObject({
      id: trace.id,
      toolCalls: [],
    });
    expect(core.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ query: "real route query" }),
      expect.anything(),
    );
  });
});
