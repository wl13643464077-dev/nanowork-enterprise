---
name: commercial-self-intro
description: Generate commercial-grade self-introductions and personal-brand display packages from a short background plus intended use. Use when the user asks for 自我介绍, 商务介绍, 个人介绍, 个人品牌, IP定位, 抖音/视频号/小红书/公众号/LinkedIn简介, 私域欢迎语, 商务社交或 elevator pitch, 嘉宾/讲师/主持人介绍, 个人名片/长图/PPT展示, or wants one background adapted across channels. Do not use for a full resume or biography unless an introduction package is also requested.
---

# Commercial Self Intro

Turn a short personal background plus intended use into a credible, speakable, scenario-native commercial introduction. Apply the complete 64-technique system distilled from Yokogawa Hiroyuki's book rather than reducing it to one formula.

## Load References By Task

Always read:

1. `references/book-technique-index.md` to see all 64 techniques and select applicable IDs.
2. `references/commercial-intro-framework.md` for the dual LOOP engine and commercial judgment.
3. `references/output-contract.md` before final delivery.

For a new introduction or repositioning, also read:

- `references/book-foundation-discovery.md`
- `references/book-writing-structures.md`
- the requested section of `references/scenario-playbooks.md`
- `references/book-practice-iteration.md`

For oral, video, meeting, interview, hosting, teaching, livestream, or speech use, also read `references/book-delivery-interaction.md`.

When the user offers more input, or after delivering a first draft with `D - missing` gaps, read `references/intake-questionnaire.md` and output a prioritized evidence-gap list with concrete collection actions. When the user asks to build an AI persona, digital twin, "AI我", or a reusable long-term introduction asset base for a person, read `references/persona-spec-template.md` and produce a layered persona spec; if a persona spec already exists for the subject, load it first and inherit its L3 evidence ledger instead of rebuilding the Truth Ledger. When the user asks for JSON, machine-readable output, form/web/auto-render integration, or queryable iteration records, read `references/structured-output-spec.md`. When upgrading this skill or changing output structure, run `scripts/validate_golden_samples.py` against `references/golden-samples/` and keep the samples in sync (see `references/golden-samples/README.md`).

For revision after real-world feedback, read `references/book-practice-iteration.md`, then the content or delivery module implicated by that feedback. Read `references/source-record.md` when the user requests provenance, current platform rules, or methodology. For claims involving `最新` or mutable platform limits, verify official sources live. Run `scripts/search_self_intro_book.py` when exact PDF passages or additional page grounding are needed; do not reproduce the book at length. If the external PDF is unavailable, continue with the complete 64-technique reference library instead of blocking the task.

## Minimum Input

Accept as little as:

- `简介`: a rough description of the person, work, experiences, strengths, products, or results.
- `用途`: platform, occasion, audience, or intended use.

Treat audience, intended action, evidence, tone, privacy limits, and prohibited claims as optional accelerators. If information is sparse, infer conservatively, label assumptions, produce a useful first version, and ask only the highest-value follow-up questions after the draft. Ask before drafting only when different interpretations create material legal, medical, financial, identity, or reputational risk.

## Workflow

### 1. Build The Truth Ledger

Classify each usable statement:

- `A - verified`: supported by a source, public record, artifact, or explicit evidence.
- `B - user-stated`: supplied by the user but not independently verified.
- `C - aspiration`: desired positioning, projected outcome, or unverified superlative.
- `D - missing`: a fact that would materially improve relevance or credibility.

Use A directly with scope. Phrase B precisely and mark it for confirmation when public-facing. Convert C into a goal, current action, pilot, or cautious formulation. Never invent D.

### 2. Diagnose Foundation And Self-Image

Use relevant `F` techniques to identify:

- the one value label the audience should remember;
- hidden value in ordinary work, including before/after evidence;
- the primary role this person can honestly sustain;
- useful earth-talent, heaven-talent, or ideal-self material;
- old self-definitions that make the proposed wording feel false or impossible to maintain.

The introduction must be commercially sharp and internally believable. Use ideal-self rehearsal as a commitment to real behavior, never as permission to fake identity, clients, outcomes, or status.

### 3. Define Purpose And One Listener

Apply `D01-D04`, `D09-D13` as relevant:

- name one representative listener;
- identify the scene, attention state, surface need, hidden motive, and language they use;
- define one observable ideal reaction;
- choose one core message and explicitly exclude distracting identities.

Do not write for everyone. Do not confuse “good impression” with an observable action.

### 4. Create A Technique Selection Card

Before drafting, select `8-15` technique IDs; use up to `20` for deep packages. Meet these minimums:

- at least `1 F` technique;
- at least `3 D` techniques, including purpose/audience, structure, and proof or language;
- at least `1 E` technique for any spoken or interactive use;
- at least `2 L` techniques, including real use and feedback/iteration.

For every selected ID, record: `ID | PDF page | why it fits | how it changes the output`. Do not select decorative methods. `D16`, `D23`, and `E11` are optional author metaphors or creative/somatic prompts, not scientific claims.

### 5. Run The Content LOOP

- `L - Listener`: who is listening, in what state, using what language, and what should they do next?
- `O - Outcome`: what specific, observable future can this person help create?
- `O - Ownable Proof`: what smallest relevant result, case, mechanism, credential, work sample, or experience makes the promise credible?
- `P - Prompt Next Step`: what single low-friction action fits this relationship stage?

Choose one of the book structures instead of forcing every situation into the same script:

- one sentence: benefit `A -> B` or concrete vision;
- 18 seconds: `future -> proof -> action`;
- one minute: `dream -> origin -> current action -> others' future`;
- no proof yet: honest pilot invitation with clear boundaries;
- networking: listen first, then one-point introduction and a return question.

### 6. Generate Scenario-Native Assets

Use the relevant playbook and adapt vocabulary, proof density, rhythm, CTA, and content hierarchy. Do not merely trim one master paragraph.

Default to one recommended version plus two genuinely different alternatives. For any version labeled 15, 18, 30, or 60 seconds, run `scripts/check_intro_length.py --target <seconds> "<copy>"`, revise into the target band, and still recommend a real recording.

For spoken work, add delivery cues from the selected `E` techniques: atmosphere, posture, listener focus, pauses, objection checks, and one recovery question. For a visual card, long image, one-page slide, or profile display, create the actual artifact when the user asks for it and tools are available; use real person/work/product/case evidence rather than decorative filler.

### 7. Rehearse And Launch

Apply `L01-L03` before calling a version finished:

1. read it aloud once;
2. record it once and check timing, breath, jargon, and unnatural claims;
3. use it in one real or realistic target scene;
4. give the version a stable ID such as `DY-15-V1` or `BIZ-30-V2`.

### 8. Run The Growth LOOP

- `L - Launch`: use the version in a defined real scene.
- `O - Observe`: capture exact questions, objections, audience restatement, behavior, and one primary metric.
- `O - Optimize`: change one variable only, such as opening, outcome, proof, label, or CTA.
- `P - Preserve`: keep the winning version, evidence, feedback, and applicable technique IDs as reusable assets.

Use `L04-L12` to report, contact, discuss, request concrete feedback, recover from cold responses, align online footprints, and attract better-fit relationships. Do not call subjective liking “validation.”

### 9. Apply Evidence, Compliance, And Privacy Boundaries

- Lead with audience value, but keep every promise within the person's contribution and evidence.
- Never invent client names, titles, partnerships, numbers, awards, media, medical effects, financial returns, or outcomes.
- Use institutional names and logos only with accurate relationship wording and permission where required.
- Avoid `国家级`, `最高级`, `最佳`, `第一`, `唯一`, `顶级`, or guaranteed results without current, applicable proof and compliance review.
- Cite data, rankings, studies, and measured results with source, scope, and date.
- Protect phone numbers, addresses, client-confidential facts, health details, and sensitive personal history.
- Keep uncertainty explicit. A decisive delivery style never turns uncertainty into fact.

### 10. Score, Rewrite, And Deliver

Use `references/output-contract.md`. Rewrite up to three times until the draft scores at least `85/100` and passes all technique/evidence gates. If proof is the blocker, deliver the strongest honest version and the three highest-value evidence items to collect.

## Voice

- Write in Chinese unless asked otherwise.
- Lead with the positioning judgment.
- Use short, speakable, concrete language and the audience's own vocabulary.
- Balance conviction with evidence boundaries.
- Avoid jargon, title walls, inflated adjectives, empty motivation, template stiffness, and self-deprecating openings.

## Success Test

The intended audience should be able to answer: `What future can this person help me reach? Why should I believe it? What should I do next?` The person introducing themselves should also be able to say the words naturally, support them with real behavior, and improve the version from observed feedback.
