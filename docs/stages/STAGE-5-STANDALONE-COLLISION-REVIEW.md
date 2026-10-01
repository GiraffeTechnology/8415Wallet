# Stage 5 standalone cross-token review

This slice exposes the existing PRD section 4.9 cross-token comparison in the
standalone browser view. It is independent of the responsibility controller,
payment adapter and selected-account transaction authorization. It reads public
commitments and opaque registry locators; it never resolves registry contents.

## Implementation

- One explicit comma-separated set of up to 32 distinct uint256 token IDs.
- SDK validation rejects duplicate, empty, oversized and invalid sets before
  RPC. Duplicate inputs can no longer fabricate same-token repeat findings.
- ERC-165 projection conformance precedes projection reads. The session's
  immutable register/profile identity is checked before and after the scan.
- Maximum 2048 entries across the entire set. This is an interactive work
  budget, not a protocol lifetime constraint. No truncated report is returned.
- Zero-entry projections, malformed counts, transport failures and identity
  drift fail the scan rather than becoming a clean result.
- The existing renderer retains collision occurrences and scope disclosures.
  Reads are sequential/live, not an atomic historical snapshot. No collisions
  in this set is not proof that none exists elsewhere or after these reads.
- Connection changes discard stale display results. Error bodies are not
  rendered. No signature, send, retry, registry fetch or key access is added.

This branch builds on the connection-lifecycle PR #31. It does not include or
depend on the independent signer or package-delivery branches.

## Linux validation handoff — NOT RUN

The development task added ten SDK boundary cases and four UI-handler cases;
none was executed in this slice. Artfi总控 owns execution on managed CTYun/SIN
Linux. Bind results to the delivered commit/tree and report actual Node,
TypeScript, browser and provider versions. Do not disclose infrastructure names,
addresses or credentials. No Windows runtime is permitted.

1. Run typecheck and browser compilation from the exact source, then the focused
   collision-boundaries, browser-connection and existing holderViews suites.
2. Run the complete Node suite to catch regressions in existing standalone and
   linked consumers. Preserve failures with exact test names and source identity.
3. In the genuine functional browser, use a test-only deployment with no linked
   controller. Compare two tokens; verify actual public read results and scope
   text. Check invalid/duplicate input, oversized history, transport refusal,
   and account/chain switching while a read is pending. Do not simulate this
   journey with a fake injected provider and call it browser acceptance.
4. Confirm no transaction/signature prompts, no registry resolution and no
   partial clean report on failure. UI-handler fixtures are not real UI evidence.

This document records implementation and test requirements, not PASS, release
acceptance or completion of V3. CI and merging remain with the release owner.
