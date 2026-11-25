// storage.ts
var DATABASE_NAME = "notes-app-storage";
var DATABASE_VERSION = 1;
var STORE_NAME = "app-state";
var databasePromise = null;
function openDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this browser."));
  }
  if (!databasePromise) {
    const opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error("Could not open the notes database."));
      request.onblocked = () => reject(new Error("The notes database upgrade is blocked by another open tab."));
    });
    databasePromise = opening.catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}
async function readStorage(key) {
  const database = await openDatabase();
  const storedValue = await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not read notes from the database."));
    transaction.onabort = () => reject(transaction.error || new Error("Reading notes was aborted."));
  });
  return storedValue === undefined ? null : storedValue;
}
async function writeStorage(key, value) {
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not save notes to the database."));
    transaction.onabort = () => reject(transaction.error || new Error("Saving notes was aborted."));
  });
}

// app.ts
var STORAGE_KEY = "notes_app_state_v2";
var DEFAULT_FILE = "tmp";
var DEFAULT_SAVE_DELAY_SECONDS = 5;
var MAX_SAVE_DELAY_SECONDS = 86400;
var DEFAULT_LEFT_PANE_WIDTH = 220;
var DEFAULT_CARET_TYPE = "block";
var container = document.querySelector(".split-con");
var leftPane = document.getElementById("leftPane");
var editorWrap = document.querySelector(".editor-wrap");
var textEditor = document.getElementById("textEditor");
var richEditor = document.getElementById("richEditor");
var saveStatusEl = document.getElementById("saveStatus");
var cursorStatusEl = document.getElementById("cursorStatus");
var syntaxStatusEl = document.getElementById("syntaxStatus");
var lineGutterLines = document.getElementById("lineGutterLines");
var markdownPreview = document.getElementById("markdownPreview");
var markdownPreviewBtn = document.getElementById("markdownPreviewBtn");
var runJsBtn = document.getElementById("runJsBtn");
var strip = document.getElementById("dragStrip");
var fileListEl = document.getElementById("fileList");
var newFileBtn = document.getElementById("newFileBtn");
var newFolderBtn = document.getElementById("newFolderBtn");
var settingsBtn = document.getElementById("settingsBtn");
var settingsDialog = document.getElementById("settingsDialog");
var settingsCloseBtn = document.getElementById("settingsCloseBtn");
var darkThemeToggle = document.getElementById("darkThemeToggle");
var lineNumbersToggle = document.getElementById("lineNumbersToggle");
var editorFontSelect = document.getElementById("editorFont");
var caretTypeSelect = document.getElementById("caretType");
var saveDelayInput = document.getElementById("saveDelaySeconds");
var ctxMenu = document.getElementById("ctxMenu");
var appReady = false;
container.setAttribute("inert", "");
container.setAttribute("aria-busy", "true");
saveStatusEl.textContent = "Loading...";
var dragging = false;
function syncStrip() {
  strip.style.left = `${leftPane.offsetWidth}px`;
}
function clampLeftPaneWidth(width) {
  const minLeft = parseFloat(getComputedStyle(leftPane).minWidth) || 0;
  const minRight = parseFloat(getComputedStyle(editorWrap).minWidth) || 0;
  const availableWidth = container.clientWidth || window.innerWidth;
  const maxLeft = Math.max(minLeft, availableWidth - minRight);
  return Math.max(minLeft, Math.min(width, maxLeft));
}
strip.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0)
    return;
  e.preventDefault();
  dragging = true;
  strip.classList.add("active");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  strip.setPointerCapture(e.pointerId);
});
document.addEventListener("pointermove", (e) => {
  if (!dragging)
    return;
  const rawWidth = e.clientX - container.getBoundingClientRect().left;
  const clampedWidth = clampLeftPaneWidth(rawWidth);
  leftPane.style.width = `${clampedWidth}px`;
  syncStrip();
});
function finishPaneResize() {
  if (!dragging)
    return;
  dragging = false;
  strip.classList.remove("active");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  if (!appReady)
    return;
  const width = leftPane.offsetWidth;
  if (state.leftPaneWidth !== width) {
    state.leftPaneWidth = width;
    persistAll();
  }
}
document.addEventListener("pointerup", finishPaneResize);
document.addEventListener("pointercancel", finishPaneResize);
new ResizeObserver(syncStrip).observe(leftPane);
window.addEventListener("resize", syncStrip);
syncStrip();
var syntaxLanguages = [];
var syntaxConfigError = null;
var storageError = null;
var storageReady = false;
function findSyntaxLanguage(name) {
  const normalized = name.toLowerCase();
  return syntaxLanguages.find((language) => language.id.toLowerCase() === normalized || language.aliases.some((alias) => alias.toLowerCase() === normalized) || language.extensions.some((extension) => extension.toLowerCase() === normalized));
}
function detectEditorMode(filePath) {
  const baseName = (filePath.split("/").pop() || "").toLowerCase();
  const dotIdx = baseName.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = baseName.slice(dotIdx + 1);
    if (ext === "md" || ext === "markdown") {
      return "markdown";
    }
    if (findSyntaxLanguage(ext)) {
      return "code";
    }
  }
  return "textarea";
}
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function compileSyntaxPattern(rule) {
  const flags = [...new Set((rule.patternFlags || "").replace(/[gy]/g, ""))].join("");
  return new RegExp(rule.pattern, `${flags}y`);
}
function highlightCode(rawText, languageName) {
  const language = languageName ? findSyntaxLanguage(languageName) : undefined;
  if (!language)
    return `<span class="md-code-block">${escapeHtml(rawText)}</span>`;
  const compiledRules = language.rules.map((rule) => ({
    scope: rule.scope,
    pattern: compileSyntaxPattern(rule)
  }));
  let html = "";
  let cursor = 0;
  while (cursor < rawText.length) {
    let matched = false;
    for (const rule of compiledRules) {
      rule.pattern.lastIndex = cursor;
      const match = rule.pattern.exec(rawText);
      if (!match || match.index !== cursor || match[0].length === 0)
        continue;
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
function highlightInlineMarkdown(rawLine) {
  const tokenPattern = /(`[^`\n]+`|\[[^\]\n]+\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\s](?:[^*]*[^*\s])?\*|_[^_\s](?:[^_]*[^_\s])?_)/g;
  let html = "";
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(rawLine)) !== null) {
    html += escapeHtml(rawLine.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      html += `<span class="md-code">${escapeHtml(token)}</span>`;
    } else if (token.startsWith("[")) {
      html += `<span class="md-link">${escapeHtml(token)}</span>`;
    } else if (token.startsWith("~~")) {
      html += `<span class="md-strike">${escapeHtml(token)}</span>`;
    } else if (token.startsWith("**") || token.startsWith("__")) {
      html += `<span class="md-bold">${escapeHtml(token)}</span>`;
    } else {
      html += `<span class="md-italic">${escapeHtml(token)}</span>`;
    }
    cursor = match.index + token.length;
  }
  return html + escapeHtml(rawLine.slice(cursor));
}
function renderMarkdownSourceHtml(rawText) {
  const lines = rawText.split(`
`);
  let fence = null;
  const htmlLines = [];
  for (let lineIndex = 0;lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (fence) {
      const closeMatch = line.match(/^\s*(`+|~+)\s*$/);
      if (closeMatch && closeMatch[1][0] === fence.marker && closeMatch[1].length >= fence.length) {
        if (fence.body.length > 0)
          htmlLines.push(highlightCode(fence.body.join(`
`), fence.language));
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
      const marker = taskMatch ? `<span class="md-task">${escapeHtml(taskMatch[1])}</span>` : "";
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
    if (line.includes("|")) {
      const isTableHeader = lines[lineIndex + 1] !== undefined && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[lineIndex + 1]);
      const cells = line.split("|");
      htmlLines.push(cells.map((cell, cellIndex) => {
        const pipe = cellIndex > 0 ? '<span class="md-table-pipe">|</span>' : "";
        const content = highlightInlineMarkdown(cell);
        return `${pipe}${isTableHeader ? `<span class="md-table-header">${content}</span>` : content}`;
      }).join(""));
      continue;
    }
    htmlLines.push(highlightInlineMarkdown(line));
  }
  if (fence && fence.body.length > 0)
    htmlLines.push(highlightCode(fence.body.join(`
`), fence.language));
  return htmlLines.join(`
`);
}
function getMarkdownFoldRanges(source) {
  const headings = [];
  const lines = source.split(`
`);
  let fence = null;
  lines.forEach((line, index) => {
    if (fence) {
      const closeMatch = line.match(/^\s*(`+|~+)\s*$/);
      if (closeMatch && closeMatch[1][0] === fence.marker && closeMatch[1].length >= fence.length) {
        fence = null;
      }
      return;
    }
    const openMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (openMatch) {
      fence = { marker: openMatch[1][0], length: openMatch[1].length };
      return;
    }
    const headingMatch = line.match(/^\s{0,3}(#{1,6})(?:[ \t]+|$)/);
    if (headingMatch)
      headings.push({ line: index + 1, level: headingMatch[1].length });
  });
  const ranges = new Map;
  const parents = [];
  const lastVisibleLine = lines.length;
  for (const heading of headings) {
    while (parents.length > 0 && parents[parents.length - 1].level >= heading.level) {
      const parent = parents.pop();
      if (heading.line > parent.line + 1)
        ranges.set(parent.line, heading.line);
    }
    parents.push(heading);
  }
  while (parents.length > 0) {
    const heading = parents.pop();
    if (lastVisibleLine > heading.line + 1)
      ranges.set(heading.line, lastVisibleLine);
  }
  return ranges;
}
function renderMarkdownHtml(rawText) {
  const template = document.createElement("template");
  template.innerHTML = marked.parse(rawText, { gfm: true, breaks: false });
  const allowedTags = new Set([
    "A",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "DEL",
    "EM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "IMG",
    "INPUT",
    "LI",
    "OL",
    "P",
    "PRE",
    "S",
    "STRONG",
    "TABLE",
    "TBODY",
    "TD",
    "TH",
    "THEAD",
    "TR",
    "UL"
  ]);
  const allowedAttributes = new Set([
    "alt",
    "checked",
    "class",
    "disabled",
    "href",
    "id",
    "start",
    "src",
    "title",
    "type"
  ]);
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    if (!allowedTags.has(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!allowedAttributes.has(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (attribute.name === "href" || attribute.name === "src") {
        try {
          const protocol = new URL(attribute.value, document.baseURI).protocol;
          const safeProtocols = attribute.name === "href" ? ["http:", "https:", "mailto:"] : ["http:", "https:"];
          if (!safeProtocols.includes(protocol))
            element.removeAttribute(attribute.name);
        } catch {
          element.removeAttribute(attribute.name);
        }
      }
    }
    if (element.tagName === "INPUT") {
      element.setAttribute("type", "checkbox");
      element.setAttribute("disabled", "");
    }
  }
  template.content.querySelectorAll("pre code").forEach((code) => {
    const languageClass = Array.from(code.classList).find((className) => className.startsWith("language-"));
    const languageName = languageClass?.slice("language-".length);
    code.innerHTML = highlightCode(code.textContent ?? "", languageName);
  });
  return template.innerHTML;
}
function loadSyntaxConfig() {
  fetch("./syntax-highlighting.json").then((response) => {
    if (!response.ok)
      throw new Error(`Could not load syntax-highlighting.json (${response.status})`);
    return response.json();
  }).then((config) => {
    if (!config || !Array.isArray(config.languages)) {
      throw new Error("syntax-highlighting.json must contain a languages array");
    }
    for (const language of config.languages) {
      if (!language || typeof language.id !== "string" || !Array.isArray(language.extensions) || !Array.isArray(language.aliases) || !language.extensions.every((extension) => typeof extension === "string") || !language.aliases.every((alias) => typeof alias === "string") || !Array.isArray(language.rules)) {
        throw new Error("Each syntax language needs an id, extensions, aliases, and rules");
      }
      for (const rule of language.rules) {
        if (!rule || typeof rule.pattern !== "string" || typeof rule.scope !== "string" || !/^[a-z][a-z0-9-]*$/.test(rule.scope) || rule.patternFlags !== undefined && typeof rule.patternFlags !== "string") {
          throw new Error(`Invalid syntax rule in language "${language.id}"`);
        }
        compileSyntaxPattern(rule);
      }
    }
    syntaxLanguages = config.languages;
    setEditorForFile(state.active, getEditorValue());
  }).catch((error) => {
    console.error("Syntax highlighting configuration could not be loaded.", error);
    syntaxConfigError = "Syntax highlighting could not be loaded. Check syntax-highlighting.json and reload.";
    setSaveStatus("saved");
  });
}
var AUTO_CLOSE_PAIRS = {
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
  "'": "'",
  '"': '"',
  "`": "`"
};
var STRUCTURAL_OPENERS = new Set(["(", "[", "{"]);
function getSelectionCharacterOffsets(element) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0)
    return { start: 0, end: 0 };
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer))
    return { start: 0, end: 0 };
  if (activeMode !== "textarea" && element === richEditor) {
    return {
      start: getCodePointOffset(element, range.startContainer, range.startOffset),
      end: getCodePointOffset(element, range.endContainer, range.endOffset)
    };
  }
  const startRange = range.cloneRange();
  startRange.selectNodeContents(element);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = range.cloneRange();
  endRange.selectNodeContents(element);
  endRange.setEnd(range.endContainer, range.endOffset);
  return { start: startRange.toString().length, end: endRange.toString().length };
}
function getCaretCharacterOffset(element) {
  return getSelectionCharacterOffsets(element).end;
}
function getCodeLines(element) {
  return Array.from(element.children).filter((child) => child.classList.contains("code-line"));
}
function getCodePointOffset(element, node, nodeOffset) {
  const lineElement = node instanceof Element ? node.closest(".code-line") : node.parentElement?.closest(".code-line");
  if (!lineElement || !element.contains(lineElement))
    return 0;
  const lines = getCodeLines(element);
  const lineIndex = lines.indexOf(lineElement);
  if (lineIndex < 0)
    return 0;
  const range = document.createRange();
  range.selectNodeContents(lineElement);
  range.setEnd(node, nodeOffset);
  const lineOffset = range.toString().length;
  const precedingLength = lines.slice(0, lineIndex).reduce((length, line) => length + (line.textContent?.length ?? 0) + 1, 0);
  return precedingLength + lineOffset;
}
function getTextPosition(element, targetOffset) {
  if (activeMode !== "textarea" && element === richEditor) {
    const lines = getCodeLines(element);
    let remaining = targetOffset;
    for (const line of lines) {
      const lineLength = line.textContent?.length ?? 0;
      if (remaining <= lineLength) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let currentNode = walker.nextNode();
        if (!currentNode)
          return { node: line, offset: 0 };
        while (currentNode) {
          const length = currentNode.nodeValue?.length ?? 0;
          if (remaining <= length)
            return { node: currentNode, offset: remaining };
          remaining -= length;
          currentNode = walker.nextNode();
        }
        return { node: line, offset: line.childNodes.length };
      }
      remaining -= lineLength + 1;
    }
    const lastLine = lines[lines.length - 1];
    if (lastLine) {
      const walker = document.createTreeWalker(lastLine, NodeFilter.SHOW_TEXT);
      let lastNode = null;
      let currentNode = walker.nextNode();
      while (currentNode) {
        lastNode = currentNode;
        currentNode = walker.nextNode();
      }
      return lastNode ? { node: lastNode, offset: lastNode.length } : { node: lastLine, offset: lastLine.childNodes.length };
    }
    return null;
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = targetOffset;
  let currentNode = walker.nextNode();
  let lastNode = null;
  while (currentNode) {
    lastNode = currentNode;
    const length = currentNode.nodeValue?.length ?? 0;
    if (remaining <= length)
      return { node: currentNode, offset: remaining };
    remaining -= length;
    currentNode = walker.nextNode();
  }
  return lastNode ? { node: lastNode, offset: lastNode.length } : null;
}
function setSelectionCharacterOffsets(element, startOffset, endOffset) {
  const selection = window.getSelection();
  if (!selection)
    return;
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
function setCaretCharacterOffset(element, targetOffset) {
  setSelectionCharacterOffsets(element, targetOffset, targetOffset);
}
function getPairedEdit(text, start, end, key) {
  if (start === end && Object.values(AUTO_CLOSE_PAIRS).includes(key) && text[start] === key) {
    return { text, start: start + 1, end: start + 1, changed: false };
  }
  if (key === "Backspace" && start === end && start > 0) {
    const opener = text[start - 1];
    if (AUTO_CLOSE_PAIRS[opener] && text[start] === AUTO_CLOSE_PAIRS[opener]) {
      return {
        text: text.slice(0, start - 1) + text.slice(start + 1),
        start: start - 1,
        end: start - 1,
        changed: true
      };
    }
    return null;
  }
  const closer = AUTO_CLOSE_PAIRS[key];
  if (!closer)
    return null;
  if (key === "'" && start === end && /\w/.test(text[start - 1] || "") && /\w/.test(text[end] || "")) {
    return null;
  }
  if (start === end && text[start] === closer)
    return null;
  const selectedText = text.slice(start, end);
  return {
    text: text.slice(0, start) + key + selectedText + closer + text.slice(end),
    start: start + 1,
    end: start + 1 + selectedText.length,
    changed: true
  };
}
function getEnterEdit(text, start, end) {
  if (start !== end)
    return null;
  const opener = text[start - 1];
  const closer = AUTO_CLOSE_PAIRS[opener];
  const lineStart = text.lastIndexOf(`
`, start - 1) + 1;
  const linePrefix = text.slice(lineStart, start);
  const baseIndent = linePrefix.match(/^[\t ]*/)?.[0] ?? "";
  const isBetweenPair = STRUCTURAL_OPENERS.has(opener) && closer !== undefined && text[end] === closer;
  if (!isBetweenPair && baseIndent.length === 0)
    return null;
  const innerIndent = isBetweenPair ? `${baseIndent}  ` : baseIndent;
  const insertion = isBetweenPair ? `
${innerIndent}
${baseIndent}` : `
${innerIndent}`;
  const caret = start + 1 + innerIndent.length;
  return {
    text: text.slice(0, start) + insertion + text.slice(end),
    start: caret,
    end: caret,
    changed: true
  };
}
var activeMode = "textarea";
var foldedLineStarts = new Set;
var markdownPreviewMode = false;
function getEditorValue() {
  if (activeMode !== "textarea") {
    return Array.from(richEditor.children).filter((child) => child.classList.contains("code-line")).map((line) => line.textContent ?? "").join(`
`);
  }
  return textEditor.value;
}
function getCodeFoldRanges(source, languageName) {
  const ranges = new Map;
  const stack = [];
  let line = 1;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0;index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === `
`) {
      line += 1;
      lineComment = false;
      if (quote && quote !== "`")
        quote = "";
      escaped = false;
      continue;
    }
    if (lineComment)
      continue;
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped)
        escaped = false;
      else if (character === "\\")
        escaped = true;
      else if (character === quote)
        quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (languageName === "sql" && character === "-" && next === "-" || languageName === "python" && character === "#") {
      lineComment = true;
      if (character === "-")
        index += 1;
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "{") {
      stack.push(line);
    } else if (character === "}") {
      const startLine = stack.pop();
      if (startLine !== undefined && line > startLine)
        ranges.set(startLine, line);
    }
  }
  return ranges;
}
function renderFoldableLines(source, highlightedHtml, foldRanges) {
  const template = document.createElement("template");
  template.innerHTML = highlightedHtml;
  const sourceLines = source.split(`
`);
  const codeLines = sourceLines.map((_, index) => {
    const line = document.createElement("span");
    line.className = "code-line";
    line.dataset.line = String(index + 1);
    return line;
  });
  let lineIndex = 0;
  const appendText = (text, ancestors) => {
    const destination = codeLines[lineIndex];
    if (!destination || !text)
      return;
    let parent = destination;
    for (const ancestor of ancestors) {
      const clone = ancestor.cloneNode(false);
      parent.appendChild(clone);
      parent = clone;
    }
    parent.appendChild(document.createTextNode(text));
  };
  const visit = (node, ancestors) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const segments = (node.nodeValue ?? "").split(`
`);
      segments.forEach((segment, index) => {
        appendText(segment, ancestors);
        if (index < segments.length - 1)
          lineIndex += 1;
      });
      return;
    }
    if (node instanceof HTMLElement) {
      const nextAncestors = [...ancestors, node];
      node.childNodes.forEach((child) => visit(child, nextAncestors));
    }
  };
  template.content.childNodes.forEach((node) => visit(node, []));
  for (const startLine of foldedLineStarts) {
    const endLine = foldRanges.get(startLine);
    if (endLine === undefined)
      continue;
    for (let line = startLine + 1;line < endLine; line += 1) {
      codeLines[line - 1].classList.add("folded-code-line");
    }
    const placeholder = document.createElement("span");
    placeholder.className = "fold-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    codeLines[startLine - 1].appendChild(placeholder);
  }
  return codeLines.map((line) => line.outerHTML).join("");
}
function renderFoldableCode(source, languageName) {
  const normalizedSource = source.replace(/\r\n/g, `
`);
  return renderFoldableLines(normalizedSource, highlightCode(normalizedSource, languageName), getCodeFoldRanges(normalizedSource, languageName));
}
function getActiveLanguageName() {
  const baseName = state.active.split("/").pop() || "";
  const extension = baseName.includes(".") ? baseName.slice(baseName.lastIndexOf(".") + 1) : "";
  return findSyntaxLanguage(extension)?.id;
}
function renderRichEditorHtml(rawText) {
  if (activeMode === "markdown") {
    const source = rawText.replace(/\r\n/g, `
`);
    return renderFoldableLines(source, renderMarkdownSourceHtml(source), getMarkdownFoldRanges(source));
  }
  return renderFoldableCode(rawText, getActiveLanguageName());
}
function setEditorForFile(filePath, content) {
  activeMode = detectEditorMode(filePath);
  markdownPreviewMode = false;
  textEditor.spellcheck = activeMode === "textarea";
  if (activeMode !== "textarea") {
    textEditor.hidden = true;
    richEditor.hidden = markdownPreviewMode;
    foldedLineStarts = new Set;
    richEditor.innerHTML = renderRichEditorHtml(content);
    markdownPreview.hidden = !markdownPreviewMode;
    if (markdownPreviewMode)
      markdownPreview.innerHTML = renderMarkdownHtml(content);
  } else {
    richEditor.hidden = true;
    markdownPreview.hidden = true;
    textEditor.hidden = false;
    textEditor.value = content;
  }
  editorWrap.classList.toggle("markdown-preview-mode", markdownPreviewMode);
  editorWrap.classList.toggle("markdown-source", activeMode === "markdown" && !markdownPreviewMode);
  refreshEditorStatus();
}
function setMarkdownPreview(showPreview) {
  if (activeMode !== "markdown")
    return;
  markdownPreviewMode = showPreview;
  editorWrap.classList.toggle("markdown-preview-mode", showPreview);
  editorWrap.classList.toggle("markdown-source", !showPreview);
  markdownPreview.hidden = !showPreview;
  richEditor.hidden = showPreview;
  markdownPreviewBtn.textContent = showPreview ? "Edit" : "Preview";
  if (showPreview) {
    markdownPreview.innerHTML = renderMarkdownHtml(getEditorValue());
  } else {
    richEditor.focus();
  }
  refreshEditorStatus();
}
function focusActiveEditor() {
  if (activeMode === "markdown" && markdownPreviewMode) {
    setMarkdownPreview(false);
  } else if (activeMode !== "textarea") {
    richEditor.focus();
  } else {
    textEditor.focus();
  }
}
var saveTimer = null;
function getFileFromHash() {
  const rawHash = window.location.hash.replace(/^#/, "");
  if (!rawHash)
    return null;
  try {
    return decodeURIComponent(rawHash);
  } catch {
    return rawHash;
  }
}
function syncHash(filePath) {
  const encoded = `#${encodeURI(filePath)}`;
  if (window.location.hash !== encoded) {
    history.replaceState(null, "", encoded);
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function loadState(raw) {
  let base = {
    files: { [DEFAULT_FILE]: "" },
    folders: [],
    collapsed: {},
    active: DEFAULT_FILE,
    leftPaneWidth: DEFAULT_LEFT_PANE_WIDTH,
    darkTheme: false,
    saveDelaySeconds: DEFAULT_SAVE_DELAY_SECONDS,
    lineNumbers: false,
    editorFont: "system",
    caretType: DEFAULT_CARET_TYPE
  };
  if (isRecord(raw) && isRecord(raw.files)) {
    const files = { [DEFAULT_FILE]: "" };
    for (const [path, content] of Object.entries(raw.files)) {
      if (typeof content === "string")
        files[path] = content;
    }
    const collapsed = {};
    if (isRecord(raw.collapsed)) {
      for (const [path, isCollapsed] of Object.entries(raw.collapsed)) {
        if (typeof isCollapsed === "boolean")
          collapsed[path] = isCollapsed;
      }
    }
    base = {
      files,
      folders: Array.isArray(raw.folders) ? raw.folders.filter((folder) => typeof folder === "string") : [],
      collapsed,
      active: typeof raw.active === "string" ? raw.active : DEFAULT_FILE,
      leftPaneWidth: typeof raw.leftPaneWidth === "number" && Number.isFinite(raw.leftPaneWidth) ? raw.leftPaneWidth : DEFAULT_LEFT_PANE_WIDTH,
      darkTheme: raw.darkTheme === true,
      saveDelaySeconds: typeof raw.saveDelaySeconds === "number" && Number.isInteger(raw.saveDelaySeconds) && raw.saveDelaySeconds >= 0 && raw.saveDelaySeconds <= MAX_SAVE_DELAY_SECONDS ? raw.saveDelaySeconds : DEFAULT_SAVE_DELAY_SECONDS,
      lineNumbers: raw.lineNumbers === true,
      editorFont: raw.editorFont === "jetbrains" ? "jetbrains" : "system",
      caretType: raw.caretType === "bar" ? "bar" : DEFAULT_CARET_TYPE
    };
  }
  const hashFile = getFileFromHash();
  if (hashFile && Object.prototype.hasOwnProperty.call(base.files, hashFile)) {
    base.active = hashFile;
  } else if (!Object.prototype.hasOwnProperty.call(base.files, base.active)) {
    base.active = DEFAULT_FILE;
  }
  return base;
}
var state = loadState(null);
function findUnmatchedCloserLine(source, closer) {
  const expectedOpeners = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let line = 1;
  for (let index = 0;index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === `
`) {
      line += 1;
      lineComment = false;
      if (quote && quote !== "`")
        quote = "";
      escaped = false;
      continue;
    }
    if (lineComment)
      continue;
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped)
        escaped = false;
      else if (character === "\\")
        escaped = true;
      else if (character === quote)
        quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "(" || character === "[" || character === "{") {
      stack.push({ character, line });
    } else if (character === ")" || character === "]" || character === "}") {
      const opener = stack.pop();
      if (!opener || opener.character !== expectedOpeners[character]) {
        if (character === closer)
          return line;
      }
    }
  }
  return null;
}
function findSyntaxErrorLine(source, message, error) {
  const reportedLine = typeof error === "object" && error !== null && "lineNumber" in error ? Number(error.lineNumber) : NaN;
  const lines = source.split(/\r?\n/);
  if (Number.isInteger(reportedLine) && reportedLine > 0) {
    return Math.min(reportedLine, lines.length);
  }
  const findLine = (pattern) => {
    const index = lines.findIndex((line) => pattern.test(line));
    return index < 0 ? null : index + 1;
  };
  const lastNonEmptyLine = () => {
    for (let index = lines.length - 1;index >= 0; index -= 1) {
      if (lines[index].trim())
        return index + 1;
    }
    return 1;
  };
  if (/Function statements require a function name/i.test(message)) {
    return findLine(/\bfunction\s*\*?\s*\(/) ?? lastNonEmptyLine();
  }
  if (/unexpected end of input|end of input/i.test(message))
    return lastNonEmptyLine();
  if (/Unexpected token ['"]=['"]/.test(message)) {
    return findLine(/\b(?:const|let|var)\s*=/) ?? findLine(/=\s*[;,)}]/) ?? lastNonEmptyLine();
  }
  if (/Unexpected token ['"];['"]/.test(message)) {
    return findLine(/=\s*;/) ?? lastNonEmptyLine();
  }
  const tokenMatch = message.match(/Unexpected (?:token|identifier) ['"](.+?)['"]/);
  if (tokenMatch) {
    const token = tokenMatch[1];
    if ([")", "]", "}"].includes(token)) {
      return findUnmatchedCloserLine(source, token) ?? lines.map((line, index) => line.includes(token) ? index + 1 : 0).filter(Boolean).pop() ?? lastNonEmptyLine();
    }
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (/Unexpected identifier/.test(message)) {
      const adjacentIdentifier = findLine(new RegExp(`\\b[A-Za-z_$][\\w$]*\\s+${escapedToken}\\b`));
      if (adjacentIdentifier)
        return adjacentIdentifier;
    }
    const lastTokenLine = lines.map((line, index) => line.includes(token) ? index + 1 : 0).filter(Boolean).pop();
    if (lastTokenLine)
      return lastTokenLine;
    return findLine(new RegExp(escapedToken)) ?? lastNonEmptyLine();
  }
  return lastNonEmptyLine();
}
function checkSyntax(userCode) {
  try {
    new Function(userCode);
    return { valid: true, error: null, line: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      error: message,
      line: findSyntaxErrorLine(userCode, message, error)
    };
  }
}
function isJavaScriptFile() {
  const fileName = state.active.split("/").pop() || "";
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase() : "";
  return ["js", "mjs", "cjs"].includes(extension);
}
function applyEditorSettings() {
  editorWrap.classList.toggle("line-numbers", state.lineNumbers);
  editorWrap.style.setProperty("--editor-font", state.editorFont === "jetbrains" ? '"JetBrains Mono", ui-monospace, monospace' : "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace");
  editorWrap.style.setProperty("--editor-caret-shape", state.caretType);
  lineNumbersToggle.checked = state.lineNumbers;
  editorFontSelect.value = state.editorFont;
  caretTypeSelect.value = state.caretType;
  refreshEditorStatus();
}
function getCaretOffset() {
  return activeMode === "textarea" ? textEditor.selectionStart : getCaretCharacterOffset(richEditor);
}
function updateCursorStatus() {
  const source = getEditorValue();
  const beforeCaret = source.slice(0, getCaretOffset());
  const line = beforeCaret.split(`
`).length;
  const lastNewline = beforeCaret.lastIndexOf(`
`);
  const column = beforeCaret.length - lastNewline;
  cursorStatusEl.textContent = `Ln ${line}, Col ${column}`;
}
function updateLineGutter(errorLine, errorMessage) {
  const source = getEditorValue();
  const lineCount = source.split(`
`).length;
  const foldRanges = activeMode === "code" ? getCodeFoldRanges(source, getActiveLanguageName()) : activeMode === "markdown" ? getMarkdownFoldRanges(source) : new Map;
  const hiddenGutterLines = new Set;
  for (const foldedLine of foldedLineStarts) {
    const endLine = foldRanges.get(foldedLine);
    if (endLine === undefined) {
      foldedLineStarts.delete(foldedLine);
      continue;
    }
    for (let line = foldedLine + 1;line < endLine; line += 1) {
      hiddenGutterLines.add(line);
    }
  }
  const fragment = document.createDocumentFragment();
  for (let line = 1;line <= lineCount; line += 1) {
    if (hiddenGutterLines.has(line))
      continue;
    const lineElement = document.createElement("div");
    lineElement.className = line === errorLine ? "gutter-line error-line" : "gutter-line";
    if (line === errorLine && errorMessage)
      lineElement.title = errorMessage;
    const foldToggle = document.createElement("button");
    foldToggle.type = "button";
    foldToggle.className = "fold-toggle";
    foldToggle.dataset.foldLine = String(line);
    foldToggle.disabled = !foldRanges.has(line);
    foldToggle.textContent = foldedLineStarts.has(line) ? "+" : foldRanges.has(line) ? "-" : "";
    foldToggle.setAttribute("aria-label", foldedLineStarts.has(line) ? `Expand lines from ${line}` : `Fold lines from ${line}`);
    lineElement.appendChild(foldToggle);
    const lineNumber = document.createElement("span");
    lineNumber.className = "gutter-number";
    lineNumber.textContent = String(line);
    lineElement.appendChild(lineNumber);
    fragment.appendChild(lineElement);
  }
  lineGutterLines.replaceChildren(fragment);
  editorWrap.classList.toggle("code-folding", activeMode === "code" || activeMode === "markdown");
  const activeEditor = activeMode === "textarea" ? textEditor : richEditor;
  lineGutterLines.style.transform = `translateY(${-activeEditor.scrollTop}px)`;
}
function refreshEditorStatus() {
  editorWrap.classList.toggle("code-folding", activeMode === "code" || activeMode === "markdown");
  editorWrap.classList.toggle("markdown-preview-mode", activeMode === "markdown" && markdownPreviewMode);
  editorWrap.classList.toggle("markdown-source", activeMode === "markdown" && !markdownPreviewMode);
  const isJavaScript = isJavaScriptFile();
  runJsBtn.hidden = !isJavaScript;
  markdownPreviewBtn.hidden = activeMode !== "markdown";
  markdownPreviewBtn.textContent = markdownPreviewMode ? "Edit" : "Preview";
  syntaxStatusEl.classList.remove("valid");
  let errorLine = null;
  let errorMessage = null;
  if (isJavaScript) {
    const result = checkSyntax(getEditorValue());
    if (result.valid) {
      syntaxStatusEl.textContent = "Syntax OK";
      syntaxStatusEl.title = "";
      syntaxStatusEl.classList.add("valid");
    } else {
      syntaxStatusEl.textContent = `Line ${result.line}: ${result.error}`;
      syntaxStatusEl.title = `Line ${result.line}: ${result.error}`;
      errorLine = result.line;
      errorMessage = result.error;
    }
  } else {
    syntaxStatusEl.textContent = "";
    syntaxStatusEl.title = "";
  }
  updateCursorStatus();
  updateLineGutter(errorLine, errorMessage);
}
function setSaveStatus(status) {
  const errorLabels = [];
  const errorMessages = [];
  if (storageError) {
    errorLabels.push("storage");
    errorMessages.push(storageError);
  }
  if (syntaxConfigError) {
    errorLabels.push("syntax");
    errorMessages.push(syntaxConfigError);
  }
  if (errorLabels.length > 0) {
    const saveLabel = status === "dirty" ? "Unsaved" : "Saved";
    saveStatusEl.textContent = `${saveLabel} / ${errorLabels.join(" and ")} error`;
    saveStatusEl.title = errorMessages.join(`
`);
    saveStatusEl.classList.add("error");
    if (status === "dirty")
      saveStatusEl.classList.add("dirty");
    else
      saveStatusEl.classList.remove("dirty");
    return;
  }
  saveStatusEl.title = "";
  saveStatusEl.classList.remove("error");
  if (status === "dirty") {
    saveStatusEl.textContent = "Unsaved...";
    saveStatusEl.classList.add("dirty");
  } else {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    saveStatusEl.textContent = `File saved (${time})`;
    saveStatusEl.classList.remove("dirty");
  }
}
function reportStorageError(error) {
  console.error("Could not access persistent notes storage.", error);
  storageError = "Notes could not be loaded or saved in IndexedDB.";
  setSaveStatus("dirty");
}
var persistenceQueue = Promise.resolve();
function persistAll(showSavedStatus = false) {
  if (!storageReady)
    return;
  const snapshot = {
    files: { ...state.files },
    folders: [...state.folders],
    collapsed: { ...state.collapsed },
    active: state.active,
    leftPaneWidth: state.leftPaneWidth,
    darkTheme: state.darkTheme,
    saveDelaySeconds: state.saveDelaySeconds,
    lineNumbers: state.lineNumbers,
    editorFont: state.editorFont,
    caretType: state.caretType
  };
  persistenceQueue = persistenceQueue.then(() => writeStorage(STORAGE_KEY, snapshot)).then(() => {
    const hadStorageError = storageError !== null;
    storageError = null;
    if (showSavedStatus || hadStorageError)
      setSaveStatus("saved");
  }, (error) => reportStorageError(error));
}
function saveNow() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state.files[state.active] = getEditorValue();
  persistAll(true);
}
function scheduleSave() {
  setSaveStatus("dirty");
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (state.saveDelaySeconds === 0)
    return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    state.files[state.active] = getEditorValue();
    persistAll(true);
  }, state.saveDelaySeconds * 1000);
}
function cleanName(raw) {
  return (raw || "").trim().replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
}
function ensureParentFolders(filePath) {
  const parts = filePath.split("/");
  parts.pop();
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    if (!state.folders.includes(acc))
      state.folders.push(acc);
  }
}
function buildTree() {
  const root = { folders: {}, files: [] };
  for (const folderPath of [...state.folders].sort()) {
    const parts = folderPath.split("/");
    let node = root;
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.folders[part]) {
        node.folders[part] = { name: part, path: currentPath, folders: {}, files: [] };
      }
      node = node.folders[part];
    }
  }
  const fileKeys = Object.keys(state.files).sort((a, b) => {
    if (a === DEFAULT_FILE)
      return -1;
    if (b === DEFAULT_FILE)
      return 1;
    return a.localeCompare(b);
  });
  for (const filePath of fileKeys) {
    const parts = filePath.split("/");
    const fileName = parts.pop();
    let node = root;
    let currentPath = "";
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
function renderNode(node, ulEl) {
  Object.values(node.folders).forEach((folder) => {
    const folderPath = folder.path;
    const li = document.createElement("li");
    const isCollapsed = !!state.collapsed[folderPath];
    const a = document.createElement("a");
    a.href = "#";
    a.className = "folder-row";
    a.dataset.type = "folder";
    a.dataset.path = folderPath;
    a.textContent = `${isCollapsed ? "▸" : "▾"} ${folder.name}`;
    li.appendChild(a);
    if (!isCollapsed) {
      const childUl = document.createElement("ul");
      renderNode(folder, childUl);
      li.appendChild(childUl);
    }
    ulEl.appendChild(li);
  });
  node.files.forEach((file) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    if (file.path === DEFAULT_FILE)
      a.id = DEFAULT_FILE;
    a.href = `#${encodeURI(file.path)}`;
    a.dataset.type = "file";
    a.dataset.path = file.path;
    a.textContent = file.name;
    if (file.path === state.active)
      a.classList.add("active");
    li.appendChild(a);
    ulEl.appendChild(li);
  });
}
function renderFileList() {
  fileListEl.innerHTML = "";
  renderNode(buildTree(), fileListEl);
}
function applyTheme(isDark) {
  document.body.classList.toggle("dark-theme", isDark);
  darkThemeToggle.checked = isDark;
}
function selectFile(path, shouldSaveCurrent = true) {
  if (!Object.prototype.hasOwnProperty.call(state.files, path))
    return;
  if (shouldSaveCurrent) {
    saveNow();
  }
  state.active = path;
  ensureParentFolders(path);
  setEditorForFile(path, state.files[path] ?? "");
  syncHash(path);
  persistAll(true);
  renderFileList();
}
function createNewFile(folderPrefix = "") {
  const name = cleanName(prompt(folderPrefix ? `New file in "${folderPrefix}":` : "File name (e.g. readme.md):"));
  if (!name)
    return;
  const fullPath = folderPrefix ? `${folderPrefix}/${name}` : name;
  saveNow();
  ensureParentFolders(fullPath);
  if (folderPrefix)
    delete state.collapsed[folderPrefix];
  if (!Object.prototype.hasOwnProperty.call(state.files, fullPath)) {
    state.files[fullPath] = "";
  }
  selectFile(fullPath, false);
  focusActiveEditor();
}
function createNewFolder(parentPrefix = "") {
  const name = cleanName(prompt(parentPrefix ? `New subfolder in "${parentPrefix}":` : "Folder name:"));
  if (!name)
    return;
  const fullPath = parentPrefix ? `${parentPrefix}/${name}` : name;
  if (parentPrefix)
    delete state.collapsed[parentPrefix];
  if (!state.folders.includes(fullPath)) {
    state.folders.push(fullPath);
  }
  persistAll();
  renderFileList();
}
function renameFile(oldPath) {
  if (oldPath === DEFAULT_FILE)
    return;
  const parts = oldPath.split("/");
  const oldName = parts.pop();
  const prefix = parts.join("/");
  const newName = cleanName(prompt("Rename file:", oldName));
  if (!newName || newName === oldName)
    return;
  const newPath = prefix ? `${prefix}/${newName}` : newName;
  if (Object.prototype.hasOwnProperty.call(state.files, newPath)) {
    alert("A file with that name already exists.");
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
function moveFileToFolder(filePath) {
  if (filePath === DEFAULT_FILE)
    return;
  const baseName = filePath.split("/").pop();
  const target = (prompt("Move to folder path (leave empty for root):", "") || "").trim().replace(/^\/+|\/+$/g, "");
  const newPath = target ? `${target}/${baseName}` : baseName;
  if (newPath === filePath)
    return;
  if (Object.prototype.hasOwnProperty.call(state.files, newPath)) {
    alert("A file with that name already exists in the target folder.");
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
function deleteFile(path) {
  if (path === DEFAULT_FILE)
    return;
  if (!confirm(`Delete file "${path}"?`))
    return;
  delete state.files[path];
  if (state.active === path) {
    selectFile(DEFAULT_FILE, false);
  } else {
    persistAll();
    renderFileList();
  }
}
function renameFolder(oldPath) {
  const parts = oldPath.split("/");
  const oldName = parts.pop();
  const prefix = parts.join("/");
  const newName = cleanName(prompt("Rename folder:", oldName));
  if (!newName || newName === oldName)
    return;
  const newPath = prefix ? `${prefix}/${newName}` : newName;
  if (state.folders.includes(newPath)) {
    alert("A folder with that name already exists.");
    return;
  }
  saveNow();
  const swapPrefix = (p) => p === oldPath ? newPath : p.startsWith(`${oldPath}/`) ? `${newPath}${p.slice(oldPath.length)}` : p;
  state.folders = state.folders.map(swapPrefix);
  const nextFiles = {};
  for (const [k, v] of Object.entries(state.files)) {
    nextFiles[swapPrefix(k)] = v;
  }
  state.files = nextFiles;
  state.active = swapPrefix(state.active);
  const nextCollapsed = {};
  for (const [k, v] of Object.entries(state.collapsed)) {
    nextCollapsed[swapPrefix(k)] = v;
  }
  state.collapsed = nextCollapsed;
  syncHash(state.active);
  persistAll();
  renderFileList();
}
function deleteFolder(folderPath) {
  if (!confirm(`Delete folder "${folderPath}" and all files inside it?`))
    return;
  const isInside = (p) => p === folderPath || p.startsWith(`${folderPath}/`);
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
function closeCtxMenu() {
  ctxMenu.classList.remove("open");
  ctxMenu.innerHTML = "";
}
function openCtxMenu(x, y, items) {
  ctxMenu.innerHTML = "";
  items.forEach((item) => {
    if (item === "sep") {
      ctxMenu.appendChild(document.createElement("hr"));
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = item.label;
    if (item.danger)
      btn.className = "danger";
    btn.onclick = () => {
      closeCtxMenu();
      item.action();
    };
    ctxMenu.appendChild(btn);
  });
  ctxMenu.classList.add("open");
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
}
leftPane.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const target = e.target.closest("a[data-type]");
  if (!target) {
    openCtxMenu(e.clientX, e.clientY, [
      { label: "New file", action: () => createNewFile("") },
      { label: "New folder", action: () => createNewFolder("") }
    ]);
    return;
  }
  const type = target.dataset.type;
  const path = target.dataset.path;
  if (type === "folder") {
    openCtxMenu(e.clientX, e.clientY, [
      { label: "New file inside", action: () => createNewFile(path) },
      { label: "New subfolder", action: () => createNewFolder(path) },
      "sep",
      { label: "Rename folder", action: () => renameFolder(path) },
      { label: "Delete folder", danger: true, action: () => deleteFolder(path) }
    ]);
  } else if (type === "file") {
    if (path === DEFAULT_FILE) {
      openCtxMenu(e.clientX, e.clientY, [
        {
          label: "Clear tmp buffer",
          action: () => {
            setEditorForFile(DEFAULT_FILE, "");
            saveNow();
          }
        }
      ]);
    } else {
      openCtxMenu(e.clientX, e.clientY, [
        { label: "Rename file", action: () => renameFile(path) },
        { label: "Move to folder...", action: () => moveFileToFolder(path) },
        "sep",
        { label: "Delete file", danger: true, action: () => deleteFile(path) }
      ]);
    }
  }
});
document.addEventListener("click", (e) => {
  if (!ctxMenu.contains(e.target))
    closeCtxMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape")
    closeCtxMenu();
});
newFileBtn.addEventListener("click", () => createNewFile(""));
newFolderBtn.addEventListener("click", () => createNewFolder(""));
settingsBtn.addEventListener("click", () => {
  if (!settingsDialog.open)
    settingsDialog.showModal();
});
settingsCloseBtn.addEventListener("click", () => {
  if (settingsDialog.open)
    settingsDialog.close();
});
darkThemeToggle.addEventListener("change", () => {
  state.darkTheme = darkThemeToggle.checked;
  applyTheme(state.darkTheme);
  persistAll();
});
lineNumbersToggle.addEventListener("change", () => {
  state.lineNumbers = lineNumbersToggle.checked;
  applyEditorSettings();
  persistAll();
});
editorFontSelect.addEventListener("change", () => {
  state.editorFont = editorFontSelect.value === "jetbrains" ? "jetbrains" : "system";
  applyEditorSettings();
  persistAll();
});
caretTypeSelect.addEventListener("change", () => {
  state.caretType = caretTypeSelect.value === "bar" ? "bar" : "block";
  applyEditorSettings();
  persistAll();
});
markdownPreviewBtn.addEventListener("click", () => {
  setMarkdownPreview(!markdownPreviewMode);
});
saveDelayInput.addEventListener("change", () => {
  const delaySeconds = saveDelayInput.valueAsNumber;
  if (!saveDelayInput.checkValidity() || !Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_SAVE_DELAY_SECONDS) {
    saveDelayInput.reportValidity();
    saveDelayInput.value = String(state.saveDelaySeconds);
    return;
  }
  const hasUnsavedChanges = saveStatusEl.classList.contains("dirty");
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state.saveDelaySeconds = delaySeconds;
  persistAll();
  if (delaySeconds > 0 && hasUnsavedChanges)
    scheduleSave();
});
fileListEl.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-type]");
  if (!link)
    return;
  e.preventDefault();
  if (link.dataset.type === "folder") {
    const p = link.dataset.path;
    if (state.collapsed[p])
      delete state.collapsed[p];
    else
      state.collapsed[p] = true;
    persistAll();
    renderFileList();
  } else {
    selectFile(link.dataset.path);
  }
});
lineGutterLines.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-fold-line]");
  if (!button || button.disabled || activeMode !== "code" && activeMode !== "markdown")
    return;
  const line = Number(button.dataset.foldLine);
  let source = getEditorValue();
  let caret = getCaretOffset();
  if (activeMode === "markdown" && !foldedLineStarts.has(line) && getMarkdownFoldRanges(source).get(line) === source.split(`
`).length && (source.split(`
`).pop() ?? "").trim().length > 0) {
    source += `
`;
    caret = source.length;
    state.files[state.active] = source;
    richEditor.innerHTML = renderRichEditorHtml(source);
    scheduleSave();
  }
  if (foldedLineStarts.has(line))
    foldedLineStarts.delete(line);
  else
    foldedLineStarts.add(line);
  richEditor.innerHTML = renderRichEditorHtml(source);
  richEditor.focus();
  setCaretCharacterOffset(richEditor, caret);
  refreshEditorStatus();
});
textEditor.addEventListener("keydown", (e) => {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey)
    return;
  if (e.key === "Tab") {
    e.preventDefault();
    textEditor.setRangeText("\t", textEditor.selectionStart, textEditor.selectionEnd, "end");
    scheduleSave();
    refreshEditorStatus();
    return;
  }
  if (e.key === "Enter" && activeMode === "code") {
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
  if (!edit)
    return;
  e.preventDefault();
  textEditor.value = edit.text;
  textEditor.setSelectionRange(edit.start, edit.end);
  if (edit.changed)
    scheduleSave();
  refreshEditorStatus();
});
textEditor.addEventListener("input", () => {
  scheduleSave();
  refreshEditorStatus();
});
textEditor.addEventListener("click", refreshEditorStatus);
textEditor.addEventListener("keyup", refreshEditorStatus);
textEditor.addEventListener("select", refreshEditorStatus);
textEditor.addEventListener("scroll", refreshEditorStatus);
richEditor.addEventListener("input", () => {
  const caret = getCaretCharacterOffset(richEditor);
  const raw = getEditorValue();
  richEditor.innerHTML = renderRichEditorHtml(raw);
  setCaretCharacterOffset(richEditor, caret);
  scheduleSave();
  refreshEditorStatus();
});
richEditor.addEventListener("keydown", (e) => {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey)
    return;
  const selection = getSelectionCharacterOffsets(richEditor);
  if (e.key === "Tab") {
    e.preventDefault();
    const raw = getEditorValue();
    const next = raw.slice(0, selection.start) + "\t" + raw.slice(selection.end);
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
  if (e.key === "Enter") {
    e.preventDefault();
    const raw = getEditorValue();
    const pairedEdit = activeMode === "code" ? getEnterEdit(raw, selection.start, selection.end) : null;
    const next = pairedEdit?.text ?? raw.slice(0, selection.start) + `
` + raw.slice(selection.end);
    const caret = pairedEdit?.start ?? selection.start + 1;
    richEditor.innerHTML = renderRichEditorHtml(next);
    setCaretCharacterOffset(richEditor, caret);
    scheduleSave();
    refreshEditorStatus();
  }
});
richEditor.addEventListener("click", refreshEditorStatus);
richEditor.addEventListener("keyup", refreshEditorStatus);
richEditor.addEventListener("scroll", refreshEditorStatus);
richEditor.addEventListener("paste", (e) => {
  e.preventDefault();
  const pasted = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n/g, `
`);
  const caret = getCaretCharacterOffset(richEditor);
  const raw = getEditorValue();
  const next = raw.slice(0, caret) + pasted + raw.slice(caret);
  richEditor.innerHTML = renderRichEditorHtml(next);
  setCaretCharacterOffset(richEditor, caret + pasted.length);
  scheduleSave();
});
runJsBtn.addEventListener("click", () => {
  if (!isJavaScriptFile())
    return;
  const source = getEditorValue();
  const syntax = checkSyntax(source);
  if (!syntax.valid) {
    refreshEditorStatus();
    console.error("JavaScript was not run because it contains a syntax error:", syntax.error);
    return;
  }
  try {
    const result = new Function(source)();
    if (result !== undefined)
      console.log("[Notes] JavaScript result:", result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    syntaxStatusEl.classList.remove("valid");
    syntaxStatusEl.textContent = `Runtime error: ${message}`;
    syntaxStatusEl.title = message;
    console.error("JavaScript execution failed:", error);
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    if (!appReady)
      return;
    e.preventDefault();
    saveNow();
  }
});
window.addEventListener("hashchange", () => {
  if (!appReady)
    return;
  const hashFile = getFileFromHash();
  if (hashFile && hashFile !== state.active && Object.prototype.hasOwnProperty.call(state.files, hashFile)) {
    selectFile(hashFile, true);
  }
});
async function initializeApp() {
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
  container.removeAttribute("inert");
  container.removeAttribute("aria-busy");
  selectFile(state.active, false);
  loadSyntaxConfig();
}
initializeApp();
