import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveLocalModelRootForTests } from "../../../core/embedding/providers/local.js";

/**
 * The DSH build must find a locally staged MiniLM without reaching the
 * network. `@huggingface/transformers` defaults to a `models/` directory
 * beside the package, which is not where a DSH profile stages the model, so
 * the provider resolves a root explicitly.
 */
describe("embedding/local offline model root", () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "memos-model-root-"));
    previous = process.env["MEMOS_LOCAL_MODEL_ROOT"];
  });

  afterEach(() => {
    if (previous === undefined) delete process.env["MEMOS_LOCAL_MODEL_ROOT"];
    else process.env["MEMOS_LOCAL_MODEL_ROOT"] = previous;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it("prefers the explicit override when it holds the model", () => {
    process.env["MEMOS_LOCAL_MODEL_ROOT"] = root;
    fs.mkdirSync(path.join(root, "Xenova", "all-MiniLM-L6-v2"), { recursive: true });
    expect(
      resolveLocalModelRootForTests("Xenova/all-MiniLM-L6-v2"),
    ).toBe(root);
  });

  it("returns undefined when no candidate holds the model", () => {
    process.env["MEMOS_LOCAL_MODEL_ROOT"] = path.join(root, "empty");
    fs.mkdirSync(process.env["MEMOS_LOCAL_MODEL_ROOT"], { recursive: true });
    // The package-relative candidates do not ship a model, so this is undefined.
    expect(
      resolveLocalModelRootForTests("Xenova/all-MiniLM-L6-v2"),
    ).toBeUndefined();
  });
});
