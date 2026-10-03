import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const agentDir = path.resolve(import.meta.dirname, "..");
const version = readFileSync(path.join(agentDir, "install/current-version"), "utf8").trim();
const modules = path.join(agentDir, "install/releases", version, "node_modules");
const earendil = path.join(modules, "@earendil-works");
const { createJiti } = await import(pathToFileURL(path.join(modules, "jiti/lib/jiti.mjs")));
const tui = await import(pathToFileURL(path.join(earendil, "pi-tui/dist/index.js")));
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": path.join(earendil, "pi-coding-agent/dist/index.js"),
    "@earendil-works/pi-tui": path.join(earendil, "pi-tui/dist/index.js"),
  },
});
const { ModalEditor } = await jiti.import(
  path.join(agentDir, "git/github.com/Alan-Luc/pi-vim/index.ts"),
);

const identity = (text) => text;
const theme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

function createEditor() {
  const keybindings = new tui.KeybindingsManager(tui.TUI_KEYBINDINGS);
  tui.setKeybindings(keybindings);
  return new ModalEditor({ requestRender() {} }, theme, keybindings);
}

function showSlashCompletion(editor, value = "/reload") {
  let applications = 0;
  editor.autocompleteState = "slash";
  editor.autocompletePrefix = editor.getText();
  editor.autocompleteList = {
    getSelectedItem: () => ({ value, label: value }),
  };
  editor.autocompleteProvider = {
    applyCompletion() {
      applications += 1;
      return { lines: [value], cursorLine: 0, cursorCol: value.length };
    },
  };
  return () => applications;
}

test("insert Enter accepts and submits a visible slash completion", () => {
  const editor = createEditor();
  let submitted;
  editor.setText("/relo");
  editor.onSubmit = (text) => {
    submitted = text;
  };
  const applications = showSlashCompletion(editor);

  editor.handleInput("\r");

  assert.equal(applications(), 1);
  assert.equal(submitted, "/reload");
});

test("insert Enter remains a newline without autocomplete", () => {
  const editor = createEditor();
  let submitted = false;
  editor.setText("hello");
  editor.onSubmit = () => {
    submitted = true;
  };

  editor.handleInput("\r");

  assert.equal(editor.getText(), "hello\n");
  assert.equal(submitted, false);
});

test("Escape cancels completion and normal Enter submits exact text", () => {
  const editor = createEditor();
  let submitted;
  editor.setText("/reload");
  editor.onSubmit = (text) => {
    submitted = text;
  };
  const applications = showSlashCompletion(editor);

  editor.handleInput("\x1b");
  assert.equal(editor.getMode(), "normal");
  assert.equal(editor.isShowingAutocomplete(), false);
  editor.handleInput("\r");

  assert.equal(applications(), 0);
  assert.equal(submitted, "/reload");
});

test("normal Enter ignores a late stale completion", () => {
  const editor = createEditor();
  let submitted;
  editor.setText("/reload");
  editor.onSubmit = (text) => {
    submitted = text;
  };
  editor.handleInput("\x1b");
  const applications = showSlashCompletion(editor);

  editor.handleInput("\r");

  assert.equal(applications(), 0);
  assert.equal(submitted, "/reload");
});
