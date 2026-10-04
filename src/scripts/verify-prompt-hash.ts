import { createHash } from 'crypto';
import { ANALYSIS_PROMPT_EVIDENCE_A } from '../prompts';

const EXPECTED_A =
  '79dea144a37ef58d90918d3ed48727afe580f1db48dfec9d5be32112c4ceef95';

const actual = createHash('sha256')
  .update(ANALYSIS_PROMPT_EVIDENCE_A, 'utf8')
  .digest('hex');

if (actual === EXPECTED_A) {
  console.log(`PASS: ${actual}`);
  process.exit(0);
}

console.error(`FAIL: expected ${EXPECTED_A}`);
console.error(`      got      ${actual}`);
process.exit(1);