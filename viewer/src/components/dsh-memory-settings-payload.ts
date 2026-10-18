export type DshMemorySelection =
  | { mode: "follow" }
  | { mode: "fixed"; provider: string; model: string };

export function buildDshSavePayload(
  selection: DshMemorySelection,
): DshMemorySelection {
  return selection.mode === "follow"
    ? { mode: "follow" }
    : {
        mode: "fixed",
        provider: selection.provider,
        model: selection.model,
      };
}

/**
 * A follow selection normally tests the owning conversation's captured route.
 * When no session is active, the API accepts a temporary provider/model pair
 * that is used only for this test and never saved.
 */
export function buildDshTestPayload(
  selection: DshMemorySelection,
  testRoute?: { provider?: string; model?: string },
): DshMemorySelection & {
  testProvider?: string;
  testModel?: string;
} {
  const payload = buildDshSavePayload(selection);
  if (
    payload.mode !== "follow" ||
    !testRoute?.provider?.trim() ||
    !testRoute.model?.trim()
  ) {
    return payload;
  }
  return {
    ...payload,
    testProvider: testRoute.provider.trim(),
    testModel: testRoute.model.trim(),
  };
}

/**
 * The optional settings endpoint exists only on DSH. A 404 is an expected
 * capability miss only after the Viewer has identified a non-DSH agent; on a
 * DSH agent it is a server/API failure and must not reveal standalone model
 * cards as if they controlled this installation.
 */
export function classifyDshCapabilityFailure(
  status: number | undefined,
  agent: string | undefined | null,
): "unavailable" | "error" {
  return status === 404 && !!agent && agent !== "deepseek-harness"
    ? "unavailable"
    : "error";
}
