# Engineering patterns — first principles

Deliberately project-agnostic. Each entry is a *question to ask*, the reasoning
behind it, and the failure it prevents. If you are reading this in another
project months from now, the questions should still apply.

---

## P1 — Every piece of state has an owner and a destroyer

**Ask:** for each piece of state, what single event is *allowed* to destroy it?

**Why:** state loss is almost never caused by not saving. It is caused by saving
into something whose lifetime is shorter than the state's required lifetime. The
bug is a lifetime mismatch, not a missing write.

**Do:** enumerate your state, and for each one name the event that legitimately
ends it (process exit, container removal, disk loss, retention expiry, never).
If the required lifetime exceeds the container's, it cannot live in the
container. This is a design step, not an implementation step.

**Prevents:** "we restarted and the data was gone."

---

## P2 — Commit intent before performing an irreversible act

**Ask:** if this process died one instruction from now, could I tell what had
already happened to the outside world?

**Why:** an act that leaves your system — a sent message, a charge, an email —
cannot be undone or inspected afterwards. If the only record of *what you were
about to do* is in memory, a crash destroys the evidence while the act may still
have landed. You are left unable to distinguish "did nothing" from "did it".

**Do:** write the exact intended payload durably, *then* perform the act, *then*
record the outcome. Three steps, in that order. The safe failure is a recorded
intent that never executed — you can retry that. The unsafe failure is an
execution with no record.

**Prevents:** duplicate side effects, and the worse case of not knowing whether
one occurred.

---

## P3 — Classify failures by what may already have happened

**Ask:** at this failure point, what could the outside world already have seen?

**Why:** engineers instinctively classify failures by *where the code stopped*.
That is the wrong axis. What matters is which irreversible effects might already
have escaped. Two crashes one line apart can need opposite responses.

**Do:** for each step, answer "is replaying this safe?" If yes, retry
automatically. If no, stop and mark the work **uncertain** for a human. An
explicit uncertain state is a feature: it converts an invisible risk into a
visible queue.

**Prevents:** automatic retry double-charging a customer or re-sending an email.
Never retry a non-idempotent operation just because the code path failed.

---

## P4 — A recreatable resource needs a generation stamp

**Ask:** can this resource be replaced while in-flight work still holds a
reference to the old instance?

**Why:** if yes, a late reply from the dead instance is indistinguishable from a
reply from the live one. You will attribute old work to new state. No amount of
locking fixes this, because the problem is identity, not exclusion.

**Do:** give every instance a monotonically increasing id. Stamp it on work when
the work starts. On completion, compare; reject mismatches. The stamp is free —
it costs one integer and does not change when instances are created.

**Prevents:** results applied to the wrong incarnation of a resource. Known
elsewhere as a fencing token.

---

## P5 — "Recently used" is not "currently in use"

**Ask:** does my eviction, timeout, or cleanup policy distinguish idle from
busy?

**Why:** timestamps record when something *started* being used. Any policy that
reads a timestamp is inferring activity from an event in the past. If the
operation is slow, an actively-working resource looks progressively staler and
becomes the most attractive victim — precisely because it is busy.

**Do:** maintain an explicit count of in-flight work. Let cleanup consider only
zero-count entries. If every candidate is busy, make the *new* request wait
rather than destroying live work. Never infer liveness from a timestamp when
operation duration can exceed the eviction interval.

**Prevents:** killing the one thing that was actually doing something.

---

## P6 — Serialize to fix ordering, not to fix corruption

**Ask:** am I adding this lock to prevent corruption, or to make event order
deterministic?

**Why:** these are different problems and conflating them produces the wrong
design. Storage engines already prevent corruption. What they do not give you is
a guarantee that *your* events are applied in a sensible order when several
independent producers exist. A status callback processed before the record it
refers to is a correctness bug with no corruption involved.

**Do:** identify every producer of mutations. Route them through one serialized
point per logical entity. Then contention becomes a signal — if you see it, a
producer bypassed the funnel.

**Prevents:** out-of-order state transitions, and locks placed where they solve
nothing.

---

## P7 — Drain inward on shutdown

**Ask:** does shutdown stop accepting work before it stops the things that do
the work?

**Why:** teardown order is the exact reverse of dependency order. Tearing down
inside-out means destroying capacity while requests are still arriving, so you
fail work you have already accepted responsibility for.

**Do:** close the outermost intake first. Let in-flight work finish within a
bounded grace period. Classify whatever did not finish (see P3). Then release
resources from the inside out. Any forced-kill timeout must be longer than the
grace period, or none of the above executes.

**Prevents:** self-inflicted data loss during an ordinary, intentional restart.

---

## P8 — Don't build guarantees on state you don't own

**Ask:** has whoever owns this data promised its format and its lifetime?

**Why:** a dependency's internal state is not an API. It may be compacted,
pruned, reformatted or garbage-collected at the owner's convenience, correctly
and without warning. Guarantees you make to your users cannot rest on it.

**Do:** if you must be authoritative about something, keep your own copy. Read
the dependency's state for convenience, never as a source of truth. Accept the
duplication; it is the price of the guarantee.

**Prevents:** an upstream upgrade silently invalidating your compliance,
delivery, or audit claims.

---

## P9 — Separate identification from retrieval

**Ask:** when a request references past data, am I failing to *find* it, or
failing to *know which* is meant?

**Why:** these look identical from the outside and have unrelated fixes. If you
cannot find it, store more or index better. If you cannot identify which one is
meant, storage does not help at all — the pointer is missing, and you need
either a different source for the pointer, or disambiguation with the user.

**Do:** diagnose which one you have before designing. Then: retrieval problem →
storage and indexing. Identification problem → recover the identifier upstream,
infer it and state your assumption, or ask.

**Prevents:** months spent scaling storage for a problem storage cannot solve.

---

## P10 — Layers may have independent lifecycles

**Ask:** does every component in this system need to be alive at the same times?

**Why:** systems get designed around one lifecycle, usually the request's.
Components that must hold a persistent connection, and components that can be
created on demand, have genuinely incompatible requirements. Forcing them into
one model makes one of them wrong.

**Do:** group components by required liveness — always-on, on-demand,
one-shot — and let each group have its own lifecycle. A persistent connection
cannot live inside a disposable unit, and a disposable unit should not be kept
alive to host one.

**Prevents:** discovering late that a core component cannot be scaled down, or
that scaling it down breaks connectivity.

---

## P11 — Put an always-true rule where it is always read

**Ask:** is this instruction placed where it will be read at the moment it
matters, or only where the reader has already decided what to do?

**Why:** guidance attached to an optional path is read only by someone already
taking that path. An instruction on a tool description reaches a reader who has
decided to use a tool; it does nothing for a reader who has decided the job is
finished. The same goes for docs in a folder nobody opens and warnings on a
screen nobody reaches.

**Do:** separate rules by when they must hold. A rule that is always true goes
in the always-read position, on its own, not folded inside a conditional block —
folding it in means it disappears exactly when the condition is false, which is
usually when it was needed. A rule that is situational can live with its
situation.

**Prevents:** the reader confidently doing the wrong thing while the correct
instruction sits one branch away, unread.

---

## P12 — Never extend a configuration whose schema you don't own

**Ask:** if this key turns out not to exist upstream, what happens — is it
ignored, or is it fatal?

**Why:** strict validators reject unknown keys. A setting added speculatively to
someone else's configuration file is not a harmless hint; on a strict schema it
is a startup failure, and it fails uniformly across every instance at once. The
blast radius is the whole fleet, and it lands at the next restart, which may be
long after the change.

**Do:** keep your settings in your own configuration, even when the other
system looks like the natural home for them. If you are the process that acts on
the setting, you are the right owner of it. Only write into a foreign config for
a key you have verified that version reads.

**Prevents:** a one-line config addition stopping every instance, and two
sources of truth for one behaviour.
