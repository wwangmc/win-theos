"""Replace existing payload files in a matching jailbreak DEB template on Windows."""

import argparse
import gzip
import hashlib
import io
import lzma
import re
import tarfile
from pathlib import Path, PurePosixPath

from work_dir import work_dir


def read_ar(data):
    if not data.startswith(b"!<arch>\n"):
        raise ValueError("Invalid DEB archive magic")
    offset = 8
    members = {}
    while offset < len(data):
        header = data[offset:offset + 60]
        length = int(header[48:58])
        end = offset + 60 + length
        name = header[:16].decode("ascii").strip().rstrip("/")
        if header[58:60] != b"`\n" or end > len(data) or not name or name in members:
            raise ValueError("Invalid or duplicate DEB member")
        members[name] = data[offset + 60:end]
        offset = end + length % 2
    if members.get("debian-binary") != b"2.0\n":
        raise ValueError("Expected Debian package format 2.0")
    return members


def write_ar(members):
    result = bytearray(b"!<arch>\n")
    for name, data in members.items():
        header = f"{name + '/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n"
        if len(header) != 60:
            raise ValueError(f"Invalid ar member name or size: {name}")
        result += header.encode("ascii")
        result += data
        if len(data) % 2:
            result += b"\n"
    return result


def member_name(path):
    value = PurePosixPath(path)
    if value.is_absolute() or ".." in value.parts or "\\" in path or not value.parts:
        raise ValueError(f"Use a package-relative POSIX path: {path}")
    return value.as_posix()


def archive_key(members, prefix):
    keys = [name for name in members if name == f"{prefix}.tar" or name.startswith(f"{prefix}.tar.")]
    if len(keys) != 1 or keys[0] not in (f"{prefix}.tar", f"{prefix}.tar.gz", f"{prefix}.tar.xz"):
        raise ValueError(f"Expected one {prefix}.tar member with gzip, xz or no compression")
    return keys[0]


def rewrite_tar(data, key, changes, optional=()):
    pending = changes.copy()
    output = io.BytesIO()
    with (tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as source,
          tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as target):
        for entry in source:
            name = PurePosixPath(entry.name).as_posix()
            if name in changes:
                if not entry.isfile() or name not in pending:
                    raise ValueError(f"Template has a non-file or duplicate replacement path: {name}")
                payload = pending.pop(name)(source.extractfile(entry).read())
                entry.size = len(payload)
                entry.pax_headers.pop("size", None)
                target.addfile(entry, io.BytesIO(payload))
            else:
                target.addfile(entry, source.extractfile(entry) if entry.isfile() else None)
    missing = pending.keys() - set(optional)
    if missing:
        raise ValueError(f"Missing file(s) in template {key}: {', '.join(sorted(missing))}")
    data = output.getvalue()
    if key.endswith(".gz"):
        return gzip.compress(data, mtime=0)
    if key.endswith(".xz"):
        return lzma.compress(data)
    return data


def field(control, key):
    matches = re.findall(rf"(?mi)^{re.escape(key)}:[ \t]*(.+?)[ \t]*$", control)
    if len(matches) != 1:
        raise ValueError(f"Expected one {key} field in control")
    return matches[0]


def update_control(data, args):
    original = data.decode("utf-8").replace("\r\n", "\n")
    package = field(original, "Package")
    arch = field(original, "Architecture")
    if (package, arch) != (args.package, args.architecture):
        raise ValueError(f"Template is {package} / {arch}, expected {args.package} / {args.architecture}")
    if args.control:
        new = args.control.read_text(encoding="utf-8-sig")
        if (field(new, "Package"), field(new, "Architecture")) != (package, arch):
            raise ValueError("Replacement control must keep the template package ID and architecture")
        field(new, "Version")
    else:
        if not re.fullmatch(r"[0-9][0-9A-Za-z.+:~\-]*", args.version):
            raise ValueError("Invalid version string")
        field(original, "Version")
        new = re.sub(r"(?mi)^Version:[^\n]+", lambda _: f"Version: {args.version}", original)
    return (new.rstrip("\n") + "\n").encode("utf-8")


def update_checksums(data, payloads):
    lines = []
    for line in data.decode("utf-8").splitlines():
        match = re.fullmatch(r"[0-9a-fA-F]{32} ([ *])(.+)", line)
        if not match:
            raise ValueError("Unexpected md5sums format in template")
        marker, path = match.groups()
        payload = payloads.get(member_name(path))
        digest = hashlib.md5(payload, usedforsecurity=False).hexdigest() if payload is not None else line[:32]
        lines.append(f"{digest} {marker}{path}\n")
    return "".join(lines).encode("utf-8")


def repack(args):
    if args.template.resolve() == args.output.resolve():
        raise ValueError("Choose an output other than the template")
    payloads = {}
    for archive_path, local_path in args.replace:
        name = member_name(archive_path)
        if name in payloads:
            raise ValueError(f"Repeated replacement path: {name}")
        payloads[name] = Path(local_path).read_bytes()

    members = read_ar(args.template.read_bytes())
    control_key = archive_key(members, "control")
    data_key = archive_key(members, "data")
    if set(members) != {"debian-binary", control_key, data_key}:
        raise ValueError("Template contains extra archive members; build a fresh package instead")
    control_changes = {"control": lambda data: update_control(data, args),
                       "md5sums": lambda data: update_checksums(data, payloads)}
    members[control_key] = rewrite_tar(members[control_key], control_key, control_changes, optional=("md5sums",))
    changes = {name: (lambda _, data=payload: data) for name, payload in payloads.items()}
    members[data_key] = rewrite_tar(members[data_key], data_key, changes)
    product = write_ar(members)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with work_dir(args.output.parent) as folder:
        temporary = folder / "package.deb"
        temporary.write_bytes(product)
        temporary.replace(args.output)
    print(f"{args.output}\nSHA256 {hashlib.sha256(product).hexdigest()}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--architecture", required=True)
    metadata = parser.add_mutually_exclusive_group(required=True)
    metadata.add_argument("--version")
    metadata.add_argument("--control", type=Path)
    parser.add_argument("--replace", nargs=2, metavar=("PACKAGE_PATH", "LOCAL_FILE"), action="append", required=True)
    args = parser.parse_args()
    try:
        repack(args)
    except (OSError, ValueError, tarfile.TarError, lzma.LZMAError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
