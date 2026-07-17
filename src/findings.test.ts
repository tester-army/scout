import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendFinding,
  createFinding,
  parseCategory,
  parseSeverity,
  readFindings,
  severityRank,
  updateFindingStatus,
  validateFindingInput,
} from "./findings.js";

describe("parseSeverity / parseCategory", () => {
  it("accepts valid values", () => {
    expect(parseSeverity("HIGH")).toBe("high");
    expect(parseCategory("Auth")).toBe("auth");
  });

  it("rejects invalid values", () => {
    expect(() => parseSeverity("urgent")).toThrow(/--severity must be one of/);
    expect(() => parseCategory("bug")).toThrow(/--category must be one of/);
  });
});

describe("severityRank", () => {
  it("ranks critical above info", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("info"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("medium"));
  });
});

describe("validateFindingInput", () => {
  it("requires endpoint and title", () => {
    expect(() => validateFindingInput({ severity: "high", category: "auth", title: "x" })).toThrow(
      /--endpoint/,
    );
    expect(() =>
      validateFindingInput({ severity: "high", category: "auth", endpoint: "GET /a" }),
    ).toThrow(/--title/);
  });

  it("returns normalized values", () => {
    expect(
      validateFindingInput({
        severity: "High",
        category: "AUTH",
        endpoint: " GET /a ",
        title: " boom ",
      }),
    ).toEqual({ severity: "high", category: "auth", endpoint: "GET /a", title: "boom" });
  });
});

describe("deterministic findings", () => {
  it("deduplicates repeated mechanical findings and preserves lifecycle status", () => {
    const cwd = mkdtempSync(join(tmpdir(), "scout-findings-"));
    mkdirSync(join(cwd, ".scout"));
    try {
      const input = {
        source: "sweep" as const,
        severity: "high" as const,
        category: "auth" as const,
        endpoint: "GET /admin",
        title: "Potential auth bypass",
        status: "candidate" as const,
      };
      const first = createFinding(input);
      const repeated = createFinding(input);

      expect(repeated.id).toBe(first.id);
      expect(appendFinding(first, cwd).created).toBe(true);
      expect(appendFinding(repeated, cwd).created).toBe(false);
      expect(readFindings(cwd)).toHaveLength(1);

      expect(updateFindingStatus(first.id, "dismissed", cwd).status).toBe("dismissed");
      expect(appendFinding(repeated, cwd).finding.status).toBe("dismissed");
      expect(readFindings(cwd)).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("collapses the same contract issue across probe kinds (different repro)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "scout-findings-"));
    mkdirSync(join(cwd, ".scout"));
    try {
      const base = {
        source: "sweep" as const,
        severity: "medium" as const,
        category: "contract-violation" as const,
        endpoint: "GET /v1/ai-gateway/rules",
        title: "Undocumented status 404",
      };
      // Same finding seen on happy-path, no-auth, invalid-auth probes.
      const a = createFinding({ ...base, repro: "scout call GET /v1/ai-gateway/rules" });
      const b = createFinding({ ...base, repro: "scout call GET /v1/ai-gateway/rules --no-auth" });
      const c = createFinding({
        ...base,
        repro: "scout call GET /v1/ai-gateway/rules --invalid-auth",
      });

      expect(b.id).toBe(a.id);
      expect(c.id).toBe(a.id);
      expect(appendFinding(a, cwd).created).toBe(true);
      expect(appendFinding(b, cwd).created).toBe(false);
      expect(appendFinding(c, cwd).created).toBe(false);
      expect(readFindings(cwd)).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("records and clears a dismiss reason across transitions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "scout-findings-"));
    mkdirSync(join(cwd, ".scout"));
    try {
      const finding = createFinding({
        source: "sweep",
        severity: "high",
        category: "auth",
        endpoint: "GET /admin",
        title: "Potential auth bypass",
      });
      appendFinding(finding, cwd);

      const dismissed = updateFindingStatus(finding.id, "dismissed", cwd, undefined, "known WIP");
      expect(dismissed.dismissReason).toBe("known WIP");

      const reconfirmed = updateFindingStatus(finding.id, "confirmed", cwd);
      expect(reconfirmed.dismissReason).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws when lifecycle id is unknown", () => {
    const cwd = mkdtempSync(join(tmpdir(), "scout-findings-"));
    mkdirSync(join(cwd, ".scout"));
    try {
      expect(() => updateFindingStatus("missing", "confirmed", cwd)).toThrow(/not found/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
