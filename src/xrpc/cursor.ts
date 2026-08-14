export interface CursorValue {
	key: string;
	pk: string;
}

export function encodeCursor(value: CursorValue): string {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorValue {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as CursorValue).key === 'string' &&
			typeof (parsed as CursorValue).pk === 'string'
		) {
			return { key: (parsed as CursorValue).key, pk: (parsed as CursorValue).pk };
		}
		throw new Error('malformed cursor');
	} catch {
		throw new Error('malformed cursor');
	}
}
