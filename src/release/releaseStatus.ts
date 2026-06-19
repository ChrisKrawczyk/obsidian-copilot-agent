export type ReleaseStep =
  | "not-started"
  | "files-prepared"
  | "commit-created"
  | "tag-created"
  | "tag-pushed"
  | "workflow-running"
  | "workflow-complete"
  | "release-published";

export type WorkflowConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "timed_out"
  | "action_required"
  | null;

export interface ReleaseProbeInput {
  /** Current branch name (e.g. "main"). */
  branch: string;
  /** True if the working tree has uncommitted changes. */
  treeDirty: boolean;
  /** Result of comparing the relevant files (package.json, manifest.json, versions.json, CHANGELOG.md) against `targetVersion`. */
  filesAtTargetVersion: boolean;
  /** True if a commit with subject `chore(release): v<targetVersion>` exists in branch history. */
  bumpCommitPresent: boolean;
  /** True if the local annotated tag `v<targetVersion>` exists. */
  localTagPresent: boolean;
  /** True if the remote tag `v<targetVersion>` exists on origin. */
  remoteTagPresent: boolean;
  /**
   * Latest GitHub Actions release workflow run for the target tag:
   *  - undefined: no run found
   *  - status "queued" | "in_progress" | "completed"
   *  - conclusion (only when status === "completed")
   */
  workflowRun?: { status: "queued" | "in_progress" | "completed"; conclusion: WorkflowConclusion };
  /** True if a GitHub Release named `v<targetVersion>` (or `<targetVersion>`) exists. */
  releasePublished: boolean;
}

export interface ReleaseStatus {
  version: string;
  step: ReleaseStep;
  next_action: string;
  blockers: string[];
}

export function deriveReleaseStatus(
  targetVersion: string,
  probe: ReleaseProbeInput,
): ReleaseStatus {
  const blockers: string[] = [];

  if (probe.releasePublished) {
    return {
      version: targetVersion,
      step: "release-published",
      next_action: "none",
      blockers,
    };
  }

  if (probe.workflowRun?.status === "completed") {
    if (probe.workflowRun.conclusion === "success") {
      return {
        version: targetVersion,
        step: "workflow-complete",
        next_action: "verify-release",
        blockers,
      };
    }
    blockers.push(
      `release workflow concluded "${probe.workflowRun.conclusion ?? "unknown"}"; see ci-monitor recovery menu`,
    );
    return {
      version: targetVersion,
      step: "workflow-complete",
      next_action: "recover-from-workflow-failure",
      blockers,
    };
  }

  if (
    probe.workflowRun?.status === "queued" ||
    probe.workflowRun?.status === "in_progress"
  ) {
    return {
      version: targetVersion,
      step: "workflow-running",
      next_action: "wait-for-workflow",
      blockers,
    };
  }

  if (probe.remoteTagPresent) {
    return {
      version: targetVersion,
      step: "tag-pushed",
      next_action: "wait-for-workflow",
      blockers,
    };
  }

  if (probe.localTagPresent) {
    return {
      version: targetVersion,
      step: "tag-created",
      next_action: "push-tag",
      blockers,
    };
  }

  if (probe.bumpCommitPresent) {
    return {
      version: targetVersion,
      step: "commit-created",
      next_action: "create-tag",
      blockers,
    };
  }

  if (probe.filesAtTargetVersion) {
    if (probe.treeDirty) {
      return {
        version: targetVersion,
        step: "files-prepared",
        next_action: "commit-bump",
        blockers,
      };
    }
    // Files are at target version but the tree is clean and no bump commit exists yet:
    // this is the "files match but were never staged" edge case (manual edit).
    blockers.push(
      `package.json/manifest.json/versions.json are at ${targetVersion} but no \`chore(release): v${targetVersion}\` commit was found`,
    );
    return {
      version: targetVersion,
      step: "files-prepared",
      next_action: "commit-bump",
      blockers,
    };
  }

  return {
    version: targetVersion,
    step: "not-started",
    next_action: "run-release-prepare",
    blockers,
  };
}
