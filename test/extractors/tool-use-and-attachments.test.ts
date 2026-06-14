/**
 * Regression + feature tests for:
 *  - Tool-use body truncation fix (post-tool prose no longer dropped)
 *  - Attachment capture (uploaded files, images, pasted-text cards)
 *  - ChatGPT tool-activity extraction (opt-in)
 *  - Attachment rendering (formatAttachments)
 *
 * NOTE: The ChatGPT tool-activity and attachment-card selectors are modelled
 * on the documented DOM and MUST be re-verified against the live sites
 * (see TODO(verify) markers in src/content/extractors/selectors/*). These
 * tests lock in the extraction *logic* given that assumed structure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeExtractor } from '../../src/content/extractors/claude';
import { ChatGPTExtractor } from '../../src/content/extractors/chatgpt';
import { formatAttachments } from '../../src/content/markdown-formatting';
import {
  loadFixture,
  clearFixture,
  resetLocation,
  setClaudeLocation,
  setChatGPTLocation,
} from '../fixtures/dom-helpers';
import type { MessageAttachment, TemplateOptions } from '../../src/lib/types';

const CLAUDE_ID = '12345678-1234-1234-1234-123456789012';
const CHATGPT_ID = '6789abcd-ef01-2345-6789-abcdef012345';

describe('Tool-use body truncation fix', () => {
  afterEach(() => {
    clearFixture();
    resetLocation();
  });

  it('Claude: captures prose both before AND after a tool widget', async () => {
    setClaudeLocation(CLAUDE_ID);
    loadFixture(`
      <div class="app-container"><div class="conversation-thread">
        <div data-test-render-count="2" class="group" style="height: auto;">
          <div class="bg-bg-300 rounded-xl pl-2.5 py-2.5">
            <div data-testid="user-message">
              <p class="whitespace-pre-wrap break-words">Search please</p>
            </div>
          </div>
        </div>
        <div data-test-render-count="2" class="group" style="height: auto;">
          <div class="font-claude-response" data-is-streaming="false">
            <div><div class="grid grid-rows-[auto_auto] min-w-0">
              <div class="row-start-1 col-start-1 min-w-0">
                <div class="min-w-0 pl-2 py-1.5">
                  <button class="group/status"><span class="truncate text-sm font-base">Searched the web</span></button>
                </div>
              </div>
              <div class="row-start-2 col-start-1 relative grid isolate min-w-0">
                <div class="standard-markdown"><p>Before the tool call.</p></div>
                <div class="standard-markdown"><p>After the tool call.</p></div>
              </div>
            </div></div>
          </div>
        </div>
      </div></div>
    `);

    const result = await new ClaudeExtractor().extract();
    expect(result.success).toBe(true);
    const assistant = result.data?.messages.find(m => m.role === 'assistant');
    expect(assistant?.content).toContain('Before the tool call.');
    // Regression: this used to be dropped because only the first block was read.
    expect(assistant?.content).toContain('After the tool call.');
    // Tool summary stays out of the body (tool content is opt-in & separate).
    expect(assistant?.content).not.toContain('Searched the web');
  });

  it('ChatGPT: captures prose both before AND after a tool widget', async () => {
    setChatGPTLocation(CHATGPT_ID);
    loadFixture(`
      <div class="flex flex-col text-sm">
        <section data-turn-id="t1" data-turn="assistant">
          <div data-message-author-role="assistant" data-message-id="m1">
            <div class="markdown prose"><p>Before the search.</p></div>
            <div data-message-author-role="tool"><span class="truncate">Searched the web</span></div>
            <div class="markdown prose"><p>After the search.</p></div>
          </div>
        </section>
      </div>
    `);

    const result = await new ChatGPTExtractor().extract();
    expect(result.success).toBe(true);
    const assistant = result.data?.messages.find(m => m.role === 'assistant');
    expect(assistant?.content).toContain('Before the search.');
    // Regression: previously dropped.
    expect(assistant?.content).toContain('After the search.');
  });

  it('Claude: body survives when tool and body use different markdown tiers', async () => {
    // Regression for the queryAllUnion fix: a tool section rendering
    // `.standard-markdown` (tier 1) while the body renders `.progressive-markdown`
    // (tier 2). A first-match-only query would return only the tool tier, the
    // tool-section filter would drop it, and the empty-blocks fallback would
    // dump the whole element — re-leaking tool/artifact chrome into the body.
    setClaudeLocation(CLAUDE_ID);
    loadFixture(`
      <div class="app-container"><div class="conversation-thread">
        <div data-test-render-count="2" class="group" style="height: auto;">
          <div class="font-claude-response" data-is-streaming="false">
            <div><div class="grid grid-rows-[auto_auto] min-w-0">
              <div class="row-start-1 col-start-1 min-w-0">
                <div class="min-w-0 pl-2 py-1.5">
                  <button class="group/status"><span class="truncate text-sm font-base">Ran code</span></button>
                  <div class="standard-markdown"><p>TOOL INTERNAL OUTPUT</p></div>
                </div>
              </div>
              <div class="row-start-2 col-start-1 relative grid isolate min-w-0">
                <div class="progressive-markdown"><p>The real body answer.</p></div>
              </div>
            </div></div>
          </div>
        </div>
      </div></div>
    `);

    const result = await new ClaudeExtractor().extract();
    const assistant = result.data?.messages.find(m => m.role === 'assistant');
    expect(assistant?.content).toContain('The real body answer.');
    expect(assistant?.content).not.toContain('TOOL INTERNAL OUTPUT');
    expect(assistant?.content).not.toContain('Ran code');
  });

  it('ChatGPT: tool-internal markdown does not leak into the body', async () => {
    // Regression for the isInsideToolWidget fix: a tool widget that itself
    // renders `.markdown.prose` must not be pulled into the assistant body.
    setChatGPTLocation(CHATGPT_ID);
    loadFixture(`
      <div class="flex flex-col text-sm">
        <section data-turn-id="t1" data-turn="assistant">
          <div data-message-author-role="assistant" data-message-id="m1">
            <div data-message-author-role="tool">
              <div class="markdown prose"><p>TOOL INTERNAL OUTPUT</p></div>
            </div>
            <div class="markdown prose"><p>Real answer.</p></div>
          </div>
        </section>
      </div>
    `);

    const result = await new ChatGPTExtractor().extract();
    const assistant = result.data?.messages.find(m => m.role === 'assistant');
    expect(assistant?.content).toContain('Real answer.');
    expect(assistant?.content).not.toContain('TOOL INTERNAL OUTPUT');
  });
});

describe('ChatGPT tool-activity extraction (opt-in)', () => {
  afterEach(() => {
    clearFixture();
    resetLocation();
  });

  function loadToolTurn(): void {
    setChatGPTLocation(CHATGPT_ID);
    loadFixture(`
      <div class="flex flex-col text-sm">
        <section data-turn-id="t1" data-turn="assistant">
          <div data-message-author-role="assistant" data-message-id="m1">
            <div data-message-author-role="tool"><span class="truncate">Searched the web</span> 3 results</div>
            <div class="markdown prose"><p>The answer.</p></div>
          </div>
        </section>
      </div>
    `);
  }

  it('OFF (default): tool widget is not captured', async () => {
    loadToolTurn();
    const result = await new ChatGPTExtractor().extract();
    const assistant = result.data?.messages.find(m => m.role === 'assistant');
    expect(assistant?.content).toContain('The answer.');
    expect(assistant?.toolContent).toBeUndefined();
  });

  it('ON: tool summary captured into toolContent, body kept clean', async () => {
    loadToolTurn();
    const extractor = new ChatGPTExtractor();
    extractor.enableToolContent = true;
    const result = await extractor.extract();
    const assistant = result.data?.messages.find(m => m.role === 'assistant');
    expect(assistant?.toolContent).toContain('**Searched the web**');
    expect(assistant?.content).toContain('The answer.');
    expect(assistant?.content).not.toContain('Searched the web');
  });

  it('ON: summary is not duplicated when it is not at the widget start', async () => {
    // Regression: the old prefix-slice heuristic re-emitted the summary inside
    // `rest` when text preceded the summary span ("Web search <span>...</span>").
    setChatGPTLocation(CHATGPT_ID);
    loadFixture(`
      <div class="flex flex-col text-sm">
        <section data-turn-id="t1" data-turn="assistant">
          <div data-message-author-role="assistant" data-message-id="m1">
            <div data-message-author-role="tool">Web search <span class="truncate">Searched the web</span> done</div>
            <div class="markdown prose"><p>The answer.</p></div>
          </div>
        </section>
      </div>
    `);
    const extractor = new ChatGPTExtractor();
    extractor.enableToolContent = true;
    const result = await extractor.extract();
    const assistant = result.data?.messages.find(m => m.role === 'assistant');
    const occurrences = (assistant?.toolContent?.match(/Searched the web/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

describe('Attachment capture', () => {
  afterEach(() => {
    clearFixture();
    resetLocation();
  });

  it('Claude: captures file and pasted-text ("PASTED") cards on a user turn', async () => {
    setClaudeLocation(CLAUDE_ID);
    loadFixture(`
      <div class="app-container"><div class="conversation-thread">
        <div data-test-render-count="2" class="group" style="height: auto;">
          <div class="bg-bg-300 rounded-xl pl-2.5 py-2.5">
            <div data-testid="user-message">
              <p class="whitespace-pre-wrap break-words">See attached</p>
            </div>
          </div>
          <div data-testid="file-thumbnail"><h3>data.csv</h3></div>
          <div data-testid="file-thumbnail"><h3>PASTED</h3></div>
        </div>
        <div data-test-render-count="2" class="group" style="height: auto;">
          <div class="font-claude-response" data-is-streaming="false">
            <div class="standard-markdown"><p>Got it.</p></div>
          </div>
        </div>
      </div></div>
    `);

    const result = await new ClaudeExtractor().extract();
    const user = result.data?.messages.find(m => m.role === 'user');
    expect(user?.attachments).toBeDefined();
    const names = user?.attachments?.map(a => a.name);
    expect(names).toContain('data.csv');
    expect(names).toContain('PASTED');
    const paste = user?.attachments?.find(a => a.name === 'PASTED');
    expect(paste?.kind).toBe('paste');
    const file = user?.attachments?.find(a => a.name === 'data.csv');
    expect(file?.kind).toBe('file');
  });

  it('Claude: attachments omitted when includeAttachments is OFF', async () => {
    setClaudeLocation(CLAUDE_ID);
    loadFixture(`
      <div class="app-container"><div class="conversation-thread">
        <div data-test-render-count="2" class="group" style="height: auto;">
          <div class="bg-bg-300 rounded-xl pl-2.5 py-2.5">
            <div data-testid="user-message">
              <p class="whitespace-pre-wrap break-words">See attached</p>
            </div>
          </div>
          <div data-testid="file-thumbnail"><h3>data.csv</h3></div>
        </div>
      </div></div>
    `);

    const extractor = new ClaudeExtractor();
    extractor.includeAttachments = false;
    const result = await extractor.extract();
    const user = result.data?.messages.find(m => m.role === 'user');
    expect(user?.attachments).toBeUndefined();
  });

  it('Claude: a filename containing "paste" is classified as a file, not a paste', async () => {
    // Regression for the tightened /^pasted\b/i check (was /\bpasted?\b/i, which
    // misclassified ordinary filenames like copy-paste.txt as pasted text).
    setClaudeLocation(CLAUDE_ID);
    loadFixture(`
      <div class="app-container"><div class="conversation-thread">
        <div data-test-render-count="2" class="group" style="height: auto;">
          <div class="bg-bg-300 rounded-xl pl-2.5 py-2.5">
            <div data-testid="user-message">
              <p class="whitespace-pre-wrap break-words">See file</p>
            </div>
          </div>
          <div data-testid="file-thumbnail"><h3>copy-paste.txt</h3></div>
        </div>
      </div></div>
    `);

    const result = await new ClaudeExtractor().extract();
    const user = result.data?.messages.find(m => m.role === 'user');
    const att = user?.attachments?.find(a => a.name === 'copy-paste.txt');
    expect(att?.kind).toBe('file');
  });

  it('ChatGPT: a generic [class*="attachment"] container is NOT captured as an attachment', async () => {
    // Regression for dropping the broad div[class*="attachment"] fallback +
    // not falling back to card.textContent: a mis-matched container must not
    // inject page text as an attachment name (this path runs by default).
    setChatGPTLocation(CHATGPT_ID);
    loadFixture(`
      <div class="flex flex-col text-sm">
        <section data-turn-id="t1" data-turn="user">
          <div data-message-author-role="user" data-message-id="m1">
            <div class="composer-attachment-bar">unrelated chrome text that must not be exported</div>
            <div class="whitespace-pre-wrap">hello</div>
          </div>
        </section>
      </div>
    `);

    const result = await new ChatGPTExtractor().extract();
    const user = result.data?.messages.find(m => m.role === 'user');
    expect(user?.attachments).toBeUndefined();
  });

  it('ChatGPT: captures an image attachment on a user turn', async () => {
    setChatGPTLocation(CHATGPT_ID);
    loadFixture(`
      <div class="flex flex-col text-sm">
        <section data-turn-id="t1" data-turn="user">
          <div data-message-author-role="user" data-message-id="m1">
            <div data-testid="image-attachment">
              <img src="blob:x" alt="uploaded" />
              <figcaption>photo.png</figcaption>
            </div>
            <div class="whitespace-pre-wrap">look</div>
          </div>
        </section>
      </div>
    `);

    const result = await new ChatGPTExtractor().extract();
    const user = result.data?.messages.find(m => m.role === 'user');
    const photo = user?.attachments?.find(a => a.name === 'photo.png');
    expect(photo).toBeDefined();
    expect(photo?.kind).toBe('image');
  });
});

describe('formatAttachments', () => {
  const baseOptions: TemplateOptions = {
    includeId: true,
    includeTitle: true,
    includeTags: true,
    includeSource: true,
    includeDates: true,
    includeMessageCount: true,
    messageFormat: 'callout',
    userCalloutType: 'QUESTION',
    assistantCalloutType: 'NOTE',
  };

  const atts: MessageAttachment[] = [
    { name: 'data.csv', kind: 'file' },
    { name: 'PASTED', kind: 'paste', text: 'line one\nline two' },
  ];

  it('returns empty string for no attachments', () => {
    expect(formatAttachments([], baseOptions)).toBe('');
  });

  it('renders a collapsible callout with names and inline paste text', () => {
    const out = formatAttachments(atts, baseOptions);
    expect(out.startsWith('> [!INFO]- Attachments')).toBe(true);
    expect(out).toContain('data.csv');
    expect(out).toContain('PASTED');
    expect(out).toContain('line one');
    expect(out).toContain('line two');
  });

  it('renders plain format without callout syntax', () => {
    const out = formatAttachments(atts, { ...baseOptions, messageFormat: 'plain' });
    expect(out).toContain('**Attachments**');
    expect(out).not.toContain('[!INFO]');
    expect(out).toContain('data.csv');
  });
});
