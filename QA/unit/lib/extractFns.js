'use strict';
const fs = require('fs');
const vm = require('vm');

// Extracts the exact source of a top-level `function name(...) { ... }`
// declaration from raw file text via brace matching (a line-count/regex
// approach can't reliably handle nested braces). Assumes the function body has
// no unbalanced `{`/`}` characters inside string/template literals or
// comments — true for every function this harness currently extracts; if a
// future function violates that assumption, this throws instead of silently
// producing a truncated/garbled source.
function extractFunctionSource(text, name) {
  const sigRe = new RegExp('function\\s+' + name + '\\s*\\(');
  const sigMatch = sigRe.exec(text);
  if (!sigMatch) throw new Error('extractFunctionSource: function "' + name + '" not found in source');
  const start = sigMatch.index;
  const braceStart = text.indexOf('{', sigMatch.index + sigMatch[0].length);
  if (braceStart === -1) throw new Error('extractFunctionSource: no body found for "' + name + '"');
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error('extractFunctionSource: unbalanced braces for "' + name + '"');
  return text.slice(start, end);
}

// Loads the named top-level functions out of a real GAS HTML file's inline
// <script> and evaluates them together in a fresh vm sandbox. Deliberately does
// NOT eval the whole file — these files have top-level side-effecting code
// (event listener registration, boot(), loadConfig() run at load time) that
// would throw or perform unwanted work outside a browser/GAS environment.
//
// If a named function can't be found (renamed, moved, deleted), this throws
// loudly rather than silently comparing stale/duplicated logic — that failure
// mode is itself a signal that index.html and edit-store.html have drifted.
function loadFunctionsFromHtml(filePath, functionNames, extraGlobals) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sources = functionNames.map(name => extractFunctionSource(text, name));
  const sandbox = Object.assign({}, extraGlobals || {});
  const context = vm.createContext(sandbox);
  const script = new vm.Script(sources.join('\n\n'), { filename: filePath + ' (extracted)' });
  script.runInContext(context);
  return context;
}

module.exports = { extractFunctionSource, loadFunctionsFromHtml };
