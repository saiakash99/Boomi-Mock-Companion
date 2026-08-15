# BOOMI COMPANION

# FINAL CORE ARCHITECTURE, PARALLEL RETRIEVAL & REAL-TIME ANSWER STRATEGY

## 1. PRODUCT PURPOSE

Boomi Companion is a real-time interview practice assistant designed to help a candidate respond naturally and confidently during technical mock interviews.

The primary objective is NOT to display keywords.

The primary objective is:

> Understand what the interviewer is asking, identify the most relevant candidate knowledge, prepare the answer as early as possible, and display a natural interview-ready response with minimal delay.

The system should behave like a realistic interview-support assistant for confidence-building practice.

The application is primarily concerned with understanding the **interviewer's speech** and preparing the candidate's response.

The candidate's own spoken answer is NOT currently part of the core processing pipeline and should not be added at this stage.

---

# 2. PRIMARY DOMAIN

Current active domain:

**BOOMI**

Future domains:

* DEVOPS
* OTHER TECHNICAL DOMAINS

Additional domains must be added as independent knowledge packs without changing the core engine.

Current implementation should focus on Boomi only.

---

# 3. CORE PRODUCT PRINCIPLES

1. Natural answer is the primary output.
2. Hint is secondary.
3. Accuracy is more important than generating text quickly.
4. The system should begin preparing before the interviewer finishes speaking whenever enough information is available.
5. The system must not confidently answer incomplete or ambiguous questions.
6. Candidate-specific knowledge must be preferred over generic knowledge.
7. Candidate experience must never be fabricated.
8. Conversation context must be preserved across follow-ups.
9. Job Description must influence retrieval and prioritization.
10. Unknown questions must have a useful fallback.
11. Retrieval and external AI generation should happen in parallel whenever practical.
12. A missing RAG result must NOT block API-based reasoning.
13. A weak early answer may be replaced by a stronger answer when new information becomes available.
15. Every interview turn must be isolated so stale responses cannot overwrite newer questions.
16. The system should prepare early and finalize only when confidence is sufficient.

---

# 4. PRIMARY KNOWLEDGE SOURCES

## 4.1 Candidate Resume

Contains:

* experience
* companies
* years
* technologies
* roles
* responsibilities
* achievements
* projects

Used primarily for:

* introduction
* experience questions
* candidate background questions

---

## 4.2 Job Description

The Job Description must be loaded before the interview.

It provides:

* required skills
* preferred skills
* responsibilities
* expected technologies
* domain terminology
* likely interview areas

The JD influences:

* topic prioritization
* question prediction
* retrieval ranking
* scenario selection
* preparation priority
* likely follow-up generation

The JD must never override candidate truth.

---

## 4.3 Candidate Project Profile

Each project should contain structured information:

* project name
* business purpose
* architecture
* integrations
* connectors
* APIs
* databases
* SFTP
* S3
* queues
* authentication
* error handling
* monitoring
* deployment
* performance
* production issues
* responsibilities
* decisions
* challenges
* results

Project facts are candidate-specific truth.

---

## 4.4 General Boomi Knowledge

Contains:

* core Boomi concepts
* connectors
* processes
* Atoms
* Molecules
* queues
* process properties
* environment extensions
* error handling
* retry
* monitoring
* deployment
* API management
* performance
* security
* authentication
* architecture
* production troubleshooting

This knowledge is used when a question is not directly covered by the candidate's project.

---

## 4.5 Master Interview Scenario Bank

Initial target:

**Approximately 100 master scenarios.**

Suggested distribution:

* 20 Project / Experience
* 20 Boomi Core
* 20 Connector / Integration
* 20 Production / Troubleshooting
* 20 Scenario / Architecture

Each master scenario should contain:

* main question
* alternative question phrasings
* question type
* expected concepts
* candidate-specific facts
* preferred answer
* short answer
* detailed answer
* hint
* follow-up questions
* related topics
* production variations
* failure variations
* likely next questions

The objective is not merely 100 questions.

The objective is to create a reusable scenario system capable of handling hundreds of realistic variations.

---

# 5. KNOWLEDGE PRIORITY

The logical priority is:

1. Exact prepared answer
2. Matching master scenario
3. Matching candidate/project facts
4. Relevant Boomi knowledge
5. General RAG knowledge
6. General LLM knowledge

However, this priority applies to **answer selection**, not execution order.

Execution should happen in parallel wherever possible.

Example:

* local exact retrieval starts immediately;
* scenario retrieval starts immediately;
* conversation-context analysis starts immediately;
* general LLM/API request starts immediately when enough transcript exists.

The system then merges the results.

---

# 6. INTERVIEW STAGE ENGINE

The system should track the likely interview stage.

Stages:

1. Introduction
2. Resume / Experience
3. Project Overview
4. Project Deep Dive
5. Technology / Connector Deep Dive
6. Additional / Unlisted Technology
7. Production Problems
8. Real-Time Scenarios
9. Follow-Up / Cross-Questioning

The stage influences retrieval ranking.

Example:

If the interview is in Project Deep Dive and the interviewer asks about SFTP, candidate-project SFTP information should outrank generic SFTP information.

---

# 7. REAL-TIME QUESTION PIPELINE

The runtime architecture is:

Desktop Audio
â†“
Speech / Transcript
â†“
Question Segmentation
â†“
Question Snapshot
â†“
Question Understanding
â†“
Interview Stage
â†“
Conversation Context
â†“
Job Description Context
â†“
Parallel Retrieval + Parallel API
â†“
Response Candidates
â†“
Candidate Ranking / Merge
â†“
Answer Refinement
â†“
Natural Answer
â†“
Optional Hint

---

# 7A. IMPLEMENTED â€” 3-PILLAR REAL-TIME INTERVIEW ARCHITECTURE

Three coordinated pillars ship with the current engine and are validated by the
deterministic suite (88 engine + 24 diagnostic + 9 audio-pipeline tests, 0 failed).

## Pillar 1 â€” Centralized Domain Vocabulary (`domain-vocabulary.js`)

Single source of truth per interview domain. `getDomainConfig(domain)` resolves a
domain and falls back to Boomi for unknown names.

Each domain carries:

* `stt_keyterms` â€” vocabulary sent to Deepgram so domain jargon is not misheard
  (Boomi: Boomi, OAuth, Atom, Molecule, SFTP, SAP, Salesforce, Process Property,
  Dynamic Process Property, Process Route, Environment Extensions, Flat File,
  Profile, JVM, Heap, Integration, API Management, EDI, AS2, Flow Control).
* `incomplete_hooks` â€” prepositions / connectors that make a sentence
  grammatically incomplete (between, into, from, across, using, through, during,
  via, with, for, about, and, or, to, of, in, on).
* `knowledge_base` â€” grounding prompt injected into Groq.

This is the ONLY place domain terms are defined. `audio-pipeline.js` and
`engine.js` import it; do not hardcode domain strings elsewhere.

## Pillar 2 â€” Boosted Deepgram STT Recognition (`audio-pipeline.js`)

`buildDeepgramStreamUrl({ ..., domain })` appends every `stt_keyterms` entry as a
Nova-3 `keyterm` query parameter.

Rules:

* Nova-3 accepts `keyterm` (NOT `keywords`).
* Weights / intensifiers are NOT supported â€” plain repeated `keyterm` params only.
* Multi-word terms are URL-encoded automatically.

## Pillar 3 â€” Linguistic Locking & Speculative Drafting (`engine.js`)

### Linguistic Locking

In `_boundaryDecision`, the final word of the transcript (lowercase,
punctuation-stripped) is compared against `incomplete_hooks`:

* If it matches â†’ unconditionally return `wait`.
* The engine NEVER finalizes a sentence ending in a preposition or connector,
  even when the pause exceeds 800ms.
* This prevents premature boundary finalization while the interviewer is still
  finishing the sentence ("How do you integrate data betweenâ€¦" must wait for
  "â€¦Boomi and Salesforce?").

### Speculative Early Drafting

* `draftDebounceMs` = 200ms and `fastDebounceMs` = 300ms.
* The background draft fires the millisecond a core keyword arrives, entirely
  masking Groq latency behind the interviewer's remaining speech.
* A fixed draft-snapshot promotion check (`confirmedSnapshotNo`, the pre-increment
  snapshot number) lets that fast-firing draft be promoted at the boundary instead
  of spawning a duplicate final API call.

### Crisp Answer Prompt

`buildAnswerPrompt` now enforces:

> "Answer directly in 2-3 crisp, natural spoken sentences. Focus on the exact
> technical mechanism. Do not give generic definitions."

Per-type length hints were removed.

---

# 7B. IMPLEMENTED â€” LIVE FILE-BASED ATS GROUNDING (CANDIDATE-TRUTH PERSONA LAYER)

The candidate-truth layer is a local, file-driven mechanism that shapes the
persona during real-time LLM query construction. It is deliberately simple and
dependency-free (no vector DB, no parsing library).

## Files

* `knowledge/resume.md` â€” the candidate profile (role, experience, core skills,
  key projects with concrete facts such as "SAP to Salesforce real-time order
  sync, 2M+ records daily").
* `knowledge/job-description.md` â€” the target role and its focus requirements
  (e.g. "Lead Boomi Integration Architect", Molecule clustering, API Gateway,
  OAuth 2.0).

## Loading

`loadCandidateContext()` in `engine.js`:

* Resolves `knowledge/resume.md` and `knowledge/job-description.md` under
  `process.cwd()`.
* Reads each file only if it exists; missing/corrupt files are skipped (never
  throws â€” the engine stays robust when the candidate has not configured files).
* Assembles a `[CANDIDATE TRUTH & TARGET JD]` block:
  `CANDIDATE RESUME / EXPERIENCE:` + `TARGET JOB DESCRIPTION FOCUS:`.

## Injection into query construction

* The constructor stores it as `this.candidateContext` (overridable via
  `opts.candidateContext` so tests can inject fixtures).
* `buildAnswerPrompt` appends it to the system message, followed by the
  STRICT RULE:
  > "You are the candidate described in CANDIDATE RESUME. Speak naturally in
  > first person ('In my project, I implemented...', 'I usually approach this
  > by...'). Highlight skills matching the TARGET JOB DESCRIPTION. NEVER invent
  > or fabricate experience. If a topic is not in the candidate's resume,
  > truthfully state 'I haven't worked with that directly, but my understanding
  > is...' followed by a concise, accurate technical answer."

This guarantees contextual, first-person answers that match the candidate's real
job history while keeping the "prepare early and finalize late" pipeline intact â€”
the grounding is injected at prompt-build time, never fetched serially.

---

# 7C. IMPLEMENTED â€” PHASE 5 LATENCY MASKER & INSTANT OPENER

The final answer path (`_runFinalAnswer`) masks Groq's remaining latency behind an
instant, type-matched conversational opener so the candidate is never left with
dead air.

## Opener dictionary

`SAFE_OPENERS` in `engine.js` maps question types to safe, natural openers:

* conceptual / experience / scenario / troubleshooting / comparison / followup /
  best-practice each have 3 openers; `fallback` covers unknown types.

## 0ms flash + prepend

* A random opener is selected at the start of `_runFinalAnswer` and flashed to
  the UI immediately via `onAnswer({ provisional: true, streaming: true })` â€”
  before the API call is even awaited.
* The SAME opener is prepended to every streaming chunk and to the final resolved
  answer, so the candidate reads one continuous sentence ("To explain that
  simply, <core>..."), never a duplicated opener.

## No double-pleasantries

`buildAnswerPrompt` carries a CRITICAL RULE that forbids the LLM from emitting its
own pleasantries/fillers ("Certainly", "Great question", "In my experience") and
requires it to start with the raw technical core, because the opener is already
provided locally.

## Testability

`opts.openersEnabled` (default on) disables the random opener so deterministic
tests can assert exact API text. Three Phase 5 tests were added (73 engine tests
total).

---

# 7D. IMPLEMENTED â€” PHASE 6 EXTENDED CONVERSATION MEMORY & CONFIDENCE SCORING

## Rolling conversation memory

`this.conversationHistory` in `engine.js` is a rolling `{ role, content }` message
log. Every completed turn pushes the user question and the assistant answer, capped
to the **last 4 turns (8 messages)** to prevent context bloat:

* user: the exact question text finalized for the turn
* assistant: the raw API answer (the Phase 5 opener is excluded so the history
  stays clean for the model)

`_callAnswer` splices the history into the Groq messages array **right before the
current user prompt** (system stays first, current prompt stays last). The model
therefore answers with real prior turns â€” follow-ups and multi-part interviews get
full conversational context.

Both answer-completion paths record the exchange:

* `_runFinalAnswer` (authoritative final call)
* `_promoteDraftToFinal` (a fast-firing draft promoted at the boundary is still
  the turn's final answer and must also be remembered)

## Confidence scoring

Each turn's question score (0-100, from `analyzeQuestion`) maps to a boundary-
confidence indicator carried on every `onAnswer` payload:

| Score   | Confidence | UI border color |
| :------ | :--------- | :-------------- |
| `>= 60` | `green`    | `#10B981`       |
| `35-59` | `yellow`   | `#F59E0B`       |
| `< 35`  | `red`      | `#EF4444`       |

In `index.html` the `#answer-box` left border is painted with the turn's confidence
and cleared when the box resets to the "Listening for the questionâ€¦" placeholder.

## Testability

Five Phase 6 engine tests cover: exchange recorded per turn, history injected
before the current prompt, the 8-message cap, green confidence from a high-score
turn, and yellow confidence from a forced mid-score turn.

---

# 7E. IMPLEMENTED â€” PHASE 7 LIGHTWEIGHT SCENARIO INTERCEPTOR (LOCAL FAST-PATH)

## Master Scenario Bank (`knowledge/scenarios.json`)

The first retrieval tier is a lightweight JSON bank of exact-match scenarios:

```json
{ "id": "boomi_atom_vs_molecule",
  "keywords": ["difference", "between", "atom", "molecule"],
  "answer": "An Atom is ...", "type": "comparison" }
```

`loadScenarios()` reads the file at startup (missing/malformed â†’ empty bank â†’ the
engine silently falls back to Groq). The bank is exposed as `this.scenarioBank` and
is overridable via `opts.scenarioBank` so tests stay deterministic and isolated
from the real file.

## All-keyword match

`_searchLocalScenarios(transcript)` lowercases the transcript and requires EVERY
keyword in a scenario to be present (`keywords.every(kw => transcript.includes(kw))`).
Matching is case-insensitive and order-independent. This is exact-match retrieval â€”
cheap, sub-10ms, zero network cost â€” deliberately distinct from fuzzy/RAG lookup.

## Interception in both answer paths

1. **`_runFinalAnswer`** â€” checked right before the Groq call. On a hit the API is
   skipped entirely: the stored answer is resolved instantly (with the type-matched
   Phase 5 opener when enabled), the exchange is recorded into `conversationHistory`,
   and the payload carries `confidence: 'green'` (`source: 'local-scenario-bank'`).
2. **`_runDraft`** â€” the speculative draft also intercepts, because high-score
   questions fire a draft BEFORE the boundary. Intercepting there means a known
   scenario never spends an API call; the local answer is marked `done` and promoted
   instantly at the boundary.

## Why two interception points matter

The engine's fast path is draft-first: for a high-confidence question the draft fires
at ~200ms and is promoted at the boundary, so `_runFinalAnswer` is rarely reached.
Intercepting only in `_runFinalAnswer` would let the draft still call Groq for known
scenarios. Both checks guarantee a real "no API call" on local hits.

## Testability

Seven Phase 7 engine tests cover: all-keyword matching (positive + negative),
case-insensitivity, final-path intercept (answerCount 0), opener prepend on local
hits, draft-path intercept, fall-through when no scenario matches, and the
empty-bank no-op.

---

# 7F. IMPLEMENTED â€” PHASE 8 AUDIO NOISE GATING & VAD POLISH

## Native audio processing on the captured track

`index.html` `startAudioCapture()` now requests `echoCancellation: true`,
`noiseSuppression: true`, and `autoGainControl: true` on the system-audio track
before it reaches the MediaRecorder / Deepgram WebSocket, so Deepgram receives the
cleanest possible signal:

1. **`getDisplayMedia` path** â€” the three flags are set directly on the `audio`
   constraint. They are plain optional hints for display-capture, so the browser
   applies them where the platform supports them and ignores them otherwise.
2. **Desktop-source `getUserMedia` fallback** (`chromeMediaSource: 'desktop'`) â€” the
   three flags MUST live in the legacy `optional` constraints array, NOT `mandatory`.
   Chromium throws `OverconstrainedError` for `echoCancellation: true` inside
   `mandatory` on a desktop source (desktop loopback does not implement the
   processing), so `mandatory` keeps only `chromeMediaSource` / `chromeMediaSourceId`
   and the processing requests are optional. This preserves capture while applying
   processing where supported.

## Deepgram filler-word bypass

`buildDeepgramStreamUrl` in `audio-pipeline.js` appends **`filler_words=false`**.
Deepgram then drops hesitations ("um", "uh", "you know") from the transcript, so
they never appear in the question buffer and never artificially extend the engine's
pause-watchdog / boundary timers (a filled pause must not delay the answer).

## Testability

One new audio-pipeline test asserts the Deepgram URL contains `filler_words=false`
(and never `filler_words=true`). Full suite: 76 engine + 24 diagnostic + 9
audio-pipeline, 0 failed.

---

# 7G. IMPLEMENTED â€” PHASE 9 UI/PRODUCT POLISH (PREMIUM TELEPROMPTER)

## Teleprompter styling (`#answer-box`)

The answer surface is now a premium, distraction-free teleprompter card:

* `background: rgba(15, 23, 42, 0.95)` â€” deep slate
* `color: #F8FAFC`, `font-size: 18px`, `line-height: 1.6` â€” large, readable
* `padding: 20px`, `border-radius: 12px`, `box-shadow: 0 4px 20px rgba(0,0,0,0.5)`
* `border: 1px solid rgba(255,255,255,0.1)`, `backdrop-filter: blur(10px)`
* `overflow-y: auto` + `scroll-behavior: smooth`, thin scrollbar, `box-sizing: border-box`

## Hands-free bottom-pinning

`renderAnswer()` (invoked on every `engine.onAnswer` payload â€” opener flash,
streaming chunk, and final answer) smooth-scrolls the newest text to the bottom
viewable band:

```js
if (typeof answerBox.scrollTo === 'function') {
  answerBox.scrollTo({ top: answerBox.scrollHeight, behavior: 'smooth' });
} else {
  answerBox.scrollTop = answerBox.scrollHeight;
}
```

This preserves the project's core teleprompter paradigm (see `info.md`): a hands-free
reading surface where the newest answer is always visible without manual scrolling.

## Confidence border interplay

The Green/Yellow/Red confidence indicator is painted with an inline
`borderLeft` (`4px solid`), which overrides the teleprompter's 1px white border on
the left side only â€” the other three edges keep the subtle border.

---

# 8. CRITICAL CHANGE â€” PARALLEL EXECUTION

The system must NOT use a serial architecture such as:

Question
â†“
RAG
â†“
Wait
â†“
LLM
â†“
Answer

Instead:

Question Snapshot
â†“
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                              â”‚
â”œâ†’ Exact prepared-answer search
â”‚
â”œâ†’ Scenario retrieval
â”‚
â”œâ†’ Candidate/project retrieval
â”‚
â”œâ†’ General Boomi retrieval
â”‚
â”œâ†’ Conversation-context analysis
â”‚
â””â†’ General LLM/API request

```

All useful paths should start as early as practical.

The slowest source must not block faster sources from producing an initial answer.

---

# 9. RESPONSE CANDIDATE TYPES

Every question can produce one or more candidate response sources.

## Candidate A â€” Exact Prepared Answer

Example:

Question:
"What is an Atom Queue?"

Knowledge contains an exact prepared response.

This should be the fastest possible path.

---

## Candidate B â€” Related Scenario

Example:

Question:
"How would you use an Atom Queue in your project?"

There is no exact answer, but a related scenario exists.

Use the scenario and adapt it.

---

## Candidate C â€” RAG Knowledge

Question:
"Explain Atom Queue architecture."

General Boomi knowledge is retrieved.

Use it to prepare the answer.

---

## Candidate D â€” External/LLM Knowledge

Question:
"Have you worked with X?"

No relevant local knowledge exists.

The API/model answers from general knowledge.

The model must NOT invent candidate experience.

---

# 10. UNKNOWN KNOWLEDGE FALLBACK

If the question is not found in the local knowledge base:

DO NOT WAIT for RAG.

Immediately continue with the general API/model path.

Example:

Interviewer:
"Have you worked with Atom Queue?"

Local RAG:
NO MATCH

Simultaneously:

General API:
QUESTION RECEIVED

Possible behavior:

Immediately display a safe preliminary state:

"Understanding Atom Queue..."

Then when the API returns:

"I haven't worked with Atom Queue directly, but my understanding is..."

This allows the application to remain useful even when the knowledge base has no exact answer.

---

# 11. RESPONSE MERGER

When multiple candidate sources return, use a merge/ranking layer.

Ranking factors:

- exactness of question match
- candidate-specific relevance
- project relevance
- job description relevance
- interview stage relevance
- conversation relevance
- technical confidence
- source reliability
- freshness of transcript

Preferred rule:

**Candidate truth > prepared scenario > trusted knowledge > general model knowledge.**

Do not combine conflicting facts blindly.

If the candidate-specific source conflicts with general knowledge, candidate truth should be preserved for personal experience questions.

---

# 12. EARLY ANSWER + FINAL ANSWER MODEL

The UI can support two levels:

## Preliminary Answer

Can appear early when a reliable source is already available.

This should be short and safe.

## Final Answer

Replaces/refines the preliminary response when:

- question becomes complete
- stronger source arrives
- API/model returns
- additional transcript provides clarification

The user should never see an obviously wrong preliminary answer simply to appear fast.

---

# 13. EXAMPLE â€” ATOM QUEUE NOT IN RAG

Interviewer:

"Have you worked with Atom Queue?"

### Immediately:

Question classifier:
Potential topic = Atom Queue
Question type = Experience / Technical

### Parallel execution:

PATH 1:
Local prepared knowledge search

PATH 2:
Boomi general knowledge retrieval

PATH 3:
Conversation context

PATH 4:
Job Description relevance

PATH 5:
General API/model

### If local knowledge returns:

Show a safe prepared explanation if sufficiently strong.

### Meanwhile:

API generates a stronger natural answer.

### When API returns:

Merge/refine.

If the model discovers the question is asking about candidate experience rather than general definition, it must adapt to:

"I haven't worked with that directly, but my understanding is..."

instead of falsely claiming experience.

---

# 14. SECOND EXAMPLE â€” EXACT MATCH

Interviewer:

"Tell me about yourself."

The system should NOT call a powerful model from zero.

Use the pre-prepared introduction.

Expected behavior:

- retrieve exact introduction immediately;
- display it;
- optionally allow a model to improve phrasing if necessary;
- preserve candidate truth.

This is the highest-speed scenario.

---

# 15. THIRD EXAMPLE â€” PROJECT QUESTION

Interviewer:

"Can you explain your SFTP integration?"

Retrieval should immediately prioritize:

1. current project
2. SFTP section
3. candidate responsibilities
4. relevant master scenario
5. previous discussion

General knowledge should still be available in parallel as backup.

---

# 16. FOURTH EXAMPLE â€” UNKNOWN TECHNICAL QUESTION

Interviewer:

"Have you worked with Kafka?"

Suppose the candidate has no Kafka experience.

The system should NOT fabricate.

Use:

"I haven't worked with Kafka directly, but my understanding is..."

Then give a technically credible explanation.

This is an intentional confidence-building behavior.

---

# 17. FIFTH EXAMPLE â€” RELATED QUESTION

Question:

"How did you handle SFTP failures?"

No exact match.

But retrieval finds:

- SFTP project
- error handling scenario
- production failure scenario

The system should combine those relevant sources.

This is a **related scenario match**, not an exact match.

---

# 18. SIXTH EXAMPLE â€” COMPLETELY UNRELATED QUESTION

Question:

"What is the CAP theorem?"

Nothing useful is in Boomi-specific knowledge.

The application must not fail.

Use:

General API/model path.

The final answer should be technically correct and should not pretend it is related to the candidate's project.

This is the final fallback.

---

# 19. INTERVIEWER-ONLY AUDIO MODEL

The current core system captures and analyzes the interviewer's speech.

**Phase 10 (Candidate Response Analysis) is now LIVE** on top of the core path: `Alt+V` opens a second physical-microphone capture (`startCandidateAudio()` in `audio-pipeline.js`) that streams the candidate's own speech into a dedicated Deepgram WebSocket and accumulates it into `engine.candidateTranscript` (gated by the `candidateAnalysisEnabled` master lock). `Alt+A` (Analyze) then runs `engine.analyzeCandidateResponse()` — a Groq grader comparing the candidate's spoken answer against the last suggested answer (`conversationHistory`'s last assistant message, "N/A" fallback) through the `apiCall` hook (defaults to `answerCall`). It returns a strict `{"accuracy": "X/10", "feedback": "..."}` JSON (markdown fences stripped, transcript buffer always cleared after an attempt, `null` on no-transcript/API/parse failure) which `index.html` renders in the `#scorecard-box` under the teleprompter for 8 seconds.

Candidate-microphone analysis can be extended for:

- fluency
- confidence
- speaking speed
- pause analysis
- answer evaluation

beyond the current accuracy + feedback scorecard.

The current system's job is:

**listen to interviewer â†’ understand question â†’ prepare candidate response.**

---

# 20. CONCURRENT QUESTION HANDLING

The interviewer may begin the next question before the previous answer is fully finalized.

The application must support concurrent turns.

Each question receives:

- turn ID
- transcript snapshot
- question state
- answer request ID
- retrieval request IDs

Example:

Turn 101:
Question A

Turn 102:
Question B

If Turn 101 finishes after Turn 102:

Turn 101 must NOT overwrite Turn 102.

The newest valid turn always owns the visible answer area.

---

# 21. QUESTION SNAPSHOT

When the system detects a meaningful boundary:

freeze a question snapshot containing:

- transcript
- latest stable interpretation
- stage
- context
- timestamp
- turn ID
- candidate rankings

All retrieval/API requests for that question use that snapshot.

This prevents later transcript changes from corrupting an in-flight request.

---

# 22. NEXT QUESTION PREFETCHING

While the answer to Question A is being finalized:

if new speech arrives:

create Question B immediately.

Do not wait for Question A to finish completely.

Question B can begin:

- transcript processing
- classification
- retrieval
- context loading

while Question A is still finishing.

This creates a pipeline rather than a queue.

---

# 23. ANSWER GENERATION TARGET

The system should operate under:

**PREPARE EARLY**
+
**RETRIEVE EARLY**
+
**PARALLELIZE**
+
**FINALIZE FAST**

Do not measure only "API response time."

Measure:

- time to first transcript
- time to question candidate
- time to first retrieval result
- time to answer preparation
- time to preliminary answer
- time to final answer

---

# 24. REALISTIC LATENCY EXPECTATIONS

The system should not assume that all paths take the same time.

Typical logical target:

## Exact local answer

Potentially:
**tens to hundreds of milliseconds**

This is primarily retrieval/rendering dependent.

## Related scenario

Potentially:
**sub-second to around 1 second**

depending on retrieval and formatting.

## Local RAG + fast model

Potentially:
**around 1â€“2+ seconds**

depending on model/API latency and prompt size.

## Unknown question through external model

Potentially:
**1â€“3+ seconds**

depending on provider/network/model.

These are engineering targets, not guarantees.

The system should therefore display the earliest trustworthy result and refine it as better information arrives.

---

# 25. IMPORTANT â€” 1-SECOND TARGET

The target is NOT:

"Every final answer must always be generated in exactly 1 second."

The practical target is:

**By roughly the 1-second post-question-boundary point, the system should already have:**

- identified the likely question
- selected a strong answer direction
- retrieved relevant knowledge where available
- started/continued final answer generation

For prepared/common questions, the final answer should often be immediately available or very close.

For unknown questions, the system must prioritize correctness over a fake 1-second deadline.

---

# 26. ANSWER READINESS LEVELS

## Level 1 â€” Exact Prepared Answer

Highest speed and confidence.

## Level 2 â€” Related Scenario

Adapt an existing scenario.

## Level 3 â€” Local Knowledge/RAG

Retrieve relevant content and generate.

## Level 4 â€” General API/LLM

Use external/general model knowledge.

## Level 5 â€” Safe Unknown Response

When candidate experience is unavailable or unclear, answer truthfully without fabrication.

---

# 27. CANDIDATE QUESTION PRIORITIES

Maintain up to three possible interpretations.

Example:

Priority 1 â€” High:
High-volume Boomi processing

Priority 2 â€” Medium:
Performance optimization

Priority 3 â€” Low:
High-throughput architecture

Do not claim exact mathematical probability.

Use these candidates for retrieval and answer preparation.

---

# 28. HINT

The hint is secondary.

Example:

ANSWER:
"I would use batching and controlled parallel processing..."

HINT:
Batching â†’ Parallelism â†’ Error isolation â†’ Retry

Hint should reflect the selected answer.

It must never replace the answer.

---

# 29. CONVERSATION MEMORY

Maintain recent context:

- turn ID
- question
- type
- selected topic
- answer
- stage
- important entities

Follow-up questions must reference recent context.

---

# 30. INTERVIEW FLOW

The system should support this progression:

Introduction
â†’ Resume / Experience
â†’ Project Overview
â†’ Project Deep Dive
â†’ Connector / Technology Deep Dive
â†’ Additional / Unlisted Technology
â†’ Production Problems
â†’ Real-Time Scenarios
â†’ Follow-Up / Cross-Questioning

Each stage changes retrieval priority.

---

# 31. JOB DESCRIPTION PRIORITY

The JD must be considered before and during the interview.

Before interview:
build topic priority map.

During interview:
use it to influence ranking.

Example:

JD contains:
Boomi + SFTP + REST + API Management + SQL

Then those concepts receive higher retrieval priority.

The system should NOT force irrelevant JD content into an answer.

It only increases relevance when appropriate.

---

# 32. MASTER SCENARIO BANK

Initial target:

~100 master scenarios.

Suggested:

20 Project / Experience
20 Boomi Core
20 Connector / Integration
20 Production / Troubleshooting
20 Scenario / Architecture

Each scenario should support:
- question variants
- expected concepts
- answer
- hint
- candidate truth
- follow-ups
- failure variants
- related topics

---

# 33. KNOWLEDGE STRUCTURE

Recommended:

knowledge/
â”œâ”€â”€ candidate/
â”‚   â”œâ”€â”€ resume.md
â”‚   â””â”€â”€ experience.md
â”‚
â”œâ”€â”€ job/
â”‚   â””â”€â”€ job-description.md
â”‚
â”œâ”€â”€ projects/
â”‚   â”œâ”€â”€ project-1.md
â”‚   â””â”€â”€ project-2.md
â”‚
â”œâ”€â”€ boomi/
â”‚   â”œâ”€â”€ core/
â”‚   â”œâ”€â”€ connectors/
â”‚   â”œâ”€â”€ performance/
â”‚   â”œâ”€â”€ security/
â”‚   â”œâ”€â”€ error-handling/
â”‚   â””â”€â”€ production/
â”‚
â”œâ”€â”€ scenarios/
â”‚   â”œâ”€â”€ project/
â”‚   â”œâ”€â”€ technical/
â”‚   â”œâ”€â”€ production/
â”‚   â””â”€â”€ architecture/
â”‚
â””â”€â”€ prepared/
    â”œâ”€â”€ introduction.md
    â”œâ”€â”€ project-overview.md
    â””â”€â”€ common-answers.md

Future:

knowledge/devops/
```

---

# 34. RETRIEVAL STRATEGY

Initially use lightweight local retrieval.

Possible ranking inputs:

* exact phrase match
* key concepts
* topic
* stage
* JD relevance
* current project
* conversation context
* scenario similarity

Do not introduce a heavy vector database until the lightweight strategy is measured.

Embeddings/vector search can be added later.

---

# 35. MODEL STRATEGY

The model provider must remain replaceable.

Fast model:

* prediction
* classification
* candidate ranking
* lightweight refinement

Strong model:

* difficult scenarios
* ambiguous questions
* final refinement when necessary

The knowledge layer must remain independent from the provider.

---

# 36. EXTERNAL CONTENT

Public interview questions and educational resources may be used to build the knowledge bank.

Use them to identify:

* question patterns
* follow-ups
* scenarios
* technical areas

Normalize and store useful knowledge locally.

Do not depend on live websites/videos during the interview.

---

# 37. CANDIDATE TRUTH RULE

Never invent candidate experience.

If candidate information says no direct experience:

Use a truthful formulation.

Example:

"I haven't worked with that directly, but my understanding is..."

General technical knowledge may be supplied by the model.

---

# 38. ANSWER STYLE

The answer should be:

* natural
* conversational
* confident
* concise
* technically credible
* easy to speak aloud
* candidate-specific when facts exist

Avoid:

* textbook language
* generic AI introductions
* unnecessary bullet lists
* filler phrases
* fabricated experience

---

# 39. CURRENT DEVELOPMENT PRIORITY

The 3-Pillar Real-Time Interview Architecture (Domain Vocabulary â†’ keyterm-boosted
STT â†’ Linguistic Locking + Speculative Drafting) is DONE and validated by the
deterministic suite (88 engine + 24 diagnostic + 9 audio-pipeline tests, 0 failed).

The immediate development order is now:

1. ~~Stabilize question/turn segmentation~~ â†’ DONE (3.5/3.6 engines).
2. ~~Linguistic Locking + Speculative Drafting~~ â†’ DONE (Pillar 3).
3. ~~Phase 4 â€” ATS & Resume Grounding~~ â†’ DONE: live file-based grounding from `knowledge/resume.md` + `knowledge/job-description.md` (see Â§7B). `loadCandidateContext()` injects CANDIDATE TRUTH & TARGET JD into every answer prompt with the no-fabrication STRICT RULE.
4. ~~Phase 4.5 â€” Output Modularity~~ â†’ DONE (`Alt+M` â†’ `engine.toggleOutputMode()` â†’ mode-aware FORMAT RULE in `buildAnswerPrompt`; SCRIPT/ARCHITECT status-bar badge).
5. ~~Phase 4.6 â€” Stealth UI & Screen-Share Protection~~ â†’ DONE: `setContentProtection(true)` strips the overlay from Zoom/Teams/Meet/OBS capture; `setAlwaysOnTop('screen-saver', 1)` + `setVisibleOnAllWorkspaces`; `Alt+P` Panic Mode toggles opacity 0%/100% while audio keeps running.
6. ~~Phase 5 â€” Latency Masker & Instant Opener~~ â†’ DONE: type-matched `SAFE_OPENERS` flashed at 0ms and prepended to the Groq stream/final; `buildAnswerPrompt` CRITICAL RULE forbids LLM double-pleasantries.
7. ~~Phase 6 â€” Extended Conversation Memory & Confidence Scoring~~ â†’ DONE: rolling 4-turn / 8-message `conversationHistory` injected into the Groq messages before the current user prompt; Green/Yellow/Red boundary-confidence indicator passed through `onAnswer` and painted on the `#answer-box` left border (see Â§7D).
8. ~~Phase 7 â€” Lightweight Scenario Interceptor (Local Fast-Path)~~ â†’ DONE: `knowledge/scenarios.json` Master Scenario Bank + `_searchLocalScenarios()` all-keyword match intercepts BOTH `_runFinalAnswer` and the speculative draft â€” sub-10ms local answers with zero Groq calls, `confidence: 'green'` (see Â§7E).
9. ~~Phase 8 â€” Audio Noise Gating & VAD Polish~~ â†’ DONE: native WebRTC `echoCancellation`/`noiseSuppression`/`autoGainControl` on the captured system-audio track (direct on `getDisplayMedia`, `optional` array on the desktop-source `getUserMedia` fallback) + Deepgram `filler_words=false` bypass so hesitations never extend the pause timers.
10. ~~Phase 9 â€” UI/Product Polish (Premium Teleprompter)~~ â†’ DONE: `#answer-box` is a distraction-free deep-slate teleprompter card with `scroll-behavior: smooth` + `scrollTo({ behavior: 'smooth' })` bottom-pinning in `renderAnswer()` (see Â§7G). **Core MVP is 100% finished.**
11. ~~Phase 10 â€” Candidate Response Analysis~~ â†’ DONE: Part 1 (`Alt+V` physical-mic capture â†’ dedicated Deepgram socket â†’ `engine.candidateTranscript`, gated by the `candidateAnalysisEnabled` lock) + Part 2 (`Alt+A` â†’ `engine.analyzeCandidateResponse()` Groq grader vs the last suggested answer â†’ `#scorecard-box` Score + feedback for 8s). See Â§19.
12. ~~Phase 11 â€” App Packaging (Electron Builder)~~ â†’ DONE: `electron-builder` (`^26.15.3`) dev dependency + `"build": "electron-builder --win --x64"` script + root `"build"` config (`appId: com.boomiboss.interviewengine`, `productName: "Boomi Boss Engine"`, Windows `nsis` target, output `dist/`). `npm run build` produces the installable .exe. **Project READY FOR PRODUCTION.**
13. ~~Phase 12 â€” Multi-Tier Model Split / Fuzzy RAG / Gemini Failover~~ â†’ DONE: `DEFAULT_CFG.routerMode` (hybrid/rag-only/agent-only) + `fastModel` `llama-3.1-8b-instant`; `_searchLocalScenarios` disabled in agent-only and fuzzy-matching at >= 75% keyword overlap; rag-only never calls an external API (safe fallback on miss); `callWithFallback` in index.html wraps every LLM path with a 500ms TTFT AbortController and automatic Gemini 2.5 Flash failover on 429/timeout.
14. ~~Update 1 â€” Stealth Pro UI/UX Overhaul~~ â†’ DONE: status-bar decluttered, SPEAK/THINK badge, glassmorphism `#answer-box`, floating toast scorecard, slide-out shortcuts/settings drawers (opacity + font-size sliders, 8s inactivity auto-close), freeform resize handles, `Alt+H`/`Alt+O` shortcuts, `set-opacity` IPC. Deepgram/Groq/Gemini untouched.
15. Build introduction and project answers.
16. Build the first 100 master scenarios.
17. Implement lightweight local retrieval.
18. Connect retrieval to answer generation.
19. Benchmark model providers.
20. Optimize latency.
21. Run real mock interviews.
22. Add DevOps knowledge later.
23. UI polish (beyond the Phase 9 teleprompter) last.

---

# 40. CURRENT NON-PRIORITIES

Do not prioritize:

* visual redesign
* animation
* advanced settings
* installer customization
* complex vector infrastructure
* DevOps knowledge

until the core answer engine is reliable.

---

# 41. SUCCESS DEFINITION

The system is successful when the interviewer can naturally move through:

Introduction
â†’ Resume
â†’ Project
â†’ Project Deep Dive
â†’ Technologies
â†’ Connectors
â†’ Problems
â†’ Scenarios
â†’ Follow-Ups

and the application can:

* detect the stage
* understand the question while it is being spoken
* generate candidate interpretations
* search prepared/local knowledge
* call the general API in parallel
* use whichever reliable response becomes available first
* refine an early response with a stronger response
* preserve candidate truth
* understand follow-ups
* start processing the next question immediately
* prevent stale answers from overwriting new ones
* provide a natural answer
* provide an optional hint
* handle unknown questions gracefully
* remain fast

---

# 42. FINAL DESIGN PRINCIPLE

The core engine follows:

**LISTEN EARLY**

â†“

**UNDERSTAND EARLY**

â†“

**RETRIEVE IN PARALLEL**

â†“

**CALL GENERAL AI IN PARALLEL**

â†“

**PREPARE ANSWER BEFORE QUESTION ENDS**

â†“

**USE THE BEST AVAILABLE TRUSTWORTHY RESPONSE**

â†“

**REFINE WHEN STRONGER INFORMATION ARRIVES**

â†“

**FINALIZE QUICKLY**

â†“

**IMMEDIATELY START PROCESSING THE NEXT QUESTION**

The ultimate goal is:

> A realistic, confidence-building mock interview experience where the application understands the interviewer in real time and gives the candidate a natural, relevant answer with the smallest practical delay.
