# Build log

| ID | date | status | missing | harder than expected |
| --- | --- | --- | --- | --- |
| S01 Home | 2026-11-03 | done | — | — |
| S02 Tool page (31 tools) | 2026-11-03 | done, 5 tools partial | see features.csv notes: PDF→PPT is image slides, PDF→Excel table detection is basic, Edit can't change existing text, Forms can't create fields, PDF→JPG has no image-extract mode | editor focus was lost on re-render; markdown headings needed char-weighted body size; sticky header covering the stage in tests |

Tests: `npm test` runs 40 end-to-end checks in headless Chrome (all tools, error states, no outside network requests). All passing on 2026-11-03.
Skipped from the replica pipeline: replica-diff screenshots of the original (no reference shots taken), entrepreneur/brand/launch/deploy (personal local tool, not for sale).
