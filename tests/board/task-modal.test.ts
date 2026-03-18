import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { preserveFormState } from "../../src/board/assets/components/Component.js";

type MockControl = {
  tagName: string;
  id: string;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  form: MockForm;
  name: string | null;
  type: string | null;
  dataControlId: string | null;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  matches: (selector: string) => boolean;
  closest: () => MockForm;
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
};

type MockForm = {
  id: string;
  identity: string;
  controls: MockControl[];
  hasAttribute: (name: string) => boolean;
  getAttribute: (name: string) => string | null;
  matches: (selector: string) => boolean;
  closest: () => MockForm;
  querySelectorAll: (selector: string) => MockControl[];
};

type FormSeed = {
  identity: string;
  controls: Array<{
    tagName: "INPUT" | "TEXTAREA" | "SELECT";
    name: string;
    value: string;
    dataControlId?: string;
    type?: string;
  }>;
};

function createForm(identity: string, controls: FormSeed["controls"]): MockForm {
  const form: MockForm = {
    id: "",
    identity,
    controls: [],
    hasAttribute(name: string) {
      return name === "data-form-id";
    },
    getAttribute(name: string) {
      return name === "data-form-id" ? identity : null;
    },
    matches(selector: string) {
      return selector.includes("[data-form-id]") || selector.includes("form");
    },
    closest() {
      return form;
    },
    querySelectorAll(selector: string) {
      return selector === "input, textarea, select" ? form.controls : [];
    },
  } satisfies MockForm;

  form.controls = controls.map((control) => ({
    tagName: control.tagName,
    id: "",
    value: control.value,
    selectionStart: control.tagName === "SELECT" ? null : control.value.length,
    selectionEnd: control.tagName === "SELECT" ? null : control.value.length,
    form,
    name: control.name,
    type: control.type ?? null,
    dataControlId: control.dataControlId ?? null,
    getAttribute(name: string) {
      if (name === "name") return this.name;
      if (name === "type") return this.type;
      if (name === "data-control-id") return this.dataControlId;
      if (name === "id") return this.id || null;
      return null;
    },
    hasAttribute(name: string) {
      return this.getAttribute(name) !== null;
    },
    matches() {
      return false;
    },
    closest() {
      return form;
    },
    focus() {},
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  }));

  return form;
}

function createMockContainer(forms: FormSeed[]) {
  let currentForms = forms.map((form) => createForm(form.identity, form.controls));

  const container = {
    ownerDocument: { body: {} },
    querySelectorAll(selector: string) {
      if (selector === "input, textarea, select") {
        return currentForms.flatMap((form) => form.controls);
      }

      if (selector.includes("[data-form-id]")) {
        return currentForms;
      }

      return [];
    },
    setForms(nextForms: FormSeed[]) {
      currentForms = nextForms.map((form) => createForm(form.identity, form.controls));
    },
  } as unknown as HTMLElement & {
    ownerDocument: { body: object };
    setForms: (nextForms: FormSeed[]) => void;
    querySelectorAll: (selector: string) => Array<MockForm | MockControl>;
  };

  return {
    container,
    getControl(formIdentity: string, controlName: string) {
      const form = currentForms.find((candidate) => candidate.identity === formIdentity);
      const control = form?.controls.find((candidate) => candidate.name === controlName);
      if (!control) {
        throw new Error(`Missing control ${formIdentity}:${controlName}`);
      }
      return control;
    },
  };
}

describe("task create-form preservation", () => {
  test("preserves in-progress drafts on same-task rerenders", () => {
    const { container, getControl } = createMockContainer([
      {
        identity: "task-create-subtask:task-1",
        controls: [
          { tagName: "INPUT", name: "title", value: "Draft subtask", dataControlId: "subtask-title" },
          { tagName: "TEXTAREA", name: "description", value: "Keep this draft", dataControlId: "subtask-description" },
        ],
      },
    ]);

    preserveFormState(container, () => {
      container.setForms([
        {
          identity: "task-create-subtask:task-1",
          controls: [
            { tagName: "INPUT", name: "title", value: "", dataControlId: "subtask-title" },
            { tagName: "TEXTAREA", name: "description", value: "", dataControlId: "subtask-description" },
          ],
        },
      ]);
    });

    expect(getControl("task-create-subtask:task-1", "title").value).toBe("Draft subtask");
    expect(getControl("task-create-subtask:task-1", "description").value).toBe("Keep this draft");
  });

  test("skips restoring submitted create-form values after success", () => {
    const { container, getControl } = createMockContainer([
      {
        identity: "task-create-subtask:task-1",
        controls: [
          { tagName: "INPUT", name: "title", value: "Draft subtask", dataControlId: "subtask-title" },
          { tagName: "TEXTAREA", name: "description", value: "Keep this draft", dataControlId: "subtask-description" },
        ],
      },
      {
        identity: "task-dependency:task-1",
        controls: [{ tagName: "SELECT", name: "dependsOnId", value: "task-2", dataControlId: "dependency-target" }],
      },
    ]);

    preserveFormState(container, () => {
      container.setForms([
        {
          identity: "task-create-subtask:task-1",
          controls: [
            { tagName: "INPUT", name: "title", value: "", dataControlId: "subtask-title" },
            { tagName: "TEXTAREA", name: "description", value: "", dataControlId: "subtask-description" },
          ],
        },
        {
          identity: "task-dependency:task-1",
          controls: [{ tagName: "SELECT", name: "dependsOnId", value: "", dataControlId: "dependency-target" }],
        },
      ]);
    }, {
      resetFormIds: [
        "form:task-create-subtask:task-1",
        "form:task-dependency:task-1",
      ],
    });

    expect(getControl("task-create-subtask:task-1", "title").value).toBe("");
    expect(getControl("task-create-subtask:task-1", "description").value).toBe("");
    expect(getControl("task-dependency:task-1", "dependsOnId").value).toBe("");
  });
});
