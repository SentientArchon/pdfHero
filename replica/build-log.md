# Build log

| ID | date | status | missing | harder than expected |
| --- | --- | --- | --- | --- |
| S01 Home | 2026-11-03 | done | — | — |
| S02 Tool page (31 tools) | 2026-11-03 | done, 5 tools partial | see features.csv notes: PDF→PPT is image slides, PDF→Excel table detection is basic, Edit can't change existing text, Forms can't create fields, PDF→JPG has no image-extract mode | editor focus was lost on re-render; markdown headings needed char-weighted body size; sticky header covering the stage in tests |

Tests: `npm test` runs 50 end-to-end checks in headless Chrome (all tools, error states, no outside network requests). All passing on 2026-11-03.
Skipped from the replica pipeline: replica-diff screenshots of the original (no reference shots taken), entrepreneur/brand/launch/deploy (personal local tool, not for sale).
| S02 Edit PDF: edit existing text | 2026-11-03 | done | text in rotated pages/rotated runs isn't editable; old text is covered, not removed; replacement uses the closest standard font | pdf.js hides font names unless `fontExtraProperties` is on; trailing-space widths left slivers of the old glyphs |
| S02 Edit PDF: original fonts | 2026-11-03 | done | .ttc collections on macOS are skipped (pdf-lib embeds single fonts only) | pdf-lib names subsets "Name-1234", not "ABCDEF+Name"; embedded subsets often lack letters, so coverage is checked per edit |
| Static rebuild (GitHub Pages) | 2026-11-03 | done | Office/HTML to PDF and PDF to Word/Excel are lower fidelity than the old LibreOffice/pdf2docx path; no URL mode for HTML to PDF | qpdf WASM writes errors to the console, not printErr; PowerPoint placeholders inherit positions from layout *and* master; site must use relative paths for /pdfHero/ |
