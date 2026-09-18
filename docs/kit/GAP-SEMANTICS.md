# Gap Semantics

The canonical decision on what "gap" means in this repository, and what it
does not.

## One meaning only: the settlement gap

A gap here is a **settlement gap**: a record beside a token's projection saying
that a change is in flight, reported by `openGapOf` and carrying an `openedAt`.

It is optional. A contract with projection conformance but not settlement
conformance has no gaps at all, and that is a property of the contract, not a
missing feature and not an error.

## The evidence or knowledge gap is out of scope

Some designs use "gap" for a hole in what a verifier knows — a range of remote
history nobody has proved yet. That concept is **out of scope by default**, and
the Kit implements no such notion, because the standard does not require it.

Keeping the two apart matters: an evidence gap is about what a verifier has
seen, while a settlement gap is about what a settlement authority has declared
is coming. Conflating them would make "no gap open" read as "nothing is
missing", which is a claim the projection never makes.

## What a gap does

- **It marks a token contested from `openedAt`.** An instant at or after that
  point has a change in flight covering it.
- **It closes exactly once**, by admission or by cancellation, and the
  settlement record keeps the outcome — `ADMITTED` or `CANCELLED` — rather than
  disappearing.
- **At most one is open per token.**

## What a gap does not do

- **It does not block anything.** Opening a gap does not freeze an ERC-721
  transfer, and there is no lock anywhere in the Kit that a gap could take.
  The token keeps trading while the register catches up; that decoupling is
  the whole design, not an oversight.
- **It does not decide finality, in any direction.** Opening, closing,
  cancelling and expiring a gap all leave `isFinalAsOf` exactly where it was.
  Finality is the later-admission rule and nothing else touches it.
- **It does not confer rights.** Settlement authority is separate from token
  ownership, and relaying a proof grants the relayer nothing.
- **It does not reject.** There is no rejection event and no veto. An
  admission that fails verification never becomes an entry; one that succeeds
  is permanent. Cancellation ends a contest and settles nothing — prior
  provisional history stays provisional.

## Expiry

A gap past its deadline is **expired**, which is a condition, not an outcome.
An expired gap is still open, the projection is untouched, and nothing became
final. It cannot be finalized. Only the recorded initiator may cancel it,
and only strictly after the deadline. Cancellation before or at the deadline
must fail, preserving the window for proof admission.

Expiry is not a timeout that decides against the change. The registrar may
still have issued the entry; what expired is this settlement's window to carry
it, not the register's record.

## Where the consequences live

Whether an open, cancelled or expired gap should hold trade proceeds, unwind a
sale or trigger a refund is not decided here. That is the transaction terms
between the parties. The Kit reports the state; the parties decide what it is
worth.

The escrow pattern — quarantine consideration while a gap is open, release on
admission, refund if it is cancelled without admission — is a non-normative
reference pattern, not a requirement. An application that composes on non-final
state instead accepts that risk itself.
