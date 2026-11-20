---
name: win-theos
description: Generate, build, and package iOS Theos projects on Windows, or install a built DEB on a jailbroken device via agent_ios. Use for NIC templates, Logos tweaks, Theos Makefiles, and rootful, rootless, or RootHide packages.
---

# win-theos

Use the installed CLI and the project's Makefile. Inspect the existing `Makefile`, `control`, and any custom package rules before changing an existing project.

## Set up the toolchain

- Check `theos.cmd --version` and `theos.cmd doctor`. You can also use `win-theos.cmd`. Windows x64 with Node.js 20 or newer supports portable bootstrap.
- When installing the CLI, use `npm.cmd install -g --foreground-scripts win-theos`. The global install runs the bootstrap in `postinstall`. It may report a bootstrap failure even when npm installs the CLI successfully. Run `theos.cmd bootstrap` to resume and `theos.cmd doctor` to check it.
- The portable environment lives under `%LOCALAPPDATA%\win-theos\runtime-v1`. Set `WIN_THEOS_HOME` to an ASCII path without spaces when the default path is unsuitable. A manual `theos setup` configuration or `THEOS` environment variable selects an existing toolchain.

## Generate or build a project

Use `theos.cmd init` for the NIC menu. Select the template that fits the target. `demo` is a SpringBoard tweak that displays Hello World after SpringBoard launches. Official NIC templates use names such as `iphone/application_modern`, `iphone/tool`, and `iphone/tweak`. NIC can prompt for template-specific inputs.

```powershell
theos.cmd init --template demo --name Demo --package com.example.demo --author Developer
Set-Location .\Demo
theos.cmd package
```

`theos.cmd package` in the project directory runs rootful, rootless, and RootHide by default. It passes `TYPE=0`, `TYPE=1`, and `TYPE=2` along with the corresponding `THEOS_PACKAGE_SCHEME`. By default, the resulting files go to `packages/rootful`, `packages/rootless`, and `packages/roothide`. The command reports the result of every attempted mode and returns a failure code if any mode fails.

- Use `theos.cmd package --scheme rootless` for one mode. For a Makefile whose own `TYPE` conditionals control extra settings, use its documented `TYPE` argument, for example `theos.cmd package -- TYPE=1`.
- Add `--project <dir>` to operate from a different working directory. Put additional Make arguments after `--`, for example `theos.cmd package -- FINALPACKAGE=1`.
- Official templates load the package scheme through `common.mk`. Add Makefile conditionals only when project dependencies, paths, or flags need mode-specific values. A custom Theos installation needs its own RootHide module to produce that mode.
- Inspect the generated `.deb` files and report which modes passed. Verify the actual Mach-O slices when architecture coverage is requested. Device installation and runtime behavior require separate verification.

## Install a built DEB

Check that `theos.cmd --help` lists `install`. The `theos.cmd` and `win-theos.cmd` aliases use the same CLI. For an older global copy, use the updated checkout's `node <absolute-path-to-bin/theos.js> install ...` or install an updated build of the CLI.

Use `theos.cmd install --scheme rootless` to select the latest rootless DEB or `theos.cmd install <path-to.deb>` to select an exact artifact. Match the package scheme to the phone. The phone needs a running `agent_ios` installation and the computer needs Python 3.10+.

Connect and unlock the phone, then complete computer trust. By default, the command opens a USB forward from `127.0.0.1:9191` to port `9191` on the phone and closes it on exit. Windows uses Apple Mobile Device Service. For multiple connected devices, pass `--udid <device>`. If the local port is busy, set `AGENT_IOS_LOCAL_PORT` to a free port. An explicit `AGENT_IOS_URL` uses that MCP endpoint directly.

The command verifies the `dpkg` exit code and current package identity and status. If an installation was submitted and the outcome is uncertain, use `theos.cmd install --job-id <id>` to continue verification.

See the CLI reference for custom toolchains and other build commands. [win-theos README](https://github.com/wwangmc/win-theos#readme)
