import { ACTIONABLE_LESSONS_SKILL } from './actionableLessons.js';
import { ERROR_PATH_COVERAGE_SKILL } from './errorPathCoverage.js';
import { FOLLOW_EXISTING_PATTERNS_SKILL } from './followExistingPatterns.js';
import { INCREMENTAL_COMMITS_SKILL } from './incrementalCommits.js';
import { NO_NEW_DEPENDENCIES_SKILL } from './noNewDependencies.js';
import { REVIEW_FOCUS_SECURITY_SKILL } from './reviewFocusSecurity.js';
import { SCOPE_CONSERVATISM_SKILL } from './scopeConservatism.js';
import { SECURITY_AWARE_IMPLEMENTATION_SKILL } from './securityAwareImplementation.js';
import { SHELL_COMMAND_SAFETY_SKILL } from './shellCommandSafety.js';
import { TEST_FIRST_SKILL } from './testFirst.js';

export interface BuiltinSkillDef {
  name: string;
  description: string;
  promptText: string;
  assignments: { role: string; sortOrder: number }[];
}

export const BUILTIN_SKILLS: BuiltinSkillDef[] = [
  SCOPE_CONSERVATISM_SKILL,
  FOLLOW_EXISTING_PATTERNS_SKILL,
  TEST_FIRST_SKILL,
  INCREMENTAL_COMMITS_SKILL,
  NO_NEW_DEPENDENCIES_SKILL,
  SHELL_COMMAND_SAFETY_SKILL,
  SECURITY_AWARE_IMPLEMENTATION_SKILL,
  REVIEW_FOCUS_SECURITY_SKILL,
  ERROR_PATH_COVERAGE_SKILL,
  ACTIONABLE_LESSONS_SKILL,
];

export {
  ACTIONABLE_LESSONS_SKILL,
  ERROR_PATH_COVERAGE_SKILL,
  FOLLOW_EXISTING_PATTERNS_SKILL,
  INCREMENTAL_COMMITS_SKILL,
  NO_NEW_DEPENDENCIES_SKILL,
  REVIEW_FOCUS_SECURITY_SKILL,
  SCOPE_CONSERVATISM_SKILL,
  SECURITY_AWARE_IMPLEMENTATION_SKILL,
  SHELL_COMMAND_SAFETY_SKILL,
  TEST_FIRST_SKILL,
};
