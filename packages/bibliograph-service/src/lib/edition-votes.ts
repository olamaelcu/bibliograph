// Edition→work vote derivations for the edition detail page.
//
// Only editions vote, so these stay out of `$lib/record-page`. The wording and
// the maths live here so the page, the dock bar and the tally cannot disagree.

import type { EditionWorkStatus } from "$lib/server/edition-work-votes";
import type { EditionValue } from "$lib/types/record-detail";

/** A near-match work offered for linking; mirrors the load payload. */
export type EditionCandidate = { uri: string; title: string; year?: number };

export type EditionApplication = {
  status: "pending" | "approved" | "rejected" | "revoked";
} | null;

export type EditionFormState = {
  error?: string;
  ok?: boolean;
  applied?: string;
  requested?: boolean;
};

/** Everything the edition view needs, in one shape. */
export type EditionView = {
  rkey: string;
  value: EditionValue;
  status: EditionWorkStatus | null;
  candidates: EditionCandidate[];
  canCurate: boolean;
  application: EditionApplication;
  controversial: boolean;
  canLabel: boolean;
  loggedIn: boolean;
  form: EditionFormState | undefined;
};

export function workRkey(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

export function votesFor(
  status: EditionWorkStatus | null,
  workUri: string,
): number {
  return status?.tally.links.find((l) => l.workUri === workUri)?.count ?? 0;
}

/** Distance between the leading link vote and the unlink vote. */
export function voteMargin(status: EditionWorkStatus | null): number {
  if (!status) return 0;
  const best = status.tally.links[0]?.count ?? 0;
  return Math.abs(best - status.tally.unlinkCount);
}

/** Margin as a percentage of the consensus threshold, clamped to 0–100. */
export function voteProgress(status: EditionWorkStatus | null): number {
  if (!status || status.threshold <= 0) return 0;
  const pct = Math.round((voteMargin(status) / status.threshold) * 100);
  return Math.min(100, Math.max(0, pct));
}

export function pendingNote(status: EditionWorkStatus | null): string {
  if (!status) return "";
  const { decision, tally, threshold } = status;
  if (decision.action === "link") {
    return `Consensus reached: this edition will be linked to ${workRkey(decision.workUri)}.`;
  }
  if (decision.action === "unlink") {
    return "Consensus reached: the work link will be removed.";
  }
  if (decision.reason === "no-votes") {
    return "No votes yet.";
  }
  if (decision.reason === "already-satisfied") {
    return "The current link already has the required support.";
  }
  return `Waiting for consensus: net margin ${voteMargin(status)} of ${threshold} required.`;
}
