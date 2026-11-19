import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const revision = '8167f59de02fd32cf45b16bfcb1330dfa5c9974c';
const source = 'https://github.com/theos/theos.git';
const linkerDigest = 'bf3b1684ca694d6dd6226b9a1ccc061cd72252d3656754f1b353d7543fbc44a7';
const linkerMarker = '.win-theos-macho-lld-v3';
const signerMarker = '.win-theos-signer-v1';
export const compilerMarker = '.win-theos-compiler-v2';
const compilerDirectory = 'win-theos-clang-22.1.8';
const compilerBundle = new URL('./llvm/clang-22.1.8-win64.tar.gz', import.meta.url);
const compilerDigest = '5660f7cc799a178648c55facd32baad1d09a1f4ce7bed7f2c4b193ed57971aa7';
const rootHideBundle = new URL('./roothide/theos-overlay.tar.gz', import.meta.url);
const rootHideDigest = '9623ef10b3ee3170f4c9579bc7e8cc8e46da003a6c073272cee36c39651e9dcc';
const packagingMarker = '.win-theos-packaging-v1';
const msysRelease = {
  name: 'msys2-base-x86_64-20260927.sfx.exe',
  sha256: 'ad336cccfda47758b5e15cda993fbba421115cb0b126697daef1ee4dfe37209f',
  bases: [
    'https://repo.msys2.org/distrib/x86_64/',
    'https://github.com/msys2/msys2-installer/releases/download/2026-09-27/',
  ],
};
const clangRelease = {
  name: 'theos-windows-toolchain-pinned.tar.gz',
  sha256: '478392ba62fd8687aef2447ac87ae7e8ec329d7c3721fd5f6b542621a69a72d6',
  bases: ['https://github.com/CacheW/TheosWin/releases/download/toolchain-v1/'],
};
const sdkRelease = {
  name: 'iPhoneOS16.5-windows.sdk.tar.gz',
  sha256: 'c6eb983aec355aed327d6f2ad97d2093176fe80b70a357cd9f46c5310ab9df72',
  bases: ['https://github.com/CacheW/TheosWin/releases/download/sdks-v1/'],
};
const ldidRelease = {
  name: 'ldid_w64_x86_64.exe',
  sha256: '77a3f012e09619f8cfb5902eba38a00b973da5561ac592c530efb68155f7e6f3',
  bases: ['https://github.com/ProcursusTeam/ldid/releases/download/v2.1.5-procursus7/'],
};

const toolHome = resolve(process.env.WIN_THEOS_HOME || join(process.env.LOCALAPPDATA || homedir(), 'win-theos'));
const runtime = join(toolHome, 'runtime-v1');
export const profilePath = join(runtime, 'profile.json');
export const manualConfigPath = resolve(process.env.WIN_THEOS_CONFIG || join(toolHome, 'theos.json'));
const gitTls = ['-c', 'http.sslBackend=openssl', '-c',
  `http.sslCAInfo=${join(runtime, 'msys64', 'usr', 'ssl', 'certs', 'ca-bundle.crt').replaceAll('\\', '/')}`];

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    stdio: options.capture ? 'pipe' : 'inherit', encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}`.trimEnd() : '';
    throw new Error(`${executable} exited with ${result.status ?? result.signal}.${detail}`);
  }
  return result.stdout;
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(release) {
  const cache = resolve(process.env.WIN_THEOS_DOWNLOAD_CACHE || join(toolHome, 'downloads'));
  mkdirSync(cache, { recursive: true });
  const destination = join(cache, release.name);
  if (existsSync(destination) && await digest(destination) === release.sha256) return destination;
  console.log(`Downloading ${release.name}`);
  const temporary = `${destination}.${randomUUID()}.part`;
  let lastError;
  try {
    for (const address of release.bases.map(base => `${base}${release.name}`)) {
      try {
        run('curl.exe', ['--fail', '--location', '--retry', '2', '--connect-timeout', '20',
          '--max-time', '600', '--silent', '--show-error', '--output', temporary, address]);
        if (await digest(temporary) !== release.sha256) throw new Error(`SHA-256 mismatch for ${release.name}.`);
        renameSync(temporary, destination);
        return destination;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Could not download ${release.name}. ${lastError.message}`);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function sameTree(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..\\'));
}

function windowsLinks(git, tree, env) {
  const paths = run(git, [...gitTls, '-C', tree, 'ls-files', '-s', '-z'], { capture: true, env })
    .split('\0').filter(entry => entry.startsWith('120000 '))
    .map(entry => resolve(tree, entry.slice(entry.indexOf('\t') + 1)));
  const aliases = new Map();
  for (const path of paths) {
    if (!sameTree(tree, path) || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > 2048) continue;
    const link = readFileSync(path, 'utf8').trim();
    if (link && !/\s/.test(link) && !isAbsolute(link)) aliases.set(path, resolve(dirname(path), link));
  }
  for (const [link, initial] of aliases) {
    let target = initial;
    const visited = new Set([link]);
    while (aliases.has(target) && !visited.has(target)) {
      visited.add(target);
      target = aliases.get(target);
    }
    if (!sameTree(tree, target) || visited.has(target) || target.toLowerCase() === link.toLowerCase() || !existsSync(target)) continue;
    if (lstatSync(target).isFile()) {
      copyFileSync(target, link);
    } else {
      unlinkSync(link); // git core.symlinks=false stored a text placeholder
      cpSync(target, link, { recursive: true });
    }
  }
}

function applyPatch(file, marker, edits) {
  let value = readFileSync(file, 'utf8');
  if (value.includes(marker)) return;
  for (const [anchor, replacement] of edits) {
    if (value.split(anchor).length !== 2) throw new Error(`Unsupported Theos source in ${file}.`);
    value = value.replace(anchor, () => replacement);
  }
  writeFileSync(file, value);
}

function prepareTheos(theos, git, env) {
  const marker = join(theos, '.win-theos-ready');
  if (existsSync(marker)) return;
  if (!existsSync(join(theos, '.git'))) run(git, [...gitTls, 'init', theos], { env });
  const commands = (args) => run(git, [...gitTls, '-C', theos, ...args], { env });
  commands(['config', 'core.autocrlf', 'false']);
  commands(['config', 'core.symlinks', 'false']);
  commands(['fetch', '--depth', '1', source, revision]);
  commands(['checkout', '--force', '--detach', revision]);
  commands(['submodule', 'update', '--init', '--recursive', '--depth', '1', '--jobs', '4']);
  const vendor = ['dm.pl', 'include', 'lib', 'logos', 'nic', 'templates', 'orion', 'swift-support'];
  for (const name of vendor) {
    const checkout = join(theos, 'vendor', name);
    if (existsSync(join(checkout, '.git'))) windowsLinks(git, checkout, env);
  }
  windowsLinks(git, theos, env);
  for (const name of ['logos', 'nic']) {
    cpSync(join(theos, 'vendor', name, 'bin', 'lib'), join(theos, 'bin', 'lib'), { recursive: true });
  }
  const platform = 'export _THEOS_PLATFORM = $(uname_s)\nexport _THEOS_OS = $(if $(uname_o),$(uname_o),$(uname_s))';
  applyPatch(join(theos, 'makefiles', 'common.mk'), '# win-theos: Windows MSYS2', [[platform, [
    '# win-theos: Windows MSYS2',
    'ifneq ($(filter MINGW% MSYS% CYGWIN%,$(uname_s)),)',
    'export _THEOS_PLATFORM := Windows', 'export _THEOS_OS := Windows', 'else', platform, 'endif',
  ].join('\n')]]);

  const link = '_THEOS_TARGET_LDFLAGS += -fuse-ld=$(SDKBINPATH)/$(_THEOS_TARGET_SDK_BIN_PREFIX)ld';
  applyPatch(join(theos, 'makefiles', 'targets', '_common', 'darwin_tail.mk'), '# win-theos: Mach-O linker', [[link,
    `${link}\nelse ifeq ($(THEOS_PLATFORM_NAME),windows)\n# win-theos: Mach-O linker\n_THEOS_TARGET_LDFLAGS += -B$(SDKBINPATH)`,
  ]]);

  const modeHelper = readFileSync(new URL('./windows-package-mode.pl', import.meta.url), 'utf8');
  const maintainer = '\t$mode = (lstat)[2];';
  const tarMode = 'my $mode = $stat[2] & 07777;';
  const tarStart = 'chdir(shift);\n\tmy @filelist;';
  applyPatch(join(theos, 'bin', 'dm.pl'), '# win-theos: archive modes', [
    ['sub tar_filelist {', `# win-theos: archive modes\n${modeHelper}\nsub tar_filelist {`],
    [maintainer, '\t$mode = win_theos_package_mode($_, (lstat)[2], 1);'],
    [tarStart, 'my $archive_root = shift;\n\tmy $controls = $archive_root eq $controldir;\n\tchdir($archive_root);\n\tmy @filelist;'],
    [tarMode, 'my $mode = win_theos_package_mode($_, $stat[2], $controls) & 07777;'],
  ]);
  writeFileSync(marker, `${revision}\n`);
}

function msysPackages(bash, env) {
  const command = ['--login', '-c', 'pacman -Syu --noconfirm --needed git make perl rsync'];
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = spawnSync(bash, command, { stdio: 'inherit', windowsHide: true, env });
    if (result.error) throw result.error;
    // A core MSYS2 upgrade can close the shell before the requested packages are installed.
    const installed = spawnSync(bash, ['--login', '-c', 'pacman -Q git make perl rsync'], { windowsHide: true, env });
    if (!installed.error && installed.status === 0) return;
  }
  throw new Error('MSYS2 could not finish installing GNU Make, Git, Perl, and rsync. Run win-theos bootstrap again.');
}

async function installLinker(theos) {
  const bin = join(theos, 'toolchain', 'windows', 'iphone', 'bin');
  const destination = join(bin, 'ld64.lld.exe');
  const marker = join(bin, linkerMarker);
  if (existsSync(marker) && existsSync(destination)) return;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const bundle = new URL('./llvm/ld64.lld.exe.gz', import.meta.url);
    await pipeline(createReadStream(bundle), createGunzip(), createWriteStream(temporary, { flags: 'wx' }));
    if (await digest(temporary) !== linkerDigest) throw new Error('Bundled Mach-O linker checksum mismatch.');
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const makefile = join(theos, 'makefiles', 'targets', '_common', 'darwin_tail.mk');
  const linkerFlags = '# win-theos: Mach-O linker\n_THEOS_TARGET_LDFLAGS += -B$(SDKBINPATH)';
  applyPatch(makefile, '# win-theos: authenticated fixups', [[linkerFlags,
    `${linkerFlags}\n# win-theos: authenticated fixups\nifeq ($(THEOS_CURRENT_ARCH),arm64e)\n_THEOS_TARGET_LDFLAGS += -Wl,-fixup_chains\nendif`,
  ]]);
  applyPatch(makefile, '# win-theos: explicit linker path', [[linkerFlags,
    `${linkerFlags}\n# win-theos: explicit linker path\n_THEOS_TARGET_LDFLAGS += --ld-path=$(SDKBINPATH)/ld64.lld.exe`,
  ]]);
  const linkerPath = '_THEOS_TARGET_LDFLAGS += --ld-path=$(SDKBINPATH)/ld64.lld.exe';
  applyPatch(makefile, '# win-theos: iOS deployment metadata', [[linkerPath,
    `${linkerPath}\n# win-theos: iOS deployment metadata\nifeq ($(THEOS_TARGET_NAME),iphone)\n_THEOS_TARGET_LDFLAGS += -Wl,-platform_version,ios,$(_THEOS_TARGET_OS_DEPLOYMENT_VERSION),$(_THEOS_TARGET_SDK_VERSION)\nendif`,
  ]]);
  writeFileSync(marker, `${linkerDigest}\n`);
}

function compilerPath(theos) {
  return join(theos, 'toolchain', 'windows', 'iphone', compilerDirectory);
}

function compilerFiles(theos) {
  const root = compilerPath(theos);
  return [join(root, 'bin', 'clang.exe'), join(root, 'lib', 'clang', '22', 'include', 'ptrauth.h')];
}

async function installCompiler(theos, bash, env) {
  const root = compilerPath(theos);
  if (!compilerFiles(theos).every(existsSync) || !existsSync(join(theos, compilerMarker))) {
    if (await digest(compilerBundle) !== compilerDigest) throw new Error('Bundled Clang checksum mismatch.');
    mkdirSync(root, { recursive: true });
    run('tar.exe', ['-xf', fileURLToPath(compilerBundle), '-C', root]);
    run(compilerFiles(theos)[0], ['--version'], { env, capture: true });
  }
  for (const name of ['win-theos-clang', 'win-theos-clang++']) {
    const wrapper = join(theos, 'bin', name);
    copyFileSync(new URL('./windows-clang.sh', import.meta.url), wrapper);
    run(bash, ['-c', 'chmod +x "$(cygpath -u "$1")"', 'win-theos', wrapper], { env });
  }
  const anchor = 'include $(THEOS_MAKE_PATH)/targets/_common/darwin_head.mk';
  applyPatch(join(theos, 'makefiles', 'targets', 'Windows', 'iphone.mk'), '# win-theos: compiler file arguments', [[anchor,
    ['# win-theos: compiler file arguments', 'TARGET_CC ?= $(THEOS_BIN_PATH)/win-theos-clang',
      'TARGET_CXX ?= $(THEOS_BIN_PATH)/win-theos-clang++', 'TARGET_LD ?= $(THEOS_BIN_PATH)/win-theos-clang', anchor].join('\n'),
  ]]);
  const common = join(theos, 'makefiles', 'common.mk');
  const objDir = 'ifneq ($(THEOS_TARGET_NAME),$(_THEOS_PLATFORM_DEFAULT_TARGET))\n\tTHEOS_OBJ_DIR_NAME ?= obj/';
  applyPatch(common, '# win-theos: architecture-specific build cache', [[objDir, [
    '# win-theos: architecture-specific build cache',
    'ifeq ($(THEOS_PLATFORM_NAME)-$(THEOS_TARGET_NAME),windows-iphone)',
    `THEOS_OBJ_DIR_NAME ?= obj/${compilerDirectory}/$(or $(strip $(THEOS_PACKAGE_SCHEME)),rootful)/$(subst $(_SPACE),-,$(strip $(ARCHS)))$(_THEOS_OBJ_DIR_EXTENSION)`,
    'endif',
    objDir,
  ].join('\n')]]);
  writeFileSync(join(theos, compilerMarker), `${compilerDigest}\n`);
}

function packagingSupportPresent(theos) {
  return [packagingMarker, 'vendor/mod/roothide/package/deb.mk',
    'vendor/lib/iphone/roothide/libroothide.tbd', 'include/roothide.h'].every(path => existsSync(join(theos, path)));
}

async function installPackagingSupport(theos) {
  if (packagingSupportPresent(theos)) return;
  if (await digest(rootHideBundle) !== rootHideDigest) throw new Error('Bundled RootHide support checksum mismatch.');
  run('tar.exe', ['-xf', fileURLToPath(rootHideBundle), '-C', theos]);

  const iphone = join(theos, 'makefiles', 'targets', 'Windows', 'iphone.mk');
  const commonIPhone = 'include $(THEOS_MAKE_PATH)/targets/_common/iphone.mk';
  const oldArchDefault = `${commonIPhone}\n# win-theos: dual-architecture defaults\nARCHS ?= arm64 arm64e`;
  const newArchDefault = '# win-theos: default architectures for the Windows linker';
  applyPatch(iphone, newArchDefault, [[readFileSync(iphone, 'utf8').includes(oldArchDefault) ? oldArchDefault : commonIPhone,
    `${newArchDefault}\nARCHS ?= arm64 arm64e\n${commonIPhone}`,
  ]]);

  const libroot = '_THEOS_INTERNAL_LDFLAGS += -lroot$(ABI_SUFFIX)';
  const prefixDefine = '_THEOS_INTERNAL_CFLAGS += -D THEOS_PACKAGE_INSTALL_PREFIX=';
  applyPatch(join(theos, 'makefiles', 'instance', 'rules.mk'), '# win-theos: RootHide libroot handling', [
    [libroot, ['# win-theos: RootHide libroot handling', 'ifneq ($(THEOS_PACKAGE_SCHEME),roothide)', libroot, 'endif'].join('\n')],
    [prefixDefine, `_THEOS_INTERNAL_CFLAGS += -D THEOS_PACKAGE_SCHEME_$(shell echo $(or $(THEOS_PACKAGE_SCHEME),rootful) | tr a-z A-Z)=1\n${prefixDefine}`],
  ]);
  const includeFlags = '_THEOS_INTERNAL_IFLAGS_BASE = ';
  applyPatch(join(theos, 'makefiles', 'common.mk'), '# win-theos: RootHide headers', [[includeFlags,
    `# win-theos: RootHide headers\n${includeFlags}$(if $(filter roothide,$(THEOS_PACKAGE_SCHEME)),-I$(THEOS_INCLUDE_PATH)/win-theos-roothide) `,
  ]]);
  writeFileSync(join(theos, packagingMarker), `${rootHideDigest}\n`);
}

function runtimePresent() {
  if (!existsSync(profilePath)) return false;
  let config;
  try {
    config = JSON.parse(readFileSync(profilePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (typeof config?.bash !== 'string' || typeof config.theos !== 'string') return false;
  const hostTools = ['make.exe', 'perl.exe', 'rsync.exe', 'ldid.exe'].map(name => join(dirname(config.bash), name));
  return [config.bash, ...hostTools, join(config.theos, 'bin', 'nic.pl'), join(config.theos, 'makefiles', 'common.mk'),
    join(config.theos, signerMarker),
    join(config.theos, compilerMarker),
    ...compilerFiles(config.theos),
    join(config.theos, 'toolchain', 'windows', 'iphone', 'bin', linkerMarker),
    join(config.theos, 'sdks', 'iPhoneOS16.5.sdk', 'SDKSettings.plist')].every(existsSync);
}

function acquireLock(path) {
  try {
    const descriptor = openSync(path, 'wx');
    writeFileSync(descriptor, `${process.pid}\n`);
    return descriptor;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(readFileSync(path, 'utf8'));
    if (Number.isInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (probeError) {
        if (probeError.code === 'ESRCH') {
          unlinkSync(path);
          return acquireLock(path);
        }
      }
    }
    throw new Error(`Another installation has a lock at ${path}.`);
  }
}

export async function bootstrap(automatic = false) {
  if (automatic && (process.platform !== 'win32' || process.arch !== 'x64' ||
      process.env.npm_config_global !== 'true' || process.env.WIN_THEOS_SKIP_BOOTSTRAP === '1' ||
      process.env.THEOS || existsSync(manualConfigPath))) return;
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The portable bootstrap is available on Windows x64. Use setup with your installed Theos elsewhere.');
  }
  const theos = join(runtime, 'theos');
  if (runtimePresent() && packagingSupportPresent(theos)) {
    console.log(`The Windows Theos environment is already ready at ${runtime}`);
    return;
  }
  if (/\s|[^\x20-\x7e]/.test(runtime)) {
    throw new Error('Set WIN_THEOS_HOME to an ASCII path without spaces, as required by Theos and MSYS2.');
  }
  mkdirSync(runtime, { recursive: true });
  const lock = join(runtime, 'bootstrap.lock');
  const handle = acquireLock(lock);
  try {
    if (runtimePresent()) {
      await installPackagingSupport(theos);
      console.log(`The Windows Theos environment is ready at ${runtime}`);
      return;
    }
    const msys = join(runtime, 'msys64');
    const msysBin = join(msys, 'usr', 'bin');
    const bash = join(msysBin, 'bash.exe');
    const env = { ...process.env, CHERE_INVOKING: '1', MSYSTEM: 'MSYS' };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'Path';
    env[pathKey] = [msysBin, env[pathKey]].filter(Boolean).join(';');
    const base = join(msys, '.win-theos-base');
    if (!existsSync(bash) || !existsSync(base)) {
      run(await download(msysRelease), ['-y', `-o${runtime}`]);
      if (!existsSync(bash) || !existsSync(join(msysBin, 'pacman.exe'))) {
        throw new Error(`MSYS2 extraction did not create a complete environment under ${msys}.`);
      }
      writeFileSync(base, `${msysRelease.sha256}\n`);
    }
    const packages = join(msys, '.win-theos-packages');
    if (!existsSync(packages)) {
      msysPackages(bash, env);
      writeFileSync(packages, 'git make perl rsync\n');
    }
    const git = join(msysBin, 'git.exe');
    prepareTheos(theos, git, env);
    const compiler = join(theos, 'toolchain', 'windows', 'iphone', 'bin', 'clang.exe');
    const compilerReady = join(theos, '.win-theos-llvm');
    if (!existsSync(compiler) || !existsSync(compilerReady)) {
      run('tar.exe', ['-xf', await download(clangRelease), '-C', theos]);
      writeFileSync(compilerReady, `${clangRelease.sha256}\n`);
    }
    await installLinker(theos);
    await installCompiler(theos, bash, env);
    await installPackagingSupport(theos);
    const sdkDir = join(theos, 'sdks');
    mkdirSync(sdkDir, { recursive: true });
    const sdkReady = join(sdkDir, '.win-theos-sdk16.5');
    if (!existsSync(sdkReady) || !existsSync(join(sdkDir, 'iPhoneOS16.5.sdk', 'SDKSettings.plist'))) {
      run('tar.exe', ['-xf', await download(sdkRelease), '-C', sdkDir]);
      writeFileSync(sdkReady, `${sdkRelease.sha256}\n`);
    }
    const signer = join(msysBin, 'ldid.exe');
    if (!existsSync(signer)) copyFileSync(await download(ldidRelease), signer);
    const wrapper = join(theos, 'bin', 'ldid');
    copyFileSync(new URL('./windows-ldid.sh', import.meta.url), wrapper);
    run(bash, ['-c', 'chmod +x "$(cygpath -u "$1")"', 'win-theos', wrapper], { env });
    writeFileSync(join(theos, signerMarker), '1\n');
    run(bash, ['--login', '-c', 'make --version && perl -c "$(cygpath -u "$1")" && rsync --version',
      'win-theos', join(theos, 'bin', 'nic.pl')], { env, capture: true });
    const profile = { engine: 'msys', bash, theos, 'portable-msys': true };
    const temporary = `${profilePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' });
      renameSync(temporary, profilePath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    console.log(`The Windows Theos environment is ready at ${runtime}`);
  } finally {
    closeSync(handle);
    unlinkSync(lock);
  }
}
