import { Editor } from "@tiptap/core";
import type { Mark as ProseMirrorMark } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { createCriticChange } from "./critic-markup";
import { createEditorExtensions } from "./editor-extensions";

/**
 * Helper: build a tiptap Editor in JSDOM with the standard Roughdraft
 * extensions. Returns the editor after `onCreate` has fired.
 */
function createTestEditor(html?: string): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: createEditorExtensions(""),
    content: html,
  });
}

/**
 * Helper: simulate one character of text input in suggesting mode.
 *
 * Mirrors the `handleTextInput` logic in PageCard.tsx — when the cursor
 * is a collapsed caret the character is wrapped in an addition mark that
 * reuses an adjacent addition/substitution-new mark when possible.
 */
function suggestingTypeChar(editor: Editor, char: string) {
  const { state } = editor.view;
  const from = state.selection.from;
  const to = state.selection.to;
  const tr = state.tr;
  const markType = state.schema.marks.criticChange;

  const isReusable = (m: ProseMirrorMark) =>
    m.type === markType &&
    (m.attrs.kind === "addition" || m.attrs.kind === "substitution-new");

  const $pos = state.doc.resolve(from);
  const reusableMark =
    $pos.nodeBefore?.marks.find(isReusable) ??
    $pos.nodeAfter?.marks.find(isReusable) ??
    null;

  if (from !== to) {
    throw new Error("suggestingTypeChar does not support range selections");
  }

  const mark =
    reusableMark ??
    markType.create(
      createCriticChange("addition", undefined, {
        existingChanges: [],
      }),
    );

  tr.insert(from, state.schema.text(char, [mark]));
  tr.setSelection(TextSelection.create(tr.doc, from + char.length));
  editor.view.dispatch(tr);
}

/**
 * Helper: simulate a Backspace press in suggesting mode.
 *
 * Mirrors the *fixed* handleKeyDown logic from PageCard.tsx: if the
 * character being deleted carries an addition/substitution-new mark it
 * is truly removed; otherwise it is marked as a deletion.
 */
function suggestingBackspace(editor: Editor) {
  const { state } = editor.view;
  const { selection } = state;
  const criticMarkType = state.schema.marks.criticChange;
  let from = selection.from;
  const to = selection.to;

  if (selection.empty) {
    from = Math.max(1, selection.from - 1);
  }

  if (from === to) return;

  const isAdditionKind = (m: ProseMirrorMark) =>
    m.type === criticMarkType &&
    (m.attrs.kind === "addition" || m.attrs.kind === "substitution-new");

  type Segment = { from: number; to: number; isAddition: boolean };
  const segments: Segment[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segFrom >= segTo) return;
    const isAdd = node.marks.some(isAdditionKind);
    const prev = segments[segments.length - 1];
    if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
      prev.to = segTo;
    } else {
      segments.push({ from: segFrom, to: segTo, isAddition: isAdd });
    }
  });

  const tr = state.tr;

  for (const seg of [...segments].reverse()) {
    if (seg.isAddition) {
      tr.delete(seg.from, seg.to);
    } else {
      const isReusableDeletion = (m: ProseMirrorMark) =>
        m.type === criticMarkType && m.attrs.kind === "deletion";

      const deletionMark =
        state.doc
          .resolve(seg.from)
          .nodeBefore?.marks.find(isReusableDeletion) ??
        state.doc.resolve(seg.to).nodeAfter?.marks.find(isReusableDeletion) ??
        criticMarkType.create(
          createCriticChange("deletion", undefined, { existingChanges: [] }),
        );

      tr.addMark(seg.from, seg.to, deletionMark);
    }
  }

  const mappedPos = tr.mapping.map(from, -1);
  tr.setSelection(TextSelection.create(tr.doc, mappedPos));
  tr.scrollIntoView();
  editor.view.dispatch(tr);
}

/**
 * Helper: simulate Ctrl+Backspace (word-delete backward) in suggesting mode.
 *
 * Mirrors the handleKeyDown logic from PageCard.tsx for
 * event.key === "Backspace" && (event.ctrlKey || event.altKey).
 */
function suggestingCtrlBackspace(editor: Editor) {
  const { state } = editor.view;
  const { selection } = state;
  const criticMarkType = state.schema.marks.criticChange;

  const $pos = state.doc.resolve(selection.from);
  const blockStart = $pos.start($pos.depth);

  const textBefore = state.doc.textBetween(blockStart, selection.from);
  const match = textBefore.match(/\S+\s*$/);
  const from = match
    ? selection.from - match[0].length
    : Math.max(blockStart, selection.from - 1);
  const to = selection.to;

  if (from === to) return;

  const isAdditionKind = (m: ProseMirrorMark) =>
    m.type === criticMarkType &&
    (m.attrs.kind === "addition" || m.attrs.kind === "substitution-new");

  type Segment = { from: number; to: number; isAddition: boolean };
  const segments: Segment[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segFrom >= segTo) return;
    const isAdd = node.marks.some(isAdditionKind);
    const prev = segments[segments.length - 1];
    if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
      prev.to = segTo;
    } else {
      segments.push({ from: segFrom, to: segTo, isAddition: isAdd });
    }
  });

  const tr = state.tr;

  for (const seg of [...segments].reverse()) {
    if (seg.isAddition) {
      tr.delete(seg.from, seg.to);
    } else {
      const isReusableDeletion = (m: ProseMirrorMark) =>
        m.type === criticMarkType && m.attrs.kind === "deletion";
      const deletionMark =
        state.doc
          .resolve(seg.from)
          .nodeBefore?.marks.find(isReusableDeletion) ??
        state.doc.resolve(seg.to).nodeAfter?.marks.find(isReusableDeletion) ??
        criticMarkType.create(
          createCriticChange("deletion", undefined, { existingChanges: [] }),
        );
      tr.addMark(seg.from, seg.to, deletionMark);
    }
  }

  const mappedPos = tr.mapping.map(from, -1);
  tr.setSelection(TextSelection.create(tr.doc, mappedPos));
  tr.scrollIntoView();
  editor.view.dispatch(tr);
}

/**
 * Helper: simulate Ctrl+Delete (word-delete forward) in suggesting mode.
 */
function suggestingCtrlDelete(editor: Editor) {
  const { state } = editor.view;
  const { selection } = state;
  const criticMarkType = state.schema.marks.criticChange;

  const from = selection.from;
  const $pos = state.doc.resolve(selection.to);
  const blockEnd = $pos.end($pos.depth);

  const textAfter = state.doc.textBetween(selection.to, blockEnd);
  const match = textAfter.match(/^\s*\S+/);
  const to = match
    ? selection.to + match[0].length
    : Math.min(blockEnd, selection.to + 1);

  if (from === to) return;

  const isAdditionKind = (m: ProseMirrorMark) =>
    m.type === criticMarkType &&
    (m.attrs.kind === "addition" || m.attrs.kind === "substitution-new");

  type Segment = { from: number; to: number; isAddition: boolean };
  const segments: Segment[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segFrom >= segTo) return;
    const isAdd = node.marks.some(isAdditionKind);
    const prev = segments[segments.length - 1];
    if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
      prev.to = segTo;
    } else {
      segments.push({ from: segFrom, to: segTo, isAddition: isAdd });
    }
  });

  const tr = state.tr;

  for (const seg of [...segments].reverse()) {
    if (seg.isAddition) {
      tr.delete(seg.from, seg.to);
    } else {
      const isReusableDeletion = (m: ProseMirrorMark) =>
        m.type === criticMarkType && m.attrs.kind === "deletion";
      const deletionMark =
        state.doc
          .resolve(seg.from)
          .nodeBefore?.marks.find(isReusableDeletion) ??
        state.doc.resolve(seg.to).nodeAfter?.marks.find(isReusableDeletion) ??
        criticMarkType.create(
          createCriticChange("deletion", undefined, { existingChanges: [] }),
        );
      tr.addMark(seg.from, seg.to, deletionMark);
    }
  }

  const mappedPos = tr.mapping.map(to, -1);
  tr.setSelection(TextSelection.create(tr.doc, mappedPos));
  tr.scrollIntoView();
  editor.view.dispatch(tr);
}

/**
 * Helper: simulate Cut (Ctrl+X) in suggesting mode.
 *
 * Mirrors the handleKeyDown logic from PageCard.tsx for cut.
 * Addition/substitution-new text is truly deleted; original text gets
 * a deletion mark.
 */
function suggestingCut(editor: Editor) {
  const { state } = editor.view;
  const { selection } = state;
  if (selection.empty) return;

  const criticMarkType = state.schema.marks.criticChange;
  const from = selection.from;
  const to = selection.to;

  const isAdditionKind = (m: ProseMirrorMark) =>
    m.type === criticMarkType &&
    (m.attrs.kind === "addition" || m.attrs.kind === "substitution-new");

  type Segment = { from: number; to: number; isAddition: boolean };
  const segments: Segment[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segFrom >= segTo) return;
    const isAdd = node.marks.some(isAdditionKind);
    const prev = segments[segments.length - 1];
    if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
      prev.to = segTo;
    } else {
      segments.push({ from: segFrom, to: segTo, isAddition: isAdd });
    }
  });

  const tr = state.tr;
  for (const seg of [...segments].reverse()) {
    if (seg.isAddition) {
      tr.delete(seg.from, seg.to);
    } else {
      const isReusableDeletion = (m: ProseMirrorMark) =>
        m.type === criticMarkType && m.attrs.kind === "deletion";
      const deletionMark =
        state.doc
          .resolve(seg.from)
          .nodeBefore?.marks.find(isReusableDeletion) ??
        state.doc.resolve(seg.to).nodeAfter?.marks.find(isReusableDeletion) ??
        criticMarkType.create(
          createCriticChange("deletion", undefined, { existingChanges: [] }),
        );
      tr.addMark(seg.from, seg.to, deletionMark);
    }
  }
  editor.view.dispatch(tr.scrollIntoView());
}

/**
 * Helper: simulate type-with-selection in suggesting mode.
 *
 * Mirrors the handleTextInput logic from PageCard.tsx when from !== to.
 * Addition/substitution-new text is truly deleted; original text gets
 * substitution-old mark.
 */
function suggestingTypeWithSelection(editor: Editor, text: string) {
  const { state } = editor.view;
  const { selection } = state;
  const from = selection.from;
  const to = selection.to;
  const tr = state.tr;
  const criticMarkType = state.schema.marks.criticChange;

  const isAdditionKind = (m: ProseMirrorMark) =>
    m.type === criticMarkType &&
    (m.attrs.kind === "addition" || m.attrs.kind === "substitution-new");

  type Segment = { from: number; to: number; isAddition: boolean };
  const segments: Segment[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segFrom >= segTo) return;
    const isAdd = node.marks.some(isAdditionKind);
    const prev = segments[segments.length - 1];
    if (prev && prev.isAddition === isAdd && prev.to === segFrom) {
      prev.to = segTo;
    } else {
      segments.push({ from: segFrom, to: segTo, isAddition: isAdd });
    }
  });

  const hasOriginalText = segments.some((s) => !s.isAddition);

  if (hasOriginalText) {
    const oldChange = createCriticChange("substitution-old", undefined, {
      existingChanges: [],
    });
    const newMark = criticMarkType.create({
      ...oldChange,
      kind: "substitution-new",
    });

    for (const seg of [...segments].reverse()) {
      if (seg.isAddition) {
        tr.delete(seg.from, seg.to);
      } else {
        tr.addMark(seg.from, seg.to, criticMarkType.create(oldChange));
      }
    }

    const insertPos = tr.mapping.map(to, -1);
    tr.insert(insertPos, state.schema.text(text, [newMark]));
    tr.setSelection(TextSelection.create(tr.doc, insertPos + text.length));
  } else {
    for (const seg of [...segments].reverse()) {
      tr.delete(seg.from, seg.to);
    }
    const insertPos = tr.mapping.map(from, -1);

    const isReusable = (m: ProseMirrorMark) =>
      m.type === criticMarkType &&
      (m.attrs.kind === "addition" || m.attrs.kind === "substitution-new");
    const $pos = state.doc.resolve(from);
    const reusableMark =
      $pos.nodeBefore?.marks.find(isReusable) ??
      $pos.nodeAfter?.marks.find(isReusable) ??
      null;
    const mark =
      reusableMark ??
      criticMarkType.create(
        createCriticChange("addition", undefined, { existingChanges: [] }),
      );
    tr.insert(insertPos, state.schema.text(text, [mark]));
    tr.setSelection(TextSelection.create(tr.doc, insertPos + text.length));
  }

  editor.view.dispatch(tr.scrollIntoView());
}

function getMarks(editor: Editor): Array<{ text: string; kind: string }> {
  const marks: Array<{ text: string; kind: string }> = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === "criticChange") {
        marks.push({ text: node.text ?? "", kind: mark.attrs.kind as string });
      }
    }
  });
  return marks;
}

describe("suggesting mode backspace inside an insertion", () => {
  it("should delete the last character of a suggested insertion rather than marking it as a deletion", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Place cursor at end of "Hello" (position 6 in ProseMirror)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );

    // Type " there" in suggesting mode → creates an addition mark
    for (const char of " there") {
      suggestingTypeChar(editor, char);
    }

    // Verify the addition mark exists
    let hasAdditionMark = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (
          mark.type.name === "criticChange" &&
          mark.attrs.kind === "addition"
        ) {
          hasAdditionMark = true;
        }
      }
    });
    expect(hasAdditionMark).toBe(true);

    // The full text should now be "Hello there world"
    expect(editor.state.doc.textContent).toBe("Hello there world");

    // Now press Backspace — this should delete "e" from the addition,
    // leaving "Hello ther world" with "addition" mark on " ther"
    suggestingBackspace(editor);

    // Correct behaviour: "e" is simply removed because it was part of the
    // user's own suggested insertion — it was never committed content.
    expect(editor.state.doc.textContent).toBe("Hello ther world");

    // No deletion mark should exist
    let hasDeletionMark = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (
          mark.type.name === "criticChange" &&
          mark.attrs.kind === "deletion"
        ) {
          hasDeletionMark = true;
        }
      }
    });
    expect(hasDeletionMark).toBe(false);

    editor.destroy();
  });

  it("should still mark original text as a deletion when backspacing", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Place cursor after "Hello " (position 7)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7)),
    );

    // Backspace on original text → should create a deletion mark
    suggestingBackspace(editor);

    // The text content stays the same (deletion marks don't remove text)
    expect(editor.state.doc.textContent).toBe("Hello world");

    // There should be a deletion mark on the space character
    let hasDeletionMark = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (
          mark.type.name === "criticChange" &&
          mark.attrs.kind === "deletion"
        ) {
          hasDeletionMark = true;
        }
      }
    });
    expect(hasDeletionMark).toBe(true);

    editor.destroy();
  });

  it("should fully remove a suggested insertion when all characters are backspaced", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );

    // Type "X" in suggesting mode
    suggestingTypeChar(editor, "X");
    expect(editor.state.doc.textContent).toBe("HelloX world");

    // Backspace "X" — should completely remove it
    suggestingBackspace(editor);
    expect(editor.state.doc.textContent).toBe("Hello world");

    // No critic marks should remain
    let hasCriticMark = false;
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (mark.type.name === "criticChange") {
          hasCriticMark = true;
        }
      }
    });
    expect(hasCriticMark).toBe(false);

    editor.destroy();
  });
});

describe("Ctrl+Backspace should not cross paragraph boundaries", () => {
  it("should not mark text from the previous paragraph when Ctrl+Backspace is pressed at the start of a paragraph", () => {
    const editor = createTestEditor(
      "<p>First paragraph</p><p>Second paragraph</p>",
    );

    // Place cursor at the start of "Second paragraph"
    // Doc structure: <doc><p>First paragraph</p><p>Second paragraph</p></doc>
    // Position 1: start of first paragraph
    // Position 16: end of "First paragraph" (15 chars)
    // Position 17: after first paragraph close
    // Position 18: start of second paragraph content
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 18)),
    );

    // Ctrl+Backspace should not reach into the first paragraph
    suggestingCtrlBackspace(editor);

    // The first paragraph should be untouched — no deletion marks
    const marks = getMarks(editor);
    const firstParagraphDeletions = marks.filter(
      (m) => m.kind === "deletion" && "First paragraph".includes(m.text),
    );
    expect(firstParagraphDeletions).toHaveLength(0);

    editor.destroy();
  });
});

describe("Ctrl+Delete should not cross paragraph boundaries", () => {
  it("should not mark text from the next paragraph when Ctrl+Delete is pressed at the end of a paragraph", () => {
    const editor = createTestEditor(
      "<p>First paragraph</p><p>Second paragraph</p>",
    );

    // Place cursor at the end of "First paragraph" (position 16)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 16)),
    );

    // Ctrl+Delete should not reach into the second paragraph
    suggestingCtrlDelete(editor);

    // The second paragraph should be untouched — no deletion marks
    const marks = getMarks(editor);
    const secondParagraphDeletions = marks.filter(
      (m) => m.kind === "deletion" && "Second paragraph".includes(m.text),
    );
    expect(secondParagraphDeletions).toHaveLength(0);

    editor.destroy();
  });
});

describe("Cut in suggesting mode should delete addition text, not mark it", () => {
  it("should truly delete addition text when cutting a selection that includes it", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Place cursor at end of "Hello" and type " new" as suggestion
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello new world");

    // Select " new" (positions 6..10 — the addition text)
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 6, 10),
      ),
    );

    // Cut — addition text should be deleted, not marked as deletion
    suggestingCut(editor);

    // The addition text should be gone
    expect(editor.state.doc.textContent).toBe("Hello world");

    // No deletion marks should exist (the addition text was never committed)
    const marks = getMarks(editor);
    const deletionMarks = marks.filter((m) => m.kind === "deletion");
    expect(deletionMarks).toHaveLength(0);

    editor.destroy();
  });

  it("should mark original text as deletion and delete addition text in a mixed selection", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Type " new" after "Hello"
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello new world");

    // Select "o new w" — includes original "o", addition " new", and original " w"
    // In the doc: "Hello new world"
    //              ^    ^^^^
    // Position 5 = "o", positions 6-9 = " new" (addition), position 10 = " ", position 11 = "w"
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 5, 12),
      ),
    );

    suggestingCut(editor);

    // Addition text " new" should be deleted; "o" and " w" should have deletion marks
    const marks = getMarks(editor);
    const additionMarks = marks.filter((m) => m.kind === "addition");
    expect(additionMarks).toHaveLength(0);

    const deletionMarks = marks.filter((m) => m.kind === "deletion");
    expect(deletionMarks.length).toBeGreaterThan(0);

    editor.destroy();
  });
});

describe("Type-with-selection should delete addition text, not mark as substitution-old", () => {
  it("should delete addition text and insert new addition when typing over a suggestion", () => {
    const editor = createTestEditor("<p>Hello world</p>");

    // Type " new" after "Hello"
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)),
    );
    for (const char of " new") {
      suggestingTypeChar(editor, char);
    }
    expect(editor.state.doc.textContent).toBe("Hello new world");

    // Select " new" (the addition text at positions 6-10)
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 6, 10),
      ),
    );

    // Type " replaced" over the selection
    suggestingTypeWithSelection(editor, " replaced");

    // The addition text should be replaced, not marked as substitution-old
    const marks = getMarks(editor);
    const subOldMarks = marks.filter((m) => m.kind === "substitution-old");
    expect(subOldMarks).toHaveLength(0);

    // The new text should be an addition (or substitution-new if mixed)
    expect(editor.state.doc.textContent).toContain("replaced");

    editor.destroy();
  });
});
