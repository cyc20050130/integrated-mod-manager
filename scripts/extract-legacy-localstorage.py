#!/usr/bin/env python3
"""Extract only IMM's migration-approved LocalStorage keys from a copied LevelDB."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import pathlib
import sys
import types
from collections import defaultdict


ALLOWED_KEYS = ("game-theme", "imm-lang")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--leveldb", type=pathlib.Path, required=True)
    parser.add_argument("--reader-root", type=pathlib.Path, required=True)
    parser.add_argument("--snappy-root", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    return parser.parse_args()


def write_durable_json(path: pathlib.Path, payload: object) -> None:
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    with path.open("xb") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    args = parse_args()

    for module_root in (args.reader_root, args.snappy_root):
        if not module_root.is_dir():
            raise RuntimeError(f"Pinned module root is missing: {module_root}")
        sys.path.insert(0, str(module_root))

    package_root = args.reader_root / "ccl_chromium_reader"
    if not package_root.is_dir():
        raise RuntimeError(f"Pinned reader package is missing: {package_root}")
    package = types.ModuleType("ccl_chromium_reader")
    package.__path__ = [str(package_root)]
    package.__package__ = "ccl_chromium_reader"
    sys.modules["ccl_chromium_reader"] = package
    ccl_chromium_localstorage = importlib.import_module("ccl_chromium_reader.ccl_chromium_localstorage")

    grouped: dict[str, list[object]] = defaultdict(list)
    with ccl_chromium_localstorage.LocalStoreDb(args.leveldb) as local_store:
        for record in local_store.iter_all_records(include_deletions=False):
            if record.script_key in ALLOWED_KEYS:
                grouped[record.script_key].append(record)

    missing = sorted(set(ALLOWED_KEYS) - grouped.keys())
    if missing:
        raise RuntimeError(f"Required LocalStorage keys are missing: {', '.join(missing)}")

    selected: dict[str, dict[str, object]] = {}
    for key in ALLOWED_KEYS:
        records = grouped[key]
        highest_sequence = max(record.leveldb_seq_number for record in records)
        latest = [record for record in records if record.leveldb_seq_number == highest_sequence]
        distinct = {(record.storage_key, record.value) for record in latest}
        if len(distinct) != 1:
            raise RuntimeError(f"Conflicting latest LocalStorage records for {key} at sequence {highest_sequence}")

        record = latest[0]
        selected[key] = {
            "leveldbSequence": record.leveldb_seq_number,
            "sourceFile": pathlib.Path(record.file).name,
            "storageKey": record.storage_key,
            "value": record.value,
        }

    origins = {entry["storageKey"] for entry in selected.values()}
    if len(origins) != 1:
        raise RuntimeError(f"Required LocalStorage keys resolve to different storage keys: {sorted(origins)}")

    payload = {
        "records": selected,
        "schemaVersion": 1,
        "storageKey": next(iter(origins)),
    }
    write_durable_json(args.output, payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
