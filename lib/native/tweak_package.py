"""Stage an injection dylib and filter in a minimal or existing jailbreak package."""

import argparse
import gzip
import hashlib
import io
import plistlib
import re
import tarfile
from pathlib import PurePosixPath
from typing import NamedTuple

from repack_deb import field, member_name, repack, write_ar


class TweakPackage(NamedTuple):
    package: str
    architecture: str
    control: bytes
    dylib_path: str
    filter_path: str
    filter_data: bytes


def stage_tweak(args):
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.+\-]*", args.name):
        raise ValueError("--name must be a filename stem without slashes or spaces")
    if args.output.suffix.lower() != ".deb":
        raise ValueError("Use a .deb path for --output")
    if args.template and args.template.resolve() == args.output.resolve():
        raise ValueError("Choose an output other than the template")

    architecture = {"rootful": "iphoneos-arm", "rootless": "iphoneos-arm64", "roothide": "iphoneos-arm64e"}[args.scheme]
    default_directory = "Library/MobileSubstrate/DynamicLibraries"
    if args.scheme == "rootless":
        default_directory = f"var/jb/{default_directory}"
    if args.scheme == "roothide" and not args.install_dir:
        raise ValueError("For RootHide provide --install-dir from the target loader layout or template")
    install_dir = member_name(args.install_dir or default_directory)

    control = args.control.read_text(encoding="utf-8-sig")
    package = field(control, "Package")
    if not re.fullmatch(r"[a-z0-9][a-z0-9+.\-]+", package):
        raise ValueError("Invalid Debian package identifier")
    if not re.fullmatch(r"[0-9][0-9A-Za-z.+:~\-]*", field(control, "Version")):
        raise ValueError("Invalid Debian package version")
    field(control, "Maintainer")
    field(control, "Description")
    field(control, "Architecture")
    control = re.sub(r"(?mi)^Architecture:[^\n]+", f"Architecture: {architecture}", control)

    filters = args.filter.read_bytes()
    probe = filters.removeprefix(b"\xef\xbb\xbf").lstrip()
    if not probe:
        raise ValueError("The injection filter is empty")
    if probe.startswith((b"<", b"bplist")):
        parsed = plistlib.loads(probe)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("Filter"), dict) or not parsed["Filter"]:
            raise ValueError("Expected a property list with a nonempty Filter dictionary")
    return TweakPackage(package, architecture, (control.rstrip("\n") + "\n").encode(),
                        f"{install_dir}/{args.name}.dylib", f"{install_dir}/{args.name}.plist", filters)


def tar_gzip(files):
    serialized = io.BytesIO()
    with tarfile.open(fileobj=serialized, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        directories = {parent.as_posix() for path in files for parent in PurePosixPath(path).parents}
        for path in sorted(directories):
            entry = tarfile.TarInfo(path)
            entry.type = tarfile.DIRTYPE
            entry.mode = 0o755
            entry.uname, entry.gname = "root", "wheel"
            archive.addfile(entry)
        for path, (data, mode) in files.items():
            entry = tarfile.TarInfo(path)
            entry.uname, entry.gname = "root", "wheel"
            entry.mode = mode
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return gzip.compress(serialized.getvalue(), mtime=0)


def write_tweak_package(args, plan, dylib, scratch):
    if args.template:
        control_file = scratch / "control"
        control_file.write_bytes(plan.control)
        filter_file = scratch / "filter.plist"
        filter_file.write_bytes(plan.filter_data)
        repack(argparse.Namespace(template=args.template, output=args.output, package=plan.package,
                                  architecture=plan.architecture, control=control_file,
                                  replace=[(plan.dylib_path, dylib), (plan.filter_path, filter_file)]))
        return

    payloads = {plan.dylib_path: (dylib.read_bytes(), 0o755), plan.filter_path: (plan.filter_data, 0o644)}
    checksums = "".join(f"{hashlib.md5(data, usedforsecurity=False).hexdigest()}  {path}\n"
                        for path, (data, _) in payloads.items()).encode()
    product = write_ar({"debian-binary": b"2.0\n",
                        "control.tar.gz": tar_gzip({"control": (plan.control, 0o644), "md5sums": (checksums, 0o644)}),
                        "data.tar.gz": tar_gzip(payloads)})
    temporary = scratch / "package.deb"
    temporary.write_bytes(product)
    temporary.replace(args.output)
    print(f"{args.output}\nSHA256 {hashlib.sha256(product).hexdigest()}")
