# Patterns for work that takes a long time

Rules for building work that runs for minutes or hours, can pause for a human,
and has to survive a crash or a restart in the middle.

Each rule is written to be read on its own. You should not need to know this
codebase, or have read anything else, to understand one.

---

## 1. Work that is waiting should not hold onto expensive things

**What happens:** a job starts. To run, it needs two things — permission to be
the only one doing it, and actual capacity, like a container or a worker
process. Both get picked up at the same moment, so they feel like one thing.

Then the job pauses. Maybe it is waiting for someone to approve an action, or
waiting out a retry delay, or waiting for a smaller job it started. It is not
doing anything, but it is still holding the container. If three jobs are waiting
on a human who is asleep, three containers are sitting idle and nothing else can
run. Your concurrency limit is now set by how fast people answer email.

**The rule:** these are two separate things, so store them separately.

*Permission to own the work* is a few bytes in a row — an owner id and an expiry
time. It is cheap, and it must survive crashes, restarts and hours of waiting.

*Capacity* is expensive and should be handed back the moment it is not being
used.

Then go through your list of states and mark which ones genuinely need capacity.
Almost always it is exactly one: actually running right now. Every waiting state
keeps the cheap row and gives back the container. When the job wakes up it reads
the row and asks for capacity again.

**Check:** if a job pauses for four hours, what does it cost you? If the answer
is a container, you have them coupled.

**The catch:** giving back the container means the job has to be rebuildable
from what is written down. That is rule 2's cousin — you need to save enough
along the way that resuming does not need anything that was in memory.

---

## 2. Finishing a job is two steps, and the second one is the one that gets lost

**What happens:** a job finishes. The code writes "done" to the database, then
sends the notification — an email, a message, an update to a parent job.

The process dies in between.

Now you have a job marked "done" that nobody was told about. Nothing will ever
retry it, because as far as the system is concerned it succeeded. There is no
error anywhere. No alert fires. The only person who notices is the user who
waited for a reply that never came, days later, and by then nothing in the logs
explains it.

This one is nasty because it is silent by design. Every other failure leaves a
trace. This one leaves a perfectly healthy-looking row.

**The rule:** make the notification safe to send twice. Then run a loop, say
every minute, that walks every finished job and sends its notification again —
without checking whether it was already sent.

The instinct is to add a `notified` column and only sweep the rows where it is
false. Don't. That column is another write, and it gets lost in exactly the same
crash. If the process dies after writing "done" but before writing
`notified = false`, the sweeper will never look at that row.

Sending unconditionally over something that is safe to repeat means there is
nothing to detect and nothing to get wrong.

**Check:** kill the process between the two writes and see if the notification
ever arrives.

---

## 3. Approve the thing, not the row it sits in

**What happens:** something needs a human to say yes — sending money, emailing a
client, deleting records. The usual design is a boolean: a person clicks
approve, the code sets `approved = true`, and later something reads that column
and goes ahead.

The problem is that the person approved a *row*, not the contents of the row.
Anything that edits the contents between the click and the execution inherits
that approval for free. A retry that rebuilds the payload. A background job that
"fixes" a field. A bug. The person believes they approved what was on their
screen. What they actually approved was an id.

For anything regulated this is also the question you cannot answer afterwards:
*what exactly was agreed to?* A boolean cannot tell you.

**The rule:** take a hash of the exact payload the person was shown, and store
it with their decision. Before executing, hash the payload again and compare. If
they differ, treat it as a refusal — not a warning, not a log line.

Now the approval is attached to content. Any change to the content cancels it
automatically, and you did not have to predict which changes were dangerous.

**Check:** can you show someone, six months later, the exact bytes that were
approved? If not, you have a boolean.

---

## 4. Let the database enforce "only once"

**What happens:** the same request arrives twice — a retried webhook, a
double-tapped button, a queue redelivering. The usual fix is to look first: "is
there already a row with this key? No? Then insert one."

Between the check and the insert there is a gap. Two copies of the request can
both look, both see nothing, and both insert. The gap is small, so it never
happens in testing. It happens under load, which is exactly when duplicates cost
the most.

Then someone adds a lock to close the gap, and now you have a bottleneck you
built yourself, solving a problem the database already solved.

**The rule:** take whatever must be unique — the idempotency key, the request
id, a natural key — hash it, and make that the primary key of the row. Then just
insert. If it is a duplicate, the insert fails on the key, and you catch that
and return the existing row.

There is no window, because there is no check. The database does it atomically,
which is the one thing it is genuinely better at than your code.

**Check:** if you are writing `SELECT` before `INSERT` to stop duplicates, you
have a race.

---

## 5. Write down which state you expected

**What happens:** code reads a row, decides what to do based on what it saw,
then writes the update. The read and the write are a few lines apart, so the
state feels current.

Meanwhile something else changed it. Another worker picked the job up. An
operator cancelled it. The write goes through anyway and quietly undoes that —
cancelled work starts running again, or two workers both think they own the same
job. There is no error, because an unconditional update always succeeds.

**The rule:** every state change is really a conditional. *Given it was queued,
make it running.* Write it that way: update the row only where the state still
matches what you read, and where the owner is still you. One statement, both
conditions.

When that update changes zero rows, that is not a failure to swallow. It is the
system telling you the world moved while you were thinking. Read it again and
decide again.

**Check:** find an update that sets a status without a `WHERE` clause on the old
status. That is a lost update waiting for a busy day.

---

## 6. A ping can be missed; the written-down record cannot

**What happens:** two parts of the system need to talk, so you reach for a
message transport — a websocket, a queue, a socket library. It is fast, it is
push-based, and it feels like the natural way to hand work over.

But the guarantee ends at the process boundary. If the receiver is restarting,
wedged, or mid-deploy when the message goes out, it is gone. The sender saw a
successful send. Nobody knows work was lost. You find out when someone asks why
their thing never happened.

**The rule:** write the work to the database first. Then send the message, and
let it carry nothing important — it is only a "go look, there's something for
you". Pair that with a slow sweep of the database, say every minute, for
anything not picked up.

Now a missed message costs you latency, not correctness. The system falls back
to polling instead of losing work.

This also means you usually do not need a message bus at all. The database you
already have, plus any connection you already hold open, does the job. Adding a
new piece of infrastructure to fix a durability problem is worth pausing on,
because transports do not provide durability — that is the thing they are
specifically not for.

**Check:** drop the notification on the floor. Does the work still happen, just
later? If not, the message was carrying something it should not have been.

---

## 7. Do not let tools create things they cannot find

**What happens:** a tool needs a file or a directory, does not find it, and
helpfully creates one instead of failing.

This sounds friendly and is one of the most damaging defaults in infrastructure.
The thing it invents is usually the wrong kind and owned by the wrong user. Now
the component that should have created it properly cannot even delete the
placeholder, because permission to delete comes from the parent directory, which
was also invented by the wrong user.

The original problem — "it is missing" — is now gone, replaced by "it exists and
is wrong", which is harder to recognise and often unfixable without root.

A concrete version: Docker, asked to mount a file that does not exist, creates a
directory at that path owned by root. The container then refuses to start
because a directory is not a file. It will keep refusing forever, and the
service that normally writes that file cannot remove the directory in its way.
A missing file is a five-second fix. This is an outage.

**The rule:** check that every external thing you depend on exists, and is the
right kind, *before* handing control to the tool that would invent it. Refusing
to start is the correct behaviour. It is loud, it names the problem, and it
leaves the system in a state you can still repair.

The check has to come first. After the operation, it is a post-mortem.

**Check:** for each path, socket or resource you pass to an external tool — what
does that tool do if it is not there? If you do not know, assume it creates
something.

---

## 8. A setting you never wrote is a setting someone else chose

**What happens:** you rely on a dependency for something that matters —
permissions, alerting, retention, approvals. The feature exists. The
documentation describes it well. You read about it and feel covered.

But the feature existing is not the same as it being on. Vendors ship permissive
defaults because strict ones generate support tickets, and documentation usually
explains how a mechanism works rather than what it does when you have not
configured it. Reading the docs leaves you *more* confident and no better
protected.

Nothing announces this. There is no startup warning for a safety feature that
was never switched on, and no log line for a config block you never wrote.

**The rule:** review your *effective* configuration, not your config file. For
every property you would state out loud to an auditor, a customer or your own
team, find the line that sets it. If there is no line, you do not have the
property — you have the vendor's default, and you should assume that is the most
permissive setting available.

**Check:** take three safety claims you believe about your system. Find the
config line for each. If you cannot find one, you have just learned something.

---

## 9. Name a waiting state after whatever ends the wait

**What happens:** states get named after what the system is doing. `pending`.
`processing`. `blocked`. All of these say the same thing — it is not finished —
which you already knew.

The question you actually need answered is *what has to happen for this to
move?* When one name covers several different answers, you cannot act on it.
Work waiting for a person to approve something, work waiting for a person to
answer a question, work waiting for a child job, and work waiting out a retry
delay all need different timeouts, different alerts and different escalation.
A single `blocked` state supports none of them.

**The rule:** name the state after the event that resumes it, and split it
whenever that event is different. Waiting for a decision. Waiting for an answer.
Waiting for a child. Waiting for a retry window.

Each then gets a timeout that makes sense, and "how much work is stuck on me?"
becomes a query someone can run.

Worth separating even when it feels like hair-splitting: *waiting for a
decision* and *waiting for an answer* look identical from the code's side, but
they are different obligations, they escalate to different people, and an
auditor will want them apart.

**Check:** look at your longest-waiting `pending` items. If they turn out to be
three unrelated problems in one bucket, the name was doing no work.
