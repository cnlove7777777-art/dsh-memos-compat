import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import semver from "semver";

/**
 * The DSH build must be installable on every 0.2.x prerelease, and the peer
 * ranges must not silently exclude them.
 *
 * node-semver only lets a prerelease satisfy a range when some comparator
 * shares its exact `major.minor.patch` tuple and itself carries a prerelease
 * tag. A broad-looking `>=0.1.0-rc.5 <0.2.0` therefore excludes
 * `0.2.1-rc.2`, which is the exact failure this build exists to fix.
 */
describe("dsh engine range", () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  ) as {
    engines: Record<string, string>;
    dsh: { bundle: { patch: string } };
    peerDependencies: Record<string, string>;
  };

  const dshVersions = [
    "0.2.1-alpha.1",
    "0.2.1-rc.2",
    "0.2.2",
    "0.2.1",
    "0.3.0",
    "0.1.0-rc.6",
    "0.2.0-rc.1",
  ];

  it("declares an engines.dsh range", () => {
    expect(manifest.engines.dsh).toBeTruthy();
  });

  it("accepts every 0.2.x prerelease and stable build", () => {
    for (const version of dshVersions) {
      const expected = semver.gte(version, "0.2.1-alpha.1") && semver.lt(version, "0.3.0-0");
      expect(
        semver.satisfies(version, manifest.engines.dsh),
        `${version} vs engines.dsh ${manifest.engines.dsh}`,
      ).toBe(expected);
    }
  });

  it("keeps every @deepseek-ai/dsh-* peer range matching the runtime", () => {
    const peers = Object.entries(manifest.peerDependencies).filter(([name]) =>
      name.startsWith("@deepseek-ai/dsh"),
    );
    expect(peers.length).toBeGreaterThan(0);
    for (const [name, range] of peers) {
      expect(
        semver.satisfies("0.2.1-rc.2", range),
        `${name}@${range} excludes the 0.2.1-rc.2 runtime`,
      ).toBe(true);
    }
  });

  it("declares the bundle manifest DSH requires to install the plugin", () => {
    expect(manifest.dsh?.bundle?.patch).toBeTruthy();
  });
});
