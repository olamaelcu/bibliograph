import type { Logger } from 'pino';
import type { Task, TaskList } from 'graphile-worker';
import { db } from '../db';
import { upsertEditions } from '../catalog/store';
import type { EditionInput } from '../catalog/types';
import type { EditionItem } from '../search/types';
import { usableCoverUrl } from '../media-book-view';
import { backfillCoverForEdition } from './cover-backfill';
import { backfillDescriptionForEdition } from './description-backfill';
import { backfillFormatForEdition } from './format-backfill';
import { backfillIsbnForEdition } from './isbn-backfill';
import { auditedBackfill } from './backfill-audit';
import { publishPendingEditions } from './pds-publish';

function editionInputFromItem(item: EditionItem): EditionInput {
	return {
		title: item.title,
		subtitle: item.subtitle ?? null,
		language: item.language ?? null,
		publishedDate: item.publishedYear ? String(item.publishedYear) : null,
		format: item.format ?? null,
		pages: item.pages ?? null,
		durationSeconds: item.durationSeconds ?? null,
		chapters: item.chapters ?? null,
		series: item.series ?? null,
		bookEdition: item.bookEdition ?? null,
		description: item.description ?? null,
		coverUrl: usableCoverUrl(item.coverUrl) ?? null,
		identifiers: item.identifiers,
		contributors: item.contributors,
		publisher: item.publisher ?? null,
		createdAt: item.createdAt,
	};
}

export async function ingestEditionBatch(items: EditionItem[], log: Logger): Promise<void> {
	await upsertEditions(items.map(editionInputFromItem), log);
}

export const ingestEditionTask: Task = async (payload, helpers) => {
	await ingestEditionBatch([payload as EditionItem], helpers.logger as unknown as Logger);
};

export const ingestEditionBatchTask: Task = async (payload, helpers) => {
	await ingestEditionBatch(payload as EditionItem[], helpers.logger as unknown as Logger);
};

export const backfillEditionCoverTask = auditedBackfill(
	'backfill-edition-cover',
	'edition',
	async (payload, helpers) => {
		const { uri, rkey } = payload as { uri: string; rkey: string };
		return backfillCoverForEdition(uri, rkey, helpers.logger as unknown as Logger, db);
	},
);

export const backfillEditionDescriptionTask = auditedBackfill(
	'backfill-edition-description',
	'edition',
	async (payload, helpers) => {
		const { uri } = payload as { uri: string };
		return backfillDescriptionForEdition(uri, helpers.logger as unknown as Logger, db);
	},
);

export const backfillEditionFormatTask = auditedBackfill(
	'backfill-edition-format',
	'edition',
	async (payload, helpers) => {
		const { uri } = payload as { uri: string };
		const result = await backfillFormatForEdition(uri, helpers.logger as unknown as Logger, db);
		return { reason: result.status };
	},
);

export const backfillEditionIsbnTask = auditedBackfill(
	'backfill-edition-isbn',
	'edition',
	async (payload, helpers) => {
		const { uri, rkey } = payload as { uri: string; rkey: string };
		return backfillIsbnForEdition(uri, rkey, helpers.logger as unknown as Logger, db);
	},
);

export const pdsPublishTask: Task = async (_payload, helpers) => {
	const remaining = await publishPendingEditions(helpers.logger as unknown as Logger);
	if (remaining > 0) {
		await helpers.addJob('pds-publish', {}, { jobKey: 'pds-publish' });
	}
};

export const allTaskList: TaskList = {
	'ingest-edition': ingestEditionTask,
	'ingest-edition-batch': ingestEditionBatchTask,
	'backfill-edition-cover': backfillEditionCoverTask,
	'backfill-edition-description': backfillEditionDescriptionTask,
	'backfill-edition-format': backfillEditionFormatTask,
	'backfill-edition-isbn': backfillEditionIsbnTask,
	'pds-publish': pdsPublishTask,
};
