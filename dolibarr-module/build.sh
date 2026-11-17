#!/bin/bash
# Build the DoliStore package: module_dolibarrmcpserver-<version>.zip
# Usage: dolibarr-module/build.sh [output-dir]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
out="${1:-$here}"
version="$(node -p "require('$root/package.json').version")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$root" && npm run build >/dev/null)
cp -R "$here/dolibarrmcpserver" "$work/"
mkdir -p "$work/dolibarrmcpserver/mcp-server"
(cd "$root" && git archive HEAD) | tar -x -C "$work/dolibarrmcpserver/mcp-server"
rm -rf "$work/dolibarrmcpserver/mcp-server/dolibarr-module"
cp -R "$root/dist" "$work/dolibarrmcpserver/mcp-server/"
# The server is not meant to be served by the web server
printf '<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n' > "$work/dolibarrmcpserver/mcp-server/.htaccess"

zip="$out/module_dolibarrmcpserver-$version.zip"
rm -f "$zip"
(cd "$work" && zip -qr "$zip" dolibarrmcpserver -x '*.DS_Store')
echo "$zip"
