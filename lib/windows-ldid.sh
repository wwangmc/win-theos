#!/usr/bin/env bash
set -e

# The Windows ldid port creates its temporary file relative to the target name.
# Keep the Mach-O argument a basename while preserving the caller's file options.
arguments=()
while [ "$#" -gt 1 ]; do
  case "$1" in
    -S?*) arguments+=("-S$(cygpath -am -- "${1:2}")") ;;
    -K?*) arguments+=("-K$(cygpath -am -- "${1:2}")") ;;
    -Q?*) arguments+=("-Q$(cygpath -am -- "${1:2}")") ;;
    *) arguments+=("$1") ;;
  esac
  shift
done
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'The Theos signer wrapper expects one Mach-O or bundle target.' >&2
  exit 2
fi
target="$(cygpath -au -- "$1")"
cd -- "$(dirname -- "$target")"
exec /usr/bin/ldid.exe "${arguments[@]}" "$(basename -- "$target")"
