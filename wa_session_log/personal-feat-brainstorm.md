# Personal-Feature Brainstorm — Personalized Reply System (Layers 1–4)

Date: 2026-07-23
Branch: master
Status: **DESIGN ONLY — nothing built this session.** This is a brainstorm/scope handoff.

## TL;DR

The suggested-replies feature (`suggestReplies()` in `src/replies.ts`) feels stale, generic, and
"AI-generated." Root causes were diagnosed and a full design was scoped for a **self-personalizing,
self-evolving reply system**. Two workstreams were agreed for the next build session:

- **(A) Personalization system** — make replies sound like the *specific* agent, learned from their
  own real sent messages + a short onboarding profile.
- **(B) Response-rate labeling** — start recording, for every suggested reply, whether the lead
  actually replied — the ground-truth data needed later for any optimization loop.

A third, later phase (the karpathy/autoresearch-style self-evolving loop) was researched and scoped
but explicitly **deferred** until (A) and (B) exist.

No code written. No DB changes. Server not touched.

---

## Why replies feel stale (root cause — all confirmed in code)

1. **Persona is hardcoded and identical for every agent.** `SYSTEM` string in
   [src/replies.ts:8-31](../src/replies.ts#L8-L31) is one fixed "calm, clear, professional" prompt.
   Nothing about *this* agent's voice is ever fed in → every agent sounds the same.
2. **Model is too small.** Default `llama3.1:8b` ([src/claude.ts:28](../src/claude.ts#L28)). An 8B
   model writes flat, hedge-y prose regardless of prompt. ~50% of the "AI feel" is just model size.
3. **Model never sees a real example of the agent's writing.** "Be warm and human" yields the AI's
   *idea* of warm (the cliché). Real few-shot samples of the agent's texts yield *that agent's* voice.
   Completely absent today.

---

## The design: 4 layers of "personality"

| Layer | Captures | Source |
|---|---|---|
| **1. Declared persona** | emoji y/n, languages (EN/AR/HI/RU mix), sign-off, formality, "how I talk" note | onboarding form, once |
| **2. Learned voice card** | distilled pattern: sentence length, favorite words, greetings, sign-offs | auto-distilled from real sent msgs, refreshed |
| **3. Live samples** | literal texture, exact words | 8–15 recent real outbound msgs, pulled fresh per reply |
| **4. Evolved prompt** (later) | the reply *strategy* itself | autoresearch-style loop, LLM-judge metric |

Layers 1–3 = the personalization system (A). Layer 4 = the deferred evolution loop.

### Key enabler (no new plumbing for learning)
Agent-sent messages already flow through the pipe as `direction:"out"` and are stored
([src/brain.ts:80](../src/brain.ts#L80), [src/store.ts:267](../src/store.ts#L267)). The "learning"
loop just *uses* data already collected.

---

## Data flow (end to end)

```
ONBOARDING (once)   agent fills short form ─► agent_persona row (tone, emoji, languages, sign-off, notes)

EVERY DAY (auto)    agent replies to leads (already stored as direction:"out")
                        └─ enough new sent msgs? ─► DISTILL JOB ─► writes voice_card on agent_persona

REPLY MOMENT        lead messages ─► build prompt from:
                        • declared persona (agent_persona)
                        • learned voice_card
                        • 8–15 live sample sent messages
                        • conversation + qualification + listings (as today)
                     ─► 4 replies ─► DM agent
```

---

## What gets built (workstream A — full auto-learning system)

1. **New table `agent_persona`** (keyed by `agent_id`, one row/agent):
   - declared: `tone`, `use_emoji`, `languages`, `sign_off`, `style_notes`
   - learned: `voice_card` (text, written by distill job)
   - bookkeeping: `voice_card_upto` (watermark — same trick as summaries at
     [src/store.ts:300](../src/store.ts#L300))
2. **Onboarding capture** — DECISION PENDING: WhatsApp-native Q&A on the company number (fits the
   WhatsApp-first product) vs. a dashboard form (`api.ts` + mockups already exist). **Ask user.**
3. **Distill job** — reads agent's real sent messages, folds only messages since `voice_card_upto`
   into the voice card (flat cost). Mirrors the existing `summarize()` memory pattern
   ([src/brain.ts:95-106](../src/brain.ts#L95-L106)). Triggered on threshold or the existing daily
   reminder cron.
4. **`suggestReplies()` rewrite** — stop using one hardcoded `SYSTEM`; assemble persona + voice_card
   + live samples. Generic prompt becomes the fallback for a brand-new agent.
5. **Model routing** — point THIS call at a stronger model; keep qualify/summarize on cheap local.

### Cold-start (graceful degradation)
No voice card → declared persona only. No persona → today's generic prompt. Samples (layer 3) kick in
after a handful of sent messages; voice card after first distill. Never worse than today.

### Honest caveat (feedback loop)
Some stored "out" messages are the agent copying OUR OWN suggestions verbatim. Distilling from those
risks the system learning to imitate its own AI voice. Mitigation: don't distill from messages sent
verbatim from a suggestion, or weight hand-typed messages higher. Real design point, flag at build.

---

## Workstream B — response-rate labeling (data foundation)

- Ground truth already derivable: `responsiveness()` at [src/store.ts:370](../src/store.ts#L370)
  derives active/awaiting/no_reply from the message log. A suggested reply "worked" if the lead's
  next message was inbound.
- Task: mark each suggested reply, once its conversation moves, as got-reply / no-reply. Cheap.
  **Must start collecting NOW** — it's the prerequisite for any Layer-4 optimization later.

---

## Research: karpathy/autoresearch (the "self-evolving" idea)

**What it actually is:** a while-loop where an LLM edits ONE file (`train.py`), runs a fixed 5-min
training job, reads ONE number (`val_bpb`, validation bits-per-byte), and keeps the edit if the number
dropped. `prepare.py` = fixed harness (data/tokenizer/eval, agent can't touch). `program.md` = the
"skill"/instructions. Loop: modify → commit → run 5 min → read TSV → keep or `git revert` → repeat.
~12 experiments/hour, runs overnight unattended. It's hill-climbing: LLM = mutation operator, metric =
fitness function. Genius is entirely in the CONSTRAINTS (fast + cheap + deterministic + replayable metric).

**Why it does NOT transfer as-is to reply optimization:**

| autoresearch needs | it has | our reply system has |
|---|---|---|
| fast metric | val_bpb in 5 min | response rate takes DAYS |
| cheap metric | free, offline | each experiment = a real lead you can't re-run |
| clean signal | pure model quality | response ⟵ timing/area/budget/agent-rep/luck; reply is a tiny fraction |
| replayable | same val set | every conversation is one-shot, unique |

Copying it literally (LLM edits `replies.ts`, checks response rate) = **hill-climbing on noise.** Would
confidently "improve" on random variation and make things worse. Need hundreds of leads/variant over
weeks for signal; we have one agent.

**What DOES transfer (the real plan for Layer 4, later):**
1. Replace the metric with a **fast, cheap LLM judge** over a saved eval set of ~20–40 real/realistic
   lead conversations. Judge scores "would a busy Dubai buyer reply? human / on-topic / not pushy /
   matches agent voice", graded against the agent's OWN real replies as gold. Now the autoresearch loop
   works faithfully: mutate prompt → run over 30 saved convos → judge → keep if avg up. Minutes, cents,
   replayable.
2. Use **real response rate as the slow OUTER validator** (A/B test prompt variants across weeks). If
   judge score and real response rate diverge → fix the JUDGE. That's the actual learning.

Layer 4 sits ABOVE layers 1–3: evolution optimizes the *strategy/wording*; layers 1–3 keep it
*personal per agent*. Different things, both self-improving.

---

## Local Ollama model menu (for the reply call specifically)

Voice quality is model-bound. Recommend routing ONLY the reply call to a bigger model; keep
qualify/summarize on `llama3.1:8b`.

| Model | Pull | Size | Notes |
|---|---|---|---|
| llama3.1:8b | `ollama pull llama3.1:8b` | ~4.7 GB | current default; too small = the flat voice |
| qwen2.5:7b | `ollama pull qwen2.5:7b` | ~4.7 GB | better instructions, strong multilingual |
| gemma2:9b | `ollama pull gemma2:9b` | ~5.4 GB | warmer prose |
| mistral-nemo:12b | `ollama pull mistral-nemo:12b` | ~7 GB | noticeably more human; needs ≥16 GB RAM |
| **qwen2.5:14b** | `ollama pull qwen2.5:14b` | ~9 GB | **top pick if it fits** (~16 GB RAM/GPU) |
| gemma2:27b | `ollama pull gemma2:27b` | ~16 GB | good writing; ~32 GB RAM / 24 GB GPU |
| qwen2.5:32b | `ollama pull qwen2.5:32b` | ~20 GB | closest-to-cloud locally; heavy |
| llama3.3:70b | `ollama pull llama3.3:70b` | ~43 GB | cloud-class; workstation only |

Cloud path already wired ([src/claude.ts:10](../src/claude.ts#L10)) — a strong cloud model beats any
local one for voice.

---

## Recommended build order (agreed)

1. **(A)** Personalization system — 90% of the "no heart" problem, deterministic, ships now.
2. **(B)** Response-rate labeling — start accumulating data immediately.
3. **(Later, Layer 4)** autoresearch-style loop with LLM-judge fast metric + A/B'd response-rate
   validator — ONLY after (A) and (B) exist and a labeled corpus has built up.

## DECISIONS
1. **Hardware — LOCKED.** RTX 4060 Laptop (**8 GB VRAM**), 15.7 GB RAM, i7-12650H.
   VRAM is the ceiling, not RAM.
   **Reply-call model pick (RE-VERIFIED 2026-07-23 vs LIVE ollama.com/search — supersedes ALL
   earlier picks incl. qwen2.5 and qwen3:8b, which are outdated):**
   Current library has moved to gemma4, qwen3.5, qwen3.6, granite4.1. Most new models
   (laguna 118B, deepseek-v4 284B, kimi/glm/minimax cloud) are too big or off-task (coding/vision).
   Only 3 families matter for 8 GB + short-WhatsApp-reply: gemma4, qwen3.5, granite4.1.

   - **PRIMARY: `gemma4:12b`** — 7.6 GB download, runs **~6.6 GB VRAM @ Q4_K_M**, fits 8 GB 4060
     (~21 tok/s). ~1 mo old = latest that fits. Reviews: "shorter and more conversational, exactly
     what you want chatting back and forth" — DIRECTLY attacks our stale/too-long/stiff complaint.
   - **A/B CHALLENGER: `qwen3.5:9b`** — 6.6 GB, fits. Excellent (its 9B beats last-gen 30B on
     reasoning) BUT leans verbose/analytical — wrong instinct for a warm 2-line reply. Use only if
     gemma feels too brief/shallow.
   - LIGHT option: `qwen3.5:4b` (3.4 GB) — run reply + qualify models resident at once.
   - SKIP on 8 GB: gemma4:e4b (9.6 GB), qwen3.5:27b+, everything ≥12B non-gemma. gemma4:e2b (7.2 GB,
     edge-tuned) is lower quality than gemma4:12b — no reason to pick it.
   - **HARD CONSTRAINT:** gemma4:12b fits 8 GB only at **Q4 + modest context (4K-8K tokens)**. Fine
     for us (reply prompt is small) BUT: keep persona voice-card + few-shot samples + transcript
     TIGHT or KV cache spills VRAM. Reinforces the "5-6 line voice card" rule.
   Keep llama3.1:8b (or move to qwen3.5:4b) for qualify/summarize — voice doesn't matter there.
   Cloud path ([src/claude.ts:10](../src/claude.ts#L10)) = fallback if local voice stays flat.
   Make model a ONE-LINE env swap to A/B gemma4:12b ↔ qwen3.5:9b by ear.
   NOTE: Layer-3 few-shot samples matter MORE for "human feel" than the model bump.
2. **Onboarding capture method → DEFERRED by user ("decided later").** WhatsApp-native Q&A vs.
   dashboard form vs. auto-seed. Does NOT block the build: only Layer 1 (declared persona) needs it.
   Layers 2 (voice card) + 3 (live samples) learn from already-collected sent messages — build those
   now. When creating the `agent_persona` table, include the declared-persona columns nullable/unused
   so adding the form later is data-entry, not a migration.

## ADJUSTED BUILD ORDER (post-decisions)
1. **Model routing** — reply call → qwen2.5:7b or gemma2:9b; qualify/summarize stay llama3.1:8b.
2. **Layer 3 (live samples)** — inject agent's recent real sent msgs into reply prompt. No new table.
3. **Layer 2 (voice card)** — `agent_persona` table (incl. nullable Layer-1 cols) + distill job.
4. **Workstream B** — response-rate labeling.
5. **Layer 1 (declared persona form)** — once onboarding method is chosen.
6. **Layer 4 (evolution loop)** — much later, after B has a labeled corpus.

## SHARPENED PROBLEM STATEMENT (from a live screenshot — 2026-07-23)

Lead (Madhur) said: "I want to move in November, preferably the 1st, because my current contract
ends then." The generated suggested replies exposed THREE distinct failures, ALL in
`suggestReplies()` / `replies.ts` (NOT qualify's next_question — the screenshot shows the 4 reply
options, which come from replies.ts):

1. **Stale voice** — generic, AI-sounding. (original complaint)
2. **Re-asks an answered question** — reply #3 asked "November 1st is specific, what's driving this
   timeline?" — the lead JUST said why (contract ends). Root cause: `suggestReplies` only receives
   budget/area/requirement as known-fields ([replies.ts:74](../src/replies.ts#L74)); **timeline /
   urgency is tracked NOWHERE**, so the model treats a closed topic as open.
3. **Presumes unstated facts** — replies #1/#2 asserted "JVC", "Circle Mall must-have", "pool with
   sunlight", "one-bedroom" as confirmed. Invented or pulled from stale context without validation =
   the discovery-first rule (reply-persona SKILL) already being violated.

### Implication for the rebuild
The persona rebuild must fix the INPUT CONTRACT to suggestReplies, not just tone. A reply is "human"
only if it (a) sounds like the agent AND (b) never re-asks a stated fact AND (c) never asserts an
unstated one. So the rebuild needs, beyond Layers 1-3:
- **A trustworthy conversation-state** the prompt can key off: known-AND-answered vs genuinely-open.
  The missing timeline/urgency signal is the concrete example; amenities the lead named are another.
- **A hard grounding rule in the prompt**: never re-ask a stated fact, never assert an unstated one —
  enforced against that state, not the model's memory of the transcript.

### CORRECTION — qualify.ts IS in scope (user call, 2026-07-23)
"Once the qualifier's questions are answered it should NOT re-ask them." For that to work, both the
qualify field-set AND the replies injection contract must change. Field inventory below.

#### What qualify EXTRACTS today (7 fields, qualify.ts:5-13 + SYSTEM prompt)
1. budget — price/range ("1.4M AED", "8k/month")
2. area — named Dubai community ("JVC", "Dubai Marina")
3. deal_type — buy | rent
4. unit_type — apartment | villa | townhouse | ...
5. beds — studio | 1BR | 2BR | ...
6. requirement — fields 3+4+5 joined ("rent · apartment · 1BR")
7. next_question — single best next question

#### What actually REACHES replies today (only 3!) — THIS IS THE BUG
`suggestReplies` signature ([replies.ts:70-76](../src/replies.ts#L70-L76)) takes
`Pick<Qualification,"budget"|"area"|"requirement">` — brain.ts:123 passes ONLY budget/area/
requirement. `knownFields()` ([replies.ts:51-59](../src/replies.ts#L51-L59)) prints just those 3 as
"Known so far — ...". deal_type/unit_type/beds are squeezed into the `requirement` string, not passed
as discrete answered-flags. So the reply model's ENTIRE notion of "what's answered" = 3 lines.

#### Two-part fix (planning only)
1. **Widen the injection contract** — pass replies the clean discrete set of all answered fields
   (budget/area/deal_type/unit_type/beds), with an explicit "these are ANSWERED — never re-ask" rule
   keyed off them.
2. **Add the missing tracked question(s)** — **timeline/move-in was never a qualify field at all** →
   that's why "November, contract ends then" got re-asked. It was never captured, never passed. Add a
   `timeline` field to qualify. Candidates to also consider (FLAG, not decided): `purpose`
   (end-use vs investment), `payment` (cash vs mortgage).

Net: qualify's tracked-question LIST is incomplete (no timeline) AND the replies contract is too
narrow (3 of 7). Both fixed in the rebuild. qualify still only extracts WHAT is true; the change is
WHICH facts it tracks + that ALL of them flow to replies as explicit answered-flags.

## MODEL BACKEND DECISION (2026-07-23) — test vs prod split
- **Testing (now):** local **Ollama** — `gemma4:12b` for replies (fits 8 GB RTX 4060 @ Q4). Free/private.
- **Production (before deploy):** switch to **OpenRouter key + cloud model** via env swap
  ([src/claude.ts:10](../src/claude.ts#L10)) — no code rewrite. Local can't serve many concurrent
  agents (GPU throughput wall); cloud = infinite concurrency + better voice.
- **Prod model pick (non-frontier, verified):** primary **Gemini 3.1 Flash-Lite** ($0.25/$1.50 per M,
  concise + strong multilingual, ~$43/mo @ 20 busy agents); A/B challenger **Claude Haiku 4.5**
  ($1/$5, warmest voice, ~$155/mo). Skip DeepSeek V4 Flash for replies (verbose/weak AR-HI). Prompt-
  cache the fixed system+persona block. Saved as project memory: model-provider-split-test-vs-prod.

## Environment note (this session)
- `yt-dlp`: installed as Python module (`python -m yt_dlp`, v2026.03.17). No standalone CLI on PATH.
- `notebooklm`: not a pip/npm package — provided via the `notebooklm` skill + Google connector, not a
  local install. Nothing to install in this repo.
