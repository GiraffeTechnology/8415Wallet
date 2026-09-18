"""Standard library only: no dependencies to install, nothing to pin."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Optional


class ProjectionClientError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class NotCoveredError(ProjectionClientError):
    """The projection does not cover this instant. Not a failure of the query."""

    def __init__(self, message: str) -> None:
        super().__init__(404, "INSTANT_NOT_COVERED", message)


@dataclass(frozen=True)
class Entry:
    version: int
    holder: str
    effective_at: int
    superseded_at: int
    record_commitment: str
    previous_commitment: str
    registry_reference: str

    @staticmethod
    def from_wire(wire: dict[str, Any]) -> "Entry":
        # Every uint64 arrives as a decimal string. Python ints are arbitrary
        # precision, so nothing is lost, but the wire format stays explicit.
        return Entry(
            version=int(wire["version"]),
            holder=wire["holder"],
            effective_at=int(wire["effectiveAt"]),
            superseded_at=int(wire["supersededAt"]),
            record_commitment=wire["recordCommitment"],
            previous_commitment=wire["previousCommitment"],
            registry_reference=wire["registryReference"],
        )


@dataclass(frozen=True)
class Settlement:
    settlement_id: str
    token_id: int
    initiator: str
    expected_holder: str
    snapshot_hash: str
    opened_at: int
    deadline: int
    status: str

    @staticmethod
    def from_wire(wire: dict[str, Any]) -> "Settlement":
        return Settlement(
            settlement_id=wire["settlementId"],
            token_id=int(wire["tokenId"]),
            initiator=wire["initiator"],
            expected_holder=wire["expectedHolder"],
            snapshot_hash=wire["snapshotHash"],
            opened_at=int(wire["openedAt"]),
            deadline=int(wire["deadline"]),
            status=wire["status"],
        )


@dataclass(frozen=True)
class Resolution:
    """All three facts, each still labelled as itself.

    ``holder`` is who was recorded, ``final`` is whether that can still move,
    and ``open_gap`` is whether a change is in flight. Acting on ``holder``
    without reading ``final`` acts for the wrong party when a later admission
    supersedes the answer.
    """

    holder: str
    final: bool
    open_gap: Optional[Settlement]


Opener = Callable[[str], tuple[int, dict[str, Any]]]


DEFAULT_TIMEOUT_SECONDS = 10.0


def _assert_safe_base_url(base_url: str) -> None:
    """Refuse a URL that would send credentials in clear, or carry them inline.

    Ported from the transport checks in the closed codex/stage5-sdk branch.
    """
    parsed = urllib.parse.urlparse(base_url)
    if parsed.username or parsed.password:
        raise ValueError("the base URL must not carry embedded credentials")
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise ValueError("use https, or http only for a loopback development host")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProjectionClientError(code, "REDIRECT_REFUSED", "authenticated requests do not follow redirects")


def _default_opener(url: str, timeout: float, api_key: Optional[str] = None) -> tuple[int, dict[str, Any]]:
    headers = {"accept": "application/json"}
    if api_key is not None:
        headers["authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


class ProjectionClient:
    def __init__(
        self,
        base_url: str,
        opener: Optional[Opener] = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        *,
        api_key: Optional[str] = None,
    ) -> None:
        if opener is not None and api_key is not None:
            raise ValueError("custom openers must handle their own authentication")
        if opener is None:
            _assert_safe_base_url(base_url)
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        # Reads only. A timeout surfaces rather than being retried: there is no
        # write here that a retry could duplicate.
        self._open = opener or (lambda url: _default_opener(url, timeout, api_key))

    def holder_as_of(self, token_id: int, instant: int) -> str:
        """The holder the register had confirmed at an instant. Nothing more."""
        return self._get(f"/projection/{token_id}/holder/as-of/{instant}")["holder"]

    def is_final_as_of(self, token_id: int, instant: int) -> bool:
        """Whether a later admission can still change that answer."""
        return bool(self._get(f"/projection/{token_id}/finality/as-of/{instant}")["final"])

    def entry_as_of(self, token_id: int, instant: int) -> Entry:
        return Entry.from_wire(self._get(f"/projection/{token_id}/entry/as-of/{instant}")["entry"])

    def entry_at(self, token_id: int, version: int) -> Entry:
        return Entry.from_wire(self._get(f"/projection/{token_id}/entry/version/{version}")["entry"])

    def entry_count(self, token_id: int) -> int:
        return int(self._get(f"/projection/{token_id}/entries")["entryCount"])

    def entries(self, token_id: int) -> list[Entry]:
        entries: list[Entry] = []
        total: Optional[int] = None
        while True:
            offset = len(entries)
            limit = 100 if total is None else min(100, total - offset)
            body = self._get(f"/projection/{token_id}/entries?offset={offset}&limit={limit}")
            count = body.get("entryCount")
            page = body.get("entries")
            if type(count) is not int or count < (total or 0) or body.get("offset") != offset or not isinstance(page, list):
                raise ProjectionClientError(502, "INVALID_PAGE", "invalid history page metadata")
            if total is None:
                total = count
            if len(page) != min(limit, total - offset):
                raise ProjectionClientError(502, "INVALID_PAGE", "history page is incomplete")
            entries.extend(Entry.from_wire(item) for item in page)
            if len(entries) >= total:
                return entries

    def open_gap_of(self, token_id: int) -> Optional[Settlement]:
        gap = self._get(f"/projection/{token_id}")["openGap"]
        return None if gap is None else Settlement.from_wire(gap)

    def resolve(self, token_id: int, instant: int) -> Resolution:
        body = self._get(f"/projection/{token_id}/resolve/as-of/{instant}")
        gap = body["openGap"]
        return Resolution(
            holder=body["holder"], final=bool(body["final"]),
            open_gap=None if gap is None else Settlement.from_wire(gap),
        )

    def _get(self, path: str) -> dict[str, Any]:
        status, body = self._open(f"{self._base_url}{path}")
        if status >= 400:
            code = body.get("error", "UNKNOWN")
            message = body.get("message", code)
            if code == "INSTANT_NOT_COVERED":
                raise NotCoveredError(message)
            raise ProjectionClientError(status, code, message)
        return body
