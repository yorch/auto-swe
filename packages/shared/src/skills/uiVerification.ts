import type { BuiltinSkillDef } from './index.js';

export const UI_VERIFICATION_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'implementer', sortOrder: 90 }],
  description:
    'Exercises changed application flows in a browser and records clear visual and console evidence.',
  name: 'ui-verification',
  promptText: `## UI Verification

When a change affects an application UI, verify the changed user flow in a real browser when the browser tool is granted.

- Start the configured preview with \`browser_start_app\`; if none is configured, start the app with bash and pass its URL to \`browser_navigate\`.
- Exercise the changed flow from the user's point of view, including its important success and failure states.
- Capture before-and-after screenshots with concise captions that identify the state being shown.
- Check \`browser_console\` for page errors and console errors after exercising the flow.
- Report what you exercised, the screenshot captions, console findings, and anything you could not verify. Never claim a visual check that you did not perform.`,
};
