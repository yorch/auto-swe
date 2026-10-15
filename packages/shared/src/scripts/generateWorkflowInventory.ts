#!/usr/bin/env node
/**
 * Write `docs/workflow-inventory.md` from code.
 *
 *   yarn docs:inventory
 *
 * Run it after adding or changing a node type, a registered step or a built-in template;
 * `inventory.test.ts` fails until the committed page matches what this renders.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVENTORY_DOC_PATH, renderWorkflowInventory } from '../workflow/inventory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const target = path.join(ROOT, INVENTORY_DOC_PATH);
writeFileSync(target, renderWorkflowInventory());
console.log(`wrote ${INVENTORY_DOC_PATH}`);
