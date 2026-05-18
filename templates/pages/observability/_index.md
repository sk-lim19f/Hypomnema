---
title: Observability Index
type: reference
updated: YYYY-MM-DD
tags: [observability, autonomy, wiki-health]
---

# Observability

> Tracks how often and how well the wiki is used per session. Score = proxy for autonomous wiki engagement (not ground truth).

---

## 1. Data flow

```
Stop hook (hypo-session-record.mjs)
    │  appends one JSONL entry per session
    ▼
.cache/sessions/index.jsonl
    │
    ▼
scripts/session-audit.mjs   ← per-session metrics + classification
    │
    ▼
scripts/weekly-report.mjs   ← weekly autonomy score
    │
    ▼
journal/weekly/<YYYY-Www>.md   (spec §6.4 SoT)
```

---

## 2. Session classification

| Class | Rule |
|---|---|
| `staleness-skip` | `recorded_at` older than `--max-age-days` (default 30) |
| `ingest-missed` | `urls >= 2` and `ingest_count == 0` |
| `search-many` | `search_count >= 5` |
| `search-0` | `search_count == 0` |
| `normal` | otherwise |

Counted tools: `Grep`, `WebSearch`, `WebFetch`. Counted commands: `/hypo:query`, `/hypo:ingest`, `/hypo:feedback`.

---

## 3. Autonomy score formula (heuristic v0)

Score is clamped to `[0, 100]`. `staleness-skip` sessions are excluded.

```
numerator   = Σ min(search_count, 3) + ingest_count × 3 + feedback_count × 2
denominator = Σ 1 + (urls > 0 ? min(urls, 5) × 2 : 0)
score       = clamp(round(numerator / denominator × 100), 0, 100)
```

- Each real session contributes 1 to denominator (baseline expectation).
- URLs raise the bar: each external URL is a missed-ingest opportunity (weight 2, capped at 5).
- Ingest (weight 3) and feedback (weight 2) are the strongest positive signals.
- Search (weight 1, capped at 3) is a weaker signal.

---

## 4. Four-week baseline plan

Capture v0 scores for 4 weeks before introducing LLM-judge classification or changing formula weights. Goal: establish a baseline before tuning.

| Week | Score | Notes |
|---|---|---|
| <!-- YYYY-Www --> | <!-- % --> | <!-- first run --> |

---

## 5. Privacy

Weekly reports emit only `session_id` plus aggregate counts — no transcript content, no URLs, no tool inputs. Transcripts live under `~/.claude/projects/` or `.cache/sessions/`, excluded by `.hypoignore`.
