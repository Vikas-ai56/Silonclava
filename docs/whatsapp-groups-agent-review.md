> **Historical.** A point-in-time document, kept for its reasoning. It is *not* a
> description of the current code — see `docs/features/`, `docs/CODEBASE.md`, and
> `docs/DECISIONS.md` when they disagree.

# WhatsApp group limitations: Kapso vs Meta vs alternatives

**Audience:** Rocky / EVAA product and engineering.
**Purpose:** Separate **Kapso’s gap** from **Meta’s Cloud API rules**, then show what replacing Kapso actually buys — and what **no official BSP can do**.  
**Rule for this note:** Claims below are tied to **official docs** (Meta, Kapso, 360dialog, Twilio, Infobip, OpenClaw). Kapso’s verbal “we don’t support groups” is consistent with their public docs (no Groups API guide) but is **not** a published Kapso page title; treat Meta/360dialog/Twilio as the legal-grade sources for Cloud API groups.

---

## 1. There are two different “group problems”

Do not mix these up. They have different owners and different fixes.

| Problem | Owner | Fixed by switching BSP? |
|--------|--------|-------------------------|
| Our stack (Kapso) does **not implement** Meta’s Groups API: create group, invite link, inbound `group_id` webhooks, send with `recipient_type: group` as a first-class product | **Kapso** (platform) | **Maybe** — only if the new vendor documents Groups API (e.g. 360dialog) **and** we rebuild webhooks/agents on their API |
| Official Cloud API groups are **invite-only**, **max 8 people**, **business-created only**, **OBA required**, **cannot add participants by phone**, **cannot join an existing consumer group** | **Meta** | **No** |

Switching away from Kapso can unlock **Meta’s Groups API** (if the BSP implements it). It cannot unlock “drop our agent into an existing 50-person family/team chat.” That is not a Kapso rule.

---

## 2. What is Kapso’s limitation (platform)

### 2.1 Kapso is built around 1:1 Cloud API messaging and agents

Kapso’s public product docs for agents describe **a connected WhatsApp number**, webhooks, and OpenClaw as a **channel to that number** — not group membership.

- Personal agents: [Kapso — Personal AI agents](https://docs.kapso.ai/docs/whatsapp/personal-agent)  
  Requires a Kapso project, a **connected WhatsApp number**, API key, and a runtime (OpenClaw, Hermes, Chat SDK, MCP, or your webhook).
- OpenClaw plugin: [Kapso — OpenClaw](https://docs.kapso.ai/docs/whatsapp/openclaw)  
  Inbound is a **phone-number-scoped** webhook for `whatsapp.message.received`. Channel targets are **phone numbers** (`kapso:+1555…`, E.164). Allowlist is `allowFrom` for **DM senders**, not WhatsApp group JIDs.
- Customer onboarding: [Kapso — Onboard customers](https://docs.kapso.ai/docs/platform/customer-guide)  
  Setup links → customer **logs in with Facebook** and connects WhatsApp. This is 1:1 WABA/number connect, not groups.

Kapso’s documentation index ([llms.txt](https://docs.kapso.ai/llms.txt)) lists messages, templates, inbox, broadcasts, setup links, OpenClaw, etc. It does **not** list a Groups API, group create, or group invite-link guide comparable to Meta or 360dialog.

### 2.1a Kapso is natively an **agent platform** on Cloud API; classic BSPs are not

Kapso positions itself as “WhatsApp for developers” and “give your AI agent a WhatsApp number,” not as a generic CPaaS. Official surfaces that **360dialog / Twilio / Infobip do not ship as first-party OpenClaw/Hermes products**:

| Kapso agent surface | Official docs |
|---------------------|---------------|
| **OpenClaw** channel plugin `clawhub:@kapso/openclaw-whatsapp` — install, webhook register, `allowFrom`, bundled Kapso CLI | [OpenClaw](https://docs.kapso.ai/docs/whatsapp/openclaw), [gokapso/openclaw-plugin](https://github.com/gokapso/openclaw-plugin), [kapso.com/whatsapp-openclaw](https://kapso.com/whatsapp-openclaw) |
| **Hermes Agent** plugin `gokapso/hermes-agent-plugin` — Kapso webhooks → Hermes turns. Hermes also has **built-in** Graph Cloud API (`hermes whatsapp-cloud`) that does **not** need Kapso | [Kapso Hermes](https://docs.kapso.ai/docs/whatsapp/hermes-agent), [Hermes Cloud API](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud) |
| **Chat SDK** adapter `@kapso/chat-adapter` | [Chat SDK](https://docs.kapso.ai/docs/whatsapp/chat-sdk) |
| **Project MCP** (`https://api.kapso.ai/mcp`) — send/read messages, numbers, webhooks, setup links as agent tools | [MCP server](https://docs.kapso.ai/docs/whatsapp/mcp) |
| **Workflows** with Agent nodes, waits, functions, handoff | [WhatsApp AI agent](https://kapso.com/whatsapp-ai-agent), [Twilio alternative](https://kapso.com/twilio-alternative-for-whatsapp) |
| CLI `@kapso/cli` for numbers, messages, webhooks | [CLI](https://docs.kapso.ai/docs/whatsapp/cli) |

Kapso’s own comparison: Twilio is broad CPaaS; Kapso is WhatsApp + **automation, AI agents, CLI, MCP, customer onboarding**. [A Twilio alternative for WhatsApp](https://kapso.com/twilio-alternative-for-whatsapp)

**What OpenClaw itself documents:** the **built-in** WhatsApp channel is **WhatsApp Web (Baileys)**. Quote: “There is **no separate Twilio WhatsApp channel**.” [OpenClaw — WhatsApp](https://docs.openclaw.ai/channels/whatsapp)

So:

- **Kapso + OpenClaw** = vendor-maintained **Cloud API** plugin.
- **OpenClaw default WhatsApp** = **not** Cloud API (QR / Baileys).
- **360dialog / Infobip** = messaging BSP + partner onboarding. **No** official OpenClaw, Hermes, Chat SDK, or Kapso-style Project MCP in their docs.
- **Twilio** = WhatsApp Business API + TPP. OpenClaw docs do **not** include a Twilio WhatsApp channel. A **community** plugin exists (`clawhub:@srinathh/openclaw-channel-twilio-whatsapp` / [ClawHub](https://clawhub.ai/srinathh/plugins/openclaw-channel-twilio-whatsapp)) — **not** Twilio-published, not in Twilio’s WhatsApp docs.

Replacing Kapso with 360dialog/Twilio for **groups** means we **keep our own agent** (Rocky / OpenClaw / webhooks) and **lose** Kapso’s first-party agent wiring. We do **not** get a drop-in OpenClaw plugin from those BSPs.

### 2.2 Kapso send API mentions `group` — that is not a Groups product

Kapso’s send-message schema allows `recipient_type: individual | group` and says that when `group`, `to` must be a **Group ID obtained via the Groups API**:

- [Kapso — Send a message](https://docs.kapso.ai/api/meta/whatsapp/messages/send-a-message)

That is a **passthrough field** on Meta’s Messages API. Kapso does **not** document:

- `POST …/groups` (create)
- invite link / join requests
- group lifecycle webhooks (`group_lifecycle_update`, `group_participants_update`, …)

So: even if a Group ID existed from elsewhere, Kapso has not published group **management** or inbound group routing. Their developer reply that Cloud API numbers are 1:1 in **Kapso’s product** matches the missing Groups docs.

### 2.3 What replacing Kapso can fix

If we move to a BSP that **implements Meta Groups API** (documented below), we can:

- Create **new** Cloud API groups
- Invite people with **invite links / templates**
- Send/receive in those groups over official Cloud API
- Apply **our own allowlist** in our agent (filter webhook `from` / `group_id`)

That is the Kapso-shaped gap. It is **not** the 8-person cap and **not** “join existing WhatsApp groups.”

### 2.4 True Kapso competitors (same OpenClaw / agentic Cloud API stack)?

**Short answer: no first-party twin.** After checking vendor docs, OpenClaw docs, ClawHub, and GitHub:

| Candidate | Cloud API WhatsApp? | First-party OpenClaw plugin? | Other agent stack like Kapso? | Verdict |
|-----------|---------------------|------------------------------|-------------------------------|---------|
| **Kapso** | Yes (they host the Cloud API path) | **Yes, vendor-official** — `clawhub:@kapso/openclaw-whatsapp` ([docs](https://docs.kapso.ai/docs/whatsapp/openclaw), [gokapso/openclaw-plugin](https://github.com/gokapso/openclaw-plugin)) | Hermes plugin, Chat SDK, Project MCP, Workflows, CLI, setup links, numbers | The product we have |
| **OpenClaw `@openclaw/whatsapp`** | **No** — Baileys / WhatsApp Web ([docs](https://docs.openclaw.ai/channels/whatsapp)) | Official plugin, **not Cloud API** | Allowlists + **existing groups** via Web protocol | Different stack, ToS/ban risk |
| **360dialog** | Yes + **Groups API** | **No** in 360dialog or OpenClaw official docs | Meta Business Agent (Meta’s 1:1 AI, not OpenClaw) ([MBA](https://docs.360dialog.com/docs/mba/meta-business-agent)) | Messaging BSP, not an agent platform |
| **Twilio** | Yes | **No** first-party. Community: [@srinathh/openclaw-channel-twilio-whatsapp](https://www.npmjs.com/package/@srinathh/openclaw-channel-twilio-whatsapp) | Conversations / Flex / AI Assistants — not OpenClaw | CPaaS + DIY agent |
| **Infobip / Gupshup / Bird** | Yes (CPaaS WhatsApp) | **No** OpenClaw WhatsApp channel in their docs | Bird has **coding-agent MCP/CLI** for the Bird platform ([mcp.bird.com](https://bird.com/en-nl/docs/ai/set-up-your-agent)); Gupshup has a **community** MCP ([gupshup-mcp](https://github.com/ManmohanBuildsProducts/gupshup-mcp)) | Agent-*ops* on a CPaaS, not “give OpenClaw a WhatsApp number by default” |
| **Zernio** | Claims Cloud API + [Groups API](https://docs.zernio.com/platforms/whatsapp/groups) + MCP + CLI | **No OpenClaw/Hermes plugin found** in Zernio or OpenClaw docs | MCP/CLI for posting/ops; marketing [Kapso alternative](https://zernio.com/alternatives/kapso) | Closest **developer WhatsApp + MCP** shape; **not** documented OpenClaw parity. Their [Add participants](https://docs.zernio.com/whatsapp/add-whatsapp-group-participants) API **conflicts with Meta’s** “cannot manually add participants” — treat as unverified vs Graph. |
| **ClawLink** | Uses **your existing** WhatsApp Business Cloud API | **Not a channel plugin.** ClawHub skill + hosted OAuth; 17 WhatsApp **tools** over MCP ([claw-link.dev](https://claw-link.dev/openclaw/whatsapp)) | You already have a WABA; they hide tokens. Not number provisioning, not Kapso webhooks | Overlap: “OpenClaw ↔ Cloud API without copy-pasting tokens.” **Not** a Kapso twin |
| **Hermes native Cloud API** | Yes — **direct Graph**, no Kapso ([hermes whatsapp-cloud](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud)) | N/A (Hermes, not OpenClaw). Kapso’s [Hermes plugin](https://docs.kapso.ai/docs/whatsapp/hermes-agent) is a **Kapso webhook** path; Hermes docs now say separate WhatsApp plugins are **obsolete** | Built-in Baileys **or** Cloud API; Cloud API is **DMs only (v1)** | Agent runtime with first-party Cloud API. **Not a BSP.** You still bring Meta tokens/webhook |
| **Community Graph OpenClaw channels** | Direct `graph.facebook.com` | Community only: [mcostantino-dev/openclaw-whatsapp-cloud-api](https://github.com/mcostantino-dev/openclaw-whatsapp-cloud-api), [shqear93/openclaw-whatsapp-cloud](https://github.com/shqear93/openclaw-whatsapp-cloud), [valkyriweb/openclaw-whatsapp-cloud](https://github.com/valkyriweb/openclaw-whatsapp-cloud) | You own Meta app, tokens, HTTPS webhook | **Kapso-shaped DIY**, not a competing platform |
| **Community plugins that still use Kapso** | Via Kapso | Unofficial: `openclaw-whatsapp-kapso` ([npm](https://www.npmjs.com/package/openclaw-whatsapp-kapso)), [Enriquefft/openclaw-kapso-whatsapp](https://github.com/Enriquefft/openclaw-kapso-whatsapp) | Same Kapso APIs | Ecosystem around Kapso, **not competitors** |

**What “same as Kapso” would require (and nobody else fully documents):**

1. Official Cloud API (not Baileys).  
2. Vendor-owned **OpenClaw** plugin on ClawHub (`@vendor/...`) **plus** typically Hermes / MCP / workflows.  
3. Number connect / setup links / credits as a product.

Only **Kapso** hits (1)+(2) **as a vendor product** (they publish the plugin **and** run the Cloud API proxy / numbers / webhooks). Direct-Graph community plugins hit (1)+(2) as **code**, but you become the BSP: Meta app, tokens, webhook, no Kapso rental numbers or setup links. Twilio’s OpenClaw plugin is a **third-party** ClawHub package. OpenClaw’s own WhatsApp plugin fails (1). 360dialog hits (1) and Groups, fails (2). ClawLink is MCP **tools** on a WABA you already have, not a first-class OpenClaw WhatsApp **channel** plus number product.

**Partial overlaps (not OpenClaw + BSP twins):**

- **Kapso Workflows Agent node** ≈ other chatbot builders (Botpress, Voiceflow, WATI, etc.) — different runtime, not OpenClaw.  
- **Meta Business Agent via 360dialog** ≈ hosted WhatsApp AI on the number — Meta-owned agent, not our OpenClaw/Rocky/DeepSeek.  
- **Hermes `whatsapp-cloud`** ≈ bring-your-own Meta Cloud API into Hermes; no Kapso, no OpenClaw, Cloud API groups not in v1.  
- **Bird MCP / Gupshup MCP** ≈ let a coding agent operate a CPaaS; not an inbound WhatsApp agent number.  
- **Our Rocky worker** already *is* the custom-agent path Kapso documents under “Custom agent” ([personal agent](https://docs.kapso.ai/docs/whatsapp/personal-agent)) — portable to any Cloud API webhook BSP.

**Implication for Rocky:** switching BSP for groups **trades away** Kapso’s native agent integrations. We would re-bind OpenClaw/Rocky ourselves (community Graph plugin, Twilio community plugin, ClawLink tools, or Hermes Cloud API). There is **no** documented “360dialog OpenClaw,” “Infobip OpenClaw,” or “Zernio OpenClaw” equivalent to `clawhub:@kapso/openclaw-whatsapp`.

---

## 3. Meta-side limitations (survive any BSP)

These are from **Meta WhatsApp Business Platform / Cloud API**, not 360dialog or Kapso.

### 3.1 Groups API only creates **business-owned** groups (invite-only)

Source: [Meta — Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) (updated 16 Jun 2026)

> “The Groups API enables you to programmatically **create** groups for messaging and collaboration.”  
> “Groups are an **invite-only** experience where **participants join using a group invite link you send them**.”

Source: [Meta — Get started with Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started)

> “When **you create a group**, a unique invite link is generated which you can share to potential group participants.”  
> “Once a user joins the group, a webhook is triggered, signaling that **you are now eligible to send messages to the group**.”

**Implication:** The Cloud API number is admin of groups **it creates**. Humans opt in. There is no documented “join this existing `@g.us` chat” or “add our agent to the customer’s current group.”

### 3.2 You cannot add people (or the agent) by phone number

Source: [Meta — Group management](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/reference)

> “When you **create a new group**, an invite link is created for inviting participants to the group.”  
> “**Since you cannot manually add participants to the group**, simply send a message with your invite link to WhatsApp users who you would like to join the group.”

Documented membership operations include **remove** participants (`DELETE /<GROUP_ID>/participants`) and **approve/reject join requests** to **your** group. There is **no** add-by-phone-number endpoint.

`join_requests` = humans requesting to join **the business’s** group, not the business joining theirs.

### 3.3 The 8-person cap is Meta’s, not a BSP’s

Source: [Meta — Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups)

> **Max group participants: 8**  
> Max groups you can create: **10,000 per business number**  
> **Max Cloud API businesses per group: 1**

360dialog repeats the same numbers because they implement Meta’s API: [360dialog — Groups](https://docs.360dialog.com/docs/messaging/groups) (“Max group participants: 08”).

The 8 includes the business. Practical size: **≤ 7 humans + 1 Cloud API number**.

This is **not** consumer WhatsApp group size. Consumer groups can be much larger; Cloud API Groups API is a different product.

### 3.4 Eligibility: Official Business Account (OBA), Cloud API only

Source: [Meta — Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) and [Get started](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started)

- Groups API is open to businesses with an **Official Business Account (OBA)** (green tick — not the same as “WABA Approved” or Business Verification alone).
- Number must be on **Cloud API**, **not** the WhatsApp Business app.
- **Not available** for WhatsApp Business app numbers or **Multi-solution Conversations**.
- Prerequisite: `whatsapp_business_messaging` and group webhook fields (`group_lifecycle_update`, `group_participants_update`, `group_settings_update`, `group_status_update`).

360dialog OBA explainer: [360dialog — Official Business Account](https://docs.360dialog.com/docs/resources/official-business-account-oba).

### 3.5 What Cloud API groups cannot do (Meta)

From the same Groups API “Limits” section:

**Unsupported message types:** calling, disappearing messages, view-once, auth, commerce, **interactive messages**.  
**Unsupported actions:** admin hide participant list, edit message, delete message.  
**Calling API** is not supported in groups.

Send/receive for groups: [Meta — Group messaging](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging) — `recipient_type: group`, `to` = group ID.

### 3.6 Phone-number caps (also Meta, not Kapso)

Separate from groups, but relevant if we “put all agent numbers under our WABA”:

Source: [Meta — Business phone numbers](https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers/)

- New portfolios: **2** registered business phone numbers.
- After **business verification** or messaging limit **2,000**: cap can rise to **20** (`max_phone_numbers_per_business`).
- Above 20: not automatic.

360dialog restates this: [Phone numbers](https://docs.360dialog.com/docs/resources/phone-numbers).

### 3.7 Cloud API numbers are not WhatsApp Messenger / Web clients

You cannot put a Cloud API number on Kapso **and** QR-link the same number as WhatsApp Web to join arbitrary groups.

360dialog: registered business numbers “cannot be used with WhatsApp Messenger.”  
[360dialog — Phone numbers](https://docs.360dialog.com/docs/resources/phone-numbers)

Meta Groups API requires Cloud API, not the Business app (see §3.4). Those two modes are mutually exclusive for Groups API.

### 3.8 “Unofficial groups” are not Cloud API

Join-existing-group APIs (`groupAcceptInvite`, WAHA `POST /groups/join`, etc.) use the **WhatsApp Web / linked-device** protocol. They are **not** `graph.facebook.com` Cloud API.

OpenClaw’s **official** WhatsApp channel is explicit:

Source: [OpenClaw — WhatsApp](https://docs.openclaw.ai/channels/whatsapp)

> “Status: production-ready via **WhatsApp Web (Baileys)**.”  
> “There is **no separate Twilio WhatsApp channel**.”

That path has `groupPolicy` / `groupAllowFrom` for **real WhatsApp groups**, because it is a Web client — **not** Meta Cloud API. It is unofficial relative to the Business Platform and carries ToS / ban risk. It does **not** become official by routing through Kapso.

There is **no** unofficial Graph/Cloud API trick that keeps Cloud API **and** joins existing consumer groups. Cloud API group membership is only what Meta published in Groups API.

---

## 4. Alternatives if we replace Kapso — trade-offs (official docs)

None of these is a 1:1 Kapso clone (setup links + rental numbers + OpenClaw plugin + inbox). Compare **only documented** surfaces.

### 4.1 Stay on Kapso (current)

| Gain | Cost |
|------|------|
| Number already connected (Kapso-managed Meta app, Dedicated Cloud API) | No documented Groups API product |
| Official OpenClaw plugin + CLI/webhooks | 1:1 DMs (and allowlist in OpenClaw / our worker) |
| Instant/setup-link / partner billing paths in Kapso docs | Customer Meta still required for **their** WABA via setup links ([customer guide](https://docs.kapso.ai/docs/platform/customer-guide)); v0 “we own WABA” still hits Meta number caps |

**Does not remove:** Meta 8-cap, invite-only, no join-existing — those apply if we ever get Groups via another BSP.

### 4.2 360dialog

**Groups:** Full official Groups docs aligned with Meta.

- [Groups](https://docs.360dialog.com/docs/messaging/groups) — OBA, 8 participants, 10,000 groups/number, invite-only, not coexistence  
- [Group management](https://docs.360dialog.com/docs/messaging/groups/group-management) — create, invite link, join requests, remove  
- [Group messaging](https://docs.360dialog.com/docs/messaging/groups/messaging-api) — send `recipient_type: group`; inbound webhook includes `group_id` and participant `from`

**Onboarding / numbers:**

- Numbers **only via Embedded Signup**; **360dialog does not provide phone numbers**. [Phone numbers](https://docs.360dialog.com/docs/resources/phone-numbers)  
- Partner flow always includes **Embedded Signup** (client Facebook login, their WABA). [Integrated Onboarding](https://docs.360dialog.com/partner/onboarding/integrated-onboarding)

**Trade-offs vs Kapso**

| We gain | We lose / extra work |
|---------|----------------------|
| Official Cloud API **groups we create** | Kapso OpenClaw plugin, rental/instant numbers, Kapso inbox/workflows |
| Inbound group webhooks for **our** allowlist in **our** agent | Rebuild Rocky/OpenClaw on `D360-API-KEY` + 360dialog webhooks |
| Mature Partner API | Customers still see Meta in the documented partner path |

**Still cannot:** join existing consumer groups; exceed 8; skip OBA; hide Meta for **per-customer WABAs** (docs require ES).

**Allowlist:** 360dialog’s documented allowlist for [Meta Business Agent](https://docs.360dialog.com/docs/mba/meta-business-agent) is **Meta’s hosted 1:1 MBA rollout**, not our OpenClaw agents in groups. Group allowlist remains **our code** on `from` / `group_id`.

### 4.3 Twilio WhatsApp (Tech Provider Program)

Sources:

- [Tech Provider overview](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program) — customers use **Embedded Signup**; you can **assign a Twilio number** before ES  
- [TPP integration guide](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide)  
- [Register senders (ISVs)](https://www.twilio.com/docs/whatsapp/isv/register-senders) — **first** sender via ES; **additional** senders via Senders API possible  
- [WhatsApp FAQs](https://www.twilio.com/docs/whatsapp/best-practices-and-faqs) — Meta Groups API launched Oct 2025; Twilio also mentions **Conversations API** group messaging (a Twilio product, not necessarily full Meta Groups API parity)

**Trade-offs vs Kapso**

| We gain | We lose / extra work |
|---------|----------------------|
| Large ISV: assign Twilio numbers, extra senders via API after first ES | We become a **Meta Tech Provider** (own Meta app + Twilio Partner Solution) |
| Possible Groups API / Conversations (confirm Twilio’s Groups coverage before betting the product) | No Kapso-hosted setup links; no official OpenClaw plugin |
| | Still Meta ES for the customer’s first WABA |

**Still cannot:** join existing consumer groups via Cloud API; exceed Meta’s 8 if using Meta Groups API; skip Meta for customer-owned WABAs.

### 4.4 Infobip (Tech Provider)

- [Tech Provider Program](https://www.infobip.com/docs/whatsapp/tech-provider-program)  
- [Business onboarding](https://www.infobip.com/docs/whatsapp/tech-provider-program/business-onboarding) — users **Login with Facebook**, create/select portfolio, register WABA, verify number  

Same Meta ES model as Twilio/360dialog partners. Conversations/inbox is Infobip’s product, not Kapso+OpenClaw. Groups: do not assume parity with 360dialog unless Infobip publishes Groups API docs equivalent to Meta’s.

**Still cannot:** same Meta Cloud API group rules if they only proxy Cloud API.

### 4.5 Direct Meta Cloud API (no BSP)

[Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/) + Groups API links in §3.

We implement webhooks, tokens, Groups API ourselves. OpenClaw would use a **Cloud API plugin** (community) or our Rocky worker against Graph — **not** Kapso’s official plugin.

**Trade-offs:** maximum control; maximum ops; still 100% of Meta group + number-cap rules; no Kapso rental numbers or setup links.

### 4.6 OpenClaw built-in WhatsApp (Baileys) — not a Kapso replacement for Cloud API

[OpenClaw — WhatsApp](https://docs.openclaw.ai/channels/whatsapp): WhatsApp **Web**, QR login, `groupPolicy` / `groupAllowFrom`, mention gating.

| We gain | We lose |
|---------|---------|
| Join/participate in **existing** WhatsApp groups (Web protocol) | **Not** Cloud API; not Kapso; ToS/ban risk |
| Native allowlists for groups | Templates, official throughput, BSP billing, OBA groups model do not apply the same way |

**Do not** treat this as “unofficial Cloud API.” It is a different stack. A Cloud API number **cannot** also be that Web client (§3.7).

---

## 5. What we honestly cannot do even after replacing Kapso

Assume we pick 360dialog or Twilio or raw Graph and implement Groups API correctly, with OBA.

| Desired product behavior | After replacing Kapso? | Why |
|--------------------------|------------------------|-----|
| Agent in **existing** customer/family/work WhatsApp groups | **No** (official Cloud API) | Meta: create + invite link only; no add/join-existing API ([Groups](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups), [Group management](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/reference)) |
| Unofficial join-existing **on the same Cloud API number** | **No** | Cloud API ≠ WhatsApp Web; Messenger not allowed on registered Cloud API numbers |
| Groups larger than **8** (incl. business) on Cloud API Groups API | **No** | Meta cap |
| Two Cloud API businesses in one API group | **No** | “Max Cloud API businesses per group: 1” |
| Groups on coexistence / WhatsApp Business **app** number | **No** | Meta: Groups API not available |
| Interactive messages / calls **inside** Cloud API groups | **No** | Meta unsupported list |
| Manually add allowlisted users into the group by API | **No** | “Cannot manually add participants”; invite link only |
| One-click signup, customer never sees Meta, **their** WABA | **No** (documented partner paths) | Kapso [customer guide](https://docs.kapso.ai/docs/platform/customer-guide), 360dialog [IO](https://docs.360dialog.com/partner/onboarding/integrated-onboarding), Twilio TPP, Infobip onboarding all use **Embedded Signup** |
| Unlimited agent numbers under one unverified portfolio | **No** | Meta 2 → 20 registered numbers ([phone numbers](https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers/)) |
| Kapso-identical OpenClaw plugin on 360dialog/Twilio | **Not documented** | Kapso plugin talks to Kapso APIs ([OpenClaw](https://docs.kapso.ai/docs/whatsapp/openclaw)) |
| Raise the 8-cap by choosing a “better BSP” | **No** | BSP cannot override Meta |

**What we *can* do officially after a Groups-capable BSP + OBA:**

1. Create a **new** group from the agent number.  
2. Send invite links (utility template in Template Library — Meta group management docs).  
3. Let allowlisted people **opt in**.  
4. In our backend, ignore inbound group messages whose `from` is not on the allowlist ([360dialog inbound sample](https://docs.360dialog.com/docs/messaging/groups/messaging-api) includes `group_id` + `from`).

That is a **new, small, invite-only room with the bot as owner** — not “add Rocky to the group you already have.”

---

## 6. Recommended framing for the team

1. **Kapso limitation:** no first-class Groups API. Kapso **is** natively built for **agents on Cloud API** (official OpenClaw + Hermes + Chat SDK + Project MCP + Workflows). 360dialog/Twilio/Infobip are **not** — they have no first-party OpenClaw (or Hermes) integration in their docs.  
2. **No true Kapso clone** found: nobody else publishes a **vendor** OpenClaw **Cloud API** plugin **plus** numbers/setup-links/MCP/workflows. Closest shapes: Zernio (MCP/CLI/groups, no OpenClaw); ClawLink (MCP tools on *your* WABA); community Graph OpenClaw plugins (you are the BSP); community Twilio plugin; Hermes native Cloud API (agent runtime, not a BSP); OpenClaw Baileys (groups, not Cloud API).  
3. **Meta limitation:** Cloud API groups are still **≤ 8**, **invite-only**, **business-created**, **OBA**, **not existing chats**. No BSP removes that.  
4. **Existing-group bots** = **not Cloud API** (OpenClaw Baileys / Web). Separate product, separate risk.  
5. Replacing Kapso for groups means **rebuilding the agent pipe** on the new BSP’s webhooks.  
6. **Customer never faces Meta** remains a **v0 ops model** (we own the WABA), constrained by Meta number caps.

---

## 7. Source list (official)

### Meta

- [Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups)  
- [Get started with Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started)  
- [Group management](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/reference)  
- [Group messaging](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging)  
- [Business phone numbers / registered number cap](https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers/)  
- [Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/)  
- [Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup/)

### Kapso

- [Introduction](https://docs.kapso.ai/)  
- [Personal AI agents](https://docs.kapso.ai/docs/whatsapp/personal-agent)  
- [OpenClaw](https://docs.kapso.ai/docs/whatsapp/openclaw)  
- [Hermes Agent](https://docs.kapso.ai/docs/whatsapp/hermes-agent)  
- [Chat SDK](https://docs.kapso.ai/docs/whatsapp/chat-sdk)  
- [MCP server](https://docs.kapso.ai/docs/whatsapp/mcp)  
- [CLI](https://docs.kapso.ai/docs/whatsapp/cli)  
- [WhatsApp AI agent](https://kapso.com/whatsapp-ai-agent)  
- [Twilio alternative for WhatsApp](https://kapso.com/twilio-alternative-for-whatsapp)  
- [OpenClaw product page](https://kapso.com/whatsapp-openclaw)  
- [Official plugin repo](https://github.com/gokapso/openclaw-plugin)  
- [Onboard customers](https://docs.kapso.ai/docs/platform/customer-guide)  
- [Send a message](https://docs.kapso.ai/api/meta/whatsapp/messages/send-a-message) (`recipient_type: group`)  
- [Docs index](https://docs.kapso.ai/llms.txt)

### 360dialog

- [Groups](https://docs.360dialog.com/docs/messaging/groups)  
- [Group management](https://docs.360dialog.com/docs/messaging/groups/group-management)  
- [Group messaging](https://docs.360dialog.com/docs/messaging/groups/messaging-api)  
- [Phone numbers](https://docs.360dialog.com/docs/resources/phone-numbers)  
- [Integrated Onboarding](https://docs.360dialog.com/partner/onboarding/integrated-onboarding)  
- [Official Business Account](https://docs.360dialog.com/docs/resources/official-business-account-oba)  
- [Meta Business Agent](https://docs.360dialog.com/docs/mba/meta-business-agent) (allowlist is MBA 1:1, not Groups API)

### Twilio / Infobip

- [Twilio Tech Provider Program](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program)  
- [Twilio TPP integration](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide)  
- [Twilio register senders (ISVs)](https://www.twilio.com/docs/whatsapp/isv/register-senders)  
- [Twilio WhatsApp FAQs (Groups API mention)](https://www.twilio.com/docs/whatsapp/best-practices-and-faqs)  
- [Infobip Tech Provider](https://www.infobip.com/docs/whatsapp/tech-provider-program)  
- [Infobip business onboarding](https://www.infobip.com/docs/whatsapp/tech-provider-program/business-onboarding)

### OpenClaw

- [WhatsApp channel (Baileys; no Twilio WhatsApp in core)](https://docs.openclaw.ai/channels/whatsapp)  
- [Channels list](https://docs.openclaw.ai/channels/)  
- Community Twilio plugin (not Twilio official): [ClawHub twilio-whatsapp](https://clawhub.ai/srinathh/plugins/openclaw-channel-twilio-whatsapp), [npm](https://www.npmjs.com/package/@srinathh/openclaw-channel-twilio-whatsapp)  
- Community direct-Graph channels (not vendor BSPs): [mcostantino-dev/openclaw-whatsapp-cloud-api](https://github.com/mcostantino-dev/openclaw-whatsapp-cloud-api), [shqear93/openclaw-whatsapp-cloud](https://github.com/shqear93/openclaw-whatsapp-cloud), [valkyriweb/openclaw-whatsapp-cloud](https://github.com/valkyriweb/openclaw-whatsapp-cloud)  
- ClawLink (hosted WhatsApp Business **tools**, not a Kapso-style channel): [Connect WhatsApp Business to OpenClaw](https://claw-link.dev/openclaw/whatsapp)  
- Hermes built-in Cloud API (direct Graph; DMs only v1): [WhatsApp Business Cloud API](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud)

### Zernio (developer WhatsApp; not OpenClaw)

- [WhatsApp groups](https://docs.zernio.com/platforms/whatsapp/groups)  
- [Add participants](https://docs.zernio.com/whatsapp/add-whatsapp-group-participants) (conflicts with Meta “cannot manually add” — verify before relying)  
- [Kapso alternative marketing](https://zernio.com/alternatives/kapso)  
- [MCP](https://zernio.com/)

### Other agent-adjacent (not OpenClaw WhatsApp twins)

- [Bird — set up your coding agent](https://bird.com/en-nl/docs/ai/set-up-your-agent) (`https://mcp.bird.com`)  
- Community Kapso OpenClaw forks (still Kapso-backed): [openclaw-whatsapp-kapso](https://www.npmjs.com/package/openclaw-whatsapp-kapso), [Enriquefft/openclaw-kapso-whatsapp](https://github.com/Enriquefft/openclaw-kapso-whatsapp)

---

*Last reviewed against the linked pages as of 2 Sep 2026. Meta and BSP docs change; re-check Groups API “Quick facts” and Kapso’s llms.txt before a go-live decision.*
