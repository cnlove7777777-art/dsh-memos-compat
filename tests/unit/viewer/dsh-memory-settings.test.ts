import { describe, expect, it } from "vitest";

import {
  buildDshSavePayload,
  buildDshTestPayload,
  classifyDshCapabilityFailure,
} from "../../../viewer/src/components/dsh-memory-settings-payload";

describe("DSH memory settings payloads", () => {
  it("saves follow without stale provider or model fields", () => {
    expect(buildDshSavePayload({ mode: "follow" })).toEqual({
      mode: "follow",
    });
  });

  it("saves fixed routes as an atomic provider/model pair", () => {
    expect(
      buildDshSavePayload({
        mode: "fixed",
        provider: "magpie",
        model: "group/mid",
      }),
    ).toEqual({
      mode: "fixed",
      provider: "magpie",
      model: "group/mid",
    });
  });

  it("adds a temporary test-only route when no session route exists", () => {
    expect(
      buildDshTestPayload(
        { mode: "follow" },
        { provider: " magpie ", model: " group/mid " },
      ),
    ).toEqual({
      mode: "follow",
      testProvider: "magpie",
      testModel: "group/mid",
    });
  });

  it("does not attach test fields to a fixed selection", () => {
    expect(
      buildDshTestPayload(
        { mode: "fixed", provider: "provider-a", model: "model-a" },
        { provider: "provider-b", model: "model-b" },
      ),
    ).toEqual({
      mode: "fixed",
      provider: "provider-a",
      model: "model-a",
    });
  });

  it("requires both temporary fields for a follow test", () => {
    expect(
      buildDshTestPayload(
        { mode: "follow" },
        { provider: "magpie", model: " " },
      ),
    ).toEqual({ mode: "follow" });
  });

  it("treats 404 as an optional capability miss only for non-DSH agents", () => {
    expect(classifyDshCapabilityFailure(404, "openclaw")).toBe("unavailable");
    expect(classifyDshCapabilityFailure(404, "hermes")).toBe("unavailable");
  });

  it("keeps DSH 404 and unknown-agent failures visible", () => {
    expect(classifyDshCapabilityFailure(404, "deepseek-harness")).toBe("error");
    expect(classifyDshCapabilityFailure(404, undefined)).toBe("error");
    expect(classifyDshCapabilityFailure(500, "openclaw")).toBe("error");
  });
});
