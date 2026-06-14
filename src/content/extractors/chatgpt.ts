/**
 * ChatGPT Extractor
 *
 * Extracts conversations from ChatGPT (chatgpt.com)
 * Supports normal chat mode (Deep Research treated as normal conversation)
 *
 * @see docs/design/DES-003-chatgpt-extractor.md
 */

import { BaseExtractor } from './base';
import { sanitizeHtml } from '../../lib/sanitize';
import type { ConversationMessage } from '../../lib/types';

import { SELECTORS } from './selectors/chatgpt';

/**
 * ChatGPT conversation extractor
 *
 * Implements IConversationExtractor interface
 * @see src/lib/types.ts
 */
export class ChatGPTExtractor extends BaseExtractor {
  readonly platform = 'chatgpt';

  // ========== Platform Detection ==========

  /**
   * Check if this extractor can handle the current page
   *
   * IMPORTANT: Uses strict comparison (===) to prevent
   * subdomain attacks like "evil-chatgpt.com.attacker.com"
   * @see NFR-001-1 in design document
   */
  canExtract(): boolean {
    return window.location.hostname === 'chatgpt.com';
  }

  // ========== ID & Title Extraction ==========

  /**
   * Extract conversation ID from URL
   *
   * URL formats:
   *   https://chatgpt.com/c/{uuid}
   *   https://chatgpt.com/g/{gpt-slug}/c/{uuid}
   * @returns UUID string or null if not found
   */
  getConversationId(): string | null {
    // Match /c/{uuid} pattern (works for both regular and custom GPT URLs)
    const match = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
  }

  /**
   * Get conversation title
   *
   * Priority:
   * 1. document.title (via getPageTitle())
   * 2. First user message content (truncated to MAX_CONVERSATION_TITLE_LENGTH)
   * 3. Default title
   */
  getTitle(): string {
    return (
      this.getPageTitle() ??
      this.getFirstMessageTitle(SELECTORS.userMessage, 'Untitled ChatGPT Conversation')
    );
  }

  // ========== Message Extraction ==========

  /**
   * Extract all messages from conversation
   *
   * Uses section[data-turn-id] to find conversation turns (with article fallback),
   * then extracts User/Assistant messages in DOM order
   * @see FR-002 in design document
   */
  extractMessages(): ConversationMessage[] {
    const messages: ConversationMessage[] = [];

    // Find all conversation turns
    const turns = this.queryAllWithFallback<HTMLElement>(SELECTORS.conversationTurn);

    if (turns.length === 0) {
      console.warn('[G2O] No conversation turns found with primary selectors');
      return messages;
    }

    // Process each turn
    turns.forEach((turn, index) => {
      // Determine role from data-turn attribute or data-message-author-role
      const turnRole = turn.getAttribute('data-turn');
      const messageEl = turn.querySelector('[data-message-author-role]');
      const authorRole = messageEl?.getAttribute('data-message-author-role');

      const role = turnRole || authorRole;

      if (role === 'user') {
        const content = this.extractUserContent(turn);
        if (content) {
          messages.push({
            id: `user-${index}`,
            role: 'user',
            content,
            index: messages.length,
            ...this.extractExtras(turn, 'user'),
          });
        }
      } else if (role === 'assistant') {
        const content = this.extractAssistantContent(turn);
        if (content) {
          messages.push({
            id: `assistant-${index}`,
            role: 'assistant',
            content,
            htmlContent: content,
            index: messages.length,
            ...this.extractExtras(turn, 'assistant'),
          });
        }
      }
    });

    return messages;
  }

  /**
   * Extract optional per-message extras (tool activity, attachments) according
   * to the active settings. Returned as a partial so callers can spread it onto
   * the message object only when something was found.
   */
  private extractExtras(
    turn: Element,
    role: 'user' | 'assistant'
  ): Partial<Pick<ConversationMessage, 'toolContent' | 'attachments'>> {
    const extras: Partial<Pick<ConversationMessage, 'toolContent' | 'attachments'>> = {};

    if (this.enableToolContent && role === 'assistant') {
      const toolContent = this.extractToolContentFromTurn(turn);
      if (toolContent) extras.toolContent = toolContent;
    }

    if (this.includeAttachments) {
      const attachments = this.collectAttachments(
        turn,
        SELECTORS.attachment,
        SELECTORS.attachmentName
      );
      if (attachments.length > 0) extras.attachments = attachments;
    }

    return extras;
  }

  /**
   * Extract tool-activity content (web search, code interpreter, image gen)
   * from an assistant turn. Returns a string whose first line is a bold summary
   * so {@link formatToolContent} can use it as the callout title, or null when
   * no tool widget is present.
   */
  private extractToolContentFromTurn(turn: Element): string | null {
    const widgets = this.queryAllWithFallback<HTMLElement>(SELECTORS.toolActivity, turn);
    if (widgets.length === 0) return null;

    const parts: string[] = [];
    for (const widget of widgets) {
      const summaryEl = this.queryWithFallback<HTMLElement>(SELECTORS.toolSummary, widget);
      const summary = this.sanitizeText(summaryEl?.textContent ?? '');

      // Derive the remaining text by removing the summary ELEMENT from a clone,
      // rather than slicing the summary STRING off the front. The summary is
      // not guaranteed to be a leading prefix of the widget's text (an icon or
      // label may precede it), and a naive prefix-slice would then re-emit the
      // summary inside `rest`, duplicating it.
      let rest: string;
      if (summaryEl) {
        const clone = widget.cloneNode(true) as HTMLElement;
        this.queryWithFallback<HTMLElement>(SELECTORS.toolSummary, clone)?.remove();
        rest = this.sanitizeText(clone.textContent ?? '');
      } else {
        rest = this.sanitizeText(widget.textContent ?? '');
      }

      if (summary) {
        parts.push(`**${summary}**`);
        if (rest && rest !== summary) parts.push(rest);
      } else if (rest) {
        parts.push(rest);
      }
    }

    const joined = parts.join('\n\n').trim();
    return joined || null;
  }

  /**
   * Extract user message content (plain text)
   */
  private extractUserContent(turnElement: Element): string {
    // Find user message content within the turn
    const contentEl = this.queryWithFallback<HTMLElement>(SELECTORS.userMessage, turnElement);
    if (contentEl?.textContent) {
      return this.sanitizeText(contentEl.textContent);
    }

    // Fallback: try to get any .whitespace-pre-wrap content
    const fallbackEl = turnElement.querySelector('.whitespace-pre-wrap');
    if (fallbackEl?.textContent) {
      return this.sanitizeText(fallbackEl.textContent);
    }

    return '';
  }

  /**
   * Extract assistant response content (HTML for markdown conversion)
   *
   * All HTML is sanitized via DOMPurify to prevent XSS
   * Also cleans utm_source parameters from citation URLs
   * @see NFR-001-2 in design document
   */
  private extractAssistantContent(turnElement: Element): string {
    // Collect ALL markdown blocks in DOM order, not just the first.
    //
    // When the assistant uses a tool (web search, code interpreter, image gen,
    // etc.) the response is split into multiple `.markdown.prose` blocks with
    // tool widgets in between. A single querySelector only returned the first
    // block, dropping everything after the tool use. Tool widgets are separate
    // DOM nodes (not `.markdown.prose`), so collecting every markdown block
    // recovers the post-tool prose without pulling in tool internals.
    const blocks = this.queryAllUnion<HTMLElement>(SELECTORS.markdownContent, turnElement).filter(
      el => !this.isInsideToolWidget(el, turnElement)
    );
    if (blocks.length > 0) {
      return blocks.map(el => sanitizeHtml(this.cleanCitationUrls(el.innerHTML))).join('\n');
    }

    // Fallback: try assistantResponse selectors
    const assistantBlocks = this.queryAllUnion<HTMLElement>(
      SELECTORS.assistantResponse,
      turnElement
    ).filter(el => !this.isInsideToolWidget(el, turnElement));
    if (assistantBlocks.length > 0) {
      return assistantBlocks.map(el => sanitizeHtml(this.cleanCitationUrls(el.innerHTML))).join('\n');
    }

    return '';
  }

  /**
   * Whether a markdown block lives inside a tool widget within the turn.
   *
   * The primary markdown selector (`.markdown.prose`) is not role-scoped, so a
   * tool widget that renders its output as `.markdown.prose` would otherwise
   * leak tool internals into the assistant body. Mirrors Claude's
   * isInsideToolSection. Tool content is captured separately (opt-in) via
   * extractToolContentFromTurn.
   */
  private isInsideToolWidget(el: Element, root: Element): boolean {
    const tool = el.closest('[data-message-author-role="tool"]');
    return tool !== null && root.contains(tool);
  }

  /**
   * Clean utm_source parameter from citation URLs
   *
   * ChatGPT adds ?utm_source=chatgpt.com to citation URLs.
   * Uses DOM-level manipulation instead of regex for safety.
   * @see DES-003-chatgpt-extractor.md Section 8.2
   */
  private cleanCitationUrls(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('a[href]').forEach(el => {
      const anchor = el as HTMLAnchorElement;
      try {
        const url = new URL(anchor.href);
        if (url.searchParams.get('utm_source') === 'chatgpt.com') {
          url.searchParams.delete('utm_source');
          anchor.href = url.toString();
        }
      } catch {
        // malformed href — leave for DOMPurify to handle
      }
    });
    return doc.body.innerHTML;
  }
}
