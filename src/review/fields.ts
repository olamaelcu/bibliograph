export const editableFields = {
	book: ['title', 'description', 'publishDate', 'coverUrl', 'workPk', 'formatPk'],
	work: ['title', 'description', 'originalPublishDate'],
	contributor: ['name', 'sortName', 'bio', 'imageUrl'],
	genre: ['name', 'description', 'emoji', 'parentPk'],
	contributorRole: ['name', 'description', 'iconImageUrl'],
} as const;

export type EditableFieldType = 'string' | 'date' | 'uri';

export function fieldType(entity: keyof typeof editableFields, field: string): EditableFieldType | null {
	const dateFields = ['publishDate', 'originalPublishDate'];
	const uriFields = ['coverUrl', 'imageUrl', 'iconImageUrl'];
	if (dateFields.includes(field)) return 'date';
	if (uriFields.includes(field)) return 'uri';
	if ((editableFields[entity] as readonly string[]).includes(field)) return 'string';
	return null;
}

/** Coerce a CLI string value into the DB-typed value; throws on invalid input. */
export function coerceValue(
	entity: keyof typeof editableFields,
	field: string,
	raw: string,
): string | number | null {
	const type = fieldType(entity, field);
	if (type === null) throw new Error(`unknown field '${field}' for entity '${entity}'`);
	if (type === 'date') {
		const ms = Date.parse(raw);
		if (Number.isNaN(ms)) throw new Error(`invalid date: '${raw}'`);
		return Math.floor(ms / 1000);
	}
	if (type === 'uri') {
		try {
			const u = new URL(raw);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('non-http(s) URI');
		} catch {
			throw new Error(`invalid URI: '${raw}'`);
		}
		return raw;
	}
	if (raw.length === 0) throw new Error(`empty value for '${field}'`);
	return raw;
}
