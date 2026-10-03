// ============================================================
// E.3 — REGRESSION VALIDATOR (FINAL)
// ============================================================
// Membaca manifest.json + artifact replay.
// Menghasilkan PASS / FAIL / INCONCLUSIVE per case × replay.
// Fixture = authority. Artifact = subject under test.
// Tidak mengubah production code.
// Tidak mengubah prompt.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, 'output');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const MANIFEST_PATH = path.join(__dirname, 'corpus', 'manifest.json');

// ============================================================
// TYPES
// ============================================================

interface ManifestCase {
  case_id: string;
  failure_type: string;
  fixture: string;
  expected_invariant: Record<string, any>;
}

interface Manifest {
  cases: ManifestCase[];
}

interface ReplayArtifact {
  case_id: string;
  failure_type: string;
  fixture: string;
  chunkText: string;
  rawOutput: string;
  parsedEvidence: any[];
  errors: string[];
}

interface InvariantResult {
  invariant: string;
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  violations: string[];
  unavailable: string[];
}

interface ValidationResult {
  case_id: string;
  replay: number;
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  invariants: InvariantResult[];
  violations: string[];
}

interface RegressionReport {
  generated_at: string;
  summary: RegressionSummary;
  results: ValidationResult[];
}

interface RegressionSummary {
  total_cases: number;
  total_replays: number;
  pass_count: number;
  fail_count: number;
  inconclusive_count: number;
}

function generateSummary(results: ValidationResult[]): RegressionSummary {
  const total = results.length;
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const inconclusive = results.filter(r => r.status === 'INCONCLUSIVE').length;

  return {
    total_cases: new Set(results.map(r => r.case_id)).size,
    total_replays: total,
    pass_count: pass,
    fail_count: fail,
    inconclusive_count: inconclusive
  };
}

// ============================================================
// FIXTURE PARSER — AUTHORITATIVE SOURCE (FIXED)
// ============================================================
// Stateful parser yang mendukung:
// - "Segment X: teks" (inline)
// - "Segment X:\nteks" (multiline)
// - Beberapa baris teks per segment
// ============================================================

interface FixtureSegment {
  index: number;
  text: string;
}

function parseFixtureSegments(fixtureText: string): FixtureSegment[] {
  const lines = fixtureText.split(/\r?\n/);
  const segments: FixtureSegment[] = [];

  let currentSegment: FixtureSegment | null = null;

  for (const line of lines) {
    // Deteksi header "Segment X:" atau "Segment X: teks"
    const headerMatch = line.match(/^Segment\s+(\d+):\s*(.*)$/i);

    if (headerMatch) {
      // Simpan segment sebelumnya
      if (currentSegment) {
        currentSegment.text = currentSegment.text.trim();
        segments.push(currentSegment);
      }

      const index = parseInt(headerMatch[1], 10);
      const inlineText = headerMatch[2]?.trim() || '';

      currentSegment = {
        index,
        text: inlineText
      };

      continue;
    }

    // Line lanjutan untuk segment saat ini
    if (currentSegment) {
      const trimmed = line.trim();

      if (trimmed) {
        currentSegment.text +=
          (currentSegment.text ? ' ' : '') + trimmed;
      }
    }
  }

  // Simpan segment terakhir
  if (currentSegment) {
    currentSegment.text = currentSegment.text.trim();
    segments.push(currentSegment);
  }

  return segments;
}

// ============================================================
// VALIDATORS
// ============================================================

function validateRequiredPropositions(
  evidenceList: any[],
  requiredPropositions: string[]
): InvariantResult {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!requiredPropositions || requiredPropositions.length === 0) {
    return {
      invariant: 'required_propositions',
      status: 'PASS',
      violations,
      unavailable
    };
  }

  // Empty evidence → INCONCLUSIVE
  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'required_propositions',
      status: 'INCONCLUSIVE',
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const prop of requiredPropositions) {
    const found = evidenceList.some(ev => {
      const excerpt = ev.source_excerpt || '';
      return excerpt.includes(prop);
    });

    if (!found) {
      violations.push(`MISSING_REQUIRED_PROPOSITION: ${prop}`);
    }
  }

  return {
    invariant: 'required_propositions',
    status: violations.length > 0 ? 'FAIL' : 'PASS',
    violations,
    unavailable
  };
}

function validateLiteralExcerpt(
  evidenceList: any[],
  chunkText: string
): InvariantResult {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!chunkText) {
    return {
      invariant: 'excerpt_must_be_literal',
      status: 'INCONCLUSIVE',
      violations,
      unavailable: ['CHUNK_TEXT_UNAVAILABLE']
    };
  }

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'excerpt_must_be_literal',
      status: 'INCONCLUSIVE',
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const ev of evidenceList) {
    const excerpt = ev.source_excerpt || '';

    if (!excerpt) continue;

    if (!chunkText.includes(excerpt)) {
      violations.push(`NON_LITERAL_EXCERPT: "${excerpt}"`);
    }
  }

  return {
    invariant: 'excerpt_must_be_literal',
    status: violations.length > 0 ? 'FAIL' : 'PASS',
    violations,
    unavailable
  };
}

function validateRequiredProperties(
  evidenceList: any[],
  requiredProperties: Array<{
    property: string;
    value: string;
    unit: string;
  }>
): InvariantResult {
  const violations: string[] = [];
  const unavailable: string[] = [];

  if (!requiredProperties || requiredProperties.length === 0) {
    return {
      invariant: 'required_properties',
      status: 'PASS',
      violations,
      unavailable
    };
  }

  // Empty evidence → INCONCLUSIVE
  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'required_properties',
      status: 'INCONCLUSIVE',
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const prop of requiredProperties) {
    const found = evidenceList.some(ev => {
      const claimHasProperty = (ev.claim || '')
        .toLowerCase()
        .includes(prop.property.toLowerCase());

      return (
        claimHasProperty &&
        String(ev.value ?? '') === prop.value &&
        String(ev.unit ?? '') === prop.unit
      );
    });

    if (!found) {
      violations.push(
        `MISSING_REQUIRED_PROPERTY: ${prop.property} = ${prop.value} ${prop.unit}`
      );
    }
  }

  return {
    invariant: 'required_properties',
    status: violations.length > 0 ? 'FAIL' : 'PASS',
    violations,
    unavailable
  };
}

function validateNoCompoundValue(
  evidenceList: any[]
): InvariantResult {
  const violations: string[] = [];
  const unavailable: string[] = [];

  // Empty evidence → INCONCLUSIVE
  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'no_compound_value',
      status: 'INCONCLUSIVE',
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  const compoundEvidence = evidenceList.filter(ev => {
    const claim = (ev.claim || '').toLowerCase();
    return (
      claim.includes('ram') &&
      claim.includes('storage')
    );
  });

  if (compoundEvidence.length > 0) {
    violations.push(
      'COMPOUND_PROPERTY_DETECTED: RAM dan storage dalam satu evidence'
    );
  }

  return {
    invariant: 'no_compound_value',
    status: violations.length > 0 ? 'FAIL' : 'PASS',
    violations,
    unavailable
  };
}

function validateForbiddenCombinations(
  evidenceList: any[],
  forbiddenCombinations: Array<Record<string, string>>
): InvariantResult {
  const violations: string[] = [];

  if (!forbiddenCombinations || forbiddenCombinations.length === 0) {
    return {
      invariant: 'forbidden_combinations',
      status: 'PASS',
      violations,
      unavailable: []
    };
  }

  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'forbidden_combinations',
      status: 'INCONCLUSIVE',
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  for (const ev of evidenceList) {
    for (const combo of forbiddenCombinations) {
      if (
        combo.type === 'FACT' &&
        combo.reviewer_assessment === 'not_null' &&
        ev.type === 'FACT' &&
        ev.reviewer_assessment !== null &&
        ev.reviewer_assessment !== undefined
      ) {
        violations.push(
          `FORBIDDEN_COMBINATION: FACT + reviewer_assessment=${ev.reviewer_assessment}`
        );
      }
    }
  }

  return {
    invariant: 'forbidden_combinations',
    status: violations.length > 0 ? 'FAIL' : 'PASS',
    violations,
    unavailable: []
  };
}

function validateSourceBoundary(
  evidenceList: any[],
  allowedSegments: number[],
  fixtureSegments: FixtureSegment[]
): InvariantResult {
  const violations: string[] = [];
  const unavailable: string[] = [];

  // 1. PINDAHKAN KE SINI: Log di paling atas agar selalu tereksekusi
  console.log(
    "DEBUG REG-004 fixtureSegments:",
    JSON.stringify(fixtureSegments, null, 2)
  );

  if (!fixtureSegments || fixtureSegments.length === 0) {
    return {
      invariant: 'source_boundary',
      status: 'INCONCLUSIVE',
      violations,
      unavailable: ['FIXTURE_SEGMENTS_UNAVAILABLE']
    };
  }

  if (!allowedSegments || allowedSegments.length === 0) {
    return {
      invariant: 'source_boundary',
      status: 'INCONCLUSIVE',
      violations,
      unavailable: ['ALLOWED_SEGMENTS_UNAVAILABLE']
    };
  }

  // Empty evidence → INCONCLUSIVE
  if (!evidenceList || evidenceList.length === 0) {
    return {
      invariant: 'source_boundary',
      status: 'INCONCLUSIVE',
      violations,
      unavailable: ['EVIDENCE_LIST_EMPTY']
    };
  }

  const allowedTexts = fixtureSegments
    .filter(seg => allowedSegments.includes(seg.index))
    .map(seg => seg.text);

  for (const ev of evidenceList) {
    const excerpt = ev.source_excerpt || '';

    // 2. Log per evidence di dalam loop
    console.log(
      "DEBUG REG-004 boundary check:",
      JSON.stringify(
        {
          excerpt,
          allowedTexts,
          matches: allowedTexts.map(text => text.includes(excerpt))
        },
        null,
        2
      )
    );

    if (!excerpt) continue;

    const foundInAllowed = allowedTexts.some(text =>
      text.includes(excerpt)
    );

    if (!foundInAllowed) {
      violations.push(`EXCERPT_OUTSIDE_ALLOWED_SEGMENTS: "${excerpt}"`);
    }
  }

  return {
    invariant: 'source_boundary',
    status: violations.length > 0 ? 'FAIL' : 'PASS',
    violations,
    unavailable
  };
}

// ============================================================
// AGGREGATION
// ============================================================

function finalStatus(
  invariantResults: InvariantResult[]
): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  if (invariantResults.some(r => r.status === 'FAIL')) {
    return 'FAIL';
  }

  if (invariantResults.some(r => r.status === 'INCONCLUSIVE')) {
    return 'INCONCLUSIVE';
  }

  return 'PASS';
}

// ============================================================
// MAIN VALIDATOR
// ============================================================

function validateReplay(
  caseDef: ManifestCase,
  artifact: ReplayArtifact,
  replayNumber: number,
  fixtureSegments: FixtureSegment[]
): ValidationResult {
  const evidenceList = artifact.parsedEvidence || [];
  const invariant = caseDef.expected_invariant;

  const invariantResults: InvariantResult[] = [];

  // required_propositions
  if (invariant.required_propositions) {
    invariantResults.push(
      validateRequiredPropositions(
        evidenceList,
        invariant.required_propositions
      )
    );
  }

  // excerpt_must_be_literal
  if (invariant.excerpt_must_be_literal) {
    invariantResults.push(
      validateLiteralExcerpt(evidenceList, artifact.chunkText)
    );
  }

  // required_properties
  if (invariant.required_properties) {
    invariantResults.push(
      validateRequiredProperties(
        evidenceList,
        invariant.required_properties
      )
    );
  }

  // no_compound_value
  if (invariant.no_compound_value) {
    invariantResults.push(
      validateNoCompoundValue(evidenceList)
    );
  }

  // forbidden_combinations
  if (invariant.forbidden_combinations) {
    invariantResults.push(
      validateForbiddenCombinations(
        evidenceList,
        invariant.forbidden_combinations
      )
    );
  }

  // source_boundary
  if (invariant.source_boundary === 'strict') {
    invariantResults.push(
      validateSourceBoundary(
        evidenceList,
        invariant.allowed_segments || [],
        fixtureSegments
      )
    );
  }

  const status = finalStatus(invariantResults);

  const allViolations = invariantResults.flatMap(r => r.violations);

  return {
    case_id: caseDef.case_id,
    replay: replayNumber,
    status,
    invariants: invariantResults,
    violations: allViolations
  };
}



// ============================================================
// MAIN
// ============================================================

function main() {
  console.log('\n📊 E.3 — Regression Validator (Final)\n');

  const manifestRaw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest: Manifest = JSON.parse(manifestRaw);

  const report: RegressionReport = {
    generated_at: new Date().toISOString(),
    summary: {
      total_cases: 0,
      total_replays: 0,
      pass_count: 0,
      fail_count: 0,
      inconclusive_count: 0
    },
    results: []
  };

  for (const caseDef of manifest.cases) {
    const fixturePath = path.join(FIXTURE_DIR, caseDef.fixture);
    const fixtureText = fs.readFileSync(fixturePath, 'utf8');
    const fixtureSegments = parseFixtureSegments(fixtureText);

    for (let replay = 1; replay <= 3; replay++) {
      const artifactPath = path.join(
        OUTPUT_DIR,
        `${caseDef.case_id}_replay_${replay}.json`
      );

      if (!fs.existsSync(artifactPath)) {
        report.results.push({
          case_id: caseDef.case_id,
          replay,
          status: 'INCONCLUSIVE',
          invariants: [],
          violations: ['ARTIFACT_MISSING']
        });
        continue;
      }

      const artifactRaw = fs.readFileSync(artifactPath, 'utf8');
      const artifact: ReplayArtifact = JSON.parse(artifactRaw);

      const result = validateReplay(
        caseDef,
        artifact,
        replay,
        fixtureSegments
      );

      report.results.push(result);

      console.log(
        `${result.case_id} Replay #${replay}: ${result.status}` +
        (result.violations.length > 0
          ? ` (${result.violations.length} violations)`
          : '')
      );
    }
  }

  // ====================================================
  // SUMMARY — DERIVED DATA dari results
  // ====================================================

  report.summary = {
    total_cases: manifest.cases.length,
    total_replays: report.results.length,
    pass_count: report.results.filter(r => r.status === 'PASS').length,
    fail_count: report.results.filter(r => r.status === 'FAIL').length,
    inconclusive_count: report.results.filter(
      r => r.status === 'INCONCLUSIVE'
    ).length
  };

  const reportPath = path.join(OUTPUT_DIR, 'regression-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n============================================');
  console.log(`💾 Regression report disimpan: ${reportPath}`);
  console.log('============================================\n');
}

main();