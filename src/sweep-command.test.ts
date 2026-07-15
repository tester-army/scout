import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutorContext } from "./http-executor.js";
import { runSweepCommand } from "./sweep-command.js";
import { runSweep } from "./sweep-engine.js";

vi.mock("./http-executor.js", () => ({ createExecutorContext: vi.fn() }));
vi.mock("./sweep-engine.js", () => ({ runSweep: vi.fn() }));

describe("runSweepCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createExecutorContext).mockReturnValue({
      operations: [
        {
          method: "get",
          path: "/pets",
          tags: ["pets"],
          deprecated: false,
          secured: false,
          authParameters: [],
          parameters: [],
          responses: {},
        },
      ],
      policy: { allowMutations: false, rateLimit: 5, budget: 20 },
    } as ReturnType<typeof createExecutorContext>);
  });

  it("rejects explicit filters matching no operations", async () => {
    await expect(runSweepCommand({ tag: "missing", json: true })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runSweep).not.toHaveBeenCalled();
  });
});
