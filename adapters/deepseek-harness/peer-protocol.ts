/** Shared authentication for the private peer listener and the HTTPS gateway. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

export const PEER_PROTOCOL = "saya-memory/2";
export const MAX_PEER_BYTES = 1024 * 1024;
export const PEER_PORT = 18802;

export function isPrivateAddress(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return address === "::1" || /^(fc|fd|fe[89ab])/i.test(address) && isIP(address.split("%")[0]) === 6;
}

export function peerBaseUrl(input: string): URL {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { throw new Error("Invalid peer URL"); }
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === "https:" || url.protocol === "http:" &&
      (isPrivateAddress(url.hostname) || url.hostname === "localhost")) ||
    !["/", "/peer", "/peer/", "/desktop/api/memory-peer", "/desktop/api/memory-peer/"].includes(url.pathname)) {
    throw new Error("Use HTTPS for a public peer or a private LAN address");
  }
  return url;
}

export function peerUrl(base: string, route: string): URL {
  const url = peerBaseUrl(base);
  const prefix = url.pathname.replace(/\/$/, "");
  const mount = prefix || (url.protocol === "https:" ? "/desktop/api/memory-peer" : "/peer");
  url.pathname = mount + route.slice(5).split("?")[0];
  url.search = route.includes("?") ? route.slice(route.indexOf("?")) : "";
  return url;
}

export function validNodeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value);
}

function signature(key: string, method: string, route: string, body: string,
  node: string, timestamp: string, nonce: string): string {
  return createHmac("sha256", key).update([PEER_PROTOCOL, method, route, timestamp, nonce, node,
    createHash("sha256").update(body).digest("hex")].join("\n")).digest("hex");
}

export function signPeerRequest(key: string, node: string, method: string, route: string, body = "",
  now = Date.now(), nonce = randomBytes(16).toString("hex")): Record<string, string> {
  const timestamp = String(now);
  return { "X-Memory-Node": node, "X-Memory-Time": timestamp, "X-Memory-Nonce": nonce,
    "X-Memory-Signature": signature(key, method, route, body, node, timestamp, nonce) };
}

export class PeerReplayGuard {
  private seen = new Map<string, number>();
  verify(key: string, method: string, route: string, body: string, headers: IncomingHttpHeaders,
    expectedNode?: string, now = Date.now()): string | undefined {
    const node = headers["x-memory-node"], timestamp = headers["x-memory-time"],
      nonce = headers["x-memory-nonce"], supplied = headers["x-memory-signature"];
    if (!validNodeId(node) || expectedNode && expectedNode !== node || typeof timestamp !== "string" ||
      !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 ||
      typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce) ||
      typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)) return undefined;
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
    const identity = `${node}:${nonce}`;
    if (this.seen.has(identity) || this.seen.size >= 4096) return undefined;
    const expected = signature(key, method, route, body, node, timestamp, nonce);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"))) return undefined;
    this.seen.set(identity, now + 60_000);
    return node;
  }
}

export function handshakeProof(key: string, challenge: string, nodeId: string): string {
  return createHmac("sha256", key).update(`${PEER_PROTOCOL}\n${challenge}\n${nodeId}`).digest("hex");
}

export function peerResponseProof(key: string, nonce: string, nodeId: string, status: number, body: string): string {
  return createHmac("sha256", key).update([PEER_PROTOCOL, nonce, nodeId, String(status),
    createHash("sha256").update(body).digest("hex")].join("\n")).digest("hex");
}

export async function readPeerJson(response: Response, proof?: { key: string; nonce: string; expectedNode?: string }): Promise<unknown> {
  if (Number(response.headers.get("content-length") || 0) > MAX_PEER_BYTES) {
    await response.body?.cancel(); throw new Error("Peer response is too large");
  }
  if (!response.body) throw new Error("Empty peer response");
  const reader = response.body.getReader(); const parts: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_PEER_BYTES) { await reader.cancel(); throw new Error("Peer response is too large"); }
      parts.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(parts).toString("utf8");
  if (proof) {
    const node = response.headers.get("X-Memory-Node"), supplied = response.headers.get("X-Memory-Response-Signature");
    if (!validNodeId(node) || proof.expectedNode && proof.expectedNode !== node ||
      !supplied || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, "hex"),
      Buffer.from(peerResponseProof(proof.key, proof.nonce, node, response.status, text), "hex"))) {
      throw new Error("Peer response authentication failed");
    }
  }
  return JSON.parse(text);
}
