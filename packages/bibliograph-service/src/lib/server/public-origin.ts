/** The origin clients reach this service at. */
export function publicOrigin(): string {
	const configured = process.env.ORIGIN;
	if (configured) return configured.replace(/\/$/, '');
	return `http://127.0.0.1:${process.env.PORT ?? '5176'}`;
}
