// Structured-output schemas and a small validator.
//
// The harness asks the model for JSON in three places now: plan,
// edit-spec, and repair-findings. Each has a stable shape that the
// rest of the harness can rely on. We keep the schema language
// deliberately small (this module is ~150 lines, no dependencies) so
// adding new schemas is cheap and so validation failures produce
// human-readable error lists.
//
// A schema is `{ type, properties?, items?, enum?, required? }` mirroring
// JSON Schema's draft-07 vocabulary. Supported types:
//   - "string"  (with optional `enum` and `pattern`)
//   - "integer" / "number"
//   - "boolean"
//   - "array"   (items: <schema>)
//   - "object"  (properties: { name: schema }, required: string[])
//   - "any"     (always passes; useful for tool args bags)

export const PLAN_SCHEMA = {
  type: "object",
  required: ["steps", "summary"],
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: { type: "string" }
    },
    risky_boundaries: {
      type: "array",
      items: { type: "string" }
    },
    expected_files: {
      type: "array",
      items: { type: "string" }
    },
    expected_checks: {
      type: "array",
      items: { type: "string" }
    },
    notes: { type: "string" }
  }
};

export const EDIT_SPEC_SCHEMA = {
  type: "object",
  required: ["edits", "summary"],
  properties: {
    summary: { type: "string" },
    estimated_risk: {
      type: "string",
      enum: ["low", "medium", "high"]
    },
    edits: {
      type: "array",
      items: {
        type: "object",
        required: ["tool", "intent"],
        properties: {
          tool: { type: "string" },
          path: { type: "string" },
          intent: { type: "string" },
          args: { type: "any" }
        }
      }
    }
  }
};

export const REPAIR_FINDINGS_SCHEMA = {
  type: "object",
  required: ["diagnosis", "summary"],
  properties: {
    diagnosis: { type: "string" },
    summary: { type: "string" },
    severity: {
      type: "string",
      enum: ["low", "medium", "high"]
    },
    blockers: {
      type: "array",
      items: { type: "string" }
    },
    proposed_fix: {
      type: "object",
      properties: {
        summary: { type: "string" },
        steps: {
          type: "array",
          items: { type: "string" }
        }
      }
    }
  }
};

/**
 * Validate `value` against `schema`. Returns `{ ok, errors }` where
 * `errors` is an array of `{ path, message }` records. `path` is a
 * JSON-pointer-ish dotted path describing where the violation lives.
 */
export function validate(value, schema, path = "$") {
  const errors = [];
  walk(value, schema, path, errors);
  return { ok: errors.length === 0, errors };
}

function walk(value, schema, path, errors) {
  if (!schema) return;
  if (schema.type === "any") return;

  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push({ path, message: `expected string, got ${typeofValue(value)}` });
      return;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      errors.push({ path, message: `value "${value}" not in enum [${schema.enum.join(", ")}]` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `value does not match pattern /${schema.pattern}/` });
    }
    return;
  }

  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      errors.push({ path, message: `expected ${schema.type}, got ${typeofValue(value)}` });
      return;
    }
    if (schema.type === "integer" && !Number.isInteger(value)) {
      errors.push({ path, message: `expected integer, got fractional number` });
    }
    return;
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      errors.push({ path, message: `expected boolean, got ${typeofValue(value)}` });
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `expected array, got ${typeofValue(value)}` });
      return;
    }
    if (schema.items) {
      value.forEach((entry, index) => walk(entry, schema.items, `${path}[${index}]`, errors));
    }
    return;
  }

  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push({ path, message: `expected object, got ${typeofValue(value)}` });
      return;
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push({ path: `${path}.${key}`, message: `required field missing` });
      }
    }
    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (key in value) walk(value[key], child, `${path}.${key}`, errors);
      }
    }
  }
}

function typeofValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Build a compact human-readable schema description, suitable for
 * inclusion in a system prompt that asks the model to return JSON.
 */
export function describeSchema(schema, indent = 0) {
  const pad = " ".repeat(indent);
  if (!schema) return `${pad}any`;
  if (schema.type === "any") return `${pad}<any>`;
  if (schema.type === "string") {
    const enums = Array.isArray(schema.enum) ? ` (one of: ${schema.enum.join(", ")})` : "";
    return `${pad}string${enums}`;
  }
  if (schema.type === "integer" || schema.type === "number" || schema.type === "boolean") {
    return `${pad}${schema.type}`;
  }
  if (schema.type === "array") {
    return `${pad}array of\n${describeSchema(schema.items, indent + 2)}`;
  }
  if (schema.type === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const lines = [`${pad}{`];
    for (const [key, child] of Object.entries(schema.properties || {})) {
      const tag = required.has(key) ? "*" : "";
      lines.push(`${pad}  "${key}"${tag}: ${describeSchema(child, indent + 2).trimStart()}`);
    }
    lines.push(`${pad}}`);
    return lines.join("\n");
  }
  return `${pad}<unknown:${schema.type}>`;
}
