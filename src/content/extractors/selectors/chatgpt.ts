/**
 * CSS Selectors for ChatGPT (chatgpt.com)
 *
 * Selectors are ordered by stability (HIGH → LOW)
 * @see DES-003-chatgpt-extractor.md Section 5.3.2
 * @see docs/adr/005-shared-selector-modules.md
 */

import type { SelectorGroup } from './types';

export const SELECTORS = {
  // Conversation turn (each Q&A pair)
  // ChatGPT changed from <article> to <section> in 2026-03
  conversationTurn: [
    'section[data-turn-id]', // Current structure (HIGH)
    'section[data-testid^="conversation-turn"]', // Current test attr (MEDIUM)
    'article[data-turn-id]', // Legacy fallback (LOW)
    'article[data-testid^="conversation-turn"]', // Legacy fallback (LOW)
  ],

  // User message
  userMessage: [
    '[data-message-author-role="user"] .whitespace-pre-wrap', // Structure (HIGH)
    'section[data-turn="user"] .whitespace-pre-wrap', // Current structure (HIGH)
    'article[data-turn="user"] .whitespace-pre-wrap', // Legacy fallback (LOW)
    '.user-message-bubble-color .whitespace-pre-wrap', // Style (MEDIUM)
  ],

  // Assistant message
  assistantResponse: [
    '[data-message-author-role="assistant"] .markdown.prose', // Structure (HIGH)
    'section[data-turn="assistant"] .markdown.prose', // Current structure (HIGH)
    'article[data-turn="assistant"] .markdown.prose', // Legacy fallback (LOW)
    '.markdown.prose.dark\\:prose-invert', // Style (MEDIUM)
  ],

  // Markdown content
  markdownContent: [
    '.markdown.prose', // Semantic (HIGH)
    '.markdown-new-styling', // Style (MEDIUM)
  ],

  // Tool activity widgets within an assistant turn (web search, code
  // interpreter, image generation). Used to render an opt-in tool-activity
  // block, mirroring the Claude extractor.
  // TODO(verify): confirm against live chatgpt.com DOM before relying on these.
  // Broad substring fallbacks ([data-testid*="tool"], div[class*="tool-"]) were
  // intentionally removed: they over-match unrelated chrome (toolbar, tooltip,
  // tool-tip) and would dump that text into the tool callout. Until the live
  // DOM is verified, prefer safe degradation (capture nothing) over garbage.
  toolActivity: [
    '[data-message-author-role="tool"]', // Tool message (HIGH)
  ],

  // Summary / label text inside a tool widget (e.g. "Searched the web")
  toolSummary: [
    '[class*="truncate"]', // Summary label (MEDIUM)
    'button span', // Generic button label (LOW)
  ],

  // Attachment cards on a user turn (uploaded files, images).
  // TODO(verify): confirm against live chatgpt.com DOM before relying on these.
  // The broad div[class*="attachment"] fallback was intentionally removed: it
  // over-matches non-card chrome anywhere in the turn, and because attachment
  // capture runs by default (includeAttachments defaults ON) a false match
  // would inject unrelated page text into every export. Until verified, capture
  // nothing rather than garbage when the data-testid selector misses.
  attachment: [
    '[data-testid$="-attachment"]', // Attachment card (HIGH)
  ],

  // Filename / label within an attachment card
  attachmentName: [
    '.truncate', // Filename text (MEDIUM)
    'figcaption', // Image caption (LOW)
  ],
} as const satisfies SelectorGroup;
