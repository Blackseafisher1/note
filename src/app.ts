import { readStorage, writeStorage } from './storage';

type EditorMode = 'textarea' | 'markdown' | 'code';

interface SyntaxRule {
  pattern: string;
  scope: string;
  patternFlags?: string;
}

interface SyntaxLanguage {
  id: string;
  extensions: string[];
  aliases: string[];
  rules: SyntaxRule[];
}

interface SyntaxConfig {
  languages: SyntaxLanguage[];
}

interface AppState {
  files: Record<string, string>;
  folders: string[];
  collapsed: Record<string, boolean>;
  active: string;
  leftPaneWidth: number;
  darkTheme: boolean;
  saveDelaySeconds: number;
  lineNumbers: boolean;
  editorFont: 'system' | 'jetbrains';
}

interface TreeNode {
  name?: string;
  path?: string;
  folders: Record<string, TreeNode>;
  files: { name: string; path: string }[];
}

interface CtxMenuItem {
  label: string;
  danger?: boolean;
  action: () => void;
}

const STORAGE_KEY = 'notes_app_state_v2';
const DEFAULT_FILE = 'tmp';
const DEFAULT_SAVE_DELAY_SECONDS = 5;
const MAX_SAVE_DELAY_SECONDS = 86400;
const DEFAULT_LEFT_PANE_WIDTH = 220;

const container = document.querySelector<HTMLElement>('.split-con')!;
const leftPane = document.getElementById('leftPane')!;
const editorWrap = document.querySelector<HTMLElement>('.editor-wrap')!;
const textEditor = document.getElementById('textEditor') as HTMLTextAreaElement;
const richEditor = document.getElementById('richEditor') as HTMLDivElement;
const saveStatusEl = document.getElementById('saveStatus')!;
const cursorStatusEl = document.getElementById('cursorStatus')!;
const syntaxStatusEl = document.getElementById('syntaxStatus')!;
const lineGutterLines = document.getElementById('lineGutterLines')!;
const runJsBtn = document.getElementById('runJsBtn') as HTMLButtonElement;
const strip = document.getElementById('dragStrip')!;
const fileListEl = document.getElementById('fileList')!;
const newFileBtn = document.getElementById('newFileBtn')!;
const newFolderBtn = document.getElementById('newFolderBtn')!;
const settingsBtn = document.getElementById('settingsBtn') as HTMLButtonElement;
const settingsDialog = document.getElementById('settingsDialog') as HTMLDialogElement;
const settingsCloseBtn = document.getElementById('settingsCloseBtn') as HTMLButtonElement;
const darkThemeToggle = document.getElementById('darkThemeToggle') as HTMLInputElement;
const lineNumbersToggle = document.getElementById('lineNumbersToggle') as HTMLInputElement;
const editorFontSelect = document.getElementById('editorFont') as HTMLSelectElement;
const saveDelayInput = document.getElementById('saveDelaySeconds') as HTMLInputElement;
const ctxMenu = document.getElementById('ctxMenu')!;
let appReady = false;

container.setAttribute('inert', '');
container.setAttribute('aria-busy', 'true');
saveStatusEl.textContent = 'Loading...';

// --- Resizable split bar + native resize sync ---
let dragging = false;

function syncStrip(): void {
  strip.style.left = `${leftPane.offsetWidth}px`;
}

function clampLeftPaneWidth(width: number): number {
  const minLeft = parseFloat(getComputedStyle(leftPane).minWidth) || 0;
  const minRight = parseFloat(getComputedStyle(editorWrap).minWidth) || 0;
  const availableWidth = container.clientWidth || window.innerWidth;
  const maxLeft = Math.max(minLeft, availableWidth - minRight);
  return Math.max(minLeft, Math.min(width, maxLeft));
}

strip.addEventListener('mousedown', (e: MouseEvent) => {
  e.preventDefault();
  dragging = true;
  strip.classList.add('active');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e: MouseEvent) => {
  if (!dragging) return;
  const rawWidth = e.clientX - container.getBoundingClientRect().left;
  const clampedWidth = clampLeftPaneWidth(rawWidth);
  leftPane.style.width = `${clampedWidth}px`;
  syncStrip();
});

document.addEventListener('mouseup', () => {
  if (!appReady) return;
  if (dragging) {
    dragging = false;
    strip.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  const width = leftPane.offsetWidth;
  if (state.leftPaneWidth !== width) {
    state.leftPaneWidth = width;
    persistAll();
  }
});

new ResizeObserver(syncStrip).observe(leftPane);
window.addEventListener('resize', syncStrip);
syncStrip();

// --- File type detection ---
let syntaxLanguages: SyntaxLanguage[] = [];
let syntaxConfigError: string | null = null;
let storageError: string | null = null;
let storageReady = false;

function findSyntaxLanguage(name: string): SyntaxLanguage | undefined {
  const normalized = name.toLowerCase();
  return syntaxLanguages.find((language) =>
    language.id.toLowerCase() === normalized ||
    language.aliases.some((alias) => alias.toLowerCase() === normalized) ||
    language.extensions.some((extension) => extension.toLowerCase() === normalized)
  );
}

function detectEditorMode(filePath: string): EditorMode {
  const baseName = (filePath.split('/').pop() || '').toLowerCase();
  const dotIdx = baseName.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = baseName.slice(dotIdx + 1);
    if (ext === 'md' || ext === 'markdown') {
      return 'markdown';
    }
    if (findSyntaxLanguage(ext)) {
      return 'code';
    }
  }

  // Default for .txt or any unrecognized filename
  return 'textarea';
}

// --- JSON-configured syntax and Markdown highlighters ---
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function compileSyntaxPattern(rule: SyntaxRule): RegExp {
  const flags = [...new Set((rule.patternFlags || '').replace(/[gy]/g, ''))].join('');
  return new RegExp(rule.pattern, `${flags}y`);
}

function highlightCode(rawText: string, languageName: string | undefined): string {
  const language = languageName ? findSyntaxLanguage(languageName) : undefined;
  if (!language) return `<span class="md-code-block">${escapeHtml(rawText)}</span>`;

  const compiledRules = language.rules.map((rule) => ({
    scope: rule.scope,
    pattern: compileSyntaxPattern(rule),
  }));
  let html = '';
  let cursor = 0;
  while (cursor < rawText.length) {
    let matched = false;
    for (const rule of compiledRules) {
      rule.pattern.lastIndex = cursor;
      const match = rule.pattern.exec(rawText);
      if (!match || match.index !== cursor || match[0].length === 0) continue;
      html += `<span class="tok-${rule.scope}">${escapeHtml(match[0])}</span>`;
      cursor += match[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      html += escapeHtml(rawText[cursor]);
      cursor += 1;
    }
  }
  return html;
}

function highlightInlineMarkdown(rawLine: string): string {
  const tokenPattern = /(`[^`\n]+`|\[[^\]\n]+\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\s](?:[^*]*[^*\s])?\*|_[^_\s](?:[^_]*[^_\s])?_)/g;
  let html = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(rawLine)) !== null) {
    html += escapeHtml(rawLine.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      html += `<span class="md-code">${escapeHtml(token)}</span>`;
    } else if (token.startsWith('[')) {
      html += `<span class="md-link">${escapeHtml(token)}</span>`;
    } else if (token.startsWith('~~')) {
      html += `<span class="md-strike">${escapeHtml(token)}</span>`;
    } else if (token.startsWith('**') || token.startsWith('__')) {
      html += `<span class="md-bold">${escapeHtml(token)}</span>`;
    } else {
      html += `<span class="md-italic">${escapeHtml(token)}</span>`;
    }
    cursor = match.index + token.length;
  }
  return html + escapeHtml(rawLine.slice(cursor));
}

function renderMarkdownHtml(rawText: string): string {
  const lines = rawText.split('\n');
  let fence: { marker: string; length: number; language?: string; body: string[] } | null = null;
  const htmlLines: string[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (fence) {
      const closeMatch = line.match(/^\s*(`+|~+)\s*$/);
      if (closeMatch && closeMatch[1][0] === fence.marker && closeMatch[1].length >= fence.length) {
        if (fence.body.length > 0) htmlLines.push(highlightCode(fence.body.join('\n'), fence.language));
        htmlLines.push(`<span class="md-fence">${escapeHtml(line)}</span>`);
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }

    const openMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (openMatch) {
      const info = openMatch[2].trim().split(/\s+/, 1)[0];
      fence = { marker: openMatch[1][0], length: openMatch[1].length, language: info || undefined, body: [] };
      htmlLines.push(`<span class="md-fence">${escapeHtml(line)}</span>`);
      continue;
    }

    const headingMatch = line.match(/^(\s*#{1,6}\s+)(.*)$/);
    if (headingMatch) {
      htmlLines.push(`<span class="md-syntax">${escapeHtml(headingMatch[1])}</span><span class="md-h">${highlightInlineMarkdown(headingMatch[2])}</span>`);
      continue;
    }

    const quoteMatch = line.match(/^(\s*&gt;\s?|\s*>\s?)(.*)$/);
    if (quoteMatch) {
      htmlLines.push(`<span class="md-syntax">${escapeHtml(quoteMatch[1])}</span><span class="md-quote">${highlightInlineMarkdown(quoteMatch[2])}</span>`);
      continue;
    }

    const listMatch = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/);
    if (listMatch) {
      const taskMatch = listMatch[2].match(/^(\[[ xX]\]\s+)(.*)$/);
      const marker = taskMatch ? `<span class="md-task">${escapeHtml(taskMatch[1])}</span>` : '';
      htmlLines.push(`<span class="md-list">${escapeHtml(listMatch[1])}</span>${marker}${highlightInlineMarkdown(taskMatch ? taskMatch[2] : listMatch[2])}`);
      continue;
    }

    if (/^\s*(?:([-*_])\s*){3,}$/.test(line)) {
      htmlLines.push(`<span class="md-syntax">${escapeHtml(line)}</span>`);
      continue;
    }

    const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    if (tableSeparator) {
      htmlLines.push(`<span class="md-table-separator">${escapeHtml(line)}</span>`);
      continue;
    }

    if (line.includes('|')) {
      const isTableHeader = lines[lineIndex + 1] !== undefined &&
        /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[lineIndex + 1]);
      const cells = line.split('|');
      htmlLines.push(cells.map((cell, cellIndex) => {
        const pipe = cellIndex > 0 ? '<span class="md-table-pipe">|</span>' : '';
        const content = highlightInlineMarkdown(cell);
        return `${pipe}${isTableHeader ? `<span class="md-table-header">${content}</span>` : content}`;
      }).join(''));
      continue;
    }

    htmlLines.push(highlightInlineMarkdown(line));
  }

  if (fence && fence.body.length > 0) htmlLines.push(highlightCode(fence.body.join('\n'), fence.language));
  return htmlLines.join('\n');
}

function loadSyntaxConfig(): void {
  fetch('./syntax-highlighting.json')
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load syntax-highlighting.json (${response.status})`);
      return response.json() as Promise<SyntaxConfig>;
    })
    .then((config) => {
      if (!config || !Array.isArray(config.languages)) {
        throw new Error('syntax-highlighting.json must contain a languages array');
      }
      for (const language of config.languages) {
        if (
          !language || typeof language.id !== 'string' ||
          !Array.isArray(language.extensions) || !Array.isArray(language.aliases) ||
          !language.extensions.every((extension) => typeof extension === 'string') ||
          !language.aliases.every((alias) => typeof alias === 'string') ||
          !Array.isArray(language.rules)
        ) {
          throw new Error('Each syntax language needs an id, extensions, aliases, and rules');
        }
        for (const rule of language.rules) {
          if (
            !rule || typeof rule.pattern !== 'string' ||
            typeof rule.scope !== 'string' || !/^[a-z][a-z0-9-]*$/.test(rule.scope) ||
            (rule.patternFlags !== undefined && typeof rule.patternFlags !== 'string')
          ) {
            throw new Error(`Invalid syntax rule in language "${language.id}"`);
          }
          compileSyntaxPattern(rule);
        }
      }
      syntaxLanguages = config.languages;
      setEditorForFile(state.active, getEditorValue());
    })
    .catch((error: unknown) => {
      console.error('Syntax highlighting configuration could not be loaded.', error);
      syntaxConfigError = 'Syntax highlighting could not be loaded. Check syntax-highlighting.json and reload.';
      setSaveStatus('saved');
    });
}

// --- Caret offset preservation for contenteditable ---
interface CharacterSelection {
  start: number;
  end: number;
}

interface PairedEdit extends CharacterSelection {
  text: string;
  changed: boolean;
}

const AUTO_CLOSE_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
  "'": "'",
  '"': '"',
  '`': '`',
};

function getSelectionCharacterOffsets(element: HTMLElement): CharacterSelection {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return { start: 0, end: 0 };

  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return { start: 0, end: 0 };

  const startRange = range.cloneRange();
  startRange.selectNodeContents(element);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = range.cloneRange();
  endRange.selectNodeContents(element);
  endRange.setEnd(range.endContainer, range.endOffset);
  return { start: startRange.toString().length, end: endRange.toString().length };
}

function getCaretCharacterOffset(element: HTMLElement): number {
  return getSelectionCharacterOffsets(element).end;
}

function getTextPosition(element: HTMLElement, targetOffset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = targetOffset;
  let currentNode = walker.nextNode() as Text | null;
  let lastNode: Text | null = null;

  while (currentNode) {
    lastNode = currentNode;
    const length = currentNode.nodeValue?.length ?? 0;
    if (remaining <= length) return { node: currentNode, offset: remaining };
    remaining -= length;
    currentNode = walker.nextNode() as Text | null;
  }

  return lastNode ? { node: lastNode, offset: lastNode.length } : null;
}

function setSelectionCharacterOffsets(element: HTMLElement, startOffset: number, endOffset: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  const start = getTextPosition(element, startOffset);
  const end = getTextPosition(element, endOffset);
  const range = document.createRange();
  if (start && end) {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } else {
    range.selectNodeContents(element);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function setCaretCharacterOffset(element: HTMLElement, targetOffset: number): void {
  setSelectionCharacterOffsets(element, targetOffset, targetOffset);
}

function getPairedEdit(text: string, start: number, end: number, key: string): PairedEdit | null {
  if (start === end && Object.values(AUTO_CLOSE_PAIRS).includes(key) && text[start] === key) {
    return { text, start: start + 1, end: start + 1, changed: false };
  }

  if (key === 'Backspace' && start === end && start > 0) {
    const opener = text[start - 1];
    if (AUTO_CLOSE_PAIRS[opener] && text[start] === AUTO_CLOSE_PAIRS[opener]) {
      return {
        text: text.slice(0, start - 1) + text.slice(start + 1),
        start: start - 1,
        end: start - 1,
        changed: true,
      };
    }
    return null;
  }

  const closer = AUTO_CLOSE_PAIRS[key];
  if (!closer) return null;
  if (key === "'" && start === end && /\w/.test(text[start - 1] || '') && /\w/.test(text[end] || '')) {
    return null;
  }
  if (start === end && text[start] === closer) return null;

  const selectedText = text.slice(start, end);
  return {
    text: text.slice(0, start) + key + selectedText + closer + text.slice(end),
    start: start + 1,
    end: start + 1 + selectedText.length,
    changed: true,
  };
}

function getEnterEdit(text: string, start: number, end: number): PairedEdit | null {
  const opener = text[start - 1];
  const closer = AUTO_CLOSE_PAIRS[opener];
  if (start !== end || !closer || text[end] !== closer) return null;

  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const linePrefix = text.slice(lineStart, start);
  const baseIndent = linePrefix.match(/^[\t ]*/)?.[0] ?? '';
  const innerIndent = `${baseIndent}  `;
  const insertion = `\n${innerIndent}\n${baseIndent}`;
  const caret = start + 1 + innerIndent.length;
  return {
    text: text.slice(0, start) + insertion + text.slice(end),
    start: caret,
    end: caret,
    changed: true,
  };
}

// --- Unified editor read/write ---
let activeMode: EditorMode = 'textarea';

function getEditorValue(): string {
  if (activeMode !== 'textarea') {
    // Normalize innerText/textContent without trailing synthetic newline
    return (richEditor.textContent ?? '').replace(/\r\n/g, '\n');
  }
  return textEditor.value;
}

function renderRichEditorHtml(rawText: string): string {
  if (activeMode === 'markdown') return renderMarkdownHtml(rawText);
  const baseName = state.active.split('/').pop() || '';
  const extension = baseName.includes('.') ? baseName.slice(baseName.lastIndexOf('.') + 1) : '';
  return highlightCode(rawText, findSyntaxLanguage(extension)?.id);
}

function setEditorForFile(filePath: string, content: string): void {
  activeMode = detectEditorMode(filePath);
  const spellcheck = activeMode === 'markdown';
  textEditor.spellcheck = spellcheck;
  richEditor.spellcheck = spellcheck;

  if (activeMode !== 'textarea') {
    textEditor.hidden = true;
    richEditor.hidden = false;
    richEditor.innerHTML = renderRichEditorHtml(content);
  } else {
    richEditor.hidden = true;
    textEditor.hidden = false;
    textEditor.value = content;
  }
  refreshEditorStatus();
}

function focusActiveEditor(): void {
  if (activeMode !== 'textarea') {
    richEditor.focus();
  } else {
    textEditor.focus();
  }
}

// --- State, Hash Routing & Persistence ---
let saveTimer: number | null = null;

function getFileFromHash(): string | null {
  const rawHash = window.location.hash.replace(/^#/, '');
  if (!rawHash) return null;
  try {
    return decodeURIComponent(rawHash);
  } catch {
    return rawHash;
  }
}

function syncHash(filePath: string): void {
  const encoded = `#${encodeURI(filePath)}`;
  if (window.location.hash !== encoded) {
    history.replaceState(null, '', encoded);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadState(raw: unknown): AppState {
  let base: AppState = {
    files: { [DEFAULT_FILE]: '' },
    folders: [],
    collapsed: {},
    active: DEFAULT_FILE,
    leftPaneWidth: DEFAULT_LEFT_PANE_WIDTH,
    darkTheme: false,
    saveDelaySeconds: DEFAULT_SAVE_DELAY_SECONDS,
    lineNumbers: false,
    editorFont: 'system',
  };

  if (isRecord(raw) && isRecord(raw.files)) {
    const files: Record<string, string> = { [DEFAULT_FILE]: '' };
    for (const [path, content] of Object.entries(raw.files)) {
      if (typeof content === 'string') files[path] = content;
    }

    const collapsed: Record<string, boolean> = {};
    if (isRecord(raw.collapsed)) {
      for (const [path, isCollapsed] of Object.entries(raw.collapsed)) {
        if (typeof isCollapsed === 'boolean') collapsed[path] = isCollapsed;
      }
    }

    base = {
      files,
      folders: Array.isArray(raw.folders)
        ? raw.folders.filter((folder): folder is string => typeof folder === 'string')
        : [],
      collapsed,
      active: typeof raw.active === 'string' ? raw.active : DEFAULT_FILE,
      leftPaneWidth: typeof raw.leftPaneWidth === 'number' && Number.isFinite(raw.leftPaneWidth)
        ? raw.leftPaneWidth
        : DEFAULT_LEFT_PANE_WIDTH,
      darkTheme: raw.darkTheme === true,
      saveDelaySeconds: typeof raw.saveDelaySeconds === 'number' &&
        Number.isInteger(raw.saveDelaySeconds) &&
        raw.saveDelaySeconds >= 0 &&
        raw.saveDelaySeconds <= MAX_SAVE_DELAY_SECONDS
        ? raw.saveDelaySeconds
        : DEFAULT_SAVE_DELAY_SECONDS,
      lineNumbers: raw.lineNumbers === true,
      editorFont: raw.editorFont === 'jetbrains' ? 'jetbrains' : 'system',
    };
  }

  // If URL has #<filename> and that file exists, open it on load
  const hashFile = getFileFromHash();
  if (hashFile && Object.prototype.hasOwnProperty.call(base.files, hashFile)) {
    base.active = hashFile;
  } else if (!Object.prototype.hasOwnProperty.call(base.files, base.active)) {
    base.active = DEFAULT_FILE;
  }

  return base;
}

let state: AppState = loadState(null);

interface SyntaxResult {
  valid: boolean;
  error: string | null;
  line: number | null;
}

function findUnmatchedCloserLine(source: string, closer: string): number | null {
  const expectedOpeners: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: { character: string; line: number }[] = [];
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let line = 1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '\n') {
      line += 1;
      lineComment = false;
      if (quote && quote !== '`') quote = '';
      escaped = false;
      continue;
    }
    if (lineComment) continue;
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(' || character === '[' || character === '{') {
      stack.push({ character, line });
    } else if (character === ')' || character === ']' || character === '}') {
      const opener = stack.pop();
      if (!opener || opener.character !== expectedOpeners[character]) {
        if (character === closer) return line;
      }
    }
  }
  return null;
}

function findSyntaxErrorLine(source: string, message: string, error: unknown): number {
  const reportedLine = typeof error === 'object' && error !== null && 'lineNumber' in error
    ? Number((error as { lineNumber: unknown }).lineNumber)
    : NaN;
  const lines = source.split(/\r?\n/);
  if (Number.isInteger(reportedLine) && reportedLine > 0) {
    return Math.min(reportedLine, lines.length);
  }

  const findLine = (pattern: RegExp): number | null => {
    const index = lines.findIndex((line) => pattern.test(line));
    return index < 0 ? null : index + 1;
  };
  const lastNonEmptyLine = (): number => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim()) return index + 1;
    }
    return 1;
  };

  if (/Function statements require a function name/i.test(message)) {
    return findLine(/\bfunction\s*\*?\s*\(/) ?? lastNonEmptyLine();
  }
  if (/unexpected end of input|end of input/i.test(message)) return lastNonEmptyLine();
  if (/Unexpected token ['"]=['"]/.test(message)) {
    return findLine(/\b(?:const|let|var)\s*=/) ??
      findLine(/=\s*[;,)}]/) ??
      lastNonEmptyLine();
  }
  if (/Unexpected token ['"];['"]/.test(message)) {
    return findLine(/=\s*;/) ?? lastNonEmptyLine();
  }

  const tokenMatch = message.match(/Unexpected (?:token|identifier) ['"](.+?)['"]/);
  if (tokenMatch) {
    const token = tokenMatch[1];
    if ([')', ']', '}'].includes(token)) {
      return findUnmatchedCloserLine(source, token) ??
        lines.map((line, index) => line.includes(token) ? index + 1 : 0).filter(Boolean).pop() ??
        lastNonEmptyLine();
    }
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/Unexpected identifier/.test(message)) {
      const adjacentIdentifier = findLine(new RegExp(`\\b[A-Za-z_$][\\w$]*\\s+${escapedToken}\\b`));
      if (adjacentIdentifier) return adjacentIdentifier;
    }
    const lastTokenLine = lines.map((line, index) => line.includes(token) ? index + 1 : 0)
      .filter(Boolean)
      .pop();
    if (lastTokenLine) return lastTokenLine;
    return findLine(new RegExp(escapedToken)) ?? lastNonEmptyLine();
  }

  return lastNonEmptyLine();
}

function checkSyntax(userCode: string): SyntaxResult {
  try {
    new Function(userCode);
    return { valid: true, error: null, line: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      error: message,
      line: findSyntaxErrorLine(userCode, message, error),
    };
  }
}

function isJavaScriptFile(): boolean {
  const fileName = state.active.split('/').pop() || '';
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : '';
  return ['js', 'mjs', 'cjs'].includes(extension);
}

function applyEditorSettings(): void {
  editorWrap.classList.toggle('line-numbers', state.lineNumbers);
  editorWrap.style.setProperty(
    '--editor-font',
    state.editorFont === 'jetbrains'
      ? '"JetBrains Mono", ui-monospace, monospace'
      : 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
  );
  lineNumbersToggle.checked = state.lineNumbers;
  editorFontSelect.value = state.editorFont;
  refreshEditorStatus();
}

function getCaretOffset(): number {
  return activeMode === 'textarea'
    ? textEditor.selectionStart
    : getCaretCharacterOffset(richEditor);
}

function updateCursorStatus(): void {
  const source = getEditorValue();
  const beforeCaret = source.slice(0, getCaretOffset());
  const line = beforeCaret.split('\n').length;
  const lastNewline = beforeCaret.lastIndexOf('\n');
  const column = beforeCaret.length - lastNewline;
  cursorStatusEl.textContent = `Ln ${line}, Col ${column}`;
}

function updateLineGutter(errorLine: number | null, errorMessage: string | null): void {
  const source = getEditorValue();
  const lineCount = source.split('\n').length;
  const fragment = document.createDocumentFragment();
  for (let line = 1; line <= lineCount; line += 1) {
    const lineElement = document.createElement('div');
    lineElement.className = line === errorLine ? 'gutter-line error-line' : 'gutter-line';
    lineElement.textContent = String(line);
    if (line === errorLine && errorMessage) lineElement.title = errorMessage;
    fragment.appendChild(lineElement);
  }
  lineGutterLines.replaceChildren(fragment);
  const activeEditor = activeMode === 'textarea' ? textEditor : richEditor;
  lineGutterLines.style.transform = `translateY(${-activeEditor.scrollTop}px)`;
}

function refreshEditorStatus(): void {
  const isJavaScript = isJavaScriptFile();
  runJsBtn.hidden = !isJavaScript;
  syntaxStatusEl.classList.remove('valid');

  let errorLine: number | null = null;
  let errorMessage: string | null = null;
  if (isJavaScript) {
    const result = checkSyntax(getEditorValue());
    if (result.valid) {
      syntaxStatusEl.textContent = 'Syntax OK';
      syntaxStatusEl.title = '';
      syntaxStatusEl.classList.add('valid');
    } else {
      syntaxStatusEl.textContent = `Line ${result.line}: ${result.error}`;
      syntaxStatusEl.title = `Line ${result.line}: ${result.error}`;
      errorLine = result.line;
      errorMessage = result.error;
    }
  } else {
    syntaxStatusEl.textContent = '';
    syntaxStatusEl.title = '';
  }

  updateCursorStatus();
  updateLineGutter(errorLine, errorMessage);
}

function setSaveStatus(status: 'saved' | 'dirty'): void {
  const errorLabels: string[] = [];
  const errorMessages: string[] = [];
  if (storageError) {
    errorLabels.push('storage');
    errorMessages.push(storageError);
  }
  if (syntaxConfigError) {
    errorLabels.push('syntax');
    errorMessages.push(syntaxConfigError);
  }

  if (errorLabels.length > 0) {
    const saveLabel = status === 'dirty' ? 'Unsaved' : 'Saved';
    saveStatusEl.textContent = `${saveLabel} / ${errorLabels.join(' and ')} error`;
    saveStatusEl.title = errorMessages.join('\n');
    saveStatusEl.classList.add('error');
    if (status === 'dirty') saveStatusEl.classList.add('dirty');
    else saveStatusEl.classList.remove('dirty');
    return;
  }

  saveStatusEl.title = '';
  saveStatusEl.classList.remove('error');
  if (status === 'dirty') {
    saveStatusEl.textContent = 'Unsaved...';
    saveStatusEl.classList.add('dirty');
  } else {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    saveStatusEl.textContent = `File saved (${time})`;
    saveStatusEl.classList.remove('dirty');
  }
}

function reportStorageError(error: unknown): void {
  console.error('Could not access persistent notes storage.', error);
  storageError = 'Notes could not be loaded or saved in IndexedDB.';
  setSaveStatus('dirty');
}

let persistenceQueue: Promise<void> = Promise.resolve();

function persistAll(showSavedStatus = false): void {
  if (!storageReady) return;

  const snapshot: AppState = {
    files: { ...state.files },
    folders: [...state.folders],
    collapsed: { ...state.collapsed },
    active: state.active,
    leftPaneWidth: state.leftPaneWidth,
    darkTheme: state.darkTheme,
    saveDelaySeconds: state.saveDelaySeconds,
    lineNumbers: state.lineNumbers,
    editorFont: state.editorFont,
  };

  persistenceQueue = persistenceQueue.then(() =>
    writeStorage(STORAGE_KEY, snapshot)
  ).then(
    () => {
      const hadStorageError = storageError !== null;
      storageError = null;
      if (showSavedStatus || hadStorageError) setSaveStatus('saved');
    },
    (error: unknown) => reportStorageError(error)
  );
}

function saveNow(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state.files[state.active] = getEditorValue();
  persistAll(true);
}

function scheduleSave(): void {
  setSaveStatus('dirty');
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (state.saveDelaySeconds === 0) return;

  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    state.files[state.active] = getEditorValue();
    persistAll(true);
  }, state.saveDelaySeconds * 1000);
}

// --- Tree Rendering & File Operations ---
function cleanName(raw: string | null): string {
  return (raw || '').trim().replace(/^\/+|\/+$/g, '').replace(/\//g, '-');
}

function ensureParentFolders(filePath: string): void {
  const parts = filePath.split('/');
  parts.pop();
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    if (!state.folders.includes(acc)) state.folders.push(acc);
  }
}

function buildTree(): TreeNode {
  const root: TreeNode = { folders: {}, files: [] };

  for (const folderPath of [...state.folders].sort()) {
    const parts = folderPath.split('/');
    let node = root;
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.folders[part]) {
        node.folders[part] = { name: part, path: currentPath, folders: {}, files: [] };
      }
      node = node.folders[part];
    }
  }

  const fileKeys = Object.keys(state.files).sort((a, b) => {
    if (a === DEFAULT_FILE) return -1;
    if (b === DEFAULT_FILE) return 1;
    return a.localeCompare(b);
  });

  for (const filePath of fileKeys) {
    const parts = filePath.split('/');
    const fileName = parts.pop()!;
    let node = root;
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.folders[part]) {
        node.folders[part] = { name: part, path: currentPath, folders: {}, files: [] };
      }
      node = node.folders[part];
    }
    node.files.push({ name: fileName, path: filePath });
  }

  return root;
}

function renderNode(node: TreeNode, ulEl: HTMLUListElement): void {
  Object.values(node.folders).forEach((folder) => {
    const folderPath = folder.path!;
    const li = document.createElement('li');
    const isCollapsed = !!state.collapsed[folderPath];

    const a = document.createElement('a');
    a.href = '#';
    a.className = 'folder-row';
    a.dataset.type = 'folder';
    a.dataset.path = folderPath;
    a.textContent = `${isCollapsed ? '▸' : '▾'} ${folder.name}`;
    li.appendChild(a);

    if (!isCollapsed) {
      const childUl = document.createElement('ul');
      renderNode(folder, childUl);
      li.appendChild(childUl);
    }
    ulEl.appendChild(li);
  });

  node.files.forEach((file) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    if (file.path === DEFAULT_FILE) a.id = DEFAULT_FILE;
    a.href = `#${encodeURI(file.path)}`;
    a.dataset.type = 'file';
    a.dataset.path = file.path;
    a.textContent = file.name;
    if (file.path === state.active) a.classList.add('active');
    li.appendChild(a);
    ulEl.appendChild(li);
  });
}

function renderFileList(): void {
  fileListEl.innerHTML = '';
  renderNode(buildTree(), fileListEl as HTMLUListElement);
}

function applyTheme(isDark: boolean): void {
  document.body.classList.toggle('dark-theme', isDark);
  darkThemeToggle.checked = isDark;
}

function selectFile(path: string, shouldSaveCurrent = true): void {
  if (!Object.prototype.hasOwnProperty.call(state.files, path)) return;
  if (shouldSaveCurrent) {
    saveNow();
  }
  state.active = path;
  ensureParentFolders(path);
  setEditorForFile(path, state.files[path] ?? '');
  syncHash(path);
  persistAll(true);
  renderFileList();
}

function createNewFile(folderPrefix = ''): void {
  const name = cleanName(prompt(folderPrefix ? `New file in "${folderPrefix}":` : 'File name (e.g. readme.md):'));
  if (!name) return;
  const fullPath = folderPrefix ? `${folderPrefix}/${name}` : name;

  saveNow();
  ensureParentFolders(fullPath);
  if (folderPrefix) delete state.collapsed[folderPrefix];
  if (!Object.prototype.hasOwnProperty.call(state.files, fullPath)) {
    state.files[fullPath] = '';
  }
  selectFile(fullPath, false);
  focusActiveEditor();
}

function createNewFolder(parentPrefix = ''): void {
  const name = cleanName(prompt(parentPrefix ? `New subfolder in "${parentPrefix}":` : 'Folder name:'));
  if (!name) return;
  const fullPath = parentPrefix ? `${parentPrefix}/${name}` : name;

  if (parentPrefix) delete state.collapsed[parentPrefix];
  if (!state.folders.includes(fullPath)) {
    state.folders.push(fullPath);
  }
  persistAll();
  renderFileList();
}

function renameFile(oldPath: string): void {
  if (oldPath === DEFAULT_FILE) return;
  const parts = oldPath.split('/');
  const oldName = parts.pop()!;
  const prefix = parts.join('/');
  const newName = cleanName(prompt('Rename file:', oldName));
  if (!newName || newName === oldName) return;

  const newPath = prefix ? `${prefix}/${newName}` : newName;
  if (Object.prototype.hasOwnProperty.call(state.files, newPath)) {
    alert('A file with that name already exists.');
    return;
  }

  saveNow();
  state.files[newPath] = state.files[oldPath];
  delete state.files[oldPath];
  if (state.active === oldPath) {
    selectFile(newPath, false);
  } else {
    persistAll();
    renderFileList();
  }
}

function moveFileToFolder(filePath: string): void {
  if (filePath === DEFAULT_FILE) return;
  const baseName = filePath.split('/').pop()!;
  const target = (prompt('Move to folder path (leave empty for root):', '') || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  const newPath = target ? `${target}/${baseName}` : baseName;
  if (newPath === filePath) return;

  if (Object.prototype.hasOwnProperty.call(state.files, newPath)) {
    alert('A file with that name already exists in the target folder.');
    return;
  }

  saveNow();
  ensureParentFolders(newPath);
  state.files[newPath] = state.files[filePath];
  delete state.files[filePath];
  if (state.active === filePath) {
    selectFile(newPath, false);
  } else {
    persistAll();
    renderFileList();
  }
}

function deleteFile(path: string): void {
  if (path === DEFAULT_FILE) return;
  if (!confirm(`Delete file "${path}"?`)) return;

  delete state.files[path];
  if (state.active === path) {
    selectFile(DEFAULT_FILE, false);
  } else {
    persistAll();
    renderFileList();
  }
}

function renameFolder(oldPath: string): void {
  const parts = oldPath.split('/');
  const oldName = parts.pop()!;
  const prefix = parts.join('/');
  const newName = cleanName(prompt('Rename folder:', oldName));
  if (!newName || newName === oldName) return;

  const newPath = prefix ? `${prefix}/${newName}` : newName;
  if (state.folders.includes(newPath)) {
    alert('A folder with that name already exists.');
    return;
  }

  saveNow();
  const swapPrefix = (p: string): string =>
    p === oldPath ? newPath : p.startsWith(`${oldPath}/`) ? `${newPath}${p.slice(oldPath.length)}` : p;

  state.folders = state.folders.map(swapPrefix);

  const nextFiles: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.files)) {
    nextFiles[swapPrefix(k)] = v;
  }
  state.files = nextFiles;
  state.active = swapPrefix(state.active);

  const nextCollapsed: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(state.collapsed)) {
    nextCollapsed[swapPrefix(k)] = v;
  }
  state.collapsed = nextCollapsed;

  syncHash(state.active);
  persistAll();
  renderFileList();
}

function deleteFolder(folderPath: string): void {
  if (!confirm(`Delete folder "${folderPath}" and all files inside it?`)) return;

  const isInside = (p: string): boolean => p === folderPath || p.startsWith(`${folderPath}/`);
  state.folders = state.folders.filter((f) => !isInside(f));

  for (const key of Object.keys(state.files)) {
    if (isInside(key) && key !== DEFAULT_FILE) {
      delete state.files[key];
    }
  }

  if (!Object.prototype.hasOwnProperty.call(state.files, state.active)) {
    selectFile(DEFAULT_FILE, false);
  } else {
    persistAll();
    renderFileList();
  }
}

// --- Context menu ---
function closeCtxMenu(): void {
  ctxMenu.classList.remove('open');
  ctxMenu.innerHTML = '';
}

function openCtxMenu(x: number, y: number, items: (CtxMenuItem | 'sep')[]): void {
  ctxMenu.innerHTML = '';
  items.forEach((item) => {
    if (item === 'sep') {
      ctxMenu.appendChild(document.createElement('hr'));
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    if (item.danger) btn.className = 'danger';
    btn.onclick = () => {
      closeCtxMenu();
      item.action();
    };
    ctxMenu.appendChild(btn);
  });

  ctxMenu.classList.add('open');
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
}

leftPane.addEventListener('contextmenu', (e: MouseEvent) => {
  e.preventDefault();
  const target = (e.target as HTMLElement).closest<HTMLElement>('a[data-type]');

  if (!target) {
    openCtxMenu(e.clientX, e.clientY, [
      { label: 'New file', action: () => createNewFile('') },
      { label: 'New folder', action: () => createNewFolder('') },
    ]);
    return;
  }

  const type = target.dataset.type;
  const path = target.dataset.path!;

  if (type === 'folder') {
    openCtxMenu(e.clientX, e.clientY, [
      { label: 'New file inside', action: () => createNewFile(path) },
      { label: 'New subfolder', action: () => createNewFolder(path) },
      'sep',
      { label: 'Rename folder', action: () => renameFolder(path) },
      { label: 'Delete folder', danger: true, action: () => deleteFolder(path) },
    ]);
  } else if (type === 'file') {
    if (path === DEFAULT_FILE) {
      openCtxMenu(e.clientX, e.clientY, [
        {
          label: 'Clear tmp buffer',
          action: () => {
            setEditorForFile(DEFAULT_FILE, '');
            saveNow();
          },
        },
      ]);
    } else {
      openCtxMenu(e.clientX, e.clientY, [
        { label: 'Rename file', action: () => renameFile(path) },
        { label: 'Move to folder...', action: () => moveFileToFolder(path) },
        'sep',
        { label: 'Delete file', danger: true, action: () => deleteFile(path) },
      ]);
    }
  }
});

document.addEventListener('click', (e: MouseEvent) => {
  if (!ctxMenu.contains(e.target as Node)) closeCtxMenu();
});
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeCtxMenu();
});

newFileBtn.addEventListener('click', () => createNewFile(''));
newFolderBtn.addEventListener('click', () => createNewFolder(''));

settingsBtn.addEventListener('click', () => {
  if (!settingsDialog.open) settingsDialog.showModal();
});
settingsCloseBtn.addEventListener('click', () => {
  if (settingsDialog.open) settingsDialog.close();
});
darkThemeToggle.addEventListener('change', () => {
  state.darkTheme = darkThemeToggle.checked;
  applyTheme(state.darkTheme);
  persistAll();
});
lineNumbersToggle.addEventListener('change', () => {
  state.lineNumbers = lineNumbersToggle.checked;
  applyEditorSettings();
  persistAll();
});
editorFontSelect.addEventListener('change', () => {
  state.editorFont = editorFontSelect.value === 'jetbrains' ? 'jetbrains' : 'system';
  applyEditorSettings();
  persistAll();
});
saveDelayInput.addEventListener('change', () => {
  const delaySeconds = saveDelayInput.valueAsNumber;
  if (
    !saveDelayInput.checkValidity() ||
    !Number.isInteger(delaySeconds) ||
    delaySeconds < 0 ||
    delaySeconds > MAX_SAVE_DELAY_SECONDS
  ) {
    saveDelayInput.reportValidity();
    saveDelayInput.value = String(state.saveDelaySeconds);
    return;
  }

  const hasUnsavedChanges = saveStatusEl.classList.contains('dirty');
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  state.saveDelaySeconds = delaySeconds;
  persistAll();
  if (delaySeconds > 0 && hasUnsavedChanges) scheduleSave();
});

fileListEl.addEventListener('click', (e: MouseEvent) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('a[data-type]');
  if (!link) return;
  e.preventDefault();

  if (link.dataset.type === 'folder') {
    const p = link.dataset.path!;
    if (state.collapsed[p]) delete state.collapsed[p];
    else state.collapsed[p] = true;
    persistAll();
    renderFileList();
  } else {
    selectFile(link.dataset.path!);
  }
});

// --- Editor Input & Keyboard Events ---
textEditor.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    textEditor.setRangeText('\t', textEditor.selectionStart, textEditor.selectionEnd, 'end');
    scheduleSave();
    refreshEditorStatus();
    return;
  }
  if (e.key === 'Enter' && activeMode === 'code') {
    const edit = getEnterEdit(textEditor.value, textEditor.selectionStart, textEditor.selectionEnd);
    if (edit) {
      e.preventDefault();
      textEditor.value = edit.text;
      textEditor.setSelectionRange(edit.start, edit.end);
      scheduleSave();
      refreshEditorStatus();
      return;
    }
  }
  const edit = getPairedEdit(textEditor.value, textEditor.selectionStart, textEditor.selectionEnd, e.key);
  if (!edit) return;

  e.preventDefault();
  textEditor.value = edit.text;
  textEditor.setSelectionRange(edit.start, edit.end);
  if (edit.changed) scheduleSave();
  refreshEditorStatus();
});

textEditor.addEventListener('input', () => {
  scheduleSave();
  refreshEditorStatus();
});
textEditor.addEventListener('click', refreshEditorStatus);
textEditor.addEventListener('keyup', refreshEditorStatus);
textEditor.addEventListener('select', refreshEditorStatus);
textEditor.addEventListener('scroll', refreshEditorStatus);

richEditor.addEventListener('input', () => {
  const caret = getCaretCharacterOffset(richEditor);
  const raw = getEditorValue();
  richEditor.innerHTML = renderRichEditorHtml(raw);
  setCaretCharacterOffset(richEditor, caret);
  scheduleSave();
  refreshEditorStatus();
});

// Ensure Enter inserts a clean newline inside contenteditable instead of <div>/<br> quirks
richEditor.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;

  const selection = getSelectionCharacterOffsets(richEditor);
  if (e.key === 'Tab') {
    e.preventDefault();
    const raw = getEditorValue();
    const next = raw.slice(0, selection.start) + '\t' + raw.slice(selection.end);
    richEditor.innerHTML = renderRichEditorHtml(next);
    setCaretCharacterOffset(richEditor, selection.start + 1);
    scheduleSave();
    refreshEditorStatus();
    return;
  }

  const edit = getPairedEdit(getEditorValue(), selection.start, selection.end, e.key);
  if (edit) {
    e.preventDefault();
    if (edit.changed) {
      richEditor.innerHTML = renderRichEditorHtml(edit.text);
      scheduleSave();
    }
    setSelectionCharacterOffsets(richEditor, edit.start, edit.end);
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    const raw = getEditorValue();
    const pairedEdit = activeMode === 'code'
      ? getEnterEdit(raw, selection.start, selection.end)
      : null;
    const next = pairedEdit?.text ??
      raw.slice(0, selection.start) + '\n' + raw.slice(selection.end);
    const caret = pairedEdit?.start ?? selection.start + 1;
    richEditor.innerHTML = renderRichEditorHtml(next);
    setCaretCharacterOffset(richEditor, caret);
    scheduleSave();
    refreshEditorStatus();
  }
});
richEditor.addEventListener('click', refreshEditorStatus);
richEditor.addEventListener('keyup', refreshEditorStatus);
richEditor.addEventListener('scroll', refreshEditorStatus);

// Paste plain text only into contenteditable
richEditor.addEventListener('paste', (e: ClipboardEvent) => {
  e.preventDefault();
  const pasted = (e.clipboardData?.getData('text/plain') || '').replace(/\r\n/g, '\n');
  const caret = getCaretCharacterOffset(richEditor);
  const raw = getEditorValue();
  const next = raw.slice(0, caret) + pasted + raw.slice(caret);
  richEditor.innerHTML = renderRichEditorHtml(next);
  setCaretCharacterOffset(richEditor, caret + pasted.length);
  scheduleSave();
});

runJsBtn.addEventListener('click', () => {
  if (!isJavaScriptFile()) return;
  const source = getEditorValue();
  const syntax = checkSyntax(source);
  if (!syntax.valid) {
    refreshEditorStatus();
    console.error('JavaScript was not run because it contains a syntax error:', syntax.error);
    return;
  }

  try {
    const result = new Function(source)();
    if (result !== undefined) console.log('[Notes] JavaScript result:', result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    syntaxStatusEl.classList.remove('valid');
    syntaxStatusEl.textContent = `Runtime error: ${message}`;
    syntaxStatusEl.title = message;
    console.error('JavaScript execution failed:', error);
  }
});

// Instant save on Ctrl+S / Cmd+S
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    if (!appReady) return;
    e.preventDefault();
    saveNow();
  }
});

// Open file when URL hash changes externally
window.addEventListener('hashchange', () => {
  if (!appReady) return;
  const hashFile = getFileFromHash();
  if (hashFile && hashFile !== state.active && Object.prototype.hasOwnProperty.call(state.files, hashFile)) {
    selectFile(hashFile, true);
  }
});

// --- Initial Load ---
async function initializeApp(): Promise<void> {
  try {
    state = loadState(await readStorage(STORAGE_KEY));
    storageReady = true;
  } catch (error) {
    reportStorageError(error);
    state = loadState(null);
  }

  state.leftPaneWidth = clampLeftPaneWidth(state.leftPaneWidth);
  leftPane.style.width = `${state.leftPaneWidth}px`;
  syncStrip();
  applyTheme(state.darkTheme);
  applyEditorSettings();
  saveDelayInput.value = String(state.saveDelaySeconds);

  appReady = true;
  container.removeAttribute('inert');
  container.removeAttribute('aria-busy');
  selectFile(state.active, false);
  loadSyntaxConfig();
}

void initializeApp();