import { describe, it, expect } from "vitest";
import { deriveReleaseStatus, type ReleaseProbeInput } from "./releaseStatus";

const baseProbe = (overrides: Partial<ReleaseProbeInput> = {}): ReleaseProbeInput => ({
  branch: "main",
  treeDirty: false,
  filesAtTargetVersion: false,
  bumpCommitPresent: false,
  localTagPresent: false,
  remoteTagPresent: false,
  workflowRun: undefined,
  releasePublished: false,
  ...overrides,
});

describe("deriveReleaseStatus", () => {
  it("returns not-started when nothing has happened", () => {
    const r = deriveReleaseStatus("0.6.0", baseProbe());
    expect(r.step).toBe("not-started");
    expect(r.next_action).toBe("run-release-prepare");
    expect(r.blockers).toEqual([]);
    expect(r.version).toBe("0.6.0");
  });

  it("returns files-prepared when files mutated and tree is dirty", () => {
    const r = deriveReleaseStatus("0.6.0", baseProbe({ filesAtTargetVersion: true, treeDirty: true }));
    expect(r.step).toBe("files-prepared");
    expect(r.next_action).toBe("commit-bump");
    expect(r.blockers).toEqual([]);
  });

  it("returns files-prepared with a blocker if files match target version on a clean tree with no bump commit", () => {
    const r = deriveReleaseStatus(
      "0.6.0",
      baseProbe({ filesAtTargetVersion: true, treeDirty: false, bumpCommitPresent: false }),
    );
    expect(r.step).toBe("files-prepared");
    expect(r.blockers.length).toBe(1);
    expect(r.blockers[0]).toMatch(/no `chore\(release\)/);
  });

  it("returns commit-created when bump commit exists but no tag", () => {
    const r = deriveReleaseStatus("0.6.0", baseProbe({ filesAtTargetVersion: true, bumpCommitPresent: true }));
    expect(r.step).toBe("commit-created");
    expect(r.next_action).toBe("create-tag");
  });

  it("returns tag-created when local tag exists but not pushed", () => {
    const r = deriveReleaseStatus(
      "0.6.0",
      baseProbe({ filesAtTargetVersion: true, bumpCommitPresent: true, localTagPresent: true }),
    );
    expect(r.step).toBe("tag-created");
    expect(r.next_action).toBe("push-tag");
  });

  it("returns tag-pushed when remote tag exists but no workflow run", () => {
    const r = deriveReleaseStatus(
      "0.6.0",
      baseProbe({
        filesAtTargetVersion: true,
        bumpCommitPresent: true,
        localTagPresent: true,
        remoteTagPresent: true,
      }),
    );
    expect(r.step).toBe("tag-pushed");
    expect(r.next_action).toBe("wait-for-workflow");
  });

  it("returns workflow-running for queued/in_progress workflow", () => {
    for (const status of ["queued", "in_progress"] as const) {
      const r = deriveReleaseStatus(
        "0.6.0",
        baseProbe({
          filesAtTargetVersion: true,
          bumpCommitPresent: true,
          localTagPresent: true,
          remoteTagPresent: true,
          workflowRun: { status, conclusion: null },
        }),
      );
      expect(r.step).toBe("workflow-running");
      expect(r.next_action).toBe("wait-for-workflow");
    }
  });

  it("returns workflow-complete + verify on successful workflow", () => {
    const r = deriveReleaseStatus(
      "0.6.0",
      baseProbe({
        filesAtTargetVersion: true,
        bumpCommitPresent: true,
        localTagPresent: true,
        remoteTagPresent: true,
        workflowRun: { status: "completed", conclusion: "success" },
      }),
    );
    expect(r.step).toBe("workflow-complete");
    expect(r.next_action).toBe("verify-release");
    expect(r.blockers).toEqual([]);
  });

  it("returns workflow-complete + recover on failed workflow with blocker", () => {
    const r = deriveReleaseStatus(
      "0.6.0",
      baseProbe({
        filesAtTargetVersion: true,
        bumpCommitPresent: true,
        localTagPresent: true,
        remoteTagPresent: true,
        workflowRun: { status: "completed", conclusion: "failure" },
      }),
    );
    expect(r.step).toBe("workflow-complete");
    expect(r.next_action).toBe("recover-from-workflow-failure");
    expect(r.blockers.length).toBe(1);
    expect(r.blockers[0]).toMatch(/concluded "failure"/);
  });

  it("returns release-published when GitHub Release exists (terminal)", () => {
    const r = deriveReleaseStatus(
      "0.6.0",
      baseProbe({
        filesAtTargetVersion: true,
        bumpCommitPresent: true,
        localTagPresent: true,
        remoteTagPresent: true,
        workflowRun: { status: "completed", conclusion: "success" },
        releasePublished: true,
      }),
    );
    expect(r.step).toBe("release-published");
    expect(r.next_action).toBe("none");
  });
});
