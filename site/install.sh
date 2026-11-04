#!/bin/sh
# Installs snowglobe from its GitHub release:
#
#   curl -fsSL https://filipecabaco.github.io/snowglobe/install.sh | sh
#
# It picks the release for this system (Linux on x86-64 or arm64, macOS on Apple silicon), checks it against the
# release's SHA256SUMS, and puts the snowglobe binary in ~/.local/bin (no sudo). snowglobe fetches
# its machine runtime (snowglobe-vm) itself the first time it needs it.
#
#   SNOWGLOBE_VERSION=0.4.0      a version instead of the latest
#   SNOWGLOBE_INSTALL_DIR=DIR    where to put it instead of ~/.local/bin
set -eu

repo="filipecabaco/snowglobe"
dir="${SNOWGLOBE_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
fail() { say "snowglobe install: $*"; exit 1; }

# Fetch $1 to file $2, or to stdout without one
fetch() {
	if command -v curl >/dev/null 2>&1; then
		if [ $# -gt 1 ]; then curl -fsSL "$1" -o "$2"; else curl -fsSL "$1"; fi
	elif command -v wget >/dev/null 2>&1; then
		if [ $# -gt 1 ]; then wget -qO "$2" "$1"; else wget -qO- "$1"; fi
	else
		fail "it needs curl or wget"
	fi
}

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) fail "snowglobe runs on Linux and macOS, not $(uname -s)" ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
arm64 | aarch64) arch=arm64 ;;
*) fail "no snowglobe release for $(uname -m)" ;;
esac
# Under Rosetta an arm64 Mac reports x86_64: it is Apple silicon all the same
if [ "$os/$arch" = darwin/amd64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
	arch=arm64
fi
[ "$os/$arch" != darwin/amd64 ] || fail "snowglobe runs on Macs with Apple silicon, not Intel ones"

version="${SNOWGLOBE_VERSION:-}"
if [ -z "$version" ]; then
	# The latest release's tag, from where /releases/latest redirects (no API, no rate limit)
	if command -v curl >/dev/null 2>&1; then
		latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")
	else
		latest=$(wget -S --spider "https://github.com/$repo/releases/latest" 2>&1 | sed -n 's/^ *[Ll]ocation: //p' | tail -1)
	fi
	version="${latest##*/}"
fi
version="${version#v}"
case "$version" in
[0-9]*.[0-9]*.[0-9]*) ;;
*) fail "couldn't tell the latest version (got '$version'); set SNOWGLOBE_VERSION" ;;
esac

name="snowglobe_${version}_${os}_${arch}"
base="https://github.com/$repo/releases/download/v$version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "Downloading snowglobe $version for $os/$arch..."
fetch "$base/$name.tar.gz" "$tmp/$name.tar.gz" || fail "no $name.tar.gz in release v$version"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "no SHA256SUMS in release v$version"

want=$(awk -v f="$name.tar.gz" '$2 == f || $2 == "*"f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "$name.tar.gz isn't in the release's SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
	got=$(sha256sum "$tmp/$name.tar.gz" | awk '{ print $1 }')
else
	got=$(shasum -a 256 "$tmp/$name.tar.gz" | awk '{ print $1 }')
fi
[ "$got" = "$want" ] || fail "$name.tar.gz doesn't match its checksum: not installing it"

tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
mkdir -p "$dir"
# A new file in place of the old, never written over a binary that may be running
rm -f "$dir/snowglobe"
cp "$tmp/$name/snowglobe" "$dir/snowglobe"
chmod 755 "$dir/snowglobe"

say "Installed $("$dir/snowglobe" version 2>/dev/null || echo "snowglobe $version") in $dir"
case ":$PATH:" in
*":$dir:"*) ;;
*)
	say ""
	say "$dir isn't on your PATH. Add it, for example:"
	say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile"
	;;
esac
say ""
say "Next: snowglobe build ./my-app, then snowglobe serve dist"
say "Docs: https://filipecabaco.github.io/snowglobe/docs/"
