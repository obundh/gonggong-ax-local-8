"""Build the pinned local filename-model pack from verified allowlists only."""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
from typing import Any
import zipfile


PACK_DECLARATION = Path("optional-ai/offline-pack-entries.json")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot read {label}: {path}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"Malformed {label}: expected a JSON object: {path}")
    return value


def _relative_path(value: Any, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise RuntimeError(f"Malformed {label}: expected a non-empty POSIX relative path")
    candidate = PurePosixPath(value)
    if (
        candidate.is_absolute()
        or candidate.as_posix() != value
        or any(part in ("", ".", "..") or ":" in part for part in candidate.parts)
    ):
        raise RuntimeError(f"Unsafe {label}: {value!r}")
    return candidate


def _assert_no_links(path: Path, root: Path, label: str) -> Path:
    root = root.resolve(strict=True)
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise RuntimeError(f"Unsafe {label}: path escapes pack root: {path}") from error

    current = root
    for part in relative.parts:
        current = current / part
        try:
            status = current.lstat()
        except OSError as error:
            raise RuntimeError(f"Missing {label}: {current}") from error
        attributes = getattr(status, "st_file_attributes", 0)
        if stat.S_ISLNK(status.st_mode) or attributes & REPARSE_POINT:
            raise RuntimeError(f"Unsafe {label}: symlink or reparse point: {current}")

    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise RuntimeError(f"Missing {label}: {path}") from error
    if not resolved.is_relative_to(root):
        raise RuntimeError(f"Unsafe {label}: path escapes pack root: {path}")
    return resolved


def _project_member(root: Path, relative: PurePosixPath, label: str) -> Path:
    path = root.joinpath(*relative.parts)
    resolved = _assert_no_links(path, root, label)
    if not resolved.is_file():
        raise RuntimeError(f"Missing {label}: expected a regular file: {path}")
    return resolved


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _matches_exclude(path: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if pattern.endswith("/**"):
            prefix = pattern[:-3].rstrip("/")
            if path == prefix or path.startswith(prefix + "/"):
                return True
        elif fnmatch.fnmatchcase(path, pattern):
            return True
    return False


def _load_declaration(root: Path) -> dict[str, Any]:
    declaration_path = _project_member(root, PACK_DECLARATION, "pack declaration")
    declaration = _read_json(declaration_path, "pack declaration")
    if declaration.get("schemaVersion") != 2:
        raise RuntimeError("Malformed pack declaration: schemaVersion must be 2")
    if not isinstance(declaration.get("metadata"), list) or not isinstance(
        declaration.get("manifests"), list
    ):
        raise RuntimeError("Malformed pack declaration: metadata and manifests must be lists")
    if not isinstance(declaration.get("exclude"), list):
        raise RuntimeError("Malformed pack declaration: exclude must be a list")
    archive_name = declaration.get("archiveName")
    if (
        not isinstance(archive_name, str)
        or Path(archive_name).name != archive_name
        or not archive_name.lower().endswith(".zip")
    ):
        raise RuntimeError("Malformed pack declaration: archiveName must be a ZIP filename")
    return declaration


def _collect_members(root: Path) -> list[tuple[str, Path]]:
    root = root.resolve(strict=True)
    declaration = _load_declaration(root)

    exclude_patterns: list[str] = []
    for index, value in enumerate(declaration["exclude"]):
        if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
            raise RuntimeError(f"Malformed exclude[{index}]: expected a POSIX path pattern")
        prefix = value[:-3] if value.endswith("/**") else value
        _relative_path(prefix.rstrip("/"), f"exclude[{index}]")
        exclude_patterns.append(value)

    members: dict[str, Path] = {}
    declared: set[str] = set()

    def add(path_text: str, source: str, expected: dict[str, Any] | None = None) -> None:
        relative = _relative_path(path_text, source)
        archive_path = relative.as_posix()
        if archive_path in declared:
            raise RuntimeError(f"Ambiguous duplicate pack member: {archive_path}")
        declared.add(archive_path)
        excluded = _matches_exclude(archive_path, exclude_patterns)
        if excluded and expected is None:
            return
        file_path = _project_member(root, relative, source)
        if expected is not None:
            expected_bytes = expected.get("bytes")
            expected_hash = expected.get("sha256")
            if (
                not isinstance(expected_bytes, int)
                or isinstance(expected_bytes, bool)
                or expected_bytes < 0
                or not isinstance(expected_hash, str)
                or SHA256_PATTERN.fullmatch(expected_hash) is None
            ):
                raise RuntimeError(f"Malformed verified manifest entry: {archive_path}")
            actual_bytes = file_path.stat().st_size
            if actual_bytes != expected_bytes:
                raise RuntimeError(
                    f"Size mismatch for {archive_path}: expected {expected_bytes}, got {actual_bytes}"
                )
            actual_hash = _hash_file(file_path)
            if actual_hash != expected_hash:
                raise RuntimeError(
                    f"SHA-256 mismatch for {archive_path}: expected {expected_hash}, got {actual_hash}"
                )
        if excluded:
            return
        members[archive_path] = file_path

    for index, value in enumerate(declaration["metadata"]):
        if not isinstance(value, str):
            raise RuntimeError(f"Malformed metadata[{index}]: expected a path string")
        add(value, f"metadata[{index}]")

    for manifest_index, descriptor in enumerate(declaration["manifests"]):
        if not isinstance(descriptor, dict) or set(descriptor) != {"path", "root"}:
            raise RuntimeError(
                f"Malformed manifests[{manifest_index}]: expected path and root only"
            )
        manifest_relative = _relative_path(
            descriptor["path"], f"manifests[{manifest_index}].path"
        )
        manifest_root = _relative_path(
            descriptor["root"], f"manifests[{manifest_index}].root"
        )
        manifest_archive_path = manifest_relative.as_posix()
        add(manifest_archive_path, f"manifests[{manifest_index}].path")
        if _matches_exclude(manifest_archive_path, exclude_patterns):
            raise RuntimeError(f"Verified manifest cannot be excluded: {manifest_archive_path}")

        manifest_path = members[manifest_archive_path]
        verified_manifest = _read_json(manifest_path, "verified manifest")
        if verified_manifest.get("schemaVersion") != 1 or not isinstance(
            verified_manifest.get("files"), list
        ):
            raise RuntimeError(f"Malformed verified manifest: {manifest_archive_path}")
        manifest_entries: set[str] = set()
        for file_index, entry in enumerate(verified_manifest["files"]):
            if not isinstance(entry, dict):
                raise RuntimeError(
                    f"Malformed verified manifest entry {manifest_archive_path}#{file_index}"
                )
            entry_relative = _relative_path(
                entry.get("path"),
                f"verified manifest entry {manifest_archive_path}#{file_index}",
            )
            entry_text = entry_relative.as_posix()
            if entry_text in manifest_entries:
                raise RuntimeError(
                    f"Ambiguous duplicate manifest entry: {manifest_archive_path}: {entry_text}"
                )
            manifest_entries.add(entry_text)
            archive_path = (manifest_root / entry_relative).as_posix()
            add(
                archive_path,
                f"verified manifest entry {manifest_archive_path}#{file_index}",
                entry,
            )

    return sorted(members.items())


def collect_files(root: Path) -> list[Path]:
    """Return the exact, verified files declared for the pack in archive order."""

    return [path for _, path in _collect_members(Path(root))]


def build_archive(root: Path) -> dict[str, Any]:
    root = Path(root).resolve(strict=True)
    declaration = _load_declaration(root)
    members = _collect_members(root)
    output = root / "dist" / declaration["archiveName"]
    output.parent.mkdir(exist_ok=True)
    _assert_no_links(output.parent, root, "archive output directory")

    archive_fd, archive_temp_name = tempfile.mkstemp(
        prefix=output.name + ".", suffix=".partial", dir=output.parent
    )
    os.close(archive_fd)
    archive_temp = Path(archive_temp_name)
    try:
        with zipfile.ZipFile(
            archive_temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as archive:
            for archive_path, file_path in members:
                archive.write(file_path, archive_path)
        with zipfile.ZipFile(archive_temp) as archive:
            failed_member = archive.testzip()
            if failed_member is not None:
                raise RuntimeError(f"AI pack CRC verification failed: {failed_member}")
            if archive.namelist() != [archive_path for archive_path, _ in members]:
                raise RuntimeError("AI pack inventory verification failed")
        digest = _hash_file(archive_temp)
        os.replace(archive_temp, output)
    finally:
        archive_temp.unlink(missing_ok=True)

    checksum = output.with_suffix(output.suffix + ".sha256")
    checksum_fd, checksum_temp_name = tempfile.mkstemp(
        prefix=checksum.name + ".", suffix=".partial", dir=output.parent
    )
    checksum_temp = Path(checksum_temp_name)
    try:
        with os.fdopen(checksum_fd, "w", encoding="ascii", newline="\n") as stream:
            stream.write(f"{digest}  {output.name}\n")
        os.replace(checksum_temp, checksum)
    finally:
        checksum_temp.unlink(missing_ok=True)

    return {
        "path": str(output),
        "files": len(members),
        "bytes": output.stat().st_size,
        "sha256": digest,
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    print(json.dumps(build_archive(root), ensure_ascii=False))


if __name__ == "__main__":
    main()
