# Where Periphery Is Uniquely Useful

> A deep dive into high-leverage applications across the Developer, Product
> Manager, and Executive loops. Written 2026-07-26 against the shipped
> architecture; items marked **[buildable today]** need only a connector or a
> webhook, items marked **[needs platform work]** require a new primitive.

## The primitive nobody else has

Every mainstream notification system is **event-shaped**: something happened,
so interrupt someone. The interruption cost is paid in full, once per event,
regardless of whether the event mattered.

Periphery's overlay can do something structurally different — it can carry
**state**. A glow that persists is not saying "this just happened", it is
saying "this is true right now". That distinction is the source of almost every
opportunity below, because an enormous amount of what knowledge workers need to
know is *state*, and we currently express it by either (a) interrupting them
repeatedly about a condition that has not changed, or (b) hiding it in a
dashboard they must remember to visit.

Three properties compound on that:

1. **Cost-proportional delivery.** Three tiers plus focus-hold, pause-timing,
   and persistence mean the interruption cost can be matched to the information
   value. Nothing else on the desktop lets you say "tell me, but cheaply".
2. **Quantity without content.** The Constellation communicates *how much*
   without *what*. This is not a compromise — it is a distinct information type
   that is safe to display when content is not: during screen shares, demos,
   recorded meetings, in open-plan offices, over a shoulder.
3. **No cloud, no broker.** Everything below works inside a bank, a defence
   contractor, or a hospital, where Zapier and third-party notification SaaS
   are simply not options. This is the moat.

---

## 1. The Developer Loop

The obvious cases (CI, review requests, mail) are shipped. These are the ones
with disproportionate leverage remaining.

### 1.1 Agent supervision — the highest-value gap **[buildable today]**

The 2026 developer runs 2–6 coding agents in parallel and has become their
bottleneck. The expensive failure is not an agent finishing unnoticed (the
beacon solved that) — it is an agent **silently blocked waiting for approval**.
That stall is invisible, unbounded, and costs the entire task's latency.

*   ✅ **Shipped: agent blocked on input** → the `glow-blocked` beacon, which
    escalates with age rather than interrupting up front, and which presence
    alone cannot clear. This also delivered the **state-cue primitive** (§4)
    it needed: `POST /resolve` and a `ref` correlation id. See
    [agents.md](agents.md).
*   **Agent fleet state as ambient colour** → *N running / M blocked* rendered
    as a persistent corner beacon whose colour encodes the worst state. A
    glance answers "does anything need me?" without a terminal sweep.
*   **Agent went off the rails** — touched files outside its brief, burned
    through a token budget, entered a retry loop → amber, immediately.

The MCP server already gives agents a voice; what is missing is a
`task_blocked` tool and a fleet-state cue. This is the single most valuable
thing to build next.

### 1.2 "Is main broken right now?" as ambient state **[needs platform work]**

Every team has a Slack channel that answers this badly. A red build is *state*,
not an event: the current design fires one glow when it breaks and another when
it is fixed, and if you looked away you have no idea which side of that you are
on. A persistent tinted edge for as long as trunk is red — visible to the whole
team simultaneously, costing nobody an interruption — changes "who broke main?"
from an interrupt-driven scramble into shared peripheral awareness.

Needs: a *state cue* primitive (a cue that a connector sets and clears, rather
than fires). This is the most reusable missing piece in the codebase.

### 1.3 Aging escalation — SLA made visible **[needs platform work]**

A review request that has waited 20 minutes and one that has waited two days
currently produce the same comet. Tier should be a function of **age**, not
just type: ambient at first, edge glow after an hour, comet after a day. This
converts Periphery from a notifier into a gentle accountability surface, and it
is a small change — a connector re-firing with a computed tier — with an
outsized effect on team throughput.

### 1.4 Expensive-action guardrails **[buildable today]**

A pre-execution hook that glows *before* something costly or irreversible: a
query about to scan 2 TB, a `terraform apply` touching production, a migration
on a live database, a `git push --force` to a shared branch. Peripheral vision
is fast enough to catch a hand mid-motion — this is arguably the highest-value
millisecond in the whole system, and it is a webhook call from a wrapper script.

### 1.5 On-call as ambient state **[needs platform work]**

Being on call changes how you should interpret everything else. A permanent,
very subtle tint for the duration of a rotation — plus automatic Tier-1
promotion of incident cues while it is active — makes the mode visible instead
of remembered. Pairs naturally with the state-cue primitive.

### 1.6 Local machine health **[buildable today]**

Disk nearly full, a container that died an hour ago, a dev server that crashed
while you were in another window, VPN dropped, battery about to force a
shutdown mid-build. All are cheap `fs`/Docker-socket/`os` polls and all are
things developers currently discover the hard way.

---

## 2. The Product Manager Loop

PMs have the *opposite* problem to developers: not too few interruptions, but no
peripheral awareness at all — their day is meetings and their signal arrives
through a dozen tools they cannot watch simultaneously. Periphery's value here
is less about protecting flow and more about **compressing the surface they must
monitor**.

### 2.1 The decision queue — "people are blocked on you" **[needs platform work]**

PMs are blockers-in-chief and usually do not know it. Aggregating "things
waiting on a PM decision" (a Jira ticket in *Needs Decision*, a PR asking a
product question, a Slack thread with an unanswered direct ask) into a single
ambient count that **escalates with age** is the highest-leverage PM feature
imaginable: it converts invisible organisational latency into a visible,
personal, gently insistent signal. Same aging-escalation engine as §1.3.

### 2.2 Launch windows as a mode **[needs platform work]**

During a rollout, a PM's attention model inverts — normally-ambient signals
(error rate, crash-free sessions, support volume) become Tier 1, and normally
Tier-1 signals (a mention, an email) become noise. A **launch mode** that
re-tiers cues for a defined window is a genuinely novel notification concept and
maps cleanly onto the existing tier system.

### 2.3 Experiment reaches significance **[buildable today]**

The perfect ambient event: not urgent, but you want to know *the moment* it
happens, and today you find out by checking a dashboard on a hunch. An A/B
platform webhook → one glow. Same shape for a canary crossing an error
threshold, or a feature flag rollout stalling.

### 2.4 Named-account signal **[buildable today]**

Not "a support ticket arrived" (noise) but "**a ticket from one of your five
strategic accounts** arrived", or an NPS detractor from a logo on the board
deck. Filtering by account importance at the connector, not at the human, is
where the leverage is — a Zendesk/Intercom poll with an allowlist.

### 2.5 Meeting-prep and calendar defence **[buildable today]**

Already half-shipped via the calendar poll. The extensions worth building: a
15-minute-ahead cue *only* for meetings the PM owns or must present at; a cue
when someone books over a protected focus block; and an end-of-day glow if
tomorrow has zero uninterrupted hours — a nudge to fix the calendar while it is
still fixable.

---

## 3. The Executive Loop

Executives have the highest interruption cost per minute in the organisation and
the worst signal-to-noise ratio arriving at them. They also mostly do not want
another dashboard — the whole executive-information problem is really the
sentence *"tell me only when something needs me."* Periphery is, structurally,
an exception-surfacing device.

### 3.1 Exception-based management **[needs platform work]**

Instead of a daily metrics email nobody reads: a threshold-watcher connector
that stays completely silent while every tracked metric is inside its band, and
produces exactly one ambient glow when one is not. The value proposition is the
**silence** — an executive who trusts the silence has been given back their
attention, which is the scarcest resource in the building.

### 3.2 The escalation surface **[buildable today]**

"Something has been escalated to you *and nobody below you could resolve it*" —
a Sev-1 crossing an hour, a deal blocked on legal for three days, an approval
queue aging past SLA. This is precisely the aging-escalation pattern again, and
for executives it is the difference between finding out now and finding out in
the Monday review.

### 3.3 Screen-share-safe awareness — the Constellation's killer application **[buildable today]**

Executives and PMs present constantly. Every notification system is either
muted during a screen share (you lose all awareness for an hour) or dangerously
unmuted (a private message appears on the projector — a real, career-adjacent
risk). The Constellation is the only mechanism that is *safe to leave on*: it
shows accumulation without content. Formalise it — automatic presentation-mode
detection is already wired via `SHQueryUserNotificationState` — and Periphery
becomes the only notification tool you can keep running while sharing a screen.
This deserves to be marketed as a first-class capability.

### 3.4 Ambient organisational pulse **[needs platform work]**

A single very-low-frequency state colour reflecting overall system health —
green through amber to red — updated a few times an hour and never demanding
anything. It answers "is the company on fire?" with zero clicks and zero
interruptions. This is what an executive dashboard *wants* to be.

### 3.5 Board-critical thresholds **[buildable today]**

Cash runway, a top-10 customer's usage collapsing, churn crossing a plan
number, a security incident touching customer data. Rare by construction, so
Tier 1 is justified; local-first is a hard requirement, because these numbers
cannot go through a third-party notification broker.

---

## 4. Cross-cutting primitives worth building

The persona list keeps converging on four missing mechanics. Building these
unlocks most of the above at once:

| Primitive | What it enables | Rough shape |
| --------- | --------------- | ----------- |
| ✅ **State cues** (set/clear, not fire) | Broken trunk, on-call, launch mode, org pulse | **Shipped** for blocked agents: a `ref` on the payload plus `POST /resolve`. Generalising it to connectors is the remaining work |
| **Aging escalation** | Review SLAs, decision queue, escalation surface | Re-evaluate tier as a function of age; connectors re-fire with a computed tier |
| **Modes / re-tiering** | Launch windows, on-call, demo mode | A named profile that remaps tiers for a window, layered over the existing hierarchy |
| **Threshold watchers** | Experiments, canaries, exec metrics | A generic "poll a number, cue on band exit" connector — one implementation, dozens of uses |

A fifth, more speculative: **team-visible presence**. Periphery currently
*reads* focus state; broadcasting it (loopback → a colleague's instance over
LAN, no cloud) would let a team see who is deep without asking — turning a
personal tool into a shared social contract about interruption.

---

## 5. Where Periphery is the wrong tool

Naming these protects the product's credibility:

*   **Anything requiring proof of delivery.** Ambient cues are best-effort and
    deliberately missable. Never use them for compliance alerting, legal
    deadlines, or anything needing an audit trail of acknowledgment.
*   **Content that must be read exactly.** A 160-character pill is not a
    channel for anything you must quote, forward, or act on verbatim.
*   **Multi-person coordination.** "Everyone join the bridge now" needs a
    system with acknowledgment and escalation-to-a-human. Periphery can be the
    *first* signal, never the only one.
*   **High-frequency streams.** More than a few cues an hour and the ambient
    channel stops being ambient — it becomes wallpaper, and you have rebuilt
    the notification fatigue you set out to remove. **The constraint is the
    product.**

---

## 6. If you build five things next

Ranked by value ÷ effort, drawing on everything above:

1. ✅ **`task_blocked`** (§1.1) — shipped, and it brought the **state-cue
   primitive** and a first **aging-escalation** curve with it. Still open: an
   *agent fleet* state cue (N running / M blocked as one colour).
2. **Generalise state cues to connectors** (§4) — the plumbing exists; giving
   connectors set/clear unlocks §1.2 (broken trunk), §1.5 (on-call), §3.4.
3. **Aging escalation as a shared engine** (§4) — `utils/blockedAgents.js`
   proves the curve; lifting it out unlocks §1.3, §2.1, §3.2.
4. **Threshold-watcher connector** (§4) — one implementation serves PM and exec cases alike.
5. **Screen-share-safe mode** (§3.3) — mostly *packaging* what already exists,
   and it is the most differentiated story Periphery can tell.
