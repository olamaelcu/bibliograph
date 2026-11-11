// The gate every `/admin` server route goes through.
//
// This deployment has no browser login: admin pages write catalog rows directly,
// so they are gated on an operator token (`ADMIN_TOKEN`) compared in constant
// time. When the token is unset the routes answer 404 rather than expose
// unauthenticated writes. The header link is a convenience; every route
// re-checks on the server.

import { error } from '@sveltejs/kit';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { PUBLISHER_DID } from './did';

const COOKIE = 'bib_admin';

export function adminToken(): string | null {
	const token = process.env.ADMIN_TOKEN;
	return token && token.length > 0 ? token : null;
}

function equal(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export function hasAdminAccess(event: { request: Request; cookies: Cookies }): boolean {
	const expected = adminToken();
	if (!expected) return false;
	const header = event.request.headers.get('authorization');
	if (header?.startsWith('Bearer ') && equal(header.slice('Bearer '.length), expected)) return true;
	const cookie = event.cookies.get(COOKIE);
	return !!cookie && equal(cookie, expected);
}

/** The DID recorded on labels and applications the admin acts on. */
export function adminActorDid(): string {
	const configured = process.env.ADMIN_DID ?? process.env.ADMIN_DIDS?.split(',')[0]?.trim();
	return configured && configured.startsWith('did:') ? configured : PUBLISHER_DID;
}

/** Gate a route and return the admin actor DID. */
export function requireAdmin(event: RequestEvent, _next?: string): string {
	if (!adminToken()) error(404, 'Admin access is not configured');
	if (!hasAdminAccess(event)) error(401, 'Admin token required');
	return adminActorDid();
}

export function setAdminCookie(cookies: Cookies, token: string): void {
	cookies.set(COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: 60 * 60 * 12,
	});
}
