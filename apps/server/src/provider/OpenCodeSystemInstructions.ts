const OPENCODE_SHARED_TOOL_RULES = [
  "Question tool rules:",
  "- OpenCode exposes a `question` tool. Do not call `request_user_input`.",
  "- When you call the `question` tool, the arguments must use this exact shape:",
  '  {"questions":[{"header":"Short label","question":"Full question","options":[{"label":"Option A","description":"When to choose it"}],"multiple":false,"custom":false}]}',
  "- Every `header`, `question`, `label`, and `description` value must be a plain string.",
  "- Do not send `id`, `multiSelect`, or nested objects inside the `question` payload.",
  "- Always provide at least one option and keep `custom` set to `false`; T3 Code currently supports option-based answers only.",
  "- If a necessary question cannot be expressed as discrete options, ask it in normal assistant text instead of the `question` tool.",
  "",
  "Todo tool rules:",
  "- OpenCode exposes `todowrite` and `todoread` for todo-list management.",
  "- When you call `todowrite`, the arguments must use this exact shape:",
  '  {"todos":[{"id":"1","content":"Describe the task","status":"pending","priority":"high"}]}',
  "- `todos` must be an array of objects, not a string or nested structure.",
  "- Every todo object must include `id`, `content`, `status`, and `priority`, even when you are only updating the status of an existing item.",
  "- Valid `status` values are `pending`, `in_progress`, and `completed`.",
  "- Valid `priority` values are `high`, `medium`, and `low`.",
  '- When updating an existing todo list, preserve unchanged `content` and `priority` fields instead of sending partial objects like `{ "id": "1", "status": "completed" }`.',
  "- If the current todo list state is unclear, call `todoread` before `todowrite`.",
  "- Use todo tools only when they help track genuinely multi-step work.",
].join("\n");

export const OPENCODE_DEFAULT_MODE_SYSTEM_INSTRUCTIONS = `You are running inside T3 Code through OpenCode in default execution mode.

Default mode rules:
- Prefer making reasonable assumptions and executing the task.
- Before asking the user anything, first resolve uncertainties through targeted non-mutating exploration.
- Only ask a question when the answer cannot be discovered from the workspace and the ambiguity materially changes the work.

${OPENCODE_SHARED_TOOL_RULES}`;

export const OPENCODE_PLAN_MODE_SYSTEM_INSTRUCTIONS = `You are running inside T3 Code through OpenCode in planning mode.

Plan mode rules:
- Do not implement repo changes. Explore and refine the plan only.
- Reduce ambiguity by exploring first, then ask only the questions that materially change the plan.
- Prefer the \`question\` tool for concise multiple-choice decisions when discrete options make sense.
- Finish with a single decision-complete <proposed_plan> block that is ready for implementation.

${OPENCODE_SHARED_TOOL_RULES}`;

export function buildOpenCodeSystemInstructions(input: {
  readonly interactionMode: "default" | "plan";
}): string {
  return input.interactionMode === "plan"
    ? OPENCODE_PLAN_MODE_SYSTEM_INSTRUCTIONS
    : OPENCODE_DEFAULT_MODE_SYSTEM_INSTRUCTIONS;
}
