# win-theos

Windows 上的 iOS Theos 命令行工具。用 `theos init` 从 NIC 模板生成项目，在项目目录运行 `theos package` 即可构建 rootful、rootless 和 RootHide 安装包。

Windows CLI for scaffolding iOS Theos projects and building jailbreak packages from existing Makefiles.

支持 Theos 的 App、CLI 工具、库、Framework、偏好设置面板、XPC、tweak、自定义模板和 aggregate 子项目。构建使用项目自身的 Makefile、资源、签名和封包规则。[Theos NIC 模板](https://theos.dev/docs/nic) · [Theos 命令](https://theos.dev/docs/commands)

## 安装和设置

需要 Node.js 20+。Windows x64 首次全局安装时，会自动配置便携版 MSYS2、Theos、Clang、iPhoneOS 16.5 SDK 和签名工具。

```powershell
npm.cmd install -g --foreground-scripts win-theos
theos.cmd doctor
```

工具链放在 `%LOCALAPPDATA%\win-theos\runtime-v1`，原始下载包默认缓存到 `%LOCALAPPDATA%\win-theos\downloads`。`WIN_THEOS_HOME` 可指定一个无空格的 ASCII 路径，`WIN_THEOS_DOWNLOAD_CACHE` 可单独指定下载缓存。已有手动配置或 `THEOS` 环境变量时，全局安装沿用现有环境。npm 包包含 Clang 22.1.8、Mach-O 链接器和 RootHide 组件，首次初始化还需要访问 GitHub 和 MSYS2。安装时禁用脚本或初始化中断后，可以运行 `theos.cmd bootstrap`。[npm 安装脚本](https://docs.npmjs.com/using-npm/scripts/) · [MSYS2 便携发行版](https://www.msys2.org/docs/installer/)

`setup` 用于手动选择已有的 Theos 环境，`doctor` 检查 GNU Make、Perl 和 NIC。

```powershell
# Windows 上不使用 WSL。指定已配置好 iOS 交叉工具链的 MSYS2 Theos。
win-theos.cmd setup --engine msys --bash 'C:\msys64\usr\bin\bash.exe' --theos 'C:\toolchains\theos'
win-theos.cmd doctor
```

也可指定 `--bin-dir` 添加额外工具目录，或指定 `--make` 选择 GNU Make。Theos SDK、编译器、签名工具和 Make 依赖由这套环境提供。原生 Windows 可用为 MSYS2 配置的 Theos，例如 [TheosWin](https://github.com/CacheW/TheosWin)。项目要调用 Apple 的 `actool`、`ibtool` 或 `xcodebuild` 时，用 macOS 上的 Theos 环境执行相应构建。[Xcode 命令行工具](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)

```powershell
# Windows 上使用已有 WSL 环境的另一种配置
win-theos.cmd setup --engine wsl --distro Ubuntu --theos /opt/theos
```

在 macOS 或 Linux 上，可用 `win-theos setup --engine local --theos /opt/theos`，也可直接使用环境变量 `THEOS`。Windows 的配置文件位于 `%LOCALAPPDATA%\win-theos\theos.json`，可用 `WIN_THEOS_CONFIG` 覆盖。Theos 项目路径应避免空格，遵循所用 Makefile 的路径规则。

## 生成项目

`init` 打开当前 Theos 安装里的模板菜单。`theos` 和 `win-theos` 都可以调用这个入口。也可以指定官方模板或自己的 NIC 文件。模板需要的信息由 NIC 继续询问，项目在当前目录生成。用 `--project` 指定其他父目录。

```powershell
win-theos.cmd init
win-theos.cmd init --template iphone/application_modern --name MyApp --package com.example.myapp --author Developer
win-theos.cmd init --template iphone/tool --name MyTool --package com.example.mytool --author Developer
win-theos.cmd init --nic .\CompanyTemplate.nic.tar --name MyProject
```

在 `theos init` 的菜单中选择 `demo`，也可以直接生成。模板只注入 SpringBoard，每次 SpringBoard 启动后通过系统弹窗显示一次 **Hello World**，点 **OK** 关闭。项目包含 arm64 和 arm64e。

```powershell
theos.cmd init --template demo --name Demo --package com.example.demo --author Developer
cd .\Demo
theos.cmd package
```

## 构建现有项目

进入含有 Makefile 的项目目录后运行 `theos package`。默认按下表顺序执行三次 `make package`。每种模式使用独立的构建缓存和默认输出子目录。某种模式构建失败后仍会尝试其余模式，最终返回失败状态并列出各模式的结果。`--project` 可从其他目录指定项目。

| 模式 | 传给 Make 的 `TYPE` | 默认产物目录 |
| --- | --- | --- |
| rootful | `0` | `packages/rootful/` |
| rootless | `1` | `packages/rootless/` |
| RootHide | `2` | `packages/roothide/` |

官方 NIC 模板通过 `common.mk` 读取 `THEOS_PACKAGE_SCHEME`。该变量决定链接路径、安装前缀和 DEB 架构。Makefile 可以按模式额外配置项目的依赖、路径或编译参数。便携 Windows 工具链内置 RootHide 构建支持，自备的 Theos 需要安装对应的 RootHide 模块和依赖。[Theos rootless 规则](https://theos.dev/docs/rootless) · [RootHide 打包说明](https://github.com/roothide/Developer)

`build` 对应 `make all`，`stage` 对应 `make stage`，`make` 可转发任意目标和参数。CLI 使用项目自身的架构设置，`--archs` 可覆盖该设置。

```powershell
win-theos.cmd build
win-theos.cmd package --scheme rootless --archs 'arm64 arm64e' -- FINALPACKAGE=1
win-theos.cmd clean
win-theos.cmd make -- -j4 package
```

用 `--scheme` 只构建指定的 `THEOS_PACKAGE_SCHEME`。也可以显式转发 `THEOS_PACKAGE_SCHEME`，或者在支持 `TYPE` 的项目中用 `TYPE` 单独选一种模式。单模式构建沿用项目的原有输出目录。

```powershell
theos.cmd package -- TYPE=1 FINALPACKAGE=1
```

自动安装的便携环境会给 Mach-O 可执行文件和 Debian 维护脚本保留所需的执行位。使用自备 MSYS2 环境时，封包权限由该环境的 Theos 和打包工具处理。

从 0.3.1 起，便携 Windows 环境使用 Clang 22.1.8。iOS 项目未指定架构时默认构建 arm64 和 arm64e，同一个 dylib 内包含两个切片。项目自己的架构配置和命令行 `--archs` 可以覆盖默认值。默认对象目录按编译器版本、封包模式和项目的 `ARCHS` 区分。手动指定编译器、对象目录或修改单个子项目的架构时，切换前可执行 `win-theos.cmd clean`。

rootful、rootless 和 RootHide 的安装路径和包架构各自独立。项目只在所选模式的依赖和设备环境匹配时运行，使用绝对越狱路径的源码及安装脚本需要按相应模式适配。

从 0.4.2 起，便携 Windows 环境会安装 Objective-C `@available` 和 `__builtin_available` 所需的 iOS 版本检查运行库，支持 arm64 和 arm64e。升级 CLI 时会给已有便携环境补齐该运行库。

## 独立的原生 tweak 流程

上一版的 Windows Python 构建流程可通过 `win-theos native` 继续使用。它适用于简单 `.x`、`.xm` 注入项目，可用现有的 `WIN_IOS_TWEAK_CONFIG`。需要 GNU Make 规则、其他项目类型或多子项目时，从上面的 `init` 和 `package` 入口运行 Theos。

```powershell
win-theos.cmd native setup --sdk 'C:\toolchains\iPhoneOS16.5.sdk' --sdk-version 16.5 --logos 'C:\toolchains\logos\bin\logos.pl'
win-theos.cmd native doctor
win-theos.cmd native init MyTweak --bundle com.apple.Preferences
cd MyTweak
win-theos.cmd native build
```

若工具不在 `PATH`，`native setup` 还可传 `--clang`、`--linker`、`--ipsw`、`--perl`、`--python`、`--resource-dir` 和 `--perl-include`。默认的独立流程把 `.deb` 放在 `dist\`，使用 Theos 的项目按其自己的 `THEOS_PACKAGE_DIR` 输出，通常为 `packages\`。

## Agent Skill

仓库提供可单独使用的 `win-theos` Skill，覆盖工具链检查、模板选择、三模式打包和产物验证。把 `skills/win-theos` 复制到支持 `SKILL.md` 的 agent 的技能目录。Codex 用户可以放到 `~/.codex/skills/win-theos`，然后使用 `$win-theos`。npm 安装包也包含同一个 Skill。[查看 SKILL.md](skills/win-theos/SKILL.md)

## 从源码安装

在仓库根目录生成 npm 安装包，再用 npm 全局安装。

```powershell
New-Item -ItemType Directory -Force dist
npm.cmd pack --pack-destination dist
npm.cmd install -g --foreground-scripts .\dist\win-theos-0.4.2.tgz
theos.cmd doctor
```

## 许可证

win-theos 的源码、模板、文档和 Skill 采用 MIT 许可证。随包工具和上游文件遵循各自的许可证。[MIT](LICENSE) · [LLVM 组件与许可](lib/llvm/SOURCE.md) · [RootHide 组件与许可](lib/roothide/SOURCE.md)
