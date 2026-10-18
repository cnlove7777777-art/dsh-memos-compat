/**
 * DSH Session V4 message-source typing.
 *
 * DSH 0.2.x retired the `{ kind: "plugin", plugin: id }` wrapper: a
 * producer now owns its whole `kind` string, so a plugin's source reads
 * `{ kind: \`plugin:${id}\` }`. The type union is documented as
 * merge-extensible ("plugins add their own `kind`s"), but the
 * `@deepseek-ai/dsh-llm` build this package develops against still
 * declares the closed three-member union, so `tsc` rejects the new form.
 *
 * This module augments that map with the producer-owned kinds MemOS emits.
 * It is a type-only declaration and produces no runtime output.
 */

import type { ContextFormed } from "@deepseek-ai/dsh-llm";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    /** MemOS recall injection, produced under the harness adapter's own name. */
    "plugin:memos-local-memory": {
      kind: "plugin:memos-local-memory";
    } & ContextFormed;
  }
}
