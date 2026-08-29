import type { BuiltinSkillDef } from './index.js';

export const SUPPORT_RESPONSE_TEMPLATES_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'supportResponder', sortOrder: 40 }],
  description:
    'Structural templates for common support reply shapes, used only when they fit the situation.',
  name: 'support-response-templates',
  promptText: `## Support Response Templates

Use these structural templates only when the situation matches. Do not force a template that does not fit.

**Acknowledge + direct answer**
"Thanks for reaching out. [Direct answer]. Let me know if you need any other details."

**Acknowledge + missing information**
"Thanks for letting us know. To help you, I need a bit more information: [specific question 1], and [specific question 2]."

**Acknowledge + next step**
"I understand [summary of issue]. The next step is [action]. I'll update you here once [expected outcome]."

**Escalation**
"I want to make sure this gets the right attention. I'm escalating your case to [team/area], and you can expect an update [timeframe]. Thank you for your patience."

**Tone note:** These are skeletons only. Replace the bracketed text with specific, accurate, situation-appropriate content.`,
};
