#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const builder = fileURLToPath(new URL('../lib/native/ios_binary.py', import.meta.url));
const scaffoldSource = new URL('../templates/Tweak.xm', import.meta.url);
const toolchainPath = resolve(process.env.WIN_IOS_TWEAK_CONFIG ||
  join(process.env.LOCALAPPDATA || homedir(), 'win-ios-tweak', 'toolchain.json'));
const toolFlags = {
  python: 'python', clang: 'clang', linker: 'ld64.lld', ipsw: 'ipsw', perl: 'perl',
};
const toolchainPaths = ['sdk', 'logos', 'resource-dir'];
const projectSchemes = ['rootful', 'rootless', 'roothide'];
const fileStem = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const stringOption = { type: 'string' };
const listOption = { type: 'string', multiple: true };
const commands = {
  init: { options: { bundle: stringOption, package: stringOption }, positional: true },
  setup: { options: {
    ...Object.fromEntries([...Object.keys(toolFlags), ...toolchainPaths, 'sdk-version'].map(key => [key, stringOption])),
    'perl-include': listOption,
  } },
  doctor: { options: {} },
  build: { options: {
    project: stringOption, scheme: stringOption, output: stringOption, template: stringOption,
    'install-dir': stringOption,
  } },
};
const help = `win-theos native

  init <directory> --bundle <bundle-id> [--package <package-id>]
  setup --sdk <path> --sdk-version <version> --logos <logos.pl>
        [--clang <exe>] [--linker <exe>] [--ipsw <exe>]
        [--perl <exe>] [--perl-include <path>] [--python <exe>]
        [--resource-dir <path>]
  doctor
  build [--project <directory>] [--scheme rootful|rootless|roothide]
        [--install-dir <package path>] [--template <old.deb>] [--output <new.deb>]

Toolchain configuration: ${toolchainPath}`;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  const value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `Expected a JSON object in ${file}`);
  return value;
}

function saveJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try {
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function toolchainReady(toolchain) {
  for (const key of ['sdk', 'sdk-version', 'logos']) {
    requireValue(typeof toolchain[key] === 'string' && toolchain[key].length > 0,
      `Configure --${key} with win-theos native setup first.`);
  }
  return { ...toolFlags, ...toolchain };
}

function toolchain() {
  requireValue(existsSync(toolchainPath), 'Run win-theos native setup to configure the toolchain.');
  return toolchainReady(readJson(toolchainPath));
}

function setup(values) {
  requireValue(Object.keys(values).length > 0, 'Pass toolchain options to setup. See win-theos native --help.');
  const current = existsSync(toolchainPath) ? readJson(toolchainPath) : {};
  const updated = { ...current, ...values };
  for (const key of [...Object.keys(toolFlags), ...toolchainPaths]) {
    if (values[key] && (toolchainPaths.includes(key) || /[/\\]/.test(values[key]))) {
      updated[key] = resolve(values[key]);
    }
  }
  toolchainReady(updated);
  saveJson(toolchainPath, updated);
  console.log(`Saved ${toolchainPath}`);
}

function init(path, values) {
  requireValue(path, 'Usage: win-theos native init <directory> --bundle <bundle-id>');
  const project = resolve(path);
  const name = basename(project);
  requireValue(fileStem.test(name), 'Choose a directory name with letters, digits, dots, underscores, or hyphens.');
  const bundle = values.bundle;
  requireValue(bundle && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle),
    'Provide an iOS bundle identifier with --bundle, for example com.apple.Preferences.');
  const packageId = values.package ?? `com.example.${name.toLowerCase().replaceAll('_', '-')}`;
  requireValue(/^[a-z0-9][a-z0-9+.\-]+$/.test(packageId), 'Invalid Debian package name. Set --package explicitly.');

  const config = { name, scheme: 'rootless', minIos: '14.0', sources: ['Tweak.xm'],
    frameworks: ['UIKit', 'Foundation'], linkArgs: ['-lc++'], control: 'control', filter: 'Tweak.plist' };
  const files = new Map([
    ['Tweak.xm', readFileSync(scaffoldSource)],
    ['Tweak.plist', `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict><key>Filter</key><dict><key>Bundles</key><array>\n  <string>${bundle}</string>\n</array></dict></dict>\n</plist>\n`],
    ['control', `Package: ${packageId}\nName: ${name}\nVersion: 0.1.0\nArchitecture: iphoneos-arm64\nMaintainer: Developer\nDescription: ${name} jailbreak tweak\nSection: Tweaks\n`],
    ['tweak.config.json', `${JSON.stringify(config, null, 2)}\n`],
    ['.gitignore', 'dist/\n'],
  ]);
  mkdirSync(project);
  const written = [];
  try {
    for (const [file, contents] of files) {
      const target = join(project, file);
      writeFileSync(target, contents, { flag: 'wx' });
      written.push(target);
    }
  } catch (error) {
    for (const file of written) unlinkSync(file);
    try { rmdirSync(project); } catch { /* Preserve files created concurrently. */ }
    throw error;
  }
  console.log(`Created ${project}\nOpen it and run win-theos native build.`);
}

function doctor() {
  const config = toolchain();
  const checks = [
    ['Python 3.10+', config.python, ['-B', '-c', 'import sys; sys.exit(sys.version_info < (3, 10))']],
    ['Clang', config.clang, ['--version']],
    ['Mach-O LLD', config.linker, ['-help'], /-platform_version/],
    ['ipsw', config.ipsw, ['macho', 'sign', '--help'], /--ad-hoc/],
    ['Windows Perl / Logos', config.perl,
      [...perlIncludes(config).map(path => `-I${path}`), config.logos.replaceAll('\\', '/'), '--help']],
  ];
  let failures = 0;
  for (const [label, executable, args, expected] of checks) {
    const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0 && (!expected || expected.test(output))) {
      console.log(`OK   ${label}`);
    } else {
      failures++;
      const detail = result.error?.message || output.trim().split(/\r?\n/)[0] || `exit ${result.status}`;
      console.error(`FAIL ${label}: ${detail}`);
    }
  }
  const sdkOK = existsSync(join(config.sdk, 'System', 'Library', 'Frameworks')) &&
    existsSync(join(config.sdk, 'usr', 'include'));
  if (!sdkOK) failures++;
  console.log(`${sdkOK ? 'OK  ' : 'FAIL'} iPhoneOS SDK ${config['sdk-version']}: ${config.sdk}`);
  if (config['resource-dir']) {
    const resourceOK = existsSync(join(config['resource-dir'], 'include', 'stddef.h'));
    if (!resourceOK) failures++;
    console.log(`${resourceOK ? 'OK  ' : 'FAIL'} Clang resource headers: ${config['resource-dir']}`);
  }
  return Number(failures > 0);
}

function stringList(list, field) {
  requireValue(Array.isArray(list) && list.every(item => typeof item === 'string' && item.length),
    `${field} must be an array of nonempty strings.`);
  return list;
}

function perlIncludes(config) {
  return stringList(config['perl-include'] ?? [], 'perl-include');
}

function build(values) {
  const root = resolve(values.project ?? '.');
  const projectPath = join(root, 'tweak.config.json');
  requireValue(existsSync(projectPath), `No tweak.config.json in ${root}. Run init or pass --project.`);
  const project = readJson(projectPath);
  requireValue(typeof project.name === 'string' && fileStem.test(project.name), 'Invalid project name in tweak.config.json.');
  const scheme = values.scheme ?? project.scheme ?? 'rootless';
  requireValue(projectSchemes.includes(scheme), 'Choose rootful, rootless, or roothide.');
  const config = toolchain();
  const output = resolve(root, values.output ?? `dist/${project.name}-${scheme}.deb`);
  const args = ['-B', builder, 'build-tweak', '--name', project.name, '--scheme', scheme,
    '--output', output, '--control', resolve(root, project.control ?? 'control'),
    '--filter', resolve(root, project.filter ?? 'Tweak.plist'), '--min-ios', project.minIos ?? '14.0'];

  for (const key of ['clang', 'linker', 'ipsw', 'perl', 'logos', 'sdk', 'sdk-version', 'resource-dir']) {
    if (config[key]) args.push(`--${key}`, config[key]);
  }
  for (const path of perlIncludes(config)) args.push('--perl-include', path);
  for (const [field, flag] of Object.entries({ sources: 'source', includes: 'include', frameworks: 'framework',
    architectures: 'arch', compileArgs: 'compile-arg', linkArgs: 'link-arg' })) {
    const items = stringList(project[field] ?? [], field);
    if (field === 'sources') requireValue(items.length, 'List at least one source in tweak.config.json.');
    for (const item of items) args.push(`--${flag}=${item}`);
  }
  for (const [field, flag] of Object.entries({ entitlements: 'entitlements', der: 'der', derFrom: 'der-from' })) {
    if (project[field]) args.push(`--${flag}`, resolve(root, project[field]));
  }
  const installDir = values['install-dir'] ?? project.installDirs?.[scheme];
  if (installDir) args.push('--install-dir', installDir);
  if (values.template) args.push('--template', resolve(root, values.template));

  const result = spawnSync(config.python, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || args.includes('--help')) {
    console.log(help);
    return 0;
  }
  if (command === '--version') {
    console.log(readJson(new URL('../package.json', import.meta.url)).version);
    return 0;
  }
  requireValue(Object.hasOwn(commands, command), `Unknown command: ${command}. See win-theos native --help.`);
  const spec = commands[command];
  const { values, positionals } = parseArgs({ args, options: spec.options, allowPositionals: spec.positional ?? false });
  switch (command) {
    case 'init':
      requireValue(positionals.length === 1, 'Pass exactly one directory to init.');
      init(positionals[0], values);
      return 0;
    case 'setup':
      setup(values);
      return 0;
    case 'doctor':
      return doctor();
    case 'build':
      return build(values);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`win-theos native: ${error.message}`);
  process.exitCode = 1;
}
