import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `agit import --no-redact` and the `share`/`pr` gate that follows it
 * (issue #70, the redaction-controls request). Redaction is a fixed pattern
 * list applied unconditionally at import (SPEC §8) — this adds an explicit
 * opt-out for it, and refuses to hand that unredacted session to anyone else
 * (share/pr) unless the opt-out is repeated with --allow-unredacted.
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SIMPLE = join(ROOT, "fixtures", "claude-code", "simple.jsonl");

function agit(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function freshStore(): string {
  return mkdtempSync(join(tmpdir(), "agit-no-redact-"));
}

describe("agit import --no-redact", () => {
  it("stores the session verbatim: no [REDACTED:...] markers, and says so", () => {
    const store = freshStore();
    const r = agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("redacted    SKIPPED (--no-redact)");
    const jsonl = readFileSync(
      join(store, ".agit", "sessions", "fixture-simple-0001", "events.jsonl"),
      "utf8",
    );
    expect(jsonl).not.toContain("REDACTED");
    const meta = JSON.parse(
      readFileSync(join(store, ".agit", "sessions", "fixture-simple-0001", "meta.json"), "utf8"),
    ) as { redactionSkipped?: boolean; redactions: Record<string, number> };
    expect(meta.redactionSkipped).toBe(true);
    expect(meta.redactions).toEqual({});
  });

  it("a normal import (no flag) still redacts, and carries no redactionSkipped marker", () => {
    const store = freshStore();
    expect(agit(["import", SIMPLE, "--dir", store]).code).toBe(0);
    const jsonl = readFileSync(
      join(store, ".agit", "sessions", "fixture-simple-0001", "events.jsonl"),
      "utf8",
    );
    expect(jsonl).toContain("REDACTED:anthropic-key");
    const meta = JSON.parse(
      readFileSync(join(store, ".agit", "sessions", "fixture-simple-0001", "meta.json"), "utf8"),
    ) as { redactionSkipped?: boolean };
    expect(meta.redactionSkipped).toBeUndefined();
  });

  it("show reports the skip plainly", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    const text = agit(["show", "fixture-simple-0001", "--dir", store]);
    expect(text.out).toContain("redactions  SKIPPED at import (--no-redact)");
  });

  it("pr refuses an unredacted session without --allow-unredacted", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    const r = agit(["pr", "fixture-simple-0001", "--dir", store, "--out", join(store, "bundle")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("never scanned for credentials");
    expect(r.out).toContain("--allow-unredacted");
  });

  it("pr proceeds with --allow-unredacted", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    const r = agit([
      "pr",
      "fixture-simple-0001",
      "--dir",
      store,
      "--out",
      join(store, "bundle"),
      "--allow-unredacted",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("handoff bundle for fixture-simple-0001");
  });

  it("pr on a normally-redacted session needs no flag at all", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--dir", store]);
    const r = agit(["pr", "fixture-simple-0001", "--dir", store, "--out", join(store, "bundle")]);
    expect(r.code).toBe(0);
  });

  it("share (static, from the store) refuses an unredacted session before touching the network", () => {
    const store = freshStore();
    agit(["import", SIMPLE, "--no-redact", "--dir", store]);
    // No relay is running; a refusal here proves the gate runs before any
    // network call, not that the relay happened to be reachable.
    const r = agit(["share", "fixture-simple-0001", "--static", "--dir", store]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("never scanned for credentials");
  });
});
