// The write path for edition→work votes.
//
// A vote is two steps that must not drift apart:
//   1. publish `editionWorkLink` into the voter's own repo (the durable, public,
//      attributable artifact), then
//   2. mirror it into `edition_work_votes` and re-run consensus so the catalog
//      and the UI reflect it immediately.
//
// Step 2 is downstream of step 1 on purpose: if the repo write fails we must not
// record a vote that no one can see in the user's repo. TAP will re-deliver the
// same record later, and both steps are idempotent, so a duplicate delivery
// cannot double-count.

import { eq } from 'drizzle-orm';
import { db as defaultDb } from '$lib/server/db';
import { editions, works } from '$lib/server/db/schema';
import type { DbExecutor } from '$lib/server/stats';
import {
  EDITION_WORK_LINK_COLLECTION,
  applyConsensus,
  consensusThreshold,
  parseEditionWorkVote,
  upsertVote,
  voteRkeyForEdition,
  type AppliedConsensus,
  type VoteAction,
} from './edition-work-votes';
import { putUserRecord } from './auth/oauth';

export class VoteError extends Error {
  constructor(
    readonly code: 'edition-not-found' | 'work-not-found' | 'invalid-vote',
    message: string,
  ) {
    super(message);
    this.name = 'VoteError';
  }
}

export interface SubmitVoteInput {
  did: string;
  editionRkey: string;
  action: VoteAction;
  /** Required when `action` is 'link'. */
  workUri?: string;
  now?: Date;
}

export interface SubmitVoteResult {
  recordUri: string;
  editionUri: string;
  consensus: AppliedConsensus;
}

export async function submitEditionWorkVote(
  input: SubmitVoteInput,
  db: DbExecutor = defaultDb,
): Promise<SubmitVoteResult> {
  const [edition] = await db
    .select({ uri: editions.uri, cid: editions.cid })
    .from(editions)
    .where(eq(editions.rkey, input.editionRkey));
  if (!edition) throw new VoteError('edition-not-found', `No edition with rkey ${input.editionRkey}`);

  let work: { uri: string; cid: string } | undefined;
  if (input.action === 'link') {
    if (!input.workUri) throw new VoteError('invalid-vote', 'A link vote needs a work');
    [work] = await db
      .select({ uri: works.uri, cid: works.cid })
      .from(works)
      .where(eq(works.uri, input.workUri));
    if (!work) throw new VoteError('work-not-found', `No work at ${input.workUri}`);
  }

  const now = input.now ?? new Date();
  const record: Record<string, unknown> = {
    $type: EDITION_WORK_LINK_COLLECTION,
    edition: { uri: edition.uri, cid: edition.cid },
    action: input.action,
    createdAt: now.toISOString(),
  };
  if (work) record.work = { uri: work.uri, cid: work.cid };

  const rkey = voteRkeyForEdition(edition.uri);
  const written = await putUserRecord(input.did, EDITION_WORK_LINK_COLLECTION, rkey, record);

  const vote = parseEditionWorkVote(written.uri, input.did, record);
  if (!vote) throw new VoteError('invalid-vote', 'Refusing to record a vote that failed validation');

  await upsertVote(vote, now, db);
  const consensus = await applyConsensus(edition.uri, consensusThreshold(), db);

  return { recordUri: written.uri, editionUri: edition.uri, consensus };
}
