# Toolchain provenance

`clang-22.1.8-win64.tar.gz` contains `bin/clang.exe` and the unmodified `lib/clang/22/include` resource headers extracted from the official LLVM 22.1.8 Windows x64 installer. The upstream installer's SHA-256 is `16e5709785fef73c854646241c4a92c5cd574318d1b33c63330dd7721903e55c`. The bootstrap verifies the bundled archive before extracting it.

- [LLVM 22.1.8 release](https://github.com/llvm/llvm-project/releases/tag/llvmorg-22.1.8)

`libclang_rt.ios.a` provides the Darwin version checks emitted by Clang for `@available` and `__builtin_available`. It contains only `os_version_check.c` from LLVM 22.1.8 compiler-rt. It is compiled with Clang 22.1.8, the iPhoneOS 16.5 SDK and `-Oz -fvisibility=hidden` for `arm64-apple-ios7.0` and `arm64e-apple-ios14.0`. Each object is archived with `llvm-ar rcs`, then the two archives are combined with `lipo -create`.

- [LLVM 22.1.8 os_version_check.c](https://github.com/llvm/llvm-project/blob/llvmorg-22.1.8/compiler-rt/lib/builtins/os_version_check.c)

`ld64.lld.exe.gz` contains `ld.lld.exe` from the upstream LLVM Windows x64 build at commit `bf17b41685cc01ee80b5bf42e1064800bb869b6f`. LLD selects its Mach-O driver by the executable name `ld64.lld.exe`. The bootstrap decompresses and checks the binary SHA-256 before installing it.

- [LLVM source at this revision](https://github.com/llvm/llvm-project/tree/bf17b41685cc01ee80b5bf42e1064800bb869b6f)
- [Upstream Windows build run](https://github.com/llvm/llvm-project/actions/runs/43531271831)
- [License and LLVM exceptions](LICENSE.TXT)
