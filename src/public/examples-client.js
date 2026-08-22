/**
 * Shared browser client for the /examples pages.
 *
 * `initExample` wires up a single query's form, runs the request against
 * `/xrpc/<nsid>`, and hands the parsed JSON to a page-specific `render` fn.
 * It also pre-fills inputs from the URL query string so callers can link
 * directly to a populated demo.
 */

export function initExample({ nsid, paramDefs, render, outputId, formId }) {
	const form = document.getElementById(formId);
	const output = document.getElementById(outputId);
	if (!form || !output) {
		console.error('examples-client: missing form/output element', { formId, outputId });
		return;
	}

	prefillFromUrl(form, paramDefs);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		void runQuery(nsid, paramDefs, form, output, render);
	});
}

function prefillFromUrl(form, paramDefs) {
	const params = new URLSearchParams(location.search);
	for (const p of paramDefs) {
		const el = form.querySelector(`[name="${p.name}"]`);
		if (!el) continue;
		const value = params.get(p.name);
		if (value === null) continue;
		setControlValue(el, value);
	}
}

function setControlValue(el, value) {
	// Web Awesome custom elements look like inputs but don't always expose
	// `value` to native form-data; set both the property and the attribute
	// so subsequent reads and submits see the prefill.
	el.value = value;
	if ('setAttribute' in el) el.setAttribute('value', value);
}

function readControlValue(el) {
	const v = el.value;
	return typeof v === 'string' ? v.trim() : '';
}

function buildQueryString(form, paramDefs) {
	const params = new URLSearchParams();
	for (const p of paramDefs) {
		const el = form.querySelector(`[name="${p.name}"]`);
		if (!el) continue;
		const value = readControlValue(el);
		if (!value) continue;
		params.set(p.name, value);
	}
	return params.toString();
}

async function runQuery(nsid, paramDefs, form, output, render) {
	const qs = buildQueryString(form, paramDefs);
	const url = qs ? `/xrpc/${nsid}?${qs}` : `/xrpc/${nsid}`;
	output.innerHTML = '';
	output.insertAdjacentHTML(
		'beforeend',
		'<p class="empty muted">Running query&hellip;</p>',
	);
	const submit = form.querySelector('wa-button[type="submit"]') || form.querySelector('button[type="submit"]');
	if (submit) submit.loading = true;

	try {
		const res = await fetch(url, { headers: { accept: 'application/json' } });
		const text = await res.text();
		const body = parseBody(text);
		if (!res.ok) {
			output.innerHTML = renderError(res.status, body, text);
			return;
		}
		output.innerHTML = '';
		render(body, output);
		const next = qs ? `?${qs}` : '';
		history.replaceState(null, '', `${location.pathname}${next}`);
	} catch (err) {
		output.innerHTML = renderError(0, null, String(err && err.message ? err.message : err));
	} finally {
		if (submit) submit.loading = false;
	}
}

function parseBody(text) {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function renderError(status, body, rawText) {
	const headline = status === 0
		? 'Network error'
		: `Request failed (HTTP ${status})`;
	const detail = body && body.message
		? escapeHtml(String(body.message))
		: escapeHtml(rawText || '');
	const errorName = body && body.error ? escapeHtml(String(body.error)) : '';
	return `<wa-callout variant="danger">
      <strong>${escapeHtml(headline)}</strong>${errorName ? ` &mdash; <code>${errorName}</code>` : ''}
      ${detail ? `<div style="margin-top:0.4rem">${detail}</div>` : ''}
    </wa-callout>`;
}

export function escapeHtml(value) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

export function snippet(text, max) {
	const trimmed = String(text ?? '').trim();
	if (trimmed.length <= max) return trimmed;
	return trimmed.slice(0, max).trimEnd() + '&hellip;';
}
