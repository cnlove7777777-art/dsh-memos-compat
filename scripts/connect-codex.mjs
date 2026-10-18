/** One-shot setup; the DSH plugin owns the listener and all memory maintenance. */
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const [memosHome, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), url = "http://127.0.0.1:18801/mcp"] = process.argv.slice(2);
if (!memosHome) throw new Error("Usage: node scripts/connect-codex.mjs <memos-home> [codex-home] [mcp-url]");
const endpoint = new URL(url);
if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.pathname !== "/mcp") {
  throw new Error("The Codex connection must use the local DSH /mcp endpoint");
}
const { token } = JSON.parse(await readFile(join(resolve(memosHome), ".codex-mcp.json"), "utf8"));
if (typeof token !== "string" || token.length < 32) throw new Error("Start the DSH memory plugin before connecting Codex");
const path = join(resolve(codexHome), "config.toml");
const before = await readFile(path, "utf8");
const start = "# BEGIN DSH MEMOS CONNECTION";
const end = "# END DSH MEMOS CONNECTION";
const block = `${start}\n[mcp_servers.dsh_memory]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\nstartup_timeout_sec = 10\ntool_timeout_sec = 15\nrequired = false\n${end}\n`;
let next;
if (before.includes(start)) {
  const a = before.indexOf(start); const b = before.indexOf(end, a);
  if (b < a) throw new Error("Existing connection block is incomplete; inspect config.toml");
  next = before.slice(0, a) + block + before.slice(b + end.length).replace(/^\r?\n/, "");
} else {
  if (/^\[mcp_servers\.dsh_memory(?:\.|\])/m.test(before)) throw new Error("dsh_memory already exists; preserve and inspect its configuration first");
  next = before.replace(/\s*$/, "\n\n") + block;
}
// Refuse to overwrite a concurrently edited configuration.
if (await readFile(path, "utf8") !== before) throw new Error("Codex configuration changed; rerun setup");
const temporary = `${path}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
} finally { await rm(temporary, { force: true }); }
console.log("Codex is configured for DSH memory. Existing MCP connections are preserved. Reconnect MCP or start a new Codex session to load the tools.");
