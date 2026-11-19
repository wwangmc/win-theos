#!/usr/bin/env bash
set -e

arguments=()
for argument in "$@"; do
  case "$argument" in
    -Wl,*)
      IFS=, read -r -a parts <<< "${argument:4}"
      operand=0
      for ((index=0; index<${#parts[@]}; index++)); do
        if [ "$operand" -gt 0 ]; then
          operand=$((operand - 1))
          if [ "$operand" -eq 0 ] && [ -e "${parts[index]}" ]; then
            parts[index]="$(cygpath -am -- "${parts[index]}")"
          fi
        else
          case "${parts[index]}" in
            -sectcreate) operand=3 ;;
            -order_file|-force_load|-filelist|-exported_symbols_list|-unexported_symbols_list) operand=1 ;;
          esac
        fi
      done
      argument="-Wl,$(IFS=,; printf '%s' "${parts[*]}")"
      ;;
  esac
  arguments+=("$argument")
done

compiler="$THEOS/toolchain/windows/iphone/win-theos-clang-22.1.8/bin/clang.exe"
case "$0" in *clang++) exec "$compiler" --driver-mode=g++ "${arguments[@]}" ;; esac
exec "$compiler" "${arguments[@]}"
