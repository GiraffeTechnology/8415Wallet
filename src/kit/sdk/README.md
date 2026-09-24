# SDK

Two clients for the Kit's projection API — one JavaScript, one Python. Both
keep the standard's three questions as three calls, and neither offers a single
collapsed status, because a caller handed one value cannot tell which question
it was answered.

## The three questions

| Question | Call | Note |
| --- | --- | --- |
| Who did the register confirm at instant *t*? | `holderAsOf` / `holder_as_of` | Raises for an instant the projection does not cover. |
| Can a later admission still change that? | `isFinalAsOf` / `is_final_as_of` | Answers `false` for an uncovered instant; transport/authentication failures still raise. |
| Is a change in flight? | `openGapOf` / `open_gap_of` | `null` / `None` when no gap is open, including on a contract without settlement conformance. |

Acting on the holder without reading finality acts for the wrong party when a
later admission supersedes the answer. The standard names this the most likely
integration error, because the entry resolves either way.

## JavaScript

```ts
import { ProjectionClient, NotCoveredError } from './sdk/js/index.ts';

const apiKey = process.env.KIT_API_KEY;
if (!apiKey) throw new Error('KIT_API_KEY is required');
const client = new ProjectionClient({ baseUrl: 'https://kit.example', apiKey });

const holder = await client.holderAsOf(1n, 1_700_000_000n);
const settled = await client.isFinalAsOf(1n, 1_700_000_000n);

if (!settled) {
  // The answer may still move. Whether to wait, hold consideration or proceed
  // is the transaction terms' call, not the Kit's.
}
```

All three at once, each still labelled as itself:

```ts
const { holder, final, openGap } = await client.resolve(1n, 1_700_000_000n);
```

Instants, versions and token ids are `bigint`. They cross the wire as decimal
strings and are never parsed into a JSON number, because a silently rounded
instant resolves to the wrong entry.

## Python

Standard library only — nothing to install.

```python
import os
from erc8415 import ProjectionClient, NotCoveredError

client = ProjectionClient("https://kit.example", api_key=os.environ["KIT_API_KEY"])

holder = client.holder_as_of(1, 1_700_000_000)
settled = client.is_final_as_of(1, 1_700_000_000)

resolution = client.resolve(1, 1_700_000_000)
resolution.holder, resolution.final, resolution.open_gap
```

## Errors

| Condition | JavaScript | Python |
| --- | --- | --- |
| Instant precedes the first entry | `NotCoveredError` | `NotCoveredError` |
| Unknown token or version | `ProjectionClientError` with `code` | `ProjectionClientError` with `.code` |

An uncovered instant is not a failure of the query: it means the projection
does not cover that instant. It is a distinct error type so a caller can tell
it apart from a transport or conformance problem, and never confuse it with an
answer.

## Reading, then acting

These clients read over HTTP, which means an answer can move between the read
and whatever a caller does with it. That is fine for display and indexing.

A contract acting on a projection answer should call the contract in the same
transaction as the action that depends on it. That closes the window entirely
rather than narrowing it. Do not cache a read across transactions.

## Tests

```sh
npm test                          # includes the JavaScript SDK against a live server
python3 sdk/python/test_client.py # the Python suite standalone
```

`resolve` uses one `/projection/{tokenId}/resolve/as-of/{instant}` request,
returning holder, finality and open gap from one synchronous server snapshot.
This is a display snapshot, not a guarantee across a subsequent transaction.
Contracts must still read and act atomically in the same transaction.

`entries` walks all pages up to the count observed on its first request, so
histories longer than 100 entries are not truncated. Appends after that first
request are left for the next call. Each page is a separate read; this method
does not promise an atomic snapshot across pages. Incomplete pages fail explicitly.
