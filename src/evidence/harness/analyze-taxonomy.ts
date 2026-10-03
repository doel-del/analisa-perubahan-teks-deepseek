// ============================================================
// E.3 — FAILURE TAXONOMY ANALYZER (HARDENED)
// ============================================================
// Membaca artifact E.2 dan menghasilkan raw measurement report.
// Tidak mengubah production code.
// Tidak mengubah prompt.
// Tidak menjalankan validator production.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, 'output');

// ============================================================
// TYPES
// ============================================================

interface ReplayArtifact {
  case_id: string;
  failure_type: string;
  fixture: string;
  model: string;
  prompt_version: string;
  temperature: number;
  timestamp: string;
  chunkText: string;
  rawOutput: string;
  parsedEvidence: any[];
  errors: string[];
}

interface EvidenceMetrics {
  evidence_index: number;
  type: string | null;
  value: string | null;
  unit: string | null;
  reviewer_assessment: string | null;
  comparison_target: string | null;
  source_excerpt: string | null;
  compound_value_detected: boolean;
  assessment_violation: boolean;
  excerpt_is_literal: boolean;
  excerpt_is_complete_heuristic: boolean;
  comparison_target_missing: boolean;
}

interface ReplayMetrics {
  replay: number;
  evidence_count: number;
  empty_extraction: boolean;
  compound_value_detected: boolean;
  assessment_violation_count: number;
  excerpt_literal_count: number;
  excerpt_literal_rate: number;
  excerpt_complete_count: number;
  excerpt_complete_rate: number;
  comparison_target_missing_count: number;
  evidence_details: EvidenceMetrics[];
}

interface CaseMetrics {
  case_id: string;
  failure_type: string;
  replays: ReplayMetrics[];
  case_summary: Record<string, any>;
}

interface TaxonomyReport {
  generated_at: string;
  total_cases: number;
  total_replays: number;
  cases: CaseMetrics[];
}

// ============================================================
// NORMALIZATION
// ============================================================

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[“”"'`]/g, '')
    .replace(/[.,!?;:()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// COMPARISON DETECTION — FIXED
// ============================================================

function hasExplicitComparison(text: string): boolean {
  const patterns = [
    /\bdibandingkan\b/,
    /\bdibanding\b/,
    /\bketimbang\b/,
    /\bvs\b/,
    /\bversus\b/,
    /\blebih\s+(?:tinggi|rendah|besar|kecil|luas|sempit|tebal|tipis|panjang|pendek|baik|buruk|cepat|lambat)\s+dari\b/,
    /\blebih\s+(?:tinggi|rendah|besar|kecil|luas|sempit|tebal|tipis|panjang|pendek|baik|buruk|cepat|lambat)\s+dibanding\b/,
    /\blebih\s+(?:tinggi|rendah|besar|kecil|luas|sempit|tebal|tipis|panjang|pendek|baik|buruk|cepat|lambat)\s+daripada\b/
  ];

  return patterns.some(pattern => pattern.test(text));
}

function detectComparisonTargetMissing(
  claim: string | null | undefined,
  source_excerpt: string | null | undefined,
  comparison_target: string | null | undefined
): boolean {
  const textToCheck = normalizeForSearch(
    `${claim || ''} ${source_excerpt || ''}`
  );

  if (!hasExplicitComparison(textToCheck)) {
    return false;
  }

  return (
    comparison_target === null ||
    comparison_target === undefined
  );
}

// ============================================================
// COMPOUND VALUE DETECTION
// ============================================================

function detectCompoundValue(value: string | null | undefined): boolean {
  if (!value) return false;

  const str = String(value);

  // Deteksi pola compound seperti 8/256, 4/64, dst.
  const compoundPattern = /^\d+\s*\/\s*\d+$/;

  return compoundPattern.test(str.trim());
}

// ============================================================
// ASSESSMENT VIOLATION DETECTION
// ============================================================

function detectAssessmentViolation(
  type: string | null | undefined,
  assessment: string | null | undefined
): boolean {
  // Semua type selain OPINION tidak boleh memiliki reviewer_assessment
  if (type === 'OPINION') return false;

  return (
    assessment !== null &&
    assessment !== undefined
  );
}

// ============================================================
// LITERAL EXCERPT DETECTION
// ============================================================

function detectLiteralExcerpt(
  excerpt: string | null | undefined,
  chunkText: string
): boolean {
  if (!excerpt) return false;

  const normalizedExcerpt = normalizeForSearch(excerpt);
  const normalizedChunk = normalizeForSearch(chunkText);

  return normalizedChunk.includes(normalizedExcerpt);
}

// ============================================================
// PROPERTY NUMBER EXTRACTION — FIXED
// ============================================================

function extractPropertyNumbers(claim: string): string[] {
  const withoutEntity = claim
    .replace(/\b(?:Galaxy|Samsung|Exynos|Snapdragon)\s+[A-Z]?\d+(?:\s+\d+)?/gi, '')
    .replace(/\bA\d+\b/g, '')
    .replace(/\b\d+G\b/g, '');

  return withoutEntity.match(/\d+(?:[.,]\d+)?/g) || [];
}

// ============================================================
// COMPLETE EXCERPT HEURISTIC — FIXED
// ============================================================

function detectCompleteExcerptHeuristic(
  claim: string | null | undefined,
  excerpt: string | null | undefined
): boolean {
  if (!claim || !excerpt) return false;

  const claimNumbers = extractPropertyNumbers(claim);
  const excerptNumbers = excerpt.match(/\d+(?:[.,]\d+)?/g) || [];

  if (claimNumbers.length === 0) {
    return excerpt.trim().length > 0;
  }

  const excerptNumberSet = new Set(excerptNumbers);

  return claimNumbers.every(num => excerptNumberSet.has(num));
}

// ============================================================
// ANALYZE ONE EVIDENCE
// ============================================================

function analyzeEvidence(
  evidence: any,
  chunkText: string,
  index: number
): EvidenceMetrics {
  const type = evidence?.type ?? null;
  const value = evidence?.value ?? null;
  const unit = evidence?.unit ?? null;
  const assessment = evidence?.reviewer_assessment ?? null;
  const comparisonTarget = evidence?.comparison_target ?? null;
  const excerpt = evidence?.source_excerpt ?? null;
  const claim = evidence?.claim ?? null;

  return {
    evidence_index: index,
    type,
    value: value !== null ? String(value) : null,
    unit: unit !== null ? String(unit) : null,
    reviewer_assessment: assessment,
    comparison_target: comparisonTarget,
    source_excerpt: excerpt,
    compound_value_detected: detectCompoundValue(value),
    assessment_violation: detectAssessmentViolation(type, assessment),
    excerpt_is_literal: detectLiteralExcerpt(excerpt, chunkText),
    excerpt_is_complete_heuristic: detectCompleteExcerptHeuristic(
      claim,
      excerpt
    ),
    comparison_target_missing: detectComparisonTargetMissing(
      claim,
      excerpt,
      comparisonTarget
    )
  };
}

// ============================================================
// ANALYZE ONE REPLAY
// ============================================================

function analyzeReplay(
  artifact: ReplayArtifact,
  replayNumber: number
): ReplayMetrics {
  const evidenceList = artifact.parsedEvidence || [];

  const evidenceDetails = evidenceList.map((ev, idx) =>
    analyzeEvidence(ev, artifact.chunkText, idx)
  );

  const literalCount = evidenceDetails.filter(
    e => e.excerpt_is_literal
  ).length;

  const completeCount = evidenceDetails.filter(
    e => e.excerpt_is_complete_heuristic
  ).length;

  const assessmentViolationCount = evidenceDetails.filter(
    e => e.assessment_violation
  ).length;

  const comparisonMissingCount = evidenceDetails.filter(
    e => e.comparison_target_missing
  ).length;

  const compoundDetected = evidenceDetails.some(
    e => e.compound_value_detected
  );

  return {
    replay: replayNumber,
    evidence_count: evidenceList.length,
    empty_extraction: evidenceList.length === 0,
    compound_value_detected: compoundDetected,
    assessment_violation_count: assessmentViolationCount,
    excerpt_literal_count: literalCount,
    excerpt_literal_rate:
      evidenceList.length > 0 ? literalCount / evidenceList.length : 0,
    excerpt_complete_count: completeCount,
    excerpt_complete_rate:
      evidenceList.length > 0 ? completeCount / evidenceList.length : 0,
    comparison_target_missing_count: comparisonMissingCount,
    evidence_details: evidenceDetails
  };
}

// ============================================================
// LOAD ARTIFACTS
// ============================================================

function loadArtifacts(): ReplayArtifact[] {
  if (!fs.existsSync(OUTPUT_DIR)) {
    throw new Error(`Output directory tidak ditemukan: ${OUTPUT_DIR}`);
  }

  const files = fs.readdirSync(OUTPUT_DIR).filter(
    file => file.startsWith('REG-') && file.endsWith('.json')
  );

  const artifacts: ReplayArtifact[] = [];

  for (const file of files) {
    const filePath = path.join(OUTPUT_DIR, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    const artifact = JSON.parse(raw) as ReplayArtifact;
    artifacts.push(artifact);
  }

  return artifacts;
}

// ============================================================
// GROUP BY CASE
// ============================================================

function groupByCase(
  artifacts: ReplayArtifact[]
): Map<string, ReplayArtifact[]> {
  const map = new Map<string, ReplayArtifact[]>();

  for (const artifact of artifacts) {
    const caseId = artifact.case_id;

    if (!map.has(caseId)) {
      map.set(caseId, []);
    }

    map.get(caseId)!.push(artifact);
  }

  return map;
}

// ============================================================
// AGGREGATE CASE SUMMARY
// ============================================================

function aggregateCaseSummary(replays: ReplayMetrics[]): Record<string, any> {
  const summary: Record<string, any> = {};

  summary.compound_value = {
    detections: replays.filter(r => r.compound_value_detected).length,
    total_replays: replays.length
  };

  summary.assessment_violation = {
    total_violations: replays.reduce(
      (sum, r) => sum + r.assessment_violation_count,
      0
    ),
    total_replays: replays.length
  };

  summary.empty_extraction = {
    count: replays.filter(r => r.empty_extraction).length,
    total_replays: replays.length
  };

  summary.excerpt_literal = {
    min_rate: Math.min(...replays.map(r => r.excerpt_literal_rate)),
    max_rate: Math.max(...replays.map(r => r.excerpt_literal_rate)),
    avg_rate:
      replays.reduce((sum, r) => sum + r.excerpt_literal_rate, 0) /
      replays.length
  };

  summary.excerpt_complete = {
    min_rate: Math.min(...replays.map(r => r.excerpt_complete_rate)),
    max_rate: Math.max(...replays.map(r => r.excerpt_complete_rate)),
    avg_rate:
      replays.reduce((sum, r) => sum + r.excerpt_complete_rate, 0) /
      replays.length
  };

  summary.comparison_target_missing = {
    total_missing: replays.reduce(
      (sum, r) => sum + r.comparison_target_missing_count,
      0
    ),
    total_replays: replays.length
  };

  return summary;
}

// ============================================================
// MAIN ANALYZER
// ============================================================

function main() {
  console.log('\n📊 E.3 — Failure Taxonomy Analyzer (Hardened)\n');

  const artifacts = loadArtifacts();
  console.log(`📁 Total artifact: ${artifacts.length}\n`);

  const grouped = groupByCase(artifacts);

  const report: TaxonomyReport = {
    generated_at: new Date().toISOString(),
    total_cases: grouped.size,
    total_replays: artifacts.length,
    cases: []
  };

  const sortedCaseIds = [...grouped.keys()].sort();

  for (const caseId of sortedCaseIds) {
    const caseArtifacts = grouped.get(caseId)!;

    caseArtifacts.sort((a, b) => {
      return a.fixture.localeCompare(b.fixture);
    });

    const replays: ReplayMetrics[] = caseArtifacts.map((artifact, idx) =>
      analyzeReplay(artifact, idx + 1)
    );

    const caseMetrics: CaseMetrics = {
      case_id: caseId,
      failure_type: caseArtifacts[0]?.failure_type || 'UNKNOWN',
      replays,
      case_summary: aggregateCaseSummary(replays)
    };

    report.cases.push(caseMetrics);

    console.log(`✅ ${caseId}: ${replays.length} replays dianalisis`);
  }

  const reportPath = path.join(OUTPUT_DIR, 'taxonomy-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n============================================');
  console.log(`💾 Taxonomy report disimpan: ${reportPath}`);
  console.log('============================================\n');
}

main();