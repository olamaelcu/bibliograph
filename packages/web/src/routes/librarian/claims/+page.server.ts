/**
 * The librarian queue.
 *
 * Two reads (pending claims, current bindings) and three writes (approve, reject,
 * revoke) — all through the worker's loopback admin API, because the catalog
 * writes and the queues they feed live there. This page decides; the worker
 * transcribes.
 */

import { fail, redirect } from '@sveltejs/kit';
import type { ActionFailure } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { workerAdminGet, workerAdminPost } from '$lib/server/admin/worker';
import { requireLibrarian } from '$lib/server/librarian/session';

/** One undecided claim, as the worker answers it. */
type PendingClaim = {
  uri: string;
  did: string;
  contributorUri: string | null;
  message: string | null;
  createdAt: string | null;
  name: string | null;
  contributorAtUri: string | null;
};

/** One verified binding. */
type Identity = {
  did: string;
  uri: string | null;
  issuedBy: string | null;
  createdAt: string;
  name: string;
  contributor: string;
};

/** What a decision answers instead of redirecting: a message for the page. */
type DecideFailure = ActionFailure<{ message: string }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** One entry of a worker `{ items: [...] }` body, or null when it is not one. */
function pendingClaimOf(value: unknown): PendingClaim | null {
  if (!isObject(value)) return null;
  const uri = text(value.uri);
  const did = text(value.did);
  if (uri === null || did === null) return null;
  return {
    uri,
    did,
    contributorUri: text(value.contributorUri),
    message: text(value.message),
    createdAt: text(value.createdAt),
    name: text(value.name),
    contributorAtUri: text(value.contributorAtUri)
  };
}

function identityOf(value: unknown): Identity | null {
  if (!isObject(value)) return null;
  const did = text(value.did);
  const name = text(value.name);
  const contributor = text(value.contributor);
  const createdAt = text(value.createdAt);
  if (did === null || name === null || contributor === null || createdAt === null) return null;
  return {
    did,
    uri: text(value.uri),
    issuedBy: text(value.issuedBy),
    createdAt,
    name,
    contributor
  };
}

/** The `items` array of a worker body, mapped through `read`; a bad entry is dropped. */
function itemsOf<T>(payload: unknown, read: (value: unknown) => T | null): T[] {
  if (!isObject(payload)) return [];
  const items = payload.items;
  if (!Array.isArray(items)) return [];
  return items.map(read).filter((item): item is T => item !== null);
}

function messageOf(payload: unknown): string {
  if (isObject(payload)) {
    return text(payload.message) ?? text(payload.error) ?? 'The request failed.';
  }
  return 'The request failed.';
}

export const load: PageServerLoad = async ({ cookies }) => {
  const did = requireLibrarian(cookies);

  const [pending, identities] = await Promise.all([
    workerAdminGet('/claims/pending'),
    workerAdminGet('/claims/identities')
  ]);

  // A worker that is down is not a page error: the queue renders empty with a
  // notice, which is what an operator needs to see.
  return {
    did,
    workerOk: pending.status === 200 && identities.status === 200,
    pending: itemsOf(pending.payload, pendingClaimOf),
    identities: itemsOf(identities.payload, identityOf)
  };
};

export const actions: Actions = {
  approve: async ({ cookies, request }) => decide(cookies, request, 'approve'),
  reject: async ({ cookies, request }) => decide(cookies, request, 'reject'),

  revoke: async ({ cookies, request }) => {
    const did = requireLibrarian(cookies);
    const form = await request.formData();
    const subject = String(form.get('did') ?? '').trim();
    if (!subject.startsWith('did:')) return fail(400, { message: 'A DID is required.' });

    const result = await workerAdminPost('/claims/revoke', { did: subject, issuedBy: did });
    if (result.status !== 200) return fail(result.status, { message: messageOf(result.payload) });
    redirect(303, '/librarian/claims');
  }
};

async function decide(
  cookies: Parameters<typeof requireLibrarian>[0],
  request: Request,
  action: 'approve' | 'reject'
): Promise<DecideFailure> {
  const did = requireLibrarian(cookies);
  const form = await request.formData();
  const claimUri = String(form.get('claimUri') ?? '').trim();
  const subjectDid = String(form.get('subjectDid') ?? '').trim();
  const contributorUri = String(form.get('contributorUri') ?? '').trim();
  const note = String(form.get('note') ?? '').trim();

  if (claimUri === '' || subjectDid === '' || contributorUri === '') {
    return fail(400, {
      message: 'The claim is missing the account or the contributor it names.'
    });
  }

  const result = await workerAdminPost('/claims/decide', {
    claimUri,
    subjectDid,
    contributorUri,
    action,
    ...(note === '' ? {} : { note }),
    issuedBy: did
  });
  if (result.status !== 200) {
    return fail(result.status, { message: messageOf(result.payload) });
  }
  redirect(303, '/librarian/claims');
}
