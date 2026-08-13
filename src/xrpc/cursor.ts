export interface CursorValue {
	key: string;
	pk: string;
}

export function encodeCursor(value: CursorValue): string {
	return Buffer.from(`${value.key}:${value.pk}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorValue {
	try {
		const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
		const sep = decoded.indexOf(':');
		if (sep <= 0 || sep === decoded.length - 1) {
			throw new Error('malformed cursor');
		}
		return { key: decoded.slice(0, sep), pk: decoded.slice(sep + 1) };
	} catch {
		throw new Error('malformed cursor');
	}
}
