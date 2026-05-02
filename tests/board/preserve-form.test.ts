import { afterEach, describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { preserveFormState } from "../../src/board/assets/components/Component.js";

// ---------------------------------------------------------------------------
// Minimal DOM mocks
// ---------------------------------------------------------------------------

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
  _queryCount: number;
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
    _queryCount: 0,
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
      if (selector === "input, textarea, select") {
        form._queryCount += 1;
        return form.controls;
      }
      return [];
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
    getCurrentForms() {
      return currentForms;
    },
  } as unknown as HTMLElement & {
    ownerDocument: { body: object };
    setForms: (nextForms: FormSeed[]) => void;
    getCurrentForms: () => MockForm[];
    querySelectorAll: (selector: string) => Array<MockForm | MockControl>;
  };

  return {
    container,
    getControl(formIdentity: string, controlName: string) {
      const form = currentForms.find((candidate) => candidate.identity === formIdentity);
      const control = form?.controls.find((candidate) => candidate.name === controlName);
      if (!control) throw new Error(`Missing control ${formIdentity}:${controlName}`);
      return control;
    },
    getTotalQueryCount() {
      return currentForms.reduce((sum, form) => sum + form._queryCount, 0);
    },
  };
}

/** Build a FormSeed with n named controls using data-control-id identities. */
function buildLargeForm(controlCount: number, values: string[]): FormSeed {
  return {
    identity: "large-form",
    controls: Array.from({ length: controlCount }, (_, i) => ({
      tagName: "INPUT" as const,
      name: `field_${i}`,
      value: values[i] ?? `value_${i}`,
      dataControlId: `ctrl_${i}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const originalDocument = globalThis.document;
afterEach(() => {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
    return;
  }
  globalThis.document = originalDocument;
});

describe("preserveFormState with cached getManagedControls", () => {
  test("50-control form: all values are correctly restored after rerender", () => {
    globalThis.document = { activeElement: null } as Document;

    const CONTROL_COUNT = 50;
    const originalValues = Array.from({ length: CONTROL_COUNT }, (_, i) => `original_${i}`);
    const emptyValues = Array.from({ length: CONTROL_COUNT }, () => "");

    const { container, getControl } = createMockContainer([
      buildLargeForm(CONTROL_COUNT, originalValues),
    ]);

    preserveFormState(container, () => {
      container.setForms([buildLargeForm(CONTROL_COUNT, emptyValues)]);
    });

    // Verify every control has its original value restored.
    for (let i = 0; i < CONTROL_COUNT; i++) {
      expect(getControl("large-form", `field_${i}`).value).toBe(`original_${i}`);
    }
  });

  test("50-control form: restore pass queries each form at most once per form root", () => {
    globalThis.document = { activeElement: null } as Document;

    const CONTROL_COUNT = 50;
    const originalValues = Array.from({ length: CONTROL_COUNT }, (_, i) => `val_${i}`);
    const emptyValues = Array.from({ length: CONTROL_COUNT }, () => "");

    const { container, getTotalQueryCount } = createMockContainer([
      buildLargeForm(CONTROL_COUNT, originalValues),
    ]);

    preserveFormState(container, () => {
      container.setForms([buildLargeForm(CONTROL_COUNT, emptyValues)]);
    });

    // With caching each form root is queried at most once during the restore pass
    // (plus once during the capture pass via the container). Without caching
    // it would be queried O(n) times.
    // We allow ≤ 2 querySelectorAll calls per form root (one per pass).
    expect(getTotalQueryCount()).toBeLessThanOrEqual(2);
  });

  test("single-control form restores correctly (baseline correctness)", () => {
    globalThis.document = { activeElement: null } as Document;

    const { container, getControl } = createMockContainer([
      {
        identity: "simple-form",
        controls: [
          { tagName: "INPUT", name: "title", value: "Hello world", dataControlId: "ctrl-title" },
        ],
      },
    ]);

    preserveFormState(container, () => {
      container.setForms([
        {
          identity: "simple-form",
          controls: [{ tagName: "INPUT", name: "title", value: "", dataControlId: "ctrl-title" }],
        },
      ]);
    });

    expect(getControl("simple-form", "title").value).toBe("Hello world");
  });

  test("multiple forms each get their own cache — no cross-contamination", () => {
    globalThis.document = { activeElement: null } as Document;

    const { container, getControl } = createMockContainer([
      {
        identity: "form-a",
        controls: [{ tagName: "INPUT", name: "field", value: "alpha", dataControlId: "ctrl-a" }],
      },
      {
        identity: "form-b",
        controls: [{ tagName: "INPUT", name: "field", value: "beta", dataControlId: "ctrl-b" }],
      },
    ]);

    preserveFormState(container, () => {
      container.setForms([
        {
          identity: "form-a",
          controls: [{ tagName: "INPUT", name: "field", value: "", dataControlId: "ctrl-a" }],
        },
        {
          identity: "form-b",
          controls: [{ tagName: "INPUT", name: "field", value: "", dataControlId: "ctrl-b" }],
        },
      ]);
    });

    expect(getControl("form-a", "field").value).toBe("alpha");
    expect(getControl("form-b", "field").value).toBe("beta");
  });

  test("resetFormIds option skips restore for the named form", () => {
    globalThis.document = { activeElement: null } as Document;

    const { container, getControl } = createMockContainer([
      {
        identity: "form:reset-me",
        controls: [{ tagName: "INPUT", name: "title", value: "Should be cleared", dataControlId: "ctrl" }],
      },
    ]);

    preserveFormState(
      container,
      () => {
        container.setForms([
          {
            identity: "form:reset-me",
            controls: [{ tagName: "INPUT", name: "title", value: "", dataControlId: "ctrl" }],
          },
        ]);
      },
      { resetFormIds: new Set(["form:reset-me"]) },
    );

    // Value should remain empty because the form was in resetFormIds.
    expect(getControl("form:reset-me", "title").value).toBe("");
  });
});
