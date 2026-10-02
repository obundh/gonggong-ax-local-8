import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


MODULE_PATH = Path(__file__).with_name("build-ai-pack.py")
SPEC = importlib.util.spec_from_file_location("build_ai_pack", MODULE_PATH)
assert SPEC and SPEC.loader
build_ai_pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_ai_pack)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class AiPackTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        runtime = b"verified runtime"
        model = b"verified model"
        excluded = b"excluded dependency"

        files = {
            "optional-ai/package.json": b"{}\n",
            "models/README.md": b"model metadata\n",
            "optional-ai/vendor/node_modules/runtime.js": runtime,
            "models/demo/model.bin": model,
            "optional-ai/node_modules/excluded.js": excluded,
            "optional-ai/vendor/unlisted.js": b"must not ship",
            "models/demo/unlisted.bin": b"must not ship",
        }
        for name, content in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)

        self.write_json(
            "optional-ai/runtime-manifest.json",
            {
                "schemaVersion": 1,
                "files": [
                    {
                        "path": "vendor/node_modules/runtime.js",
                        "bytes": len(runtime),
                        "sha256": digest(runtime),
                    },
                    {
                        "path": "node_modules/excluded.js",
                        "bytes": len(excluded),
                        "sha256": digest(excluded),
                    },
                ],
            },
        )
        self.write_json(
            "models/demo/model-manifest.json",
            {
                "schemaVersion": 1,
                "files": [
                    {
                        "path": "model.bin",
                        "bytes": len(model),
                        "sha256": digest(model),
                    }
                ],
            },
        )
        self.declaration = {
            "schemaVersion": 2,
            "archiveName": "test-ai-pack.zip",
            "metadata": ["optional-ai/package.json", "models/README.md"],
            "manifests": [
                {
                    "path": "optional-ai/runtime-manifest.json",
                    "root": "optional-ai",
                },
                {"path": "models/demo/model-manifest.json", "root": "models/demo"},
            ],
            "exclude": ["optional-ai/node_modules/**"],
        }
        self.write_declaration()

    def tearDown(self):
        self.temporary.cleanup()

    def write_json(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def write_declaration(self):
        self.write_json("optional-ai/offline-pack-entries.json", self.declaration)

    def relative_files(self):
        return {
            path.relative_to(self.root).as_posix()
            for path in build_ai_pack.collect_files(self.root)
        }

    def relative_files_path_strings(self):
        return [
            path.relative_to(self.root).as_posix()
            for path in build_ai_pack.collect_files(self.root)
        ]

    def test_exact_entries_exclude_unlisted_and_honor_exclude(self):
        collected = self.relative_files()
        self.assertIn("optional-ai/vendor/node_modules/runtime.js", collected)
        self.assertNotIn("optional-ai/node_modules/excluded.js", collected)
        self.assertNotIn("optional-ai/vendor/unlisted.js", collected)
        self.assertNotIn("models/demo/unlisted.bin", collected)

    def test_tampered_manifest_member_is_rejected(self):
        (self.root / "models/demo/model.bin").write_bytes(b"tampered")
        with self.assertRaisesRegex(RuntimeError, "mismatch for models/demo/model.bin"):
            build_ai_pack.collect_files(self.root)

    def test_manifest_traversal_is_rejected(self):
        manifest_path = self.root / "models/demo/model-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"][0]["path"] = "../escape.bin"
        self.write_json("models/demo/model-manifest.json", manifest)
        with self.assertRaisesRegex(RuntimeError, "Unsafe verified manifest entry"):
            build_ai_pack.collect_files(self.root)

    def test_malformed_manifest_entry_is_rejected(self):
        manifest_path = self.root / "models/demo/model-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"][0]["sha256"] = "not-a-sha256"
        self.write_json("models/demo/model-manifest.json", manifest)
        with self.assertRaisesRegex(RuntimeError, "Malformed verified manifest entry"):
            build_ai_pack.collect_files(self.root)

    def test_duplicate_archive_member_is_rejected(self):
        self.declaration["metadata"].append("optional-ai/runtime-manifest.json")
        self.write_declaration()
        with self.assertRaisesRegex(RuntimeError, "Ambiguous duplicate pack member"):
            build_ai_pack.collect_files(self.root)

    def test_archive_inventory_crc_and_checksum(self):
        result = build_ai_pack.build_archive(self.root)
        archive_path = Path(result["path"])
        with zipfile.ZipFile(archive_path) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.namelist(), sorted(self.relative_files_path_strings()))
        self.assertEqual(digest(archive_path.read_bytes()), result["sha256"])
        checksum = archive_path.with_suffix(".zip.sha256").read_text(encoding="ascii")
        self.assertEqual(checksum, f"{result['sha256']}  {archive_path.name}\n")


if __name__ == "__main__":
    unittest.main()
