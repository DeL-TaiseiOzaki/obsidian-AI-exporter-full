# DES-018: Tool-use body truncation fix & attachment capture

Status: Implemented (selectors pending live DOM verification)
Scope: Claude (`claude.ai`) and ChatGPT (`chatgpt.com`)

## Problem

1. **Post-tool prose was dropped.** When the assistant used a tool (web search,
   code interpreter, image generation, …) mid-response, only the *first*
   markdown block of the response was exported. `extractAssistantContent()` in
   both `claude.ts` and `chatgpt.ts` used `queryWithFallback()`
   (`querySelector`, single element), so any prose rendered *after* the tool
   widget was silently lost.

2. **No attachment capture.** Uploaded files and pasted-text cards (Claude
   renders pasted long text as a card labelled "PASTED") were not exported at
   all. ChatGPT had no tool-activity capture either (Claude already had an
   opt-in `enableToolContent`).

## Changes

### A. Body truncation fix (both platforms)

`extractAssistantContent()` now collects **all** markdown blocks in DOM order
and concatenates them, instead of returning the first. Collection uses
`BaseExtractor.queryAllUnion()` — the **union** across all markdown selector
tiers, de-duplicated and de-nested — **not** `queryAllWithFallback()` (which
returns only the first matching tier). The union matters because a tool section
and the body can render different tiers (e.g. tool uses `.standard-markdown`
while the body uses `.progressive-markdown`); a first-match-only query would
return just one tier, the tool-section filter would then drop it, and the
empty-blocks fallback would dump the whole element — re-leaking tool/artifact
chrome into the body.

- **Claude** (`src/content/extractors/claude.ts`): collects every
  `markdownContent` block within the `.font-claude-response`, **excluding**
  blocks inside a tool/Extended-Thinking section (`.row-start-1`) so body and
  `toolContent` are not double-counted. Exclusion (`isInsideToolSection`) treats
  only a `.row-start-1` that is **not** nested inside `.row-start-2` as the tool
  section, because the body prose wrapper is itself a nested grid that reuses
  `.row-start-1` (see Limitations).
- **ChatGPT** (`src/content/extractors/chatgpt.ts`): collects every
  `.markdown.prose` block in the turn, **excluding** blocks inside a tool widget
  (`isInsideToolWidget`, `[data-message-author-role="tool"]`). The primary
  `.markdown.prose` selector is not role-scoped, so a tool widget that renders
  its output as `.markdown.prose` would otherwise leak tool internals into the
  body; the exclusion mirrors Claude's tool-section filter.

### B. ChatGPT tool-activity extraction (new, opt-in)

Mirrors Claude's `enableToolContent`. `extractToolContentFromTurn()` reads
`toolActivity` widgets within an assistant turn and emits a string whose first
line is a bold summary, consumed by the existing `formatToolContent()`.

### C. Attachment capture (new, both platforms)

- New `MessageAttachment { name, kind: 'file'|'image'|'paste', text? }` and
  `ConversationMessage.attachments?` (`src/lib/types.ts`).
- Shared `BaseExtractor.collectAttachments(scope, cardSelectors, nameSelectors)`
  derives a reference (name + kind) per card; a name matching `/^pasted\b/i` →
  `paste`, an embedded non-favicon `<img>` → `image`, otherwise `file`.
  De-duplicated by `kind:name`. A card is only emitted when a filename/label
  element actually matches — it does **not** fall back to the card's full
  `textContent`, so a mis-matched generic container cannot inject page text as an
  attachment name.
- Rendered by `formatAttachments()` (`markdown-formatting.ts`) as a collapsible
  `[!INFO]-` callout (or plain/blockquote), placed after the owning message.
- New setting `includeAttachments` (default **on**), wired through
  `SyncSettings`, storage defaults/merge/save, popup toggle, and en/ja locales.
- Shared flags `enableToolContent` / `includeAttachments` are applied in
  `BaseExtractor.applySettings()`; subclasses that override call `super`.

### Settings ownership

`enableToolContent` and `includeAttachments` are gated at **extraction time**
(the extractor only populates `toolContent` / `attachments` when enabled),
matching the pre-existing `enableToolContent` pattern. The renderer emits
whatever is present.

## Limitations / follow-up

- **Selectors are modelled on documented DOM and need live verification.** The
  ChatGPT `toolActivity` / `attachment` selectors and the Claude `attachment`
  selectors carry `TODO(verify)` markers in
  `src/content/extractors/selectors/*`. Verify with `nix run .#e2e-auth` then
  `nix run .#e2e-selectors`, or against captured HTML, and adjust. To keep the
  unverified state **safe by default**, the broad substring fallbacks
  (`[data-testid*="tool"]`, `div[class*="tool-"]`, `div[class*="attachment"]`)
  were removed: a wrong-but-matching generic selector would otherwise dump
  unrelated chrome into a tool callout or (since `includeAttachments` defaults
  on) an attachment name on every export. With only the high-confidence
  selectors left, a miss degrades to capturing nothing rather than garbage.
- **Attachment `text` is not yet populated by extraction.** Binary file bodies
  are not in the DOM; only references are captured. Capturing the *inline text*
  of a pasted-text card requires confirming where that text lives in the live
  DOM. `formatAttachments` already renders `text` when present.
- ~~The Claude `.row-start-1` exclusion can over-match if a real multi-tool
  response nests a tool's `.row-start-1` *inside* `.row-start-2`.~~ **Fixed:**
  artifact/tool turns wrap the body prose in a nested grid whose wrapper also
  carries `.row-start-1` but lives *inside* `.row-start-2`. `isInsideToolSection`
  now treats only a `.row-start-1` that is **not** nested in `.row-start-2` as
  the tool section, so body prose is no longer excluded (which previously forced
  the whole-element fallback and leaked tool-widget / artifact-card chrome into
  the body). Covered by the `chat-simple` Claude e2e snapshot.

## Tests

`test/extractors/tool-use-and-attachments.test.ts` covers: post-tool prose
captured (both platforms), ChatGPT tool-activity on/off, Claude/ChatGPT
attachment capture incl. "PASTED" classification and the off-switch, and
`formatAttachments` rendering.

Regression tests added after the pre-merge review:

- **Claude mixed markdown tiers** — tool section uses `.standard-markdown` while
  the body uses `.progressive-markdown`; asserts the body survives and no tool
  chrome leaks (guards the `queryAllUnion` fix).
- **ChatGPT tool-internal markdown** — a tool widget containing `.markdown.prose`
  must not leak into the body (guards `isInsideToolWidget`).
- **ChatGPT summary de-duplication** — summary not at the widget start is emitted
  exactly once (guards the clone-and-remove `rest` derivation).
- **`paste` classification** — `copy-paste.txt` is a `file`, not a `paste`
  (guards the tightened `/^pasted\b/i`).
- **Attachment garbage rejection** — a generic `[class*="attachment"]` container
  is not captured (guards the removed broad fallback + no-textContent-name).
- **`includeAttachments` storage** — default `true` and round-trip to `false`
  (`test/lib/storage.test.ts`).
