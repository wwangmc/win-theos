"""Build, sign and check iOS executables and Logos tweaks on Windows."""

import argparse
import hashlib
import lzma
import plistlib
import struct
import subprocess
import tarfile
from pathlib import Path

from tweak_package import stage_tweak, write_tweak_package
from work_dir import work_dir


def require(condition, message):
    if not condition:
        raise ValueError(message)


def slices(image):
    magic = image[:4]
    if magic == b"\xcf\xfa\xed\xfe":
        return [image]
    require(magic == b"\xca\xfe\xba\xbe", "Expected a little-endian Mach-O or FAT32 Mach-O")
    count, = struct.unpack_from(">I", image, 4)
    result = []
    for index in range(count):
        _, _, start, size, exponent = struct.unpack_from(">5I", image, 8 + 20 * index)
        require(exponent <= 31 and start % (1 << exponent) == 0, "Misaligned Mach-O slice")
        require(start + size <= len(image), "Truncated Mach-O slice")
        result.append(image[start:start + size])
    require(result, "Missing Mach-O slices")
    return result


def architecture(image):
    magic, cpu, subtype = struct.unpack_from("<3I", image)
    require(magic == 0xFEEDFACF and cpu == 0x0100000C, "Expected an Apple ARM64 Mach-O")
    require(subtype & 0xFF in (0, 2), f"Unexpected ARM CPU subtype 0x{subtype:08x}")
    if subtype & 0xFF == 0:
        return "arm64"
    require(subtype & 0x80000000, "arm64e slice lacks the modern pointer-authentication ABI flag")
    return "arm64e"


def load_commands(image):
    count, = struct.unpack_from("<I", image, 16)
    position = 32
    for _ in range(count):
        command, length = struct.unpack_from("<2I", image, position)
        require(length >= 8 and position + length <= len(image), "Invalid Mach-O load command")
        yield command, image[position:position + length]
        position += length


def signature_slots(image):
    for command, data in load_commands(image):
        if command == 0x1D:  # LC_CODE_SIGNATURE
            start, size = struct.unpack_from("<2I", data, 8)
            signature = image[start:start + size]
            magic, total, slots = struct.unpack_from(">3I", signature)
            require(magic == 0xFADE0CC0 and total <= len(signature), "Invalid embedded signature")
            result = {}
            for index in range(slots):
                slot, offset = struct.unpack_from(">2I", signature, 12 + 8 * index)
                _, size = struct.unpack_from(">2I", signature, offset)
                require(size >= 8 and offset + size <= total, "Invalid signature slot")
                result[slot] = signature[offset:offset + size]
            return start, result
    raise ValueError("Mach-O has no embedded code signature")


def entitlements_der(slots, expected):
    xml = slots.get(5, b"")
    require(xml.startswith(b"\xfa\xde\x71\x71"), "Signature is missing XML entitlements")
    require(plistlib.loads(xml[8:]) == expected, "Signed XML differs from requested entitlements")
    der = slots.get(7, b"")
    require(len(der) > 8 and der.startswith(b"\xfa\xde\x71\x72"), "Signature is missing DER entitlements")
    return der[8:]


def read_der(path, expected):
    payloads = [entitlements_der(signature_slots(image)[1], expected) for image in slices(path.read_bytes())]
    require(all(payload == payloads[0] for payload in payloads), "DER entitlements differ between architectures")
    return payloads[0]


def verify(path, expected, der, arches=None, kind=None, install_name=None):
    found = []
    for image in slices(path.read_bytes()):
        arch = architecture(image)
        found.append(arch)
        if kind:
            file_type, = struct.unpack_from("<I", image, 12)
            require(file_type == {"executable": 2, "dylib": 6}[kind], f"Expected a Mach-O {kind} in {arch}")
        if install_name:
            names = []
            for command, data in load_commands(image):
                if command == 0xD:  # LC_ID_DYLIB
                    offset, = struct.unpack_from("<I", data, 8)
                    names.append(data[offset:].split(b"\0", 1)[0])
            require(names == [install_name.encode()], f"Unexpected dylib install name in {arch}")
        start, slots = signature_slots(image)
        entitlement_slots = (5, 7) if expected is not None else ()
        if expected is not None:
            require(entitlements_der(slots, expected) == der, f"{arch} DER differs from the reference")
        else:
            require(5 not in slots and 7 not in slots, f"{arch} contains unexpected entitlements")
        directory = slots.get(0, b"")
        require(directory.startswith(b"\xfa\xde\x0c\x02"), f"{arch} is missing its CodeDirectory")
        hashes, _, special, pages, limit = struct.unpack_from(">5I", directory, 16)
        size, hash_kind, _, shift = struct.unpack_from("4B", directory, 36)
        require((size, hash_kind) == (32, 2) and shift <= 24, "Expected a SHA-256 CodeDirectory from ipsw")
        page_size = 1 << shift
        require(limit == start and special >= max(entitlement_slots, default=0)
                and pages == (limit + page_size - 1) // page_size,
                "Unexpected CodeDirectory bounds")
        for number in entitlement_slots:
            offset = hashes - number * size
            require(directory[offset:offset + size] == hashlib.sha256(slots[number]).digest(),
                    f"{arch} entitlement hash mismatch in slot {number}")
        for number in range(pages):
            offset = hashes + number * size
            data = image[number * page_size:min((number + 1) * page_size, limit)]
            require(directory[offset:offset + size] == hashlib.sha256(data).digest(),
                    f"{arch} CodeDirectory hash mismatch on page {number}")
    require(len(found) == len(set(found)), "Duplicate Mach-O architecture")
    if arches:
        require(set(found) == set(arches), f"Found {found}, expected {arches}")
    print(f"Verified {path} ({', '.join(found)})")


def run(*command):
    subprocess.run(command, check=True)


def prepare_sources(args, scratch):
    sources = []
    for index, source in enumerate(args.source):
        suffix = source.suffix.lower()
        if suffix in (".xi", ".xmi"):
            raise ValueError(f"{source} needs C preprocessing before Logos. Use the project rules or pass the generated source.")
        if suffix in (".x", ".xm"):
            require(args.perl and args.logos, "Provide --perl and --logos for .x/.xm inputs")
            language = ".m" if suffix == ".x" else ".mm"
            generated = scratch / f"logos-{index}{language}"
            command = [args.perl, *(f"-I{path}" for path in args.perl_include),
                       args.logos.resolve().as_posix(), source.resolve().as_posix()]
            with generated.open("wb") as stream:
                subprocess.run(command, stdout=stream, check=True)
            require(generated.stat().st_size > 0, f"Logos generated no source from {source}")
            sources.append((generated, ["-iquote", source.resolve().parent]))
        else:
            sources.append((source, []))
    return sources


def build(args, expected, der, scratch):
    signing_flags = []
    if expected is not None:
        der_file = scratch / "entitlements.der"
        der_file.write_bytes(der)
        signing_flags = ["--ent", args.entitlements, "--ent-der", der_file]
    sources = prepare_sources(args, scratch)
    signed = []
    for arch in args.arch:
        compile_flags = ["-target", f"{arch}-apple-ios{args.min_ios}", "-isysroot", args.sdk, "-O2", "-fblocks"]
        if args.resource_dir:
            compile_flags.extend(["-resource-dir", args.resource_dir])
        for include in args.include:
            compile_flags.extend(["-I", include])
        objects = []
        for index, (source, quote_flags) in enumerate(sources):
            obj = scratch / f"{arch}-{index}.o"
            objc = ["-fobjc-arc"] if source.suffix.lower() in (".m", ".mm") else []
            run(args.clang, *compile_flags, *quote_flags, *objc, *args.compile_arg, "-c", source, "-o", obj)
            objects.append(obj)

        link_flags = ["-arch", arch, "-platform_version", "ios", args.min_ios, args.sdk_version,
                      "-syslibroot", args.sdk, "-adhoc_codesign", "-dead_strip", "-lSystem", "-lobjc"]
        if args.kind == "dylib":
            link_flags.extend(["-dylib", "-install_name", args.install_name])
        if arch == "arm64e":
            link_flags.append("-fixup_chains")
        if args.info_plist:
            link_flags.extend(["-sectcreate", "__TEXT", "__info_plist", args.info_plist])
        for framework in args.framework:
            link_flags.extend(["-framework", framework])
        thin = scratch / arch
        run(args.linker, *link_flags, *args.link_arg, *objects, "-o", thin)
        output = scratch / f"{arch}.signed"
        run(args.ipsw, "macho", "sign", "--ad-hoc", "--id", args.identity, *signing_flags,
            "--output", output, "--overwrite", thin)
        signed.append(output)

    product = signed[0]
    if len(signed) > 1:
        product = scratch / "universal"
        run(args.ipsw, "macho", "bbl", *signed, "--output", product)
    verify(product, expected, der, args.arch, args.kind, args.install_name)
    return product


def add_signature_arguments(parser):
    parser.add_argument("--entitlements", type=Path, help="XML permissions to sign with, when needed")
    reference = parser.add_mutually_exclusive_group()
    reference.add_argument("--der", type=Path, help="Raw DER from a trusted ldid/codesign result")
    reference.add_argument("--der-from", type=Path, help="Mach-O signed with the exact same entitlement plist")


def add_build_arguments(builder):
    for name in ("clang", "linker", "ipsw", "sdk", "output"):
        builder.add_argument(f"--{name}", type=Path, required=True)
    builder.add_argument("--identity", help="Code-signing identifier")
    builder.add_argument("--min-ios", default="14.0")
    builder.add_argument("--sdk-version", required=True)
    builder.add_argument("--arch", choices=["arm64", "arm64e"], action="append")
    builder.add_argument("--resource-dir", type=Path)
    builder.add_argument("--source", type=Path, action="append", required=True)
    builder.add_argument("--include", type=Path, action="append", default=[])
    builder.add_argument("--info-plist", type=Path)
    builder.add_argument("--install-name", help="Mach-O install name for a dylib")
    builder.add_argument("--perl", type=Path, help="Windows Perl executable for Logos")
    builder.add_argument("--logos", type=Path, help="Path to Logos bin/logos.pl")
    builder.add_argument("--perl-include", action="append", default=[], help="Extra Perl module path")
    for name in ("framework", "compile-arg", "link-arg"):
        builder.add_argument(f"--{name}", action="append", default=[])
    add_signature_arguments(builder)


def signature_inputs(args):
    if args.entitlements is None:
        require(not (args.der or args.der_from), "DER inputs require --entitlements")
        return None, None
    expected = plistlib.loads(args.entitlements.read_bytes())
    require(args.der or args.der_from, "Supply --der or --der-from with --entitlements")
    der = read_der(args.der_from, expected) if args.der_from else args.der.read_bytes()
    require(der, "DER payload is empty")
    return expected, der


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    extract = commands.add_parser("extract-der", help="Extract raw DER from a Mach-O with matching XML")
    extract.add_argument("binary", type=Path)
    extract.add_argument("--entitlements", type=Path, required=True)
    extract.add_argument("--output", type=Path, required=True)

    verify_parser = commands.add_parser("verify", help="Check architecture, file type and signature hashes")
    verify_parser.add_argument("binary", type=Path)
    verify_parser.add_argument("--arch", action="append", choices=["arm64", "arm64e"])
    verify_parser.add_argument("--kind", choices=["executable", "dylib"])
    add_signature_arguments(verify_parser)

    builder = commands.add_parser("build", help="Compile, link, sign and verify a Mach-O")
    add_build_arguments(builder)
    builder.add_argument("--kind", choices=["executable", "dylib"], default="executable")

    tweak = commands.add_parser("build-tweak", help="Build and package an injectable tweak as a DEB")
    add_build_arguments(tweak)
    tweak.set_defaults(kind="dylib")
    tweak.add_argument("--name", required=True, help="File stem shared by the dylib and injection plist")
    tweak.add_argument("--control", type=Path, required=True, help="Project Debian control file")
    tweak.add_argument("--filter", type=Path, required=True, help="Project injection plist (XML, binary or OpenStep)")
    tweak.add_argument("--scheme", choices=["rootful", "rootless", "roothide"], required=True)
    tweak.add_argument("--install-dir", help="Override the package-relative injection directory")
    tweak.add_argument("--template", type=Path, help="Reuse a matching existing DEB layout and maintainer scripts")

    args = parser.parse_args()
    try:
        if args.command == "extract-der":
            expected = plistlib.loads(args.entitlements.read_bytes())
            args.output.write_bytes(read_der(args.binary, expected))
            print(f"Wrote {args.output}")
            return
        expected, der = signature_inputs(args)
        if args.command == "verify":
            verify(args.binary, expected, der, args.arch, args.kind)
            return
        args.arch = args.arch or ["arm64", "arm64e"]
        require(len(set(args.arch)) == len(args.arch), "Specify each architecture once")
        require("arm64e" not in args.arch or int(args.min_ios.split(".")[0]) >= 14,
                "This arm64e build requires an iOS 14.0 or later deployment target")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with work_dir(args.output.parent) as scratch:
            if args.command == "build-tweak":
                plan = stage_tweak(args)
                args.identity = args.identity or plan.package
                args.install_name = args.install_name or f"@rpath/{args.name}.dylib"
                dylib = build(args, expected, der, scratch)
                write_tweak_package(args, plan, dylib, scratch)
            else:
                require(args.identity, "Provide --identity for a standalone binary")
                require((args.kind == "dylib") == bool(args.install_name),
                        "Provide --install-name when building a dylib")
                product = build(args, expected, der, scratch)
                product.replace(args.output)
                print(f"Wrote {args.output}")
    except (OSError, ValueError, KeyError, struct.error, tarfile.TarError, lzma.LZMAError,
            subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
