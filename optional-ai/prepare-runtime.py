#!/usr/bin/env python3
"""Rebuild the fixed Windows x64 filename-embedding runtime from pinned sources."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import tempfile
import urllib.request

SOURCES = {
    "transformers": {
        "url": "https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz",
        "sha512": "8BRCoBMH0XsWaEIamuR0LrJGAfftgHAfb2Vrffy0VKlSAE/MnUJ5/h/zTfEP3fDIft+nk7TqB8xXEyABGitBjQ==",
    },
    "onnxruntime-node": {
        "url": "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.24.3.tgz",
        "sha512": "JH7+czbc8ALA819vlTgcV+Q214/+VjGeBHDjX81+ZCD0PCVCIFGFNtT0V4sXG/1JXypKPgScQcB3ij/hk3YnTg==",
    },
    "onnxruntime-common": {
        "url": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.3.tgz",
        "sha512": "GeuPZO6U/LBJXvwdaqHbuUmoXiEdeCjWi/EG7Y1HNnDwJYuk6WUbNXpF6luSUY8yASul3cmUlLGrCCL1ZgVXqA==",
    },
}
NOTICE_FILES = {
    "LICENSE.onnxruntime.txt": (
        "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/LICENSE",
        "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c",
    ),
    "ThirdPartyNotices.onnxruntime.txt": (
        "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/ThirdPartyNotices.txt",
        "0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2",
    ),
}
MAX_DOWNLOAD = 512 * 1024 * 1024
MAX_MEMBER = 128 * 1024 * 1024


def download(url, expected_digest, algorithm, destination):
    digest = hashlib.new(algorithm)
    total = 0
    with urllib.request.urlopen(url, timeout=60) as response, destination.open("wb") as stream:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_DOWNLOAD:
                raise RuntimeError(f"download exceeds {MAX_DOWNLOAD} bytes: {url}")
            digest.update(chunk)
            stream.write(chunk)
    actual = base64.b64encode(digest.digest()).decode() if algorithm == "sha512" else digest.hexdigest()
    if actual != expected_digest:
        raise RuntimeError(f"digest mismatch: {url}")


def safe_relative(member_name):
    parts = PurePosixPath(member_name).parts
    if not parts or parts[0] != "package" or any(part in ("", ".", "..") for part in parts):
        raise RuntimeError(f"unsafe tar path: {member_name}")
    return parts[1:]


def selected(component, parts):
    joined = "/".join(parts)
    if component == "transformers":
        return joined in ("dist/transformers.node.mjs", "LICENSE")
    if component == "onnxruntime-node":
        return joined == "package.json" or (joined.startswith("dist/") and joined.endswith(".js")) or joined in (
            "bin/napi-v6/win32/x64/onnxruntime_binding.node",
            "bin/napi-v6/win32/x64/onnxruntime.dll",
        )
    return component == "onnxruntime-common" and (
        joined in ("package.json", "dist/cjs/package.json", "dist/esm/package.json") or
        ((joined.startswith("dist/cjs/") or joined.startswith("dist/esm/")) and joined.endswith(".js"))
    )


def output_path(component, parts):
    joined = Path(*parts)
    if component == "transformers":
        return Path("transformers.node.mjs") if parts[-1] != "LICENSE" else Path("LICENSE.transformers.txt")
    return Path("node_modules") / component / joined


def extract_selected(archive_path, component, output):
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            parts = safe_relative(member.name)
            if not selected(component, parts):
                continue
            if not member.isfile() or member.issym() or member.islnk() or member.size > MAX_MEMBER:
                raise RuntimeError(f"refused tar member: {member.name}")
            destination = (output / output_path(component, parts)).resolve()
            if output.resolve() not in destination.parents:
                raise RuntimeError(f"escaped output: {member.name}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise RuntimeError(f"cannot read tar member: {member.name}")
            with source, destination.open("wb") as stream:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise RuntimeError(f"short tar member: {member.name}")
                    stream.write(chunk)
                    remaining -= len(chunk)


def patch_filename_only(output):
    transformer = output / "transformers.node.mjs"
    text = transformer.read_text(encoding="utf-8")
    marker = 'import sharp from "sharp";'
    replacement = ('const sharp = new Proxy(function(){}, { apply(){ throw new Error('
                   '"Image processing is not included in the filename-only AI pack."); }, get(){ throw new Error('
                   '"Image processing is not included in the filename-only AI pack."); } });')
    if text.count(marker) != 1:
        raise RuntimeError("unexpected Transformers.js sharp import")
    transformer.write_text(text.replace(marker, replacement), encoding="utf-8", newline="\n")

    package_file = output / "node_modules/onnxruntime-node/package.json"
    package = json.loads(package_file.read_text(encoding="utf-8"))
    package.pop("scripts", None)
    package.pop("devDependencies", None)
    package["dependencies"] = {"onnxruntime-common": "1.24.3"}
    package["recoveryChatCurated"] = True
    package_file.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def write_manifest(output):
    files = []
    for item in sorted(output.rglob("*")):
        if not item.is_file():
            continue
        data = item.read_bytes()
        files.append({
            "path": "vendor/" + item.relative_to(output).as_posix(),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    manifest = {
        "schemaVersion": 1,
        "runtime": "recoverychat-filename-transformers-node",
        "runtimeVersion": "4.2.0-node-filename-only",
        "runtimeSource": "https://github.com/huggingface/transformers.js/tree/54652ba3366ccd1e3b64e689a96504309e6fb53b",
        "onnxRuntimeVersion": "1.24.3",
        "onnxRuntimeSource": "https://github.com/microsoft/onnxruntime/tree/v1.24.3",
        "platform": "win32-x64",
        "patches": [
            "Removed the static sharp import; image processing calls throw because this pack only embeds filenames.",
            "Omitted onnxruntime-node installer dependencies and non-Windows binaries after installation; they are not imported by inference.",
        ],
        "files": files,
    }
    (output.parent / "runtime-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="fresh absolute directory that will become vendor/")
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute() or output.exists():
        raise SystemExit("--output must be a fresh absolute directory")
    output.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="recoverychat-runtime-") as temporary:
        temporary = Path(temporary)
        for component, source in SOURCES.items():
            archive = temporary / f"{component}.tgz"
            download(source["url"], source["sha512"], "sha512", archive)
            extract_selected(archive, component, output)
    patch_filename_only(output)
    for name, (url, digest) in NOTICE_FILES.items():
        download(url, digest, "sha256", output / name)
    write_manifest(output)


if __name__ == "__main__":
    main()
