# Timeline Pipeline Redesign — Research & Analysis

## Problem Statement

The current topic pipeline in `src/lib/topic-pipeline.ts` treats timeline construction as a **multi-stage assembly problem**: build a date spine, extract content separately, align them with heuristics, fill gaps with scaffolding. This creates compounding error across 6+ stages with no end-to-end validation and no ability to say "I don't know."

The better framing: this is an **extraction and verification problem**. The professor already solved the alignment problem in the syllabus. The system's job is to read what's there, verify it against Canvas ground truth, and be honest about what it couldn't determine.

---

## Research Findings

### 1. Single-Pass Per Local Evidence Block (Not Per Document)

**Key paper: BLOCKIE (ACL 2025)** — [Information Extraction from Visually Rich Documents using LLM-based Organization of Documents into Independent Textual Segments](https://aclanthology.org/2025.acl-long.844/)

BLOCKIE segments documents into "semantic blocks" — self-contained regions that can be independently interpreted — and processes each block separately. Key findings:

- Smaller models (7B) processing localized blocks **outperformed** larger models processing whole documents
- Performance remained robust with only 100 training samples (94.47% F1 vs LayoutLMV3's 78.79%)
- A semantic block is defined as a region where "the values extracted from B in isolation must match those extracted with full document context"
- Semi-structured documents naturally organize information in human-readable blocks, enabling focused reasoning that generalizes better across formats

**Implication**: A syllabus isn't one homogeneous text. It has distinct sections (schedule table, grading policy, course info, materials). Each is a local evidence block. Within a block, extraction should be single-pass — never split the schedule table into "date extraction" and "topic extraction." Across blocks, independent extraction is fine.

**What this replaces**: The current dual timeline/content candidate split and the merge/alignment layer. The system currently splits co-located information (dates and topics in the same table row) into separate extractions and tries to re-align them — the opposite of what BLOCKIE's research recommends.

---

### 2. LLM Date Extraction Requires Deterministic Validation

**Key source: [Strategies for Reliable LLM Date Handling (MrDashboard)](https://mrdashboard.com/proven-strategies-to-get-llms-to-handle-complex-date-time-expressions-reliably/)**

Failure modes for LLM date extraction:
- Multi-timezone confusion
- Vague reference resolution ("next Friday," "two weeks after Thanksgiving")
- Range ambiguity ("2-5pm," "between Tuesday and Thursday")
- Hallucinated dates not present in source material
- Inconsistent time granularity (date-only vs datetime vs duration)

The consensus solution: **combine LLMs for language interpretation with deterministic parsing for date accuracy**. Neither alone is sufficient.

**Key source: [LLMs Are Still Bad at Dates (Max Kerr, Talc AI)](https://talcai.substack.com/p/making-up-a-new-llm-benchmark)**

Benchmarked date extraction accuracy (2023 models):
- GPT-4 Turbo: 56% correct
- GPT-4: 41% correct
- PaLM 2: 18% correct

**Important caveat**: These benchmarks were run on GPT-4-era models. GPT-5.4 (used in Studious) is significantly better. The architectural principle remains valid regardless of specific accuracy numbers: **date normalization should not rely on unconstrained generation alone.** Even at 95% accuracy, 1 in 20 dates is wrong — in a 15-week schedule, that's likely at least one wrong week.

**Deterministic validation checks** (cheap and reliable):
- Does the date fall on a day the class actually meets?
- Is the date within the semester window?
- Is the date sequence monotonically increasing?
- Does it match or closely align with a Canvas assignment date?

**What this replaces**: The current system trusts AI-extracted dates to build a lecture calendar and then uses that calendar to date other entries. The fix is: extract dates with AI, then validate each one deterministically against known constraints.

---

### 3. Grounded Extraction: Only Output What Exists in the Source

**Key source: [Google LangExtract](https://github.com/google/langextract)**

LangExtract's core innovation: every extraction is mapped to **character-level positions** in the source document. If an extraction can't be located in the source text, it gets `char_interval = None` — flagged as ungrounded.

Key principles:
- Extractive models can only make **mistakes**; generative models can make mistakes AND **hallucinations**
- Automatic detection of hallucinations (extractions absent from source text)
- Filtering mechanisms to retain only verifiable, location-mapped results
- Every extracted value must be traceable to its source context

**Key source: [Fix AI Pipeline Hallucinations (Mikulski)](https://mikulskibartosz.name/fix-no-code-ai-pipeline-hallucinations)**

Went from "almost always crashes" to **95% accuracy with 100% correctness on structured fields** by:
- Replacing fragile prompt-based JSON requests with schema enforcement (BAML)
- Adding deterministic validation and retry handling
- Key insight: **"Structure beats scale"** — proper schema enforcement matters more than model size

**Key source: [Structured Extraction with LLM Schemas (Simon Willison)](https://simonwillison.net/2025/Feb/28/llm-schemas/)**

Willison's view: structured extraction from unstructured content is "the single most commercially valuable application of LLMs." Best practices:
- One schema, one pass, validate the aggregate
- 100% reliability is never guaranteed — design for validation, not perfection
- Log extractions and validate aggregated results at scale rather than per-prompt

**What this replaces**: The current system fabricates timeline entries from module scaffolding, dumps unmatched lectures into the last week, and uses proportional-index mapping to stretch content onto timelines. None of these are grounded in source text.

---

### 4. Fail-Closed Design for Trust-Critical Systems

**Key paper: [A Survey of Abstention in Large Language Models (TACL 2025)](https://aclanthology.org/2025.tacl-1.26/)**

Two motivations for abstention:
1. **Uncertainty-driven**: withhold response when confidence is low
2. **Safety-driven**: decline to provide information that could cause harm

Chain-of-Thought prompting emerged as the most effective method for improving abstention behavior. Key tradeoff: improving abstention necessarily increases false negatives — coverage decreases as accuracy improves.

**Key source: [UX Patterns for AI Uncertainty (Amestris)](https://amestris.com.au/blog/llm-ux-patterns.html)**

- "It's better to refuse or escalate than to fabricate"
- Citations are "one of the strongest trust mechanisms"
- Present brief answers first, allow users to explore supporting evidence
- Confidence indicators show reliability; if the AI is unsure, let users know

**Key source: [Designing for Uncertainty in AI (Medium/Bootcamp)](https://medium.com/design-bootcamp/designing-for-uncertainty-ux-challenges-in-ai-driven-systems-e8b81aab9d61)**

- "Most AI product failures are not model failures — they are experience failures"
- Users don't know when to trust outputs, error states are unclear, system over-promises capability
- Graceful Degradation Messaging: nuanced feedback instead of binary success/failure

**What this replaces**: The current system is fail-open — every failure mode has a fallback that produces output. Module scaffold, proportional alignment, dumping overflow into last week — all exist to avoid showing gaps. The research says gaps are better than wrong data.

---

### 5. Verify After Extraction, Don't Construct Then Validate

**Key source: [LLM-as-a-Judge for Extraction Validation (Towards AI)](https://towardsai.net/p/machine-learning/from-extraction-to-accuracy-evaluating-extracted-invoice-data-with-llm-as-a-judge)**

The pattern:
1. **Extraction Layer**: AI pipeline extracts structured data from source
2. **Evaluation Layer**: Compare extracted values against ground truth
3. **Scoring Layer**: Produce accuracy scores, match classifications, and explanations

Critical distinction: **ground-truth-based evaluation** (genuine accuracy measurement) vs **plausibility-based evaluation** (educated guessing). Without verified reference values, you can only assess whether data seems reasonable.

**Key source: [AgenticIE: Adaptive Information Extraction (arxiv)](https://arxiv.org/html/2509.11773v2)**

Planner-executor-responder architecture:
- Extracts information, then calls verification tools to check completeness and grounding
- If outputs are incomplete or malformed, the planner **revises strategy** rather than silently degrading
- Achieves 100% JSON validity across all configurations (vs 94-96% for baselines)
- Key: stateful reasoning that tracks decisions, progress, and tool history

**What this replaces**: The current system constructs a timeline from fragments (spine + content + modules) and then runs a "finalize" validation pass. The research says: extract candidates first, verify each against ground truth, only commit what's proven.

---

### 6. Document-Level IE: Error Propagation is the Central Risk

**Key paper: [Document-Level Information Extraction Survey (ACL 2024)](https://aclanthology.org/2024.futured-1.6.pdf)**

Core challenges:
- **Long-range dependencies**: relationships span distant passages, hard for models to maintain coherent connections
- **Cross-document consistency**: different sources reference identical concepts with varying terminology
- **Error propagation**: early-stage extraction errors cascade through downstream components, degrading overall performance — a "fundamental architectural challenge where initial mistakes become increasingly difficult to correct"

**Implication**: The current pipeline's 6+ stages are exactly the architecture this research warns against. Each stage inherits errors from prior stages with no correction mechanism. The lecture calendar is built from AI-extracted meeting times (potential error), term dates from Canvas (potential error), clamped by assignment dates (potential error) — and then AI extraction results are joined to this calendar by positional index (potential error compounding on error).

---

### 7. Entity Resolution: Probabilistic Matching Over Forced Alignment

**Key paper: [(Almost) All of Entity Resolution (Science Advances)](https://www.science.org/doi/10.1126/sciadv.abi8021)**

The current system's alignment problem — matching content to dates across sources — is a well-studied problem in data science: entity resolution / record linkage. Modern approaches use **probabilistic matching with uncertainty quantification**:
- Don't force a match — compute a probability that two records refer to the same entity
- Only accept matches above a confidence threshold
- Quantify uncertainty for downstream consumers

**What this replaces**: The current merge layer uses proportional-index mapping (`Math.round(i * (contentLen - 1) / (timelineLen - 1))`) when structures don't align. This is the opposite of probabilistic matching — it forces an alignment regardless of whether the content actually corresponds.

---

## Current System: Specific Failure Modes

### 1. Dual-Pass Extraction Creates Artificial Misalignment
Two independent AI calls on the same syllabus can disagree on how many weeks exist, where boundaries fall, and what week number a topic gets. The merge uses keyword overlap (≥2 tokens), positional zip (same count), or proportional stretching (different count) — all heuristic.

### 2. Lecture Calendar is a Fabrication
`buildLectureCalendar()` generates every lecture date from meeting patterns + term dates. It doesn't know about holidays, cancellations, or schedule changes. The only correction mechanism (lecture anchors from assignment titles referencing "Lecture #N") is uncommon.

### 3. Lecture-to-Week Grouping is Blind Positional Join
`groupLecturesIntoWeeks()` maps AI-extracted Lecture N to calendar Lecture N by number. If the calendar is off by one lecture (missed holiday, wrong start), every subsequent lecture shifts to the wrong week. Unmatched lectures get dumped into the last week.

### 4. Module Scaffold Masquerades as Timeline
Canvas module ordering treated as chronological when it often isn't. Labeled `module_scaffold` with low confidence, but displayed alongside high-confidence entries with no visual distinction (needs UI verification).

### 5. System Never Says "I Don't Know"
Every failure path has a fallback that produces output. The system optimizes for completeness over correctness.

---

## Refined Design

### Core Principle

**Localized extraction → candidate facts → constraint-based reconciliation → explicit abstention/gaps → canonical commit only for proven facts**

### Step 1: SEGMENT

Segment the syllabus into local evidence blocks:
- Schedule table (dates + topics — tightly co-located)
- Grading policy (weights, drop rules)
- Course info header (meeting times, instructor, term)
- Materials/textbook section

Layout-aware segmentation — can use AI or heuristic detection. Each block is processed independently.

### Step 2: EXTRACT (per block, single-pass)

One AI call per block. Within a block, dates and topics are extracted together (never split co-located information):

- **Schedule block** → `[(week, date, topics, readings, notes)]`
- **Grading block** → `[(group, weight, dropLowest, dropHighest)]`
- **Course info block** → `(meetingDays, times, instructor, location)`

Each extraction is grounded — only output what's in the source. Use structured output schemas with validation.

### Step 3: RECONCILE against Canvas ground truth

For each extracted fact, compare against Canvas API data:

| AI extraction says | Canvas says | Result |
|---|---|---|
| Exam 2 on March 15 | Exam 2 due March 15 | **Verified** ✓ |
| Week 5 starts Feb 3 | Homework 5 due Feb 7 | **Corroborated** (close match) |
| Week 8 starts March 3 | Nothing near that date | **Unverified** (not wrong, just unconfirmed) |
| Quiz 3 on April 1 | Quiz 3 due March 25 | **Conflicted** ⚠ |

**If NO syllabus schedule exists**: Build an assignment timeline from Canvas due dates. Label it explicitly as "Assignment Timeline" — never as "Course Schedule" or "Lecture Plan."

### Step 4: COMMIT only proven facts

| Category | Display treatment |
|---|---|
| Verified + corroborated | Full timeline entry, normal display |
| Unverified (from syllabus) | Shown with subtle indicator ("from syllabus, unconfirmed") |
| Conflicted | Shown with warning, both sources visible |
| Unknown / gaps | Shown as gap ("no data for this week") |
| Canvas modules | Supplementary content on confirmed weeks only, never timeline structure |

### What This Eliminates

| Current complexity | Why it's gone |
|---|---|
| Candidate role classification (timeline/content/mixed heuristic scoring) | Single pass per block, no role split needed |
| Dual-pass extraction + merge layer | Never split co-located information |
| Proportional-index mapping | Never fabricate alignment |
| Lecture calendar generation from meeting patterns | Don't construct dates, extract them from syllabus |
| Lecture-to-week positional grouping | AI groups its own output within the schedule block |
| Module scaffold as timeline source | Modules are content enrichment, never structure |
| Break inference from date gaps | Extract breaks from syllabus text directly |
| Term date clamping hacks | Term dates used for plausibility checks, not construction |
| "Dump overflow into last week" | Unmatched data stays unmatched, shown as unplaced content |

### What This Keeps (Repositioned)

| Capability | New role |
|---|---|
| AI extraction from syllabus | Now localized per block, not split by role |
| Canvas assignment data | Verification/anchoring, not construction (except as honest labeled fallback) |
| Module content | Enrichment on confirmed weeks only |
| Class schedule extraction | Plausibility check (does this date fall on a class day?), not calendar generator |
| Break detection | Extracted directly from syllabus schedule block |
| Confidence tracking | Now drives display decisions (fail-closed), not just metadata |

---

## Why This Design Has the Most Logic

1. **Respects information hierarchy.** The professor wrote a schedule. Read it. Don't deconstruct and rebuild from parts.

2. **Uses each source for what it's good at.** Canvas API = certain facts (due dates). Syllabus = professor's plan. Modules = supplementary content. None used beyond their authority.

3. **Has a place for uncertainty.** Explicit states: verified, corroborated, unverified, conflicted, unknown. The current system has no "I don't know."

4. **Error doesn't propagate.** If schedule block extraction is wrong, grading policy extraction is unaffected. If Canvas verification fails, extracted data still exists with lower confidence — not silently corrupted.

5. **Auditable.** Every fact traces to a specific source block and verification result. The current provenance tracking can't do this because the construction process destroys the trace.

6. **Simpler.** 4 steps instead of 6+. ~1 AI call per syllabus block instead of 3-5 chained AI calls with heuristic glue between them.

---

## Sources

- [BLOCKIE: Semantic block extraction (ACL 2025)](https://aclanthology.org/2025.acl-long.844/)
- [Abstention in LLMs survey (TACL 2025)](https://aclanthology.org/2025.tacl-1.26/)
- [Document-level IE challenges (ACL 2024)](https://aclanthology.org/2024.futured-1.6.pdf)
- [LangExtract: Grounded extraction — Google](https://github.com/google/langextract)
- [LLMs are still bad at dates — Max Kerr](https://talcai.substack.com/p/making-up-a-new-llm-benchmark)
- [Strategies for reliable LLM date handling — MrDashboard](https://mrdashboard.com/proven-strategies-to-get-llms-to-handle-complex-date-time-expressions-reliably/)
- [Structured extraction with LLM schemas — Simon Willison](https://simonwillison.net/2025/Feb/28/llm-schemas/)
- [AgenticIE: Adaptive extraction (arxiv)](https://arxiv.org/html/2509.11773v2)
- [LLM-as-a-Judge for extraction validation — Towards AI](https://towardsai.net/p/machine-learning/from-extraction-to-accuracy-evaluating-extracted-invoice-data-with-llm-as-a-judge)
- [Fix pipeline hallucinations: structure beats scale — Mikulski](https://mikulskibartosz.name/fix-no-code-ai-pipeline-hallucinations)
- [(Almost) all of entity resolution — Science Advances](https://www.science.org/doi/10.1126/sciadv.abi8021)
- [UX patterns for AI uncertainty — Amestris](https://amestris.com.au/blog/llm-ux-patterns.html)
- [Designing for uncertainty in AI — Medium/Bootcamp](https://medium.com/design-bootcamp/designing-for-uncertainty-ux-challenges-in-ai-driven-systems-e8b81aab9d61)
- [LLM structured output benchmarks are flawed — Cleanlab](https://cleanlab.ai/blog/structured-output-benchmark/)
- [Multi-step LLM chains best practices — Deepchecks](https://deepchecks.com/orchestrating-multi-step-llm-chains-best-practices/)
- [Can we achieve 100% accurate extraction? — SNH AI](https://www.snh-ai.com/content/perfect-extraction)
- [Agentic document workflows — LlamaIndex](https://www.llamaindex.ai/blog/introducing-agentic-document-workflows)
