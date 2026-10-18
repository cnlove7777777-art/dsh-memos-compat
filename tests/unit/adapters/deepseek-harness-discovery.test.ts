import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { RemoteInfo, Socket } from "node:dgram";
import type { createSocket } from "node:dgram";
import type { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PeerDiscovery,
  type PeerCandidate,
} from "../../../adapters/deepseek-harness/discovery.js";

const DISCOVERY_PORT = 18_802;
const MULTICAST = "239.255.77.77";
const KEY = "synthetic-discovery-key-32-bytes";

interface SentDatagram {
  bytes: Buffer;
  port: number;
  address: string;
}

interface FakeOwner {
  address: string;
  discoveryPort: number;
}

class FakeSocket extends EventEmitter {
  readonly sent: SentDatagram[] = [];
  readonly addMembership = vi.fn();
  readonly setBroadcast = vi.fn();
  readonly setMulticastInterface = vi.fn();
  readonly unref = vi.fn();
  bindOptions: Record<string, unknown> | undefined;
  closed = false;

  constructor(
    private readonly network: FakeNetwork | undefined,
    readonly owner: FakeOwner,
    private readonly failBind = false,
  ) {
    super();
  }

  bind(options: Record<string, unknown>): void {
    this.bindOptions = options;
    queueMicrotask(() => {
      if (this.failBind) this.emit("error", new Error("bind failed"));
      else this.emit("listening");
    });
  }

  send(
    bytes: Buffer,
    offset: number,
    length: number,
    port: number,
    address: string,
    callback: (error?: Error | null) => void,
  ): void {
    const copy = Buffer.from(bytes.subarray(offset, offset + length));
    this.sent.push({ bytes: copy, port, address });
    this.network?.send(this, copy, port, address);
    callback();
  }

  close(callback?: () => void): void {
    if (this.closed) throw new Error("already closed");
    this.closed = true;
    this.network?.remove(this);
    queueMicrotask(() => callback?.());
  }

  asSocket(): Socket {
    return this as unknown as Socket;
  }
}

class FakeNetwork {
  private readonly sockets: FakeSocket[] = [];

  create(owner: FakeOwner, failBind = false): FakeSocket {
    const socket = new FakeSocket(this, owner, failBind);
    this.sockets.push(socket);
    return socket;
  }

  remove(socket: FakeSocket): void {
    const index = this.sockets.indexOf(socket);
    if (index >= 0) this.sockets.splice(index, 1);
  }

  send(source: FakeSocket, bytes: Buffer, port: number, address: string): void {
    for (const target of this.sockets) {
      if (target === source || target.closed) continue;
      const broadcast = address === MULTICAST ||
        address.endsWith(".255") ||
        address === target.owner.address;
      if (!broadcast || target.owner.discoveryPort !== port) continue;
      const remote: RemoteInfo = {
        address: source.owner.address,
        family: "IPv4",
        port: source.owner.discoveryPort,
        size: bytes.byteLength,
      };
      target.emit("message", Buffer.from(bytes), remote);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PeerDiscovery", () => {
  it("probes every private interface via multicast and bounded directed broadcast", async () => {
    const network = new FakeNetwork();
    const sockets: FakeSocket[] = [];
    const interval = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    vi.spyOn(globalThis, "setInterval").mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const onPeer = vi.fn<(peer: PeerCandidate) => void>();

    const discovery = new PeerDiscovery({
      nodeId: "node-alpha",
      port: 18_802,
      key: async () => KEY,
      onPeer,
      interfaces: (() => ({
        lan0: [{
          address: "192.168.50.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:01",
          internal: false,
          cidr: "192.168.50.10/24",
        }],
        lan1: [{
          address: "10.20.0.7",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:02",
          internal: false,
          cidr: "10.20.0.7/16",
        }],
        loopback: [{
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        }],
        public: [{
          address: "203.0.113.9",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:03",
          internal: false,
          cidr: "203.0.113.9/24",
        }],
      })) as unknown as typeof networkInterfaces,
      socketFactory: (() => {
        const socket = network.create({
          address: "192.168.50.10",
          discoveryPort: DISCOVERY_PORT,
        });
        sockets.push(socket);
        return socket.asSocket();
      }) as unknown as typeof createSocket,
    });

    await discovery.start();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.bindOptions).toMatchObject({
      address: "0.0.0.0",
      port: DISCOVERY_PORT,
      exclusive: false,
    });
    expect(sockets[0]?.unref).toHaveBeenCalledTimes(1);
    expect(interval.unref).toHaveBeenCalledTimes(1);
    expect(sockets[0]?.addMembership.mock.calls).toEqual([
      [MULTICAST, "192.168.50.10"],
      [MULTICAST, "10.20.0.7"],
    ]);
    expect(sockets[0]?.setMulticastInterface.mock.calls).toEqual([
      ["192.168.50.10"],
      ["10.20.0.7"],
    ]);
    expect(sockets[0]?.sent.map(value => value.address)).toEqual([
      MULTICAST,
      "192.168.50.255",
      MULTICAST,
      "10.20.255.255",
    ]);

    for (const sent of sockets[0]?.sent ?? []) {
      const raw = sent.bytes.toString("utf8");
      expect(raw).not.toContain(KEY);
      const message = JSON.parse(raw) as Record<string, unknown>;
      expect(message).toMatchObject({
        protocol: "dsh-memos-discovery/1",
        kind: "probe",
        nodeId: "node-alpha",
        port: 18_802,
      });
      expect(message).not.toHaveProperty("url");
      expect(message["sig"]).toEqual(expect.any(String));
    }
    expect(onPeer).not.toHaveBeenCalled();

    await discovery.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    expect(sockets[0]?.closed).toBe(true);
  });

  it("discovers a peer through nonce response matching and derives URL from the source address", async () => {
    const network = new FakeNetwork();
    const alphaSocket = network.create({
      address: "192.168.1.10",
      discoveryPort: DISCOVERY_PORT,
    });
    const betaSocket = network.create({
      address: "192.168.1.11",
      discoveryPort: DISCOVERY_PORT,
    });
    const alphaPeers = vi.fn<(peer: PeerCandidate) => void>();
    const betaPeers = vi.fn<(peer: PeerCandidate) => void>();

    const alpha = new PeerDiscovery({
      nodeId: "alpha",
      port: 18_802,
      key: async () => KEY,
      onPeer: alphaPeers,
      interfaces: privateInterface("192.168.1.10"),
      socketFactory: (() => alphaSocket.asSocket()) as unknown as typeof createSocket,
    });
    const beta = new PeerDiscovery({
      nodeId: "beta",
      port: 18_802,
      key: async () => KEY,
      onPeer: betaPeers,
      interfaces: privateInterface("192.168.1.11"),
      socketFactory: (() => betaSocket.asSocket()) as unknown as typeof createSocket,
    });

    await alpha.start();
    await beta.start();
    await settle();

    expect(alpha.snapshot()).toEqual([{
      nodeId: "beta",
      url: "http://192.168.1.11:18802",
      lastSeenAt: expect.any(Number),
    }]);
    expect(beta.snapshot()).toEqual([{
      nodeId: "alpha",
      url: "http://192.168.1.10:18802",
      lastSeenAt: expect.any(Number),
    }]);
    expect(alphaPeers).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: "beta",
      url: "http://192.168.1.11:18802",
    }));
    expect(betaPeers).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: "alpha",
      url: "http://192.168.1.10:18802",
    }));

    await alpha.stop();
    await beta.stop();
  });

  it("rejects forged, stale, self, invalid-port and URL-bearing announcements", async () => {
    const network = new FakeNetwork();
    const socket = network.create({
      address: "192.168.1.10",
      discoveryPort: DISCOVERY_PORT,
    });
    const onPeer = vi.fn<(peer: PeerCandidate) => void>();
    let now = 1_800_000_000_000;
    const discovery = new PeerDiscovery({
      nodeId: "alpha",
      port: 18_802,
      key: async () => KEY,
      onPeer,
      interfaces: privateInterface("192.168.1.10"),
      socketFactory: (() => socket.asSocket()) as unknown as typeof createSocket,
      now: () => now,
    });
    await discovery.start();

    inject(socket, probe("forged", "forged-nonce-0001", now, "wrong-key"), "192.168.1.20");
    inject(socket, probe("stale", "stale-nonce-00001", now - 61_000, KEY), "192.168.1.21");
    inject(socket, probe("alpha", "self-nonce-000001", now, KEY), "192.168.1.22");
    inject(socket, probe("bad-port", "bad-port-nonce-01", now, KEY, 0), "192.168.1.23");
    inject(socket, {
      ...probeObject("url-claim", "url-nonce-0000001", now, 18_802),
      url: "http://attacker.invalid:18802",
      sig: signature(probeObject("url-claim", "url-nonce-0000001", now, 18_802), KEY),
    }, "192.168.1.24");
    inject(socket, probe("public-source", "public-nonce-0001", now, KEY), "203.0.113.25");
    inject(socket, probe("valid", "valid-nonce-00001", now, KEY), "192.168.1.25");
    await settle();

    expect(onPeer).toHaveBeenCalledTimes(1);
    expect(onPeer).toHaveBeenCalledWith({
      nodeId: "valid",
      url: "http://192.168.1.25:18802",
      lastSeenAt: now,
    });
    expect(discovery.snapshot().map(peer => peer.nodeId)).toEqual(["valid"]);

    inject(socket, probe("replay", "replay-nonce-0001", now, KEY), "192.168.1.26");
    const replay = socket.sent.at(-1)?.bytes;
    expect(replay).toBeDefined();
    if (replay !== undefined) {
      socket.emit("message", replay, remote("192.168.1.26"));
    }
    now += 1;
    await settle();
    expect(onPeer).toHaveBeenCalledTimes(2);
    expect(discovery.snapshot().map(peer => peer.nodeId).sort()).toEqual(["replay", "valid"]);

    await discovery.stop();
  });

  it("times out a candidate when no later probe is seen", async () => {
    const network = new FakeNetwork();
    const socket = network.create({
      address: "192.168.1.10",
      discoveryPort: DISCOVERY_PORT,
    });
    let now = 1_800_000_000_000;
    const discovery = new PeerDiscovery({
      nodeId: "alpha",
      port: 18_802,
      key: async () => KEY,
      onPeer: vi.fn(),
      interfaces: privateInterface("192.168.1.10"),
      socketFactory: (() => socket.asSocket()) as unknown as typeof createSocket,
      now: () => now,
    });
    await discovery.start();
    inject(socket, probe("beta", "ttl-nonce-0000001", now, KEY), "192.168.1.11");
    await settle();
    expect(discovery.snapshot()).toHaveLength(1);

    now += 120_000;
    expect(discovery.snapshot()).toEqual([]);
    await discovery.stop();
  });

  it("degrades when binding fails and can stop and restart cleanly", async () => {
    const network = new FakeNetwork();
    let failBind = true;
    let created = 0;
    const sockets: FakeSocket[] = [];
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const discovery = new PeerDiscovery({
      nodeId: "restartable",
      port: 18_802,
      key: async () => KEY,
      onPeer: vi.fn(),
      interfaces: privateInterface("10.0.0.5"),
      socketFactory: (() => {
        created += 1;
        const socket = network.create({
          address: "10.0.0.5",
          discoveryPort: DISCOVERY_PORT,
        }, failBind);
        sockets.push(socket);
        return socket.asSocket();
      }) as unknown as typeof createSocket,
    });

    await expect(discovery.start()).resolves.toBeUndefined();
    expect(created).toBe(1);
    expect(sockets[0]?.closed).toBe(true);
    expect(timer.unref).toHaveBeenCalledTimes(1);

    failBind = false;
    await discovery.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);

    await discovery.start();
    expect(created).toBe(2);
    expect(sockets[1]?.sent.length).toBeGreaterThan(0);
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);

    await discovery.stop();
    expect(sockets[1]?.closed).toBe(true);
    const sentBeforeScan = sockets[1]?.sent.length ?? 0;
    await discovery.scan();
    expect(sockets[1]?.sent).toHaveLength(sentBeforeScan);

    await discovery.start();
    expect(created).toBe(3);
    expect(discovery.snapshot()).toEqual([]);
    await discovery.stop();
    expect(sockets[2]?.closed).toBe(true);
  });
});

function privateInterface(address: string): typeof networkInterfaces {
  return (() => ({
    lan: [{
      address,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:01",
      internal: false,
      cidr: `${address}/24`,
    }],
  })) as unknown as typeof networkInterfaces;
}

function inject(socket: FakeSocket, bytes: Buffer, address: string): void {
  socket.emit("message", bytes, remote(address));
}

function remote(address: string): RemoteInfo {
  return {
    address,
    family: "IPv4",
    port: DISCOVERY_PORT,
    size: 0,
  };
}

function probe(
  nodeId: string,
  nonce: string,
  ts: number,
  key: string,
  port = 18_802,
): Buffer {
  const value = probeObject(nodeId, nonce, ts, port);
  return Buffer.from(JSON.stringify({
    ...value,
    sig: signature(value, key),
  }));
}

function probeObject(
  nodeId: string,
  nonce: string,
  ts: number,
  port: number,
): {
  protocol: string;
  kind: "probe";
  nodeId: string;
  port: number;
  nonce: string;
  ts: number;
} {
  return {
    protocol: "dsh-memos-discovery/1",
    kind: "probe",
    nodeId,
    port,
    nonce,
    ts,
  };
}

function signature(value: object, key: string): string {
  return createHmac("sha256", key)
    .update(JSON.stringify(value))
    .digest("base64url");
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
