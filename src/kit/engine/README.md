# engine/

Stage 1–2, 4 — projection kernel, verification engine, settlement composition

This directory is created by Stage 0 and filled by the stage named above.
See `docs/ERC-8415-Native-Infrastructure-Kit-PRD-Stage-Delivery-v2.0.md`.

Admission bindings use the `erc8415/admission/v2` domain and include the stored
settlement snapshot (zero with no open settlement). Existing v1 proofs must be
regenerated. Every built-in profile uses this same binding digest.
