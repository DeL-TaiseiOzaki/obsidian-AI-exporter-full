/**
 * Claude Extractor
 *
 * Extracts conversations from Claude AI (claude.ai)
 * Supports both normal chat and Deep Research (Extended Thinking) modes
 *
 * @see docs/design/DES-002-claude-extractor.md
 */

import { BaseExtractor } from './base';
import { sanitizeHtml } from '../../lib/sanitize';
import { htmlToMarkdownRaw } from '../markdown-rules';
import type { ConversationMessage, DeepResearchSource, MessageAttachment } from '../../lib/types';
import { SELECTORS, DEEP_RESEARCH_SELECTORS, JOINED_SELECTORS } from './selectors/claude';

/**
 * Claude conversation and Deep Research extractor
 *
 * Implements IConversationExtractor interface
 * @see src/lib/types.ts
 */
export class ClaudeExtractor extends BaseExtractor {
  readonly platform = 'claude';

  // Settings (enableToolContent, includeAttachments) are applied by BaseExtractor.

  // ========== Platform Detection ==========

  /**
   * Check if this extractor can handle the current page
   *
   * IMPORTANT: Uses strict comparison (===) to prevent
   * subdomain attacks like "evil-claude.ai.attacker.com"
   * @see NFR-001-1 in design document
   */
  canExtract(): boolean {
    return window.location.hostname === 'claude.ai';
  }

  /**
   * Check if Deep Research mode is visible
   *
   * Detects presence of #markdown-artifact element
   * @see FR-003-3 in design document
   */
  isDeepResearchVisible(): boolean {
    const artifact = this.queryWithFallback<HTMLElement>(DEEP_RESEARCH_SELECTORS.artifact);
    return artifact !== null;
  }

  // ========== ID & Title Extraction ==========

  /**
   * Extract conversation ID from URL
   *
   * URL format: https://claude.ai/chat/{uuid}
   * @returns UUID string or null if not found
   */
  getConversationId(): string | null {
    const match = window.location.pathname.match(/\/chat\/([a-f0-9-]{36})/i);
    return match ? match[1] : null;
  }

  /**
   * Get conversation title
   *
   * Priority:
   * 1. Deep Research h1 title (if Deep Research visible)
   * 2. document.title (via getPageTitle())
   * 3. First user message content (truncated)
   * 4. Default title
   */
  getTitle(): string {
    if (this.isDeepResearchVisible()) {
      return this.getDeepResearchTitle();
    }

    return (
      this.getPageTitle() ??
      this.getFirstMessageTitle(SELECTORS.userMessage, 'Untitled Claude Conversation')
    );
  }

  /** Expose platform selectors to BaseExtractor's DR title/content helpers. */
  protected getDeepResearchSelectors() {
    return DEEP_RESEARCH_SELECTORS;
  }

  // ========== Message Extraction ==========

  /**
   * Extract all messages from conversation
   *
   * Extracts User/Assistant messages in DOM order
   * @see FR-002 in design document
   */
  extractMessages(): ConversationMessage[] {
    // Collect all message elements
    const allElements: Array<{ element: Element; type: 'user' | 'assistant' }> = [];

    // Find user messages (skip nested content inside assistant responses)
    const userMessages = this.queryAllWithFallback<HTMLElement>(SELECTORS.userMessage);
    userMessages.forEach(el => {
      const assistantParent = el.closest('.font-claude-response, [class*="font-claude-response"]');
      if (!assistantParent) {
        allElements.push({ element: el, type: 'user' });
      }
    });

    // Find assistant responses
    const assistantResponses = this.queryAllWithFallback<HTMLElement>(SELECTORS.assistantResponse);
    assistantResponses.forEach(el => {
      allElements.push({ element: el, type: 'assistant' });
    });

    const sortedElements = this.sortByDomPosition(allElements);

    // Pre-extract tool content + attachments keyed by message ID
    // (keys match buildMessagesFromElements' `${type}-${index}` format).
    const toolContentById = new Map<string, string>();
    const attachmentsById = new Map<string, MessageAttachment[]>();
    sortedElements.forEach((item, index) => {
      if (this.enableToolContent && item.type === 'assistant') {
        const tc = this.extractToolContentFromElement(item.element);
        if (tc) toolContentById.set(`assistant-${index}`, tc);
      }
      if (this.includeAttachments) {
        const atts = this.extractAttachments(item.element);
        if (atts.length > 0) attachmentsById.set(`${item.type}-${index}`, atts);
      }
    });

    const messages = this.buildMessagesFromElements(
      sortedElements,
      el => this.extractUserContent(el),
      el => this.extractAssistantContent(el)
    );

    // Attach tool content + attachments to messages (DES-014 H-5: immutable)
    if (toolContentById.size === 0 && attachmentsById.size === 0) return messages;

    return messages.map(msg => {
      const tc = toolContentById.get(msg.id);
      const atts = attachmentsById.get(msg.id);
      if (!tc && !atts) return msg;
      return {
        ...msg,
        ...(tc ? { toolContent: tc } : {}),
        ...(atts ? { attachments: atts } : {}),
      };
    });
  }

  /**
   * Extract user message content as markdown.
   *
   * Sanitizes the grid container's innerHTML via DOMPurify and converts it
   * to markdown (without angle-bracket escaping — {@link formatMessage}
   * applies that step later). This preserves paragraph breaks and
   * `<pre>`/`<code>` blocks that a plain `textContent` extraction would
   * flatten or drop entirely (see issue #200).
   *
   * Falls back to sanitized plain text for elements that produce no
   * markdown output (e.g. bare text nodes without block structure).
   */
  private extractUserContent(element: Element): string {
    const rawHtml = element.innerHTML;
    if (rawHtml) {
      const markdown = htmlToMarkdownRaw(sanitizeHtml(rawHtml)).trim();
      if (markdown) return markdown;
    }

    // Defensive fallback: preserve prior behavior for elements that have
    // only a text node and no convertible HTML structure.
    const textContent = element.textContent?.trim();
    if (textContent) {
      return this.sanitizeText(textContent);
    }
    return '';
  }

  /**
   * Extract assistant response content (HTML for markdown conversion)
   *
   * All HTML is sanitized via DOMPurify to prevent XSS
   * @see NFR-001-2 in design document
   */
  private extractAssistantContent(element: Element): string {
    // Collect ALL response-body markdown blocks in DOM order, not just the first.
    //
    // When the assistant uses a tool (web search, code interpreter, etc.) the
    // response is split into multiple markdown blocks interleaved with tool
    // widgets. A single querySelector only returned the first block, dropping
    // everything after the tool use (issue: tool-use content truncation).
    //
    // Tool / Extended-Thinking sections live under `.row-start-1` and are
    // handled separately by extractToolContentFromElement(); exclude them here
    // so body and tool content are not double-counted.
    // Use the UNION across markdown tiers, not the first matching tier. The
    // body and a tool section can render different tiers (e.g. tool uses
    // `.standard-markdown` while the body uses `.progressive-markdown`); a
    // first-match-only query (queryAllWithFallback) would return just the tool
    // tier, the isInsideToolSection filter would drop it, and the empty-blocks
    // fallback below would dump the whole element — re-leaking tool/artifact
    // chrome into the body.
    const blocks = this.queryAllUnion<HTMLElement>(SELECTORS.markdownContent, element).filter(
      el => !this.isInsideToolSection(el, element)
    );

    if (blocks.length > 0) {
      return blocks.map(el => sanitizeHtml(el.innerHTML)).join('\n');
    }

    // Fallback: use the element's innerHTML (no markdown blocks found)
    return sanitizeHtml(element.innerHTML);
  }

  /**
   * Whether a markdown block lives inside a tool/thinking section
   * (`.row-start-1`) within the given assistant response element.
   *
   * Such blocks belong to tool activity, not the assistant's prose body.
   *
   * Subtlety: the assistant's *body* prose is wrapped in a nested grid whose
   * wrapper ALSO carries `.row-start-1` but lives *inside* the body container
   * `.row-start-2`. A naive `closest('.row-start-1')` therefore misclassifies
   * body prose as tool content, which dropped the body and forced the
   * whole-element fallback (leaking tool widgets / artifact-card chrome). The
   * genuine tool section is the `.row-start-1` that is a *sibling* of
   * `.row-start-2` — i.e. not itself nested inside a `.row-start-2`.
   */
  private isInsideToolSection(el: Element, root: Element): boolean {
    const toolSection = el.closest('.row-start-1');
    if (toolSection === null || !root.contains(toolSection)) return false;
    // A `.row-start-1` nested inside `.row-start-2` is the body wrapper, not
    // the tool section.
    return toolSection.closest('.row-start-2') === null;
  }

  /**
   * Extract tool content from a full .font-claude-response element
   *
   * Returns tool content string if .row-start-1 contains tool-use content,
   * null otherwise (no grid, no tool section, or Extended Thinking).
   */
  private extractToolContentFromElement(element: Element): string | null {
    const responseSection = element.querySelector('.row-start-2');
    if (!responseSection) return null; // Non-grid → no tool content

    const toolSection = element.querySelector('.row-start-1');
    if (!toolSection) return null;

    const isExtendedThinking = toolSection.querySelector('[class*="group/thinking"]') !== null;
    if (isExtendedThinking) return null;

    const toolContent = this.extractToolContent(toolSection);
    return toolContent || null;
  }

  /**
   * Extract tool content from .row-start-1 section
   *
   * Extracts:
   * 1. Summary button text (e.g., "Searched the web") as bold
   * 2. Search queries (group/row buttons with query text and result count)
   * 3. Search result items (identified by favicon images)
   * 4. .standard-markdown content (code interpreter, file analysis)
   */
  private extractToolContent(toolSection: Element): string {
    const parts: string[] = [];
    this.extractToolSummary(toolSection, parts);
    this.extractToolQueries(toolSection, parts);
    this.extractToolResults(toolSection, parts);
    this.extractToolMarkdown(toolSection, parts);
    return parts.join('\n\n');
  }

  /** Summary button text (e.g., "Searched the web") as bold */
  private extractToolSummary(toolSection: Element, parts: string[]): void {
    const summaryButton = toolSection.querySelector('button span.truncate');
    if (summaryButton?.textContent) {
      parts.push('**' + this.sanitizeText(summaryButton.textContent) + '**');
    }
  }

  /** Search queries (group/row buttons with query text and result count) */
  private extractToolQueries(toolSection: Element, parts: string[]): void {
    const queryButtons = toolSection.querySelectorAll('[class*="group/row"]');
    queryButtons.forEach(btn => {
      const queryEl = btn.querySelector('.truncate');
      const countEl = btn.querySelector('p');
      if (queryEl?.textContent?.trim()) {
        let text = this.sanitizeText(queryEl.textContent);
        if (countEl?.textContent?.trim()) {
          text += ' (' + this.sanitizeText(countEl.textContent) + ')';
        }
        parts.push(text);
      }
    });
  }

  /** Search result items (identified by favicon images) */
  private extractToolResults(toolSection: Element, parts: string[]): void {
    const favicons = toolSection.querySelectorAll('img[alt="favicon"]');
    if (favicons.length === 0) return;

    const items: string[] = [];
    favicons.forEach(img => {
      // Navigate: img → container div → result row div
      const row = img.parentElement?.parentElement;
      if (!row || row.children.length < 2) return;
      // Children: [0]=favicon container, [1]=title, [2]=domain (optional)
      const title = row.children[1]?.textContent?.trim();
      const domain = row.children.length > 2 ? row.children[2]?.textContent?.trim() : undefined;
      if (title) {
        items.push(domain ? '- ' + title + ' (' + domain + ')' : '- ' + title);
      }
    });
    if (items.length > 0) {
      parts.push(items.join('\n'));
    }
  }

  /** .standard-markdown content (code interpreter, file analysis) */
  private extractToolMarkdown(toolSection: Element, parts: string[]): void {
    const markdownEls = toolSection.querySelectorAll('.standard-markdown');
    markdownEls.forEach(el => {
      const html = sanitizeHtml(el.innerHTML);
      if (html.trim()) {
        parts.push(html);
      }
    });
  }

  // ========== Attachment Extraction ==========

  /**
   * Extract attachment cards (uploaded files, images, pasted-text cards) for a
   * message element. Searches the enclosing turn so cards rendered as siblings
   * of the message body are still found.
   *
   * Binary file bodies are not in the DOM, so only a reference (name + kind)
   * is captured.
   */
  private extractAttachments(messageElement: Element): MessageAttachment[] {
    // Attachment cards may render as siblings of the message body, so search
    // the enclosing turn rather than just the message element.
    const scope =
      messageElement.closest('.group') ?? messageElement.parentElement ?? messageElement;
    return this.collectAttachments(scope, SELECTORS.attachment, SELECTORS.attachmentName);
  }

  // ========== Deep Research Extraction ==========

  /**
   * Extract source list from Deep Research inline citations
   *
   * Deduplicates by URL and maintains DOM order
   * @see FR-003-4 in design document
   */
  extractSourceList(): DeepResearchSource[] {
    const sources: DeepResearchSource[] = [];
    const seenUrls = new Map<string, number>(); // URL -> index mapping for deduplication

    // Find all inline citation links
    const citationLinks = document.querySelectorAll<HTMLAnchorElement>(
      JOINED_SELECTORS.inlineCitation
    );

    citationLinks.forEach(link => {
      const url = link.href;
      if (!url || !url.startsWith('http')) return;

      // Skip duplicates
      if (seenUrls.has(url)) return;

      // Extract title from link text or parent
      let title = link.textContent?.trim() || '';
      if (!title || title.includes('+')) {
        // Try to get a better title from aria-label or title attribute
        title = link.getAttribute('aria-label') || link.getAttribute('title') || '';
      }
      if (!title) {
        title = 'Unknown Title';
      }

      const domain = this.extractDomain(url);

      const index = sources.length;
      seenUrls.set(url, index);

      sources.push({
        index,
        url,
        title: this.sanitizeText(title),
        domain,
      });
    });

    return sources;
  }
}
