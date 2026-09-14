# ERC-8415 Wallet PRD v1.0

## Product Definition

8415Wallet is a reference wallet for ERC-8415 ecosystem applications.

Positioning:

> A temporal asset wallet that exposes ERC-8415 projection and finality semantics to users.

The wallet is not a simple ownership viewer. It allows users and applications to understand the relationship between:

- execution state;
- registry projection;
- admission evidence;
- historical finality.

---

# 1. Design Principle

Traditional wallets answer:

```
Who owns this token now?
```

8415Wallet answers:

```
Who is the holder as of time t?

Is that answer final as of time t?

What evidence admitted this projection?
```

---

# 2. Core Architecture

```
User
 |
8415Wallet
 |
ERC-8415 SDK
 |
Native Infrastructure Kit
 |
ERC-8415 Projection Layer
```

The wallet MUST NOT directly redefine ERC-8415 semantics.

---

# 3. Core Features

## 3.1 Asset View

Display:

- asset identity;
- current execution state;
- projected holder;
- projection timestamp;
- finality status.

---

## 3.2 Temporal Ownership Query

Support:

```
holderAsOf(tokenId, instant)
```

Example:

```
Holder:
Alice

As Of:
2026-01-01

Status:
Provisional
```

---

## 3.3 Finality Display

Support:

```
isFinalAsOf(tokenId, instant)
```

Display clearly:

- Provisional;
- Final.

Do not display provisional data as confirmed legal finality.

---

## 3.4 Projection History

Display append-only history:

- admitted entries;
- timestamps;
- evidence references;
- projection changes.

---

## 3.5 Gap Awareness

Display:

- open gap;
- closed gap;
- settlement workflow status.

The wallet MUST NOT interpret gap closure as finality.

---

# 4. Application Patterns

## Trading

Support applications that choose:

- immediate composition on provisional state;
- settlement quarantine patterns.

The wallet presents risk information but does not impose settlement policy.

---

## Custody

Support institutional users:

- asset monitoring;
- evidence review;
- audit trail access.

---

# 5. Security Requirements

The wallet MUST:

- protect user keys;
- validate displayed data source;
- distinguish admitted data from pending application workflows;
- never fabricate finality.

---

# 6. Development Stages

## Stage 0

Project foundation.

## Stage 1

ERC-8415 SDK integration.

## Stage 2

Temporal asset display.

## Stage 3

Projection history and evidence display.

## Stage 4

Gap-aware settlement UX.

## Stage 5

Wallet ecosystem integrations.

---

# Definition of Done

8415Wallet is complete when users can safely understand:

1. What asset they hold;
2. What projection says as of a given time;
3. Whether that projection is final;
4. What evidence supports the projection;
5. Whether any settlement gap exists.

