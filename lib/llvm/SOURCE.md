# Toolchain provenance

`clang-22.1.8-win64.tar.gz` contains `bin/clang.exe` and the unmodified `lib/clang/22/include` resource headers extracted from the official LLVM 22.1.8 Windows x64 installer. The upstream installer's SHA-256 is `16e5709785fef73c854646241c4a92c5cd574318d1b33c63330dd7721903e55c`. The bootstrap verifies the bundled archive before extracting it.

- [LLVM 22.1.8 release](https://github.com/llvm/llvm-project/releases/tag/llvmorg-22.1.8)

`ld64.lld.exe.gz` contains `ld.lld.exe` from the upstream LLVM Windows x64 build at commit `bf17b41685cc01ee80b5bf42e1064800bb869b6f`. LLD selects its Mach-O driver by the executable name `ld64.lld.exe`. The bootstrap decompresses and checks the binary SHA-256 before installing it.

- [LLVM source at this revision](https://github.com/llvm/llvm-project/tree/bf17b41685cc01ee80b5bf42e1064800bb869b6f)
- [Upstream Windows build run](https://github.com/llvm/llvm-project/actions/runs/43531271831)
- [License and LLVM exceptions](LICENSE.TXT)
