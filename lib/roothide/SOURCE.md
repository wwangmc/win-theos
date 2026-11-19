# RootHide support for the portable Windows toolchain

`theos-overlay.tar.gz` contains the upstream Theos package module, iPhone linker inputs, and headers from these revisions.

- The Theos package rules come from `vendor/mod/roothide`. [RootHide Theos revision](https://github.com/roothide/theos/tree/958fea4f779943505b15b93c88bb4db8d97b346d).
- The linker inputs come from `iphone/roothide`. The overlay stores copies of the upstream symlink targets for Windows. [RootHide linker inputs revision](https://github.com/roothide/lib/tree/85e9b5b8aff11bbefc59525c64c8f55149926e56).
- The header overlay includes `roothide.h`, `roothide/`, and the rootless compatibility headers. It puts the compatibility version of `rootless.h` in a directory used only for RootHide builds. [RootHide headers revision](https://github.com/roothide/headers/tree/e1132e2bbc3ca15c50e2311bcd349cb7353409e1).

The archive includes the source projects' license notices under `lib/win-theos-roothide-licenses/`.
