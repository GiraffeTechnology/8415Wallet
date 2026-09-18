"""Self-contained suite for the Python SDK. Run: python3 sdk/python/test_client.py"""

from __future__ import annotations

import sys
from urllib.parse import urlsplit, parse_qs
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from erc8415 import NotCoveredError, ProjectionClient, ProjectionClientError  # noqa: E402

ALICE = "0x" + "aa" * 20
BOB = "0x" + "bb" * 20
REFERENCE = "0x" + "ab" * 32


def entry(version: int, holder: str, effective_at: int, superseded_at: int) -> dict:
    return {
        "version": str(version),
        "holder": holder,
        "effectiveAt": str(effective_at),
        "supersededAt": str(superseded_at),
        "recordCommitment": "0x" + f"{version:064x}",
        "previousCommitment": "0x" + "0" * 64,
        "registryReference": REFERENCE,
    }


ENTRIES = [entry(1, ALICE, 100, 130), entry(2, BOB, 130, 0)]


def fake_opener(url: str) -> tuple[int, dict]:
    parsed = urlsplit(url)
    path = parsed.path
    if path.endswith("/holder/as-of/99") or path.endswith("/entry/as-of/99"):
        return 404, {"error": "INSTANT_NOT_COVERED", "message": "not covered"}
    if "/resolve/as-of/" in path:
        instant = int(path.rsplit("/", 1)[-1])
        if instant < 100:
            return 404, {"error": "INSTANT_NOT_COVERED"}
        return 200, {"holder": BOB if instant >= 130 else ALICE, "final": instant < 130, "openGap": None}
    if "/holder/as-of/" in path:
        instant = int(path.rsplit("/", 1)[-1])
        holder = BOB if instant >= 130 else ALICE
        return 200, {"holder": holder}
    if "/finality/as-of/" in path:
        instant = int(path.rsplit("/", 1)[-1])
        return 200, {"final": 100 <= instant < 130}
    if "/entry/version/" in path:
        version = int(path.rsplit("/", 1)[-1])
        found = [e for e in ENTRIES if int(e["version"]) == version]
        if not found:
            return 404, {"error": "UNKNOWN_VERSION", "message": "unknown version"}
        return 200, {"entry": found[0]}
    if "/entry/as-of/" in path:
        instant = int(path.rsplit("/", 1)[-1])
        found = ENTRIES[1] if instant >= 130 else ENTRIES[0]
        return 200, {"entry": found}
    if path.endswith("/entries"):
        query = parse_qs(parsed.query)
        offset = int(query.get("offset", [0])[0])
        limit = int(query.get("limit", [100])[0])
        return 200, {"entryCount": len(ENTRIES), "offset": offset, "entries": ENTRIES[offset:offset + limit]}
    return 200, {"openGap": None}


def check(name: str, condition: bool) -> None:
    if not condition:
        raise AssertionError(f"failed: {name}")
    print(f"ok - {name}")


def main() -> int:
    client = ProjectionClient("http://kit.invalid", opener=fake_opener)

    check("holder_as_of resolves within an interval", client.holder_as_of(1, 120) == ALICE)
    check("holder_as_of resolves at a boundary", client.holder_as_of(1, 130) == BOB)
    check("holder_as_of returns a plain address", isinstance(client.holder_as_of(1, 120), str))

    check("is_final_as_of is true inside a closed interval", client.is_final_as_of(1, 120) is True)
    check("is_final_as_of is false on the latest interval", client.is_final_as_of(1, 130) is False)
    check("is_final_as_of does not raise for an uncovered instant", client.is_final_as_of(1, 99) is False)

    first = client.entry_at(1, 1)
    check("entry_at is indexed by version", first.version == 1 and first.holder == ALICE)
    check("a closed entry carries superseded_at", first.superseded_at == 130)
    check("the latest entry carries a zero superseded_at", client.entry_at(1, 2).superseded_at == 0)
    check("entry_as_of resolves the covering entry", client.entry_as_of(1, 129).version == 1)
    check("entry_count reads the history length", client.entry_count(1) == 2)
    check("entries decode in order", [e.version for e in client.entries(1)] == [1, 2])

    try:
        client.holder_as_of(1, 99)
        check("an uncovered instant raises", False)
    except NotCoveredError:
        check("an uncovered instant raises NotCoveredError", True)

    try:
        client.entry_at(1, 9)
        check("an unknown version raises", False)
    except ProjectionClientError as error:
        check("an unknown version raises with its code", error.code == "UNKNOWN_VERSION")

    calls = []
    def counting_opener(url):
        calls.append(url)
        return fake_opener(url)
    resolution = ProjectionClient("http://kit.invalid", opener=counting_opener).resolve(1, 120)
    check("resolve uses one snapshot request", len(calls) == 1 and "/resolve/as-of/" in calls[0])
    check("resolve labels each fact separately", resolution.holder == ALICE and resolution.final is True)
    check("resolve reports no open gap as None", resolution.open_gap is None)
    check(
        "resolve is three facts, never one status",
        sorted(resolution.__dataclass_fields__) == ["final", "holder", "open_gap"],
    )

    # A large instant must survive the wire without rounding.
    check("uint64 instants survive as ints", int(ENTRIES[0]["effectiveAt"]) == 100)

    print("\nall python sdk checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
