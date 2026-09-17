Yes — the best frontend design is **not a free-form node/flow builder**.  
The best design is a **Guided Modular Agent Studio with a live Agent Map**.

That means:

- The user always sees the agent as a **modular composition**: Provider/Model, Instructions, Knowledge, Tools, Guardrails, Memory, Evaluation, Publish.
- But the UX does **not** let the user draw arbitrary execution graphs.
- The “map” is a **visual composition surface** that maps exactly to the backend definition.
- The system always gives **one next best action**.
- Every missing dependency has an inline recovery path.
- Nothing can end in a dead-end.

This gives the “modular builder” feeling the user wants, without creating invalid states the engine cannot execute.

---

# 1. The core design decision

## Best design: “Guided Modular Agent Map”

Use a hybrid UX:

```text
Guided Checklist + Modular Agent Map + Inspector Panel
```

### The layout

```text
Top bar
  ← Back to Fleet
  Agent name
  Draft pill
  Autosave status
  Engine Room entry

Left rail
  Build checklist
  Purpose
  Provider
  Knowledge
  Tools
  Safety
  Try
  Evaluate
  Ship

Center canvas
  Agent Map
  Visual nodes:
    Purpose
    Brain / Provider / Model
    Knowledge
    Tools
    Guardrails
    Memory
    Evaluation
    Publish readiness

Right inspector
  Opens when a node is selected
  Contains the actual editing controls

Bottom action bar
  One primary action only
  “Continue”
  “Connect provider”
  “Add knowledge”
  “Try draft”
  “Review ship”
  “Give it life”
```

---

# 2. Why this is the correct UX

## A. It matches the backend

Your backend is not a general graph execution engine.

It creates an assistant with:

- instructions
- model policy
- knowledge policy
- tool policy
- guardrail policy
- context/memory policy
- budget policy
- brand
- draft version
- published version
- policy snapshot
- run manifest

So the frontend map must be a **projection of the assistant definition**, not a new execution graph.

If we allow arbitrary nodes and wires, the frontend will create shapes the backend cannot validate or run.

That is a failure path.

---

## B. It prevents blank-canvas terror

If the user creates an empty agent and sees a completely empty diagram, they will not know what to do.

Instead, the empty agent should initialize as a **scaffolded map**:

```text
Purpose          — needs attention
Brain/Provider   — needs attention
Knowledge        — optional / skipped
Tools            — optional / skipped
Guardrails       — default safe
Memory           — default safe
Evaluation       — optional or template-required
Ship             — blocked
```

This feels modular, but still guided.

---

## C. It supports templates correctly

Templates are not just a name and prompt.

A template may require:

- a model/provider
- tools
- knowledge
- eval dataset
- release policy
- compatibility checks

So after template install, the Agent Map should open with:

```text
Template: Customer Support Agent v1.2

Purpose          — prefilled
Brain            — recommended model, may need provider
Knowledge        — required docs missing / seeding
Tools            — ticket tool needs approval
Guardrails       — template defaults
Evaluation       — seeded dataset
Ship             — blocked until requirements pass
```

Now the user is not “trapped in a modal.”  
They are inside the builder with a clear repair path.

---

## D. It gives power users modularity without breaking normal users

Normal users follow the checklist.

Power users can click any node and edit in any order.

Engineers can open **Engine Room** for raw JSON.

All three views edit the same draft.

---

# 3. The end-to-end workflow

This is the full failure-proof flow.

---

# 4. Global setup before agent creation

There are two global areas that must exist outside the agent builder:

## Provider section

This is where the organization configures model providers.

Examples:

- Anthropic
- OpenAI
- Azure OpenAI
- Bedrock
- Vertex
- self-hosted models

The provider section should show:

```text
Provider name
Connection state
Credential fingerprint
Enabled models
Missing credentials
Residency restrictions
Cost availability
Last rotated
Compromised/incident flags
```

### Important rule

Agent creation should **not require** a provider to exist.

A user can create a draft agent without a usable provider.

But they cannot:

- run a live test
- evaluate
- publish

until a usable model is attached.

This prevents a hard failure at creation time.

---

## Knowledge section

This is where documents and connectors live.

The builder can reuse existing READY documents, but knowledge can also be uploaded inline.

States:

```text
Uploading
Processing
Embedding
Ready
Failed
Quarantined
Retired
Re-embedding
Coverage incomplete
```

The builder must show these states honestly.

---

## Tools section

Tools are org-level catalog items.

The builder should show:

```text
Tool name
Effect class
Approval requirement
Enabled state
Credential state
Schema hash state
Execution environment, when available
Egress domains, when available
```

The agent builder does not invent tools.  
It attaches tools from the catalog.

---

# 5. Entry points into the Agent Builder

There must be one route:

```text
/agent-studio/agents/new
```

But it can accept different starting modes.

## Entry modes

| Mode | Entry | Result |
|---|---|---|
| Blank | “New agent” | Empty scaffolded map |
| Template | Template gallery | Prefilled map from template |
| Clone | Clone existing agent | New draft copy |
| Import | Paste/upload JSON | Draft from definition |
| Model deep link | From provider/model page | Builder with model preselected |
| Template deep link | `/agents/new?template=customer-support` | Builder opens template flow |

All modes converge into the same Agent Map.

---

# 6. Start screen: “How do you want to begin?”

This screen should not feel like a form.

It should feel like a quiet studio.

## Center prompt

```text
What kind of agent do you want to build?
```

Optional input:

```text
Example:
A customer support agent that answers billing questions using our refund policy.
```

This input is not magic.  
It can be used as the initial directive seed.

No invented LLM configuration.

Only deterministic behavior.

---

## Starting options

Four visible options:

```text
Start blank
Use a template
Clone an agent
Import definition
```

If the org has recent drafts, show:

```text
Continue shaping
  Billing Assistant — Draft — 60% complete
  Support Agent — Draft — template provisioning
```

This prevents users from creating duplicate agents by accident.

---

# 7. Blank creation flow

This is the safest blank flow.

## Step 1 — Purpose

The user enters:

```text
Name
Description
What should it do?
```

The directive composer should be structured:

```text
Role
Task
Rules
Examples
```

Then the system composes the final instructions text.

The user can always switch to raw mode:

```text
Write it myself
```

### Primary action

```text
Create draft
```

At this point:

- create assistant identity
- create draft version if definition exists
- if identity-only, draft version is created when the first policy is saved

The UX should not expose this complexity.

It simply says:

```text
Draft created
```

---

## Step 2 — Agent Map appears

After the draft exists, the user sees the modular map.

Initial node states:

```text
Purpose          complete
Brain            needs attention
Knowledge        optional
Tools            optional
Guardrails       default safe
Memory           default safe
Evaluation       optional
Ship             blocked
```

The bottom action bar says:

```text
Next best action: Choose a model
```

This is important.

The user never asks, “What now?”

---

# 8. Provider / Model selection flow

This is one of the most critical flows.

The user should select the provider/model for this specific agent inside the Agent Map.

They click:

```text
Brain node
```

The right inspector opens.

---

## Brain inspector: simple mode

Show three recommended profiles if possible:

```text
Fast & economical
Careful & thorough
Creative & expressive
```

Each profile maps to available models in the org.

Example:

```text
Fast & economical
Uses available lightweight models
Best for FAQ/support triage

Careful & thorough
Uses stronger reasoning models
Best for policy-heavy answers

Creative & expressive
Uses higher-variance generation
Best for drafting/marketing
```

This hides model complexity.

But it must remain inspectable.

---

## Brain inspector: advanced mode

Show actual provider/model list.

Columns:

```text
Provider
Model
Context window
Cost estimate
Capability
Availability
Reason if unavailable
```

Availability states:

```text
Usable
Missing credential
Provider disabled
Model not enabled
Residency blocked
Cost data missing
Rate limited / degraded
```

### Important

If a model is unusable, do not simply disable it silently.

Show why.

Example:

```text
Claude Sonnet is unavailable because the Anthropic credential is missing.

[Connect Anthropic]
```

If the user does not have permission:

```text
You need owner/admin access to connect providers.

[Request access]
```

Never a dead end.

---

## If no provider exists

The Brain node shows:

```text
No usable model is available for this organization.
```

Then show inline options:

```text
Connect a provider
Request provider access
Continue drafting without a model
```

The user can continue drafting.

But Try and Ship remain blocked with clear reasons.

---

## If provider setup requires admin

If the current user cannot add credentials, show:

```text
Provider setup requires owner/admin permission.

Ask an owner to connect Anthropic.
```

If the product has request/notification capability, offer:

```text
Notify owners
```

If not, show copyable guidance.

---

## Model fallback

The Brain node should show:

```text
Primary model
Fallback enabled
```

Simple mode:

```text
Allow fallback to next available model
```

Advanced mode:

```text
Allowed models list
Fallback order
Model parameters
Reasoning effort
Max output tokens
Temperature
Top-p
```

For normal users, hide advanced parameters.

For power users, expose them.

---

# 9. Knowledge flow

The user clicks:

```text
Knowledge node
```

The inspector shows:

```text
Give it memory
```

Options:

```text
Upload documents
Choose existing documents
Connect a source
```

---

## Knowledge states

Each knowledge source shows a state:

```text
Uploading
Processing
Embedding
Ready
Failed
Quarantined
Not embedded for current model
Coverage incomplete
```

### Important

A document being `READY` is not enough if embedding coverage for the selected embedding model is incomplete.

The UI should show:

```text
Ready for retrieval
```

or

```text
Re-embedding in progress
```

or

```text
Embedding coverage incomplete
```

This prevents publish-time surprises.

---

## Knowledge actions

For each source:

```text
Preview
Remove from agent
Retry processing
View failure reason
```

Removing from agent should not delete the document from the org.

Microcopy:

```text
Removing only detaches it from this agent. The document remains in your knowledge library.
```

---

## Skip knowledge

Knowledge should be optional unless a template requires it.

Show:

```text
Skip for now
```

If skipped:

```text
Knowledge — skipped
```

This is gray, not red.

Skipped is not broken.

---

# 10. Tools flow

The user clicks:

```text
Tools node
```

The inspector shows:

```text
Give it hands
```

Tool sources:

```text
Built-in tools
Org tool catalog
```

Each tool row shows:

```text
Name
Effect class
Approval requirement
Enabled state
Credential state
Schema hash state
```

Effect classes:

```text
Read-only
Mutating
Destructive
```

Approval states:

```text
No approval needed
Approval optional
Approval required
Pending approval
Denied
```

---

## Adding a tool

When a tool is added:

```text
Tool chip appears on the map
```

The chip should show approval/effect status.

Example:

```text
Search knowledge base
Read-only
Enabled

Create support ticket
Mutating
Approval required
```

---

## Tool failure states

### Tool disabled

```text
This tool is disabled in your organization.

[View tool catalog]
```

### Missing credential

```text
This tool needs a connected credential.

[Connect credential]
```

### Schema drift

```text
The tool definition has changed since it was pinned.

[Review change]
[Re-pin tool]
```

### Approval required

```text
This tool requires approval before it can be used.

[Request approval]
```

Never let the user publish without resolving required tool approvals.

---

# 11. Template flow

Templates are the most important enterprise path.

The template flow must not feel separate from the builder.

It must land in the same Agent Map.

---

## Template gallery

The gallery should show:

```text
Template name
Outcome
Category
Compatibility
Requirements
What it includes
```

Example:

```text
Customer Support Agent

Resolves common support questions using policy docs and ticket tools.

Includes:
  Instructions
  Knowledge requirements
  Ticket lookup tool
  Evaluation dataset

Compatibility:
  Compatible with your org
  Needs knowledge setup
  Needs provider setup
```

---

## Template detail

Before installing, show a detail sheet.

Tabs:

```text
What it does
What it needs
Seed data
```

### What it needs

Show a checklist:

```text
Model
  Requires a capable model
  Your org has usable models

Knowledge
  Requires refund policy
  Requires FAQ documents

Tools
  Requires ticket lookup
  Tool is enabled

Evaluation
  Includes evaluation dataset
```

If something is missing, show advisory state:

```text
Needs setup
```

Do not block template selection just because setup is incomplete.

The builder is the place to fix setup.

---

## Installing a template

Primary button:

```text
Start from this template
```

Install states:

```text
Copying blueprint…
Creating draft…
Provisioning knowledge…
Seeding evaluation dataset…
Validating tools…
```

This is important because template install can have async provisioning.

Do not silently drop the user into a broken state.

---

## After template install

The builder opens with the Agent Map prefilled.

Show a template badge:

```text
Installed from customer-support@1.2.0
```

Node states:

```text
Purpose          complete, editable
Brain            needs attention or complete
Knowledge        needs attention if seed docs missing
Tools            needs attention if approval missing
Evaluation       dataset seeded
Ship             blocked
```

Left checklist shows:

```text
Template requirements
  Connect required knowledge
  Approve required tools
  Choose usable model
  Run evaluation
  Publish
```

This transforms template installation from a modal into a recoverable guided workflow.

---

# 12. Guardrails and safety flow

The user clicks:

```text
Guardrails node
```

Simple view:

```text
Input protection
Output protection
PII redaction
Brand safety
Denied patterns
```

Default state should be safe:

```text
Input guardrail: default
Output guardrail: brand-safe
PII redaction: enabled
```

Advanced view:

```text
Guardrail mode
  Blocking
  Logging
Custom deny patterns
PII handling
Moderation thresholds
```

If guardrail logging mode is supported later, show:

```text
Logging mode records what would have been blocked but does not stop the reply.
```

For now, if the engine only supports blocking verdicts, do not expose a false logging mode.

---

# 13. Memory flow

The user clicks:

```text
Memory node
```

Simple view:

```text
Remember user context
Remember conversation context
Remember organization facts
```

Mapped to backend scopes:

```text
none
conversation
user
organization
```

Show consequences plainly:

```text
Conversation memory
This agent remembers context only inside each conversation.

User memory
This agent can remember facts about the end user.

Organization memory
This agent can remember facts shared across the organization.
```

Advanced view:

```text
History limit
Summarization
Memory TTL
Memory retrieval ACL
PII scrubbing
```

If memory PII scrubbing is not yet built, do not show it as a fake control.

Instead show:

```text
PII handling uses platform defaults.
```

---

# 14. Budget flow

Budget should not be hidden only in advanced JSON.

It should appear in the Brain or Safety node.

Simple labels:

```text
Maximum spend per conversation
Maximum tool calls per run
Maximum model calls per run
Maximum wall-clock time
```

Advanced labels:

```text
max_total_tokens
max_cost_micros
max_tool_calls
max_model_calls
wall_clock_seconds
```

If cost data is available, show estimate:

```text
Estimated cost per run
  Based on model catalog pricing.
  Actual cost depends on token usage and cache behavior.
```

If cost data is unavailable:

```text
Cost estimate unavailable for this model.
```

Never invent pricing.

---

# 15. Try flow: test before publish

This is essential.

The user must be able to test the draft before publishing.

The user clicks:

```text
Try node
```

or the bottom action bar shows:

```text
Try draft
```

---

## Try prerequisites

Try is enabled when:

```text
Draft exists
At least one usable model is attached
No blocking provider error exists
```

Instructions should be strongly recommended but not falsely required unless the engine requires them.

If instructions are empty, show a whisper:

```text
Add instructions before testing for meaningful behavior.
```

If no usable model:

```text
Connect a provider or choose a usable model to try this agent.
```

Do not simulate an LLM response.

No fake output.

---

## Try interface

The conversation appears inside the builder.

Layout:

```text
Agent thread
Input box: Speak to it…
```

The test run uses the existing draft/test-run mechanism.

The UI should show:

```text
Draft test run
Not live
No production traffic
```

---

## Streaming states

While streaming:

```text
Thinking…
Streaming response…
```

If silent too long:

```text
Run plane quiet — check status.
```

If budget exceeded mid-stream, if engine supports it:

```text
Stopped: budget limit exceeded during response.
```

If provider fails:

```text
Provider error: unable to complete test run.
```

Always show retry.

---

## Inspecting a reply

When the user clicks an assistant reply, open a trace panel.

The trace panel should show only truthful data:

```text
What it saw when answering
```

Not:

```text
Why it said that
```

Because causation is not provable.

Trace contents:

```text
Retrieved knowledge chunks
Tool calls
Guardrail verdicts
Model used
Tokens/cost, if available
```

For each retrieved chunk:

```text
Source title
Excerpt
Score
Edit knowledge
```

For each tool call:

```text
Tool name
Approval state
Effect class
Result or simulated result, if shadow mode exists
```

For guardrails:

```text
Policy
Verdict
Blocked or flagged content category
```

---

# 16. Evaluation flow

Evaluation is required for some templates and recommended for enterprise agents.

The user clicks:

```text
Evaluation node
```

---

## If template has seeded dataset

Show:

```text
Evaluation dataset
  customer-support@1.2.0 seeded dataset

Cases:
  24 test cases

Last result:
  Not run
```

Primary action:

```text
Run evaluation
```

---

## If blank agent has no dataset

Show:

```text
No evaluation dataset is attached.
```

If the engine supports creating/selecting datasets, show:

```text
Choose dataset
Create dataset
```

If not, show honest guidance:

```text
Templates include evaluation datasets automatically.
For blank agents, attach a dataset before running evaluation.
```

Do not fake evaluation.

---

## Evaluation results

Show:

```text
PASS
WARN
BLOCK
```

If required by release policy and result is not PASS:

```text
Publish is blocked by evaluation policy.
```

If BLOCK:

```text
This agent version cannot be published until evaluation passes.
```

Show failing cases with:

```text
Input
Expected behavior
Actual behavior
Rubric failure
```

The user can then:

```text
Edit instructions
Edit knowledge
Edit tools
Re-run evaluation
```

---

# 17. Ship flow

The Ship node is not a cliff.  
It is a checklist.

The user clicks:

```text
Ship node
```

or the bottom bar shows:

```text
Review ship
```

---

## Readiness checklist

Each row has one of these states:

```text
Ready
Needs attention
Optional skipped
```

Required checks:

```text
Instructions present
At least one usable model
Knowledge pins resolved or degraded acknowledged
Tool pins valid
Tool approvals satisfied
Evaluation required checks passed
No blocking control blocks
No schema drift
```

Optional checks:

```text
Knowledge added
Evaluation run
Budget tuned
Guardrails tuned
Memory configured
Description added
```

---

## Inline fixes

Every amber row must have an inline fix.

Examples:

### Missing instructions

```text
Instructions are required before publishing.

[Edit instructions]
```

### No usable model

```text
No usable model is attached.

[Choose model]
[Connect provider]
```

### Knowledge not ready

```text
Refund policy is still processing.

[View knowledge]
[Wait for processing]
[Publish with degraded knowledge]
```

The degraded path must be explicit:

```text
Publishing with degraded knowledge means this agent may not retrieve the missing sources until they become ready.

Acknowledge and publish
```

This action must be audited.

### Tool approval missing

```text
The ticket tool requires approval.

[Request approval]
```

### Eval blocked

```text
Evaluation decision is BLOCK.

[View failing cases]
[Re-run evaluation]
```

---

## Publish button

The publish button should only become visually primary when required checks pass.

If clicked early, do not show a dead disabled state.

Instead, scroll to the first blocking issue.

Example:

```text
Publish is blocked because no usable model is attached.
```

Then focus the Brain node.

---

## Publish success

Do not drop the user.

Show success screen:

```text
It’s alive.

Billing Support Agent v1 is published.
```

Three primary next actions:

```text
Connect it to a channel
Watch it work
Build another
```

Secondary:

```text
Back to fleet
```

The channel action must carry `returnTo` back to the agent.

No orphaned channel flow.

---

# 18. Post-publish operate surface

After publish, the Agent Builder is no longer the primary surface.

The detail page becomes the operate surface.

It should show:

```text
Active version
Draft status
Rollouts
Evaluation history
Run traces
Cost usage
Blocks
Incidents
Channels
Audit log
```

The builder remains available for:

```text
Create new draft
Edit draft
Test draft
Publish new version
Rollback
```

---

# 19. The Agent Map node system

This is the heart of the modular UX.

But the map must be constrained.

---

## Fixed topology

Do not allow arbitrary wiring.

The map should always show this conceptual topology:

```text
Purpose
   ↓
Input Guardrails
   ↓
Context Assembly
   ├── Memory
   ├── Knowledge
   ↓
Brain / Model
   ↓
Tool Loop
   ↓
Output Guardrails
   ↓
Response
```

This is a conceptual map, not a user-programmable execution graph.

---

## Node types

### Purpose node

Contains:

```text
Name
Description
Role
Task
Rules
Examples
Final instructions
```

Status:

```text
Complete
Needs attention
```

---

### Brain node

Contains:

```text
Provider
Model
Fallback
Model parameters
Budget
```

Status:

```text
Ready
Needs provider
Model unavailable
Cost data missing
```

---

### Knowledge node

Contains:

```text
Documents
Connectors
Retrieval settings
Embedding model coverage
```

Status:

```text
Ready
Processing
Failed
Degraded
Skipped
```

---

### Tools node

Contains:

```text
Attached tools
Approval states
Effect classes
Schema pin states
```

Status:

```text
Ready
Approval required
Disabled
Schema drift
Missing credential
```

---

### Guardrails node

Contains:

```text
Input policy
Output policy
PII redaction
Denied patterns
```

Status:

```text
Default safe
Custom
Needs attention
```

---

### Memory node

Contains:

```text
Memory scope
History limit
Summarization
TTL
```

Status:

```text
Default
Custom
Needs attention
```

---

### Evaluation node

Contains:

```text
Dataset
Last result
Required checks
Failing cases
```

Status:

```text
Not run
Pass
Warn
Block
Required
```

---

### Ship node

Contains:

```text
Readiness checklist
Publish action
Degraded acknowledgements
```

Status:

```text
Blocked
Ready
```

---

# 20. Node status colors and semantics

Use four statuses.

Do not rely on color alone.

| Status | Meaning | Example |
|---|---|---|
| Ready | Good to use | Model usable, docs ready |
| Needs attention | Blocking or important | Missing provider, tool approval required |
| Skipped | Optional and intentionally skipped | No knowledge attached |
| Info | Not required yet | Evaluation optional for blank agent |

Visual language:

```text
Ready           green/white
Needs attention amber
Skipped         gray
Info            neutral/blue
Error           red only for hard failures
```

Every amber node must have a click target that opens the fix.

---

# 21. State machine for the builder

The frontend state should be derived from the backend draft, not stored as a fragile local wizard.

## Builder phase

```text
spark
purpose
provider
knowledge
tools
safety
try
evaluate
ship
success
```

But phases are not locks.

They are guidance.

---

## Section state

```text
purpose:
  idle | complete | needs_attention

provider:
  missing | unusable | ready

knowledge:
  none | processing | ready | failed | degraded | skipped

tools:
  none | ready | approval_required | invalid

guardrails:
  default | custom | attention

memory:
  default | custom | attention

evaluation:
  absent | not_run | running | pass | warn | block | required

ship:
  blocked | ready
```

---

## Derive next best action

The bottom action bar should be computed.

Examples:

```text
If no assistantId:
  Create draft

If purpose incomplete:
  Continue purpose

If provider missing:
  Choose a model

If provider unusable:
  Connect provider

If knowledge processing:
  Continue while processing

If tools invalid:
  Fix tools

If try not run:
  Try draft

If evaluation required and not pass:
  Run evaluation

If ship blocked:
  Review ship issues

If ship ready:
  Give it life
```

Only one primary button.

---

# 22. Autosave and draft safety

The builder must autosave continuously.

Use the existing draft mechanism.

## Autosave states

```text
Saved
Saving…
Unsaved changes
Conflict
Blocked
```

## Conflict handling

If another user updated the draft:

```text
This draft was updated elsewhere.

Your saved version is out of date.

[Reload latest]
[Compare changes]
```

If the engine supports hash-based merge, use the existing merge flow.

Never silently overwrite.

---

# 23. Reload and resume behavior

If the user reloads the page:

1. Load the assistant by route or last draft.
2. Load draft version.
3. Derive node states from backend truth.
4. Resume at first incomplete required section.

Example:

```text
Welcome back.
You were choosing a model.
```

The UI should not depend only on local browser state.

Server draft is the source of truth.

---

# 24. Role and permission flow

Do not silently disable buttons.

If a user lacks permission, explain.

## Viewer/read-only role

```text
You have read-only access to agents.

To build agents, ask an owner or admin for developer access.
```

If possible:

```text
Request access
```

## Developer role

Can draft and test.

If publish requires higher role, show:

```text
Publishing requires owner/admin permission.
```

## Provider credential setup

If only owner/admin can connect providers:

```text
Provider credentials can only be added by owners or admins.

[Notify owners]
```

No silent tooltips.

No dead buttons.

---

# 25. Failure-proof edge cases

This is the part that makes the UX production-grade.

---

## Case 1: No provider configured

User creates blank agent.

Map opens.

Brain node amber.

Bottom action:

```text
Connect provider
```

Secondary:

```text
Continue drafting
```

Try and Ship blocked with reason.

No failure.

---

## Case 2: Provider credential missing

Brain node shows:

```text
Anthropic credential missing.
```

Inline action:

```text
Connect credential
```

If user lacks permission:

```text
Ask an owner to connect Anthropic.
```

No failure.

---

## Case 3: Model unavailable because disabled

Model row shows:

```text
Disabled in your organization.
```

Action:

```text
Enable model
```

or

```text
Ask admin to enable model
```

No failure.

---

## Case 4: Agent name already exists

Do not show raw 409.

Show:

```text
You already have an agent named “Billing Support”.

Try “Billing Support 2”?
```

One-tap apply.

Focus remains in the field.

No red banner.

---

## Case 5: Draft already exists for this agent

If user tries to create another draft:

```text
This agent already has an open draft.

[Resume draft]
[Discard draft and start over]
```

Discard requires confirmation.

Never accidentally destroy work.

---

## Case 6: Knowledge upload fails

Row shows:

```text
Upload failed: file is too large / unsupported / processing error.
```

Actions:

```text
Retry
Remove
```

Agent draft remains safe.

Publish later blocks if the failed source is required.

---

## Case 7: Knowledge embedding incomplete

Show:

```text
Embedding coverage incomplete.
```

Action:

```text
View re-embedding progress
```

Publish options:

```text
Wait
Publish with degraded knowledge
```

If degraded publish is acknowledged, show persistent banner:

```text
Published with degraded knowledge: refund-policy, faq
```

---

## Case 8: Tool approval pending

Tool chip amber.

Action:

```text
Awaiting approval
```

If current user can approve:

```text
Approve
```

If not:

```text
Request approval
```

Publish blocked if required.

---

## Case 9: Template provisioning incomplete

Show provisioning banner:

```text
Template provisioning is still running.

Seeding knowledge…
Seeding evaluation dataset…
```

If provisioning fails:

```text
Template provisioning failed: required knowledge document missing.

[Retry]
[View requirements]
```

The draft remains editable.

Publish blocked until resolved.

---

## Case 10: Evaluation BLOCK

Ship node red/amber.

Show:

```text
Publish blocked by evaluation.
```

Action:

```text
View failing cases
Edit draft
Re-run evaluation
```

No silent override.

---

## Case 11: Publish conflict

If publish fails due to stale hash or version conflict:

```text
The draft changed while you were working.

[Reload latest]
[Compare]
```

If publish fails due to required checks:

```text
Publish failed because a required check changed.

[Review checklist]
```

Draft remains intact.

---

## Case 12: Browser reload mid-test

The conversation may not survive unless persisted.

Therefore:

```text
Draft definition survives reload.
Test conversation is temporary unless engine persists it.
```

UI should say:

```text
Your draft was restored.
Test conversation history may need to be restarted.
```

If backend test conversations are persisted, restore them.

Do not invent persistence.

---

# 26. Template-based customer support example

Here is the complete flow for a typical customer support agent.

## Step 1 — User opens New Agent

Clicks:

```text
Use a template
```

## Step 2 — Selects Customer Support Agent

Gallery card:

```text
Customer Support Agent

Answers support questions using policy documents and ticket tools.

Requires:
  Knowledge: FAQ, refund policy
  Tool: ticket lookup
  Model: capable chat model
  Evaluation: included
```

## Step 3 — Opens template detail

Shows:

```text
What it does
What it needs
Seed data
```

## Step 4 — Clicks “Start from this template”

Install progress:

```text
Copying blueprint…
Creating draft…
Validating tools…
Provisioning knowledge…
Seeding evaluation…
```

## Step 5 — Builder opens

Template badge:

```text
customer-support@1.2.0
```

Map states:

```text
Purpose          complete
Brain            needs attention
Knowledge        needs attention
Tools            needs attention
Evaluation       dataset ready
Ship             blocked
```

## Step 6 — Checklist guides repair

Left rail:

```text
1. Choose model
2. Attach FAQ document
3. Attach refund policy
4. Approve ticket lookup tool
5. Try draft
6. Run evaluation
7. Ship
```

## Step 7 — User chooses model

Brain inspector:

```text
Careful & thorough
Recommended for support policies
```

If provider missing:

```text
Connect Anthropic
```

## Step 8 — User uploads knowledge

Knowledge node:

```text
FAQ.pdf — processing
refund-policy.pdf — ready
```

## Step 9 — User approves tool

Tools node:

```text
ticket lookup
Read-only
Approved
```

## Step 10 — User tries draft

Test:

```text
User:
How long does a refund take?

Agent:
Refunds are processed within 5 business days…
```

## Step 11 — User runs evaluation

```text
Evaluation: PASS
```

## Step 12 — User ships

Readiness:

```text
Instructions ready
Model ready
Knowledge ready
Tools ready
Evaluation passed
```

Click:

```text
Give it life
```

Success:

```text
Customer Support Agent v1 is published.
```

Next actions:

```text
Connect to support channel
View agent
Build another
```

No dead end.

---

# 27. What the Agent Map must not become

This is critical.

## Do not make it a generic flow builder

No arbitrary nodes like:

```text
If/Else
Loop
HTTP Request
Custom Code
Subagent
Router
```

unless the engine explicitly supports them.

Otherwise the frontend will create promises the backend cannot keep.

---

## Do not make the map the only way to edit

Some users prefer forms.

The map nodes should open normal inspector forms.

The map is orientation, not a mandatory interaction model.

---

## Do not expose raw JSON early

Raw JSON belongs in Engine Room.

The main builder should show:

```text
Purpose
Knowledge
Model
Tools
Safety
Try
Ship
```

Not:

```text
model_policy.allowed_models[0]
schema_hash
If-Match
```

Power users can access Engine Room.

---

## Do not simulate missing providers

If no model is available, do not fake a test response.

Show:

```text
Testing requires a usable model.
```

Honesty is part of enterprise quality.

---

# 28. Recommended screen inventory

## Global surfaces

```text
Fleet / Agents list
Agent detail / Operate
Provider credentials
Knowledge library
Tool catalog
Models/costs
Channels
Approvals
Audit
```

## Builder surfaces

```text
/agents/new
/agents/:id/builder
/agents/:id/engine-room
```

## Overlays inside builder

```text
Template gallery
Template detail
Clone picker
Import pane
Provider connect
Tool catalog drawer
Knowledge source drawer
Evaluation results
Publish checklist
```

Avoid full-page redirects inside the builder unless necessary.

---

# 29. Recommended navigation model

## From Agents list

```text
New agent → Builder Start
```

## From Templates page

```text
Use template → Builder with template install
```

## From Provider page

```text
Create agent with this model → Builder with model preselected
```

## From Knowledge page

```text
Create agent using this document → Builder with knowledge preselected
```

## From Tool catalog

```text
Create agent using this tool → Builder with tool preselected
```

## From Agent detail

```text
Edit draft → Builder
View operate → Detail
```

Every cross-surface navigation must carry return context.

No orphan flows.

---

# 30. Final recommended end-to-end flow

This is the flow I recommend shipping.

---

## Phase 0 — Global setup

Org owner/admin configures:

```text
Providers
Model enablement
Knowledge sources
Tool catalog
Approvals
```

But agent creation does not require all of these to be complete.

---

## Phase 1 — Start

User clicks:

```text
New agent
```

Chooses:

```text
Blank
Template
Clone
Import
```

If template:

```text
Browse gallery
Open detail
Review requirements
Install
```

If blank:

```text
Enter name and purpose
Create draft
```

---

## Phase 2 — Agent Map opens

The draft is represented as a modular map.

Nodes:

```text
Purpose
Brain
Knowledge
Tools
Guardrails
Memory
Evaluation
Ship
```

Each node has status.

The left rail shows the checklist.

The bottom bar shows the next best action.

---

## Phase 3 — Configure Brain

User selects:

```text
Provider
Model
Fallback
```

If provider missing:

```text
Connect inline
```

If permission missing:

```text
Request access
```

---

## Phase 4 — Configure Knowledge

User can:

```text
Upload
Select existing
Connect source
Skip
```

Knowledge states are visible.

Publish later enforces readiness.

---

## Phase 5 — Configure Tools

User adds tools from catalog.

Tool states show:

```text
Approval
Effect class
Credential
Schema drift
```

Required approvals are resolved inline or via request.

---

## Phase 6 — Configure Safety and Memory

Defaults are safe.

Advanced users can tune:

```text
Guardrails
PII
Budget
History limit
Memory scope
```

---

## Phase 7 — Try draft

User tests the draft.

Test runs are clearly not live.

Trace panel shows:

```text
Retrieved knowledge
Tool calls
Guardrail verdicts
Model used
```

No fake causation.

---

## Phase 8 — Evaluate

If template requires evaluation:

```text
Run evaluation
Review failing cases
Fix draft
Re-run
```

If blank agent:

```text
Evaluation optional unless required by policy
```

---

## Phase 9 — Ship

Ship checklist shows:

```text
Required checks
Optional checks
Degraded acknowledgements
```

Every amber row has an inline fix.

Publish happens only when required checks pass.

---

## Phase 10 — Success and connect

After publish:

```text
Connect a channel
View agent
Build another
```

Channel flow returns to agent.

---

## Phase 11 — Operate

Agent detail shows:

```text
Runs
Versions
Rollouts
Evals
Cost
Blocks
Channels
Audit
```

Future drafts are edited in the same builder.

---

# 31. The single most important UX rule

The product must never say only:

```text
You can’t do this.
```

It must always say:

```text
You can’t do this yet because X.
Here is the next action to resolve X.
```

Examples:

```text
You can’t test yet because no usable model is attached.
Choose a model or connect a provider.

You can’t publish yet because the refund policy document is still processing.
Wait for processing or publish with degraded knowledge.

You can’t use this tool yet because approval is required.
Request approval.
```

That is the entire secret to making the modular builder feel powerful instead of broken.

---

# 32. Final recommendation

Proceed with this design:

```text
Guided Modular Agent Studio
with
Live Agent Map
and
Inline Recovery Paths
```

Use the map as the central visual truth.

Use the checklist as the guided path.

Use the inspector as the editing surface.

Use the bottom action bar as the single next step.

Use templates to prefill the map, not to create a separate wizard.

Use providers as org-level setup, but allow agent-level model selection inside the builder.

Use Engine Room only for advanced/raw editing.

This design is modular, enterprise-safe, and failure-proof because it never allows the frontend to create a state the backend cannot execute, and it never leaves the user without a next action.