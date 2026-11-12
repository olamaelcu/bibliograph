#!/bin/sh
# Install Caddy's internal root CA, then run HappyView's own entrypoint.
#
# HappyView fetches PDS endpoints (authorization-server metadata, DID documents'
# service endpoints) over TLS, and Caddy's internal CA is not in any public
# bundle. The CA lives in Caddy's `pki/` tree, which is mode 0700 and root-owned,
# and installing it needs root too — hence `user: root` in compose.
#
# Only HappyView needs this. The PDS never fetches HappyView: HappyView's
# PUBLIC_URL is a loopback name, so it registers as the localhost OAuth client
# and the PDS synthesises the metadata instead of resolving it.
set -e

CA_CERT=/caddy-data/caddy/pki/authorities/local/root.crt
if [ -d /caddy-data ]; then
	echo "waiting for Caddy CA certificate..."
	while [ ! -f "$CA_CERT" ]; do sleep 0.5; done
	cp "$CA_CERT" /usr/local/share/ca-certificates/caddy-local.crt
	update-ca-certificates 2>/dev/null
	echo "Caddy CA certificate installed."
fi

exec /entrypoint.sh "$@"
