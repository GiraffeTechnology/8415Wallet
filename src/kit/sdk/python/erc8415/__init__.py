"""ERC-8415 projection client.

The three questions the standard keeps apart stay three methods here. There is
deliberately no single ``status`` accessor: a caller handed one value cannot
tell which question it was answered, and treating a provisional answer as
settled is the integration error an asynchronous register makes easy.
"""

from .client import (
    Entry,
    NotCoveredError,
    ProjectionClient,
    ProjectionClientError,
    Resolution,
    Settlement,
)

__all__ = [
    "Entry",
    "NotCoveredError",
    "ProjectionClient",
    "ProjectionClientError",
    "Resolution",
    "Settlement",
]
