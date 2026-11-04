# Recon: online PDF toolbox (personal, private clone)

Scope: every tool on the original's public home page, rebuilt to run **only on this
machine**. Who it is for: the owner, personal use. Platform: web, served from 127.0.0.1.

## Sources
| source | url |
| --- | --- |
| public home page tool list | https://www.ilovepdf.com/ |

No account used, no source code or network calls inspected. Behaviour is rebuilt from the
public tool list and general knowledge of what each tool does.

## Screens
| ID | screen | route | purpose | components | states |
| --- | --- | --- | --- | --- | --- |
| S01 | Home | `#/` | grid of all tools, grouped by category, filter | tool card, category tabs, search | filled, filtered-empty |
| S02 | Tool page | `#/<tool>` | pick files → options → process → download | drop zone, file list / page thumbnails, options panel, primary button | empty, files added, processing, done, error, tool unavailable (missing local dependency) |

Every tool is an instance of S02 with its own options panel. Interactive tools (organize,
edit, sign, redact, crop, forms, compare) replace the file list with a page canvas.

## Flows
```
F01 Process a file:  S01 tool card -> S02 drop files -> set options -> Run -> download   (4 clicks)
F02 Organize pages:  S02 drop -> drag thumbnails / rotate / delete -> Run -> download
F03 Place things on a page (sign, edit, redact, crop): S02 drop -> pick tool -> click/drag on page -> Run
```
Edge: encrypted input, corrupt input, huge file, wrong file type, missing local converter.

## Components
Button (primary/secondary/ghost), drop zone, file chip list (reorder), page thumbnail grid,
page canvas with overlay items, segmented control, number/text inputs, toast/error banner.

## Data model
None persisted. Files live in memory (browser) or in a per-request temp dir (server) that is
deleted when the response is sent. No accounts, no history, no telemetry.

## Cannot / will not clone
- AI Summarizer and Translate: need a cloud AI model, which defeats the point (files leave the
  machine). Skipped. Could be added later with a local model (e.g. Ollama).
- Cloud storage pickers (Drive/Dropbox), accounts, premium tiers, desktop/mobile apps: not needed.

## Size
2 screens, 3 flows, 30 tools. Hard parts: Office ↔ PDF conversion fidelity, PDF → Excel table
detection, true redaction, OCR. Size: M.
