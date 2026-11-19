#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bootstrap, compilerMarker, manualConfigPath as configFile, profilePath } from '../lib/bootstrap.js';

const onWindows = process.platform === 'win32';
const nativeScript = fileURLToPath(new URL('./cli.js', import.meta.url));
const demoTemplate = fileURLToPath(new URL('../templates/demo.nic', import.meta.url));
const engines = ['msys', 'wsl', 'local'];
const schemes = new Map([
  ['rootful', { type: 0, value: '' }],
  ['rootless', { type: 1, value: 'rootless' }],
  ['roothide', { type: 2, value: 'roothide' }],
]);
const targets = new Map([['build', 'all'], ['stage', 'stage'], ['package', 'package'], ['clean', 'clean'], ['make', '']]);
const string = { type: 'string' };
const projectOptions = { project: string };
const help = `win-theos (also available as theos)

  bootstrap  Install the portable Windows x64 Theos environment
  setup --engine msys|wsl|local --theos <path>
        [--bash <program>] [--distro <wsl-distro>] [--make <program>] [--bin-dir <path>]
  doctor
  init [--project <parent-dir>] [--template <name> | --nic <template-file>]
       [--name <name>] [--package <id>] [--author <author>] [-- <NIC args>]
  build | stage | package | clean | make
       [--project <dir>] [--scheme rootful|rootless|roothide]
       [--archs "arm64 arm64e"] [-- <GNU Make args>]
       package defaults to all three schemes in the current project
  native <init|setup|doctor|build>  Standalone native Windows tweak workflow

Theos configuration: ${configFile}`;

// Keep the shell program fixed. Paths and all tool arguments arrive in positional parameters.
const launch = `
set -e
adapter="$1"; path_to_theos="$2"; project="$3"; operation="$4"; make_program="$5"; nic_file="$6"
menu_template="$7"; bin_count="$8"; shift 8
convert_path() {
  case "$adapter:$1" in
    msys:*) cygpath -u -- "$1" ;;
    wsl:[A-Za-z]:*) wslpath -a -u "$1" ;;
    *) printf '%s\\n' "$1" ;;
  esac
}
register_demo() {
  local source="$1" destination="$THEOS/templates/win-theos-demo.nic" temporary
  if [ -f "$destination" ] && [ "$(cksum < "$source")" = "$(cksum < "$destination")" ]; then
    return 0
  fi
  mkdir -p -- "$THEOS/templates" || return 1
  temporary="$(mktemp "$THEOS/templates/.win-theos-demo.XXXXXX")" || return 1
  if cat -- "$source" > "$temporary" && chmod 644 "$temporary" && mv -f -- "$temporary" "$destination"; then
    return 0
  fi
  rm -f -- "$temporary"
  return 1
}
make_dirs=""
while [ "$bin_count" -gt 0 ]; do
  make_dirs="$make_dirs$(convert_path "$1"):"
  shift
  bin_count=$((bin_count - 1))
done
export PATH="$make_dirs$PATH"
case "$make_program" in
  [A-Za-z]:*) make_program="$(convert_path "$make_program")" ;;
esac
if [ -n "$path_to_theos" ]; then
  export THEOS="$(convert_path "$path_to_theos")"
fi
if [ -z "$THEOS" ] || [ ! -f "$THEOS/makefiles/common.mk" ]; then
  printf '%s\\n' 'Theos is unavailable in this engine. Set its root with win-theos setup --theos.' >&2
  exit 1
fi
cd -- "$(convert_path "$project")"
case "$operation" in
  doctor)
    printf 'THEOS=%s\\n' "$THEOS"
    if [ "$adapter" = msys ] && [ -f "$THEOS/.win-theos-compiler-v2" ]; then
      "$THEOS/bin/win-theos-clang" --version
    fi
    command -v "$make_program"
    "$make_program" --version
    command -v perl
    perl -c "$THEOS/bin/nic.pl"
    ;;
  init)
    if [ -n "$menu_template" ] && ! register_demo "$(convert_path "$menu_template")"; then
      printf '%s\\n' 'Could not add demo to the NIC menu. Use --template demo to generate it directly.' >&2
    fi
    if [ -n "$nic_file" ]; then
      set -- --nic "$(convert_path "$nic_file")" "$@"
    fi
    if [ "$adapter" != local ] && [ ! -t 0 ]; then
      set -o pipefail
      tr -d '\\r' | perl "$THEOS/bin/nic.pl" "$@"
    else
      exec perl "$THEOS/bin/nic.pl" "$@"
    fi
    ;;
  *) exec "$make_program" "$@" ;;
esac`;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function readConfig(path = configFile) {
  if (!existsSync(path)) return {};
  const config = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  check(config && typeof config === 'object' && !Array.isArray(config), `Expected a JSON object in ${path}.`);
  return config;
}

function setup(options) {
  const { values } = parseArgs({ args: options, options: {
    engine: string, theos: string, bash: string, distro: string, make: string,
    'bin-dir': { type: 'string', multiple: true },
  } });
  check(Object.keys(values).length, 'Run win-theos setup --help for configuration options.');
  const config = { ...readConfig(), ...values };
  config.engine ??= onWindows ? 'msys' : 'local';
  check(engines.includes(config.engine), 'Choose the msys, wsl, or local engine.');
  // A Windows path needs to survive a later invocation from a different project directory.
  if (values.theos && config.engine !== 'wsl' && !values.theos.startsWith('/')) {
    config.theos = resolve(values.theos);
  }
  if (values.bash && /[/\\]/.test(values.bash)) config.bash = resolve(values.bash);
  if (values.make && config.engine !== 'wsl' && !values.make.startsWith('/') && /[/\\]/.test(values.make)) {
    config.make = resolve(values.make);
  }
  if (values['bin-dir'] && config.engine !== 'wsl') {
    config['bin-dir'] = values['bin-dir'].map(path => path.startsWith('/') ? path : resolve(path));
  }
  mkdirSync(dirname(configFile), { recursive: true });
  const temporary = `${configFile}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  try {
    renameSync(temporary, configFile);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  console.log(`Saved ${config.engine} configuration to ${configFile}`);
  return 0;
}

function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { stdio: 'inherit', env, windowsHide: true });
  if (result.error) throw new Error(`Could not start ${executable}: ${result.error.message}`);
  return result.status ?? 1;
}

function runTheos(operation, project, args = [], { nicFile = '', menuTemplate = '' } = {}) {
  const config = existsSync(configFile) || process.env.THEOS ? readConfig() : readConfig(profilePath);
  const engine = config.engine ?? (onWindows ? 'msys' : 'local');
  check(engines.includes(engine), `Unknown Theos engine: ${engine}.`);
  const dirs = config['bin-dir'] ?? [];
  check(Array.isArray(dirs) && dirs.every(dir => typeof dir === 'string' && dir !== ''), 'Invalid bin-dir list.');
  const theos = config.theos ?? process.env.THEOS ?? '';
  const make = config.make ?? 'make';
  const parameters = ['win-theos', engine, theos, project, operation, make, nicFile, menuTemplate, String(dirs.length), ...dirs, ...args];
  if (engine === 'wsl') {
    const selection = config.distro ? ['--distribution', config.distro] : [];
    return run('wsl.exe', [...selection, '--exec', 'bash', '--login', '-c', launch, ...parameters]);
  }
  if (engine === 'msys') {
    const bash = config.bash ?? join(process.env.MSYS2_ROOT || 'C:/msys64', 'usr', 'bin', 'bash.exe');
    check(!/[/\\]/.test(bash) || existsSync(bash), 'MSYS2 Bash is unavailable. Run win-theos bootstrap or use setup with your existing installation.');
    const env = { ...process.env, CHERE_INVOKING: '1' };
    if (config['portable-msys']) {
      check(existsSync(join(theos, compilerMarker)), 'The portable runtime update is incomplete. Run win-theos bootstrap.');
      env.MSYSTEM = 'MSYS';
      env.MSYS2_ARG_CONV_EXCL = [env.MSYS2_ARG_CONV_EXCL,
        '-install_name;-dylib_install_name;/Library;/var;/usr'].filter(Boolean).join(';');
    }
    return run(bash, ['--login', '-c', launch, ...parameters], env);
  }
  return run(config.bash ?? 'bash', ['-c', launch, ...parameters]);
}

function splitPassthrough(args) {
  const index = args.indexOf('--');
  return index < 0 ? [args, []] : [args.slice(0, index), args.slice(index + 1)];
}

function init(options, remainder) {
  const { values } = parseArgs({ args: options, options: {
    ...projectOptions, template: string, nic: string, name: string, package: string, author: string,
  } });
  check(!(values.template && values.nic), 'Choose --template or --nic.');
  const isDemo = values.template === 'demo';
  const args = [];
  for (const [flag, value] of [
    ['--template', isDemo ? undefined : values.template],
    ['--name', values.name], ['--packagename', values.package], ['--user', values.author],
  ]) {
    if (value) args.push(flag, value);
  }
  const nicFile = isDemo ? demoTemplate : values.nic ? resolve(values.nic) : '';
  const menuTemplate = values.template || values.nic ? '' : demoTemplate;
  return runTheos('init', resolve(values.project ?? '.'), [...args, ...remainder], { nicFile, menuTemplate });
}

function packageAll(project, args) {
  const results = [];
  for (const [name, { type, value }] of schemes) {
    console.log(`\nPackaging ${name} (TYPE=${type})`);
    const status = runTheos('make', project, [
      'package', `TYPE=${type}`, `THEOS_PACKAGE_SCHEME=${value}`,
      `_THEOS_RELATIVE_DATA_DIR=.theos/package/${name}`,
      `THEOS_PACKAGE_DIR_NAME=packages/${name}`,
      ...args,
    ]);
    results.push({ name, status });
  }
  console.log(`\nPackaging results: ${results.map(({ name, status }) => `${name} ${status === 0 ? 'OK' : `failed (${status})`}`).join(', ')}`);
  return results.find(({ status }) => status !== 0)?.status ?? 0;
}

function make(command, options, remainder) {
  const { values } = parseArgs({ args: options, options: { ...projectOptions, scheme: string, archs: string } });
  const project = resolve(values.project ?? '.');
  const args = values.archs ? [`ARCHS=${values.archs}`, ...remainder] : remainder;
  if (values.scheme !== undefined) {
    check(schemes.has(values.scheme), 'Choose rootful, rootless, or roothide.');
    args.unshift(`THEOS_PACKAGE_SCHEME=${schemes.get(values.scheme).value}`);
  } else if (command === 'package' && process.env.THEOS_PACKAGE_SCHEME === undefined &&
      process.env.TYPE === undefined && !remainder.some(arg => /^(?:TYPE|THEOS_PACKAGE_SCHEME)\s*[:?!+]*=/.test(arg))) {
    return packageAll(project, args);
  }
  const target = targets.get(command);
  return runTheos('make', project, target ? [target, ...args] : args);
}

async function main([command, ...args]) {
  if (command === 'native') return run(process.execPath, [nativeScript, ...args]);
  if (!command || command === '--help' || command === '-h' || args[0] === '--help') {
    console.log(help);
    return 0;
  }
  if (command === '--version') {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return 0;
  }
  if (command === 'setup') return setup(args);
  if (command === 'bootstrap') {
    check(args.length === 0 || (args.length === 1 && args[0] === '--auto'), 'Usage: win-theos bootstrap.');
    try {
      await bootstrap(args[0] === '--auto');
    } catch (error) {
      if (args[0] !== '--auto') throw error;
      console.error(`win-theos: ${error.message}\nRun win-theos bootstrap to resume.`);
    }
    return 0;
  }
  if (command === 'doctor') {
    check(args.length === 0, 'Usage: win-theos doctor.');
    return runTheos('doctor', process.cwd());
  }
  const [options, remainder] = splitPassthrough(args);
  if (command === 'init') return init(options, remainder);
  if (targets.has(command)) return make(command, options, remainder);
  throw new Error(`Unknown command: ${command}. See win-theos --help.`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`win-theos: ${error.message}`);
  process.exitCode = 1;
}
