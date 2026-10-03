// ============================================================
// VALIDATION-INSTRUMENTED HARNESS — MILESTONE 1B
// ============================================================
// POST-REDESIGN OBSERVATIONAL BASELINE
//
// Tujuan:
//   Mengukur perilaku Governance (Grounding + Provenance +
//   EvidenceValidator) + diagnostic anchor resolution pada
//   evidence yang dihasilkan LLM, tanpa mengubah production
//   code, prompt, resolver, atau historical output.
//
// ARSITEKTUR (3 fase terpisah — jangan dicampur):
//
//   R — Deterministic Instrumentation Sanity (no LLM)
//       Membuktikan klasifikasi measurement benar.
//       R1a/R1b/R2/R3/R4/R5/R6 = HARD GATE.
//       Kalau satu saja mismatch → STOP, jangan lanjut ke A/B.
//
//   A — Historical Artifact Replay (no LLM)
//       Hanya artifact yang fixture-nya parseSRT-compatible.
//       Kalau tidak compatible → SKIP + diagnostic.
//       TIDAK ADA fallback parser.
//       Ini SANITY CHECK, bukan pengukuran produksi.
//
//   B — Fresh Production Observation (LLM, T=0.0)
//       Prompt = ANALYSIS_PROMPT_EVIDENCE (production, read-only).
//       Model  = gemini-3.5-flash-lite.
//       Fixture mengontrol SOURCE, bukan output LLM.
//       Tidak ada expected classification.
//
// LINEAGE:
//   checkpoint    = 182f9b9
//   before_after  = NOT CLAIMED
//   production    = NOT INFERRED FROM THIS CORPUS
//   historical output/ → TIDAK DISENTUH.
//
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { EvidenceValidator } from '../validators/evidence-validator';
import { findSourceMatches } from '../search';
import { resolveProvenanceAnchor } from '../validators/anchor-resolver';
import { normalizeForSearch } from '../srt';
import {
  parseSRT,
  buildChunkText,
  //parseEvidenceJSON,
  parseEvidenceJSONDetailed,
  buildEvidenceInstruction,
  PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE,
} from '../production-pipeline';
import type {
  EvidenceContext,
  EvidenceItem,
  SourceCoordinates,
} from '../types';
import type { SRTSegment } from '../srt';

dotenv.config();

// ============================================================
// CONSTANTS
// ============================================================

const CHECKPOINT = '182f9b9';
const LABEL = 'POST-REDESIGN OBSERVATIONAL BASELINE';
const HARNESS_NAME = 'validation-instrumented-harness';

const MODEL = 'gemini-3.5-flash-lite';
const TEMPERATURE = 0.0;
const PROMPT_VERSION = 'v4.3';
const REPLAYS_PER_CASE = 3;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const CORPUS_DIR = path.join(__dirname, 'corpus');
const MANIFEST_PATH = path.join(CORPUS_DIR, 'manifest.json');
const HISTORICAL_OUTPUT_DIR = path.join(__dirname, 'output');
const NEW_OUTPUT_DIR = path.join(__dirname, 'output-post-redesign');
const NEW_PHASE_A_DIR = path.join(NEW_OUTPUT_DIR, 'phase-a');
const NEW_PHASE_B_DIR = path.join(NEW_OUTPUT_DIR, 'phase-b');

// ============================================================
// TYPES
// ============================================================

type Classification =
  | 'grounding_fail'
  | 'single_occurrence'
  | 'resolved_by_anchor'
  | 'unsupported_anchor'
  | 'residual_ambiguous_no_anchor'
  | 'residual_ambiguous_nondiscriminative';

interface MeasurementRecord {
  occurrence_count: number;
  anchor_normalized: string | null;
  anchor_provided: boolean;
  anchor_support_count: number;
  classification: Classification;
}

interface EvidenceRecord {
  evidence_index: number;
  evidence_id: string | null;
  source_excerpt: string;
  subtopic_raw: string | null;
  governance: {
    accepted: boolean;
    finalStatus: string | null;
    quarantineReason: string | null;
    results: Array<{
      rule: string;
      status: string;
      severity: string;
      reason: string | null;
    }>;
    coordinates: SourceCoordinates | null;
  };
  measurement: MeasurementRecord;
}

interface ChunkRecord {
  chunk_index: number;
  chunk_text: string;
  raw_output: string;
  parsed_evidence: any[];
  parsed_count: number;
  eligible_count: number;
  skipped_count: number;
  skipped_evidence: any[];
}

interface CaseReplayArtifact {
  harness: typeof HARNESS_NAME;
  label: typeof LABEL;
  checkpoint: typeof CHECKPOINT;
  phase: 'A' | 'B';
  generated_at: string;
  source: 'existing_artifact' | 'fresh_llm_call';
  case_id: string;
  replay: number;
  fixture: string;
  model: string | null;
  temperature: number | null;
  prompt_version: string | null;
  chunk_count: number;
  chunks: ChunkRecord[];
  evidence: EvidenceRecord[];
  summary: {
    parsed_total: number;
    eligible_total: number;
    validated_total: number;
    skipped_total: number;
    by_classification: Record<string, number>;
    by_final_status: Record<string, number>;
    by_rule_involvement: Record<string, number>;
  };
}

interface RCase {
  id: string;
  description: string;
  excerpt: string;
  subtopic: string | null;
  context: EvidenceContext;
  expected: {
    occurrence_count: number;
    classification: Classification;
    coordinates_start_index?: number;
  };
}

interface RResult {
  id: string;
  description: string;
  expected: RCase['expected'];
  actual: {
    occurrence_count: number;
    classification: Classification;
    anchor_support_count: number;
    coordinates: SourceCoordinates | null;
  };
  checks: {
    occurrence_count: boolean;
    classification: boolean;
    coordinates: boolean;
  };
  pass: boolean;
}

// ============================================================
// UTILS
// ============================================================

/** Eligibility gate — sama dengan server.ts isValidEvidence. */
function isValidEvidence(ev: any): boolean {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
  return typeof ev.claim === 'string' && ev.claim.trim().length > 0;
}

/**
 * Klasifikasi diagnostic — mutually exclusive.
 * Bukan governance decision. Hanya label observasi.
 */
function classify(
  occurrenceCount: number,
  anchorProvided: boolean,
  supportCount: number
): Classification {
  if (occurrenceCount === 0) return 'grounding_fail';
  if (occurrenceCount <= 1) return 'single_occurrence';
  // occurrence > 1
  if (!anchorProvided) return 'residual_ambiguous_no_anchor';
  if (supportCount === 1) return 'resolved_by_anchor';
  if (supportCount === 0) return 'unsupported_anchor';
  return 'residual_ambiguous_nondiscriminative';
}

/**
 * Diagnostic measurement — TIDAK mengubah governance.
 * Menggunakan utility yang sama dengan resolver (normalizeForSearch).
 * Menghitung support count secara lokal karena resolver tidak
 * mengembalikannya. Ini murni observability, bukan second
 * governance path.
 */
function measure(
  excerpt: string,
  subtopic: string | null | undefined,
  context: EvidenceContext
): MeasurementRecord {
  const candidates = findSourceMatches(excerpt, context);
  const anchorNormalized = normalizeForSearch(subtopic ?? '');
  const anchorProvided = anchorNormalized.length > 0;

  let supportCount = 0;
  if (anchorProvided && candidates.length > 0) {
    supportCount = candidates.filter(candidate => {
      const spanText = normalizeForSearch(
        context.chunkSegments
          .filter(
            seg =>
              seg.index >= candidate.segmentStartIndex &&
              seg.index <= candidate.segmentEndIndex
          )
          .map(seg => seg.text)
          .join(' ')
      );
      return spanText.includes(anchorNormalized);
    }).length;
  }

  return {
    occurrence_count: candidates.length,
    anchor_normalized: anchorProvided ? anchorNormalized : null,
    anchor_provided: anchorProvided,
    anchor_support_count: supportCount,
    classification: classify(candidates.length, anchorProvided, supportCount),
  };
}

/** Jalankan EvidenceValidator + measurement untuk satu evidence. */
function processEvidence(
  evidence: EvidenceItem,
  context: EvidenceContext,
  index: number
): EvidenceRecord {
  // Snapshot subtopic sebelum EvidenceValidator memutasi evidence.
  const subtopicRaw = (evidence.subtopic as any) ?? null;
  const excerpt = (evidence.source_excerpt as any) ?? '';

  // AUTHORITATIVE governance.
  const report = EvidenceValidator.validate(evidence, context);

  // DIAGNOSTIC measurement (murni observability).
  const measurement = measure(excerpt, subtopicRaw, context);

  return {
    evidence_index: index,
    evidence_id: (evidence.evidence_id as any) ?? null,
    source_excerpt: excerpt,
    subtopic_raw: subtopicRaw,
    governance: {
      accepted: report.accepted,
      finalStatus: report.finalStatus ?? null,
      quarantineReason: report.quarantineReason ?? null,
      results: report.results.map(r => ({
        rule: r.rule,
        status: r.status,
        severity: r.severity,
        reason: r.reason ?? null,
      })),
      coordinates: evidence.source_coordinates ?? null,
    },
    measurement,
  };
}

function buildSummary(evidence: EvidenceRecord[], chunks: ChunkRecord[]) {
  const byClassification: Record<string, number> = {};
  const byFinalStatus: Record<string, number> = {};
  const byRuleInvolvement: Record<string, number> = {};

  for (const ev of evidence) {
    byClassification[ev.measurement.classification] =
      (byClassification[ev.measurement.classification] || 0) + 1;
    const fs2 = ev.governance.finalStatus ?? 'UNKNOWN';
    byFinalStatus[fs2] = (byFinalStatus[fs2] || 0) + 1;
    // Rule involvement, bukan root cause.
    for (const r of ev.governance.results) {
      if (r.status === 'FAIL' || r.status === 'SUSPECT') {
        byRuleInvolvement[r.rule] = (byRuleInvolvement[r.rule] || 0) + 1;
      }
    }
  }

  return {
    parsed_total: chunks.reduce((s, c) => s + c.parsed_count, 0),
    eligible_total: chunks.reduce((s, c) => s + c.eligible_count, 0),
    validated_total: evidence.length,
    skipped_total: chunks.reduce((s, c) => s + c.skipped_count, 0),
    by_classification: byClassification,
    by_final_status: byFinalStatus,
    by_rule_involvement: byRuleInvolvement,
  };
}

// ============================================================
// R1–R6 — DETERMINISTIC INSTRUMENTATION SANITY
// ============================================================

const TRANSCRIPT_SEGMENTS: SRTSegment[] = [
  { index: 95, start: '00:05:09,129', end: '00:05:15,569', text: 'Lalu untuk di bezel atas layar ini, terdapat earpiece yang ditemani oleh kamera selfie dengan model waterdrop.' },
  { index: 96, start: '00:05:15,569', end: '00:05:20,569', text: 'Ini adalah kamera selfie 13 MP, bukaan f/2.2, fixed focus.' },
  { index: 97, start: '00:05:20,569', end: '00:05:24,129', text: 'Perekaman videonya up to 1080p 30 fps.' },
  { index: 98, start: '00:05:24,129', end: '00:05:27,610', text: 'Beralih ke sisi belakang, ini adalah 50 MP Main Camera.' },
  { index: 99, start: '00:05:27,610', end: '00:05:29,529', text: 'Bukaannya f/1.8, auto focus.' },
  { index: 100, start: '00:05:29,529', end: '00:05:35,089', text: 'Perekaman video bisa sampai 4K 30 fps dan ada pilihan juga untuk 1080p 60 fps.' },
  { index: 101, start: '00:05:35,089', end: '00:05:40,050', text: 'Kemudian untuk kamera berikutnya ada kamera ultrawide 8 MP, bukaan f/2.2.' },
  { index: 102, start: '00:05:40,050', end: '00:05:44,370', text: 'Ini fixed focus juga ya, perekaman videonya up to 1080p 30 fps.' },
  { index: 103, start: '00:05:44,370', end: '00:05:48,550', text: 'Kemudian ada kamera 2 MP macro camera dan ada LED flash.' },
];

const TRANSCRIPT_CONTEXT: EvidenceContext = {
  chunkIndex: 1,
  chunkSegments: TRANSCRIPT_SEGMENTS,
  chunkText: TRANSCRIPT_SEGMENTS.map(s => s.text).join(' '),
};

const SINGLE_SEGMENT_CONTEXT: EvidenceContext = {
  chunkIndex: 0,
  chunkSegments: [{ index: 1, start: '00:00:01,000', end: '00:00:02,000', text: 'Baterai 5000 mAh' }],
  chunkText: 'Baterai 5000 mAh',
};

const R_CASES: RCase[] = [
  {
    id: 'R1a',
    description: 'repeated + discriminative anchor (selfie) → seg 96',
    excerpt: 'bukaan f/2.2',
    subtopic: 'selfie',
    context: TRANSCRIPT_CONTEXT,
    expected: { occurrence_count: 2, classification: 'resolved_by_anchor', coordinates_start_index: 96 },
  },
  {
    id: 'R1b',
    description: 'repeated + discriminative anchor (ultrawide) → seg 101 [cross-check contract]',
    excerpt: 'bukaan f/2.2',
    subtopic: 'ultrawide',
    context: TRANSCRIPT_CONTEXT,
    expected: { occurrence_count: 2, classification: 'resolved_by_anchor', coordinates_start_index: 101 },
  },
  {
    id: 'R2',
    description: 'repeated + null anchor → residual_ambiguous_no_anchor',
    excerpt: 'bukaan f/2.2',
    subtopic: null,
    context: TRANSCRIPT_CONTEXT,
    expected: { occurrence_count: 2, classification: 'residual_ambiguous_no_anchor' },
  },
  {
    id: 'R3',
    description: 'repeated + generic anchor ("kamera") → residual_ambiguous_nondiscriminative',
    excerpt: 'bukaan f/2.2',
    subtopic: 'kamera',
    context: TRANSCRIPT_CONTEXT,
    expected: { occurrence_count: 2, classification: 'residual_ambiguous_nondiscriminative' },
  },
  {
    id: 'R4',
    description: 'repeated + unsupported anchor ("xyz123") → unsupported_anchor',
    excerpt: 'bukaan f/2.2',
    subtopic: 'xyz123',
    context: TRANSCRIPT_CONTEXT,
    expected: { occurrence_count: 2, classification: 'unsupported_anchor' },
  },
  {
    id: 'R5',
    description: 'single occurrence → single_occurrence',
    excerpt: 'Baterai 5000 mAh',
    subtopic: null,
    context: SINGLE_SEGMENT_CONTEXT,
    expected: { occurrence_count: 1, classification: 'single_occurrence' },
  },
  {
    id: 'R6',
    description: 'absent excerpt → grounding_fail',
    excerpt: 'kalimat yang tidak ada di chunk ini',
    subtopic: 'anything',
    context: TRANSCRIPT_CONTEXT,
    expected: { occurrence_count: 0, classification: 'grounding_fail' },
  },
];

function runRSanity(): { all_pass: boolean; results: RResult[] } {
  const results: RResult[] = [];
  let allPass = true;

  for (const rc of R_CASES) {
    const evidence: EvidenceItem = {
      type: 'FACT',
      claim: 'instrumentation sanity check',
      source_excerpt: rc.excerpt,
      subtopic: rc.subtopic,
      reviewer_assessment: null,
    };

    const report = EvidenceValidator.validate(evidence, rc.context);
    const m = measure(rc.excerpt, rc.subtopic, rc.context);

    const occMatch = m.occurrence_count === rc.expected.occurrence_count;
    const clsMatch = m.classification === rc.expected.classification;
    const coordMatch =
      rc.expected.coordinates_start_index === undefined ||
      (evidence.source_coordinates?.segment_start_index ===
        rc.expected.coordinates_start_index);

    const pass = occMatch && clsMatch && coordMatch;
    if (!pass) allPass = false;

    results.push({
      id: rc.id,
      description: rc.description,
      expected: rc.expected,
      actual: {
        occurrence_count: m.occurrence_count,
        classification: m.classification,
        anchor_support_count: m.anchor_support_count,
        coordinates: evidence.source_coordinates ?? null,
      },
      checks: {
        occurrence_count: occMatch,
        classification: clsMatch,
        coordinates: coordMatch,
      },
      pass,
    });

    console.log(
      `   ${pass ? '✓' : '×'} ${rc.id}: ${rc.description}`
    );
    if (!pass) {
      console.log(`       expected: ${JSON.stringify(rc.expected)}`);
      console.log(`       actual  : occurrence=${m.occurrence_count}, classification=${m.classification}, coords=${JSON.stringify(evidence.source_coordinates)}`);
    }
  }

  return { all_pass: allPass, results };
}

// ============================================================
// PHASE A — HISTORICAL ARTIFACT REPLAY (no LLM)
// ============================================================

interface PhaseADiagnostic {
  case_id: string;
  replay?: number;
  status:
    | 'PROCESSED'
    | 'PHASE_A_INCOMPATIBLE_FIXTURE'
    | 'ARTIFACT_MISSING'
    | 'FIXTURE_NOT_FOUND';
  reason?: string;
  fixture_preview?: string;
  artifact_path?: string;
}

function runPhaseA(caseFilter?: string): {
  diagnostics: PhaseADiagnostic[];
  artifacts: CaseReplayArtifact[];
} {
  const diagnostics: PhaseADiagnostic[] = [];
  const artifacts: CaseReplayArtifact[] = [];

  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  for (const caseDef of manifest.cases) {
    if (caseFilter && caseDef.case_id !== caseFilter) continue;

    const fixturePath = path.join(FIXTURE_DIR, caseDef.fixture);
    if (!fs.existsSync(fixturePath)) {
      diagnostics.push({
        case_id: caseDef.case_id,
        status: 'FIXTURE_NOT_FOUND',
        reason: `Fixture tidak ditemukan: ${caseDef.fixture}`,
      });
      continue;
    }

    const fixtureText = fs.readFileSync(fixturePath, 'utf8');
    const segments = parseSRT(fixtureText);

    if (segments.length === 0) {
      diagnostics.push({
        case_id: caseDef.case_id,
        status: 'PHASE_A_INCOMPATIBLE_FIXTURE',
        reason: 'parseSRT() mengembalikan array kosong (fixture bukan SRT standar)',
        fixture_preview: fixtureText.slice(0, 200),
      });
      continue;
    }

    for (let replay = 1; replay <= REPLAYS_PER_CASE; replay++) {
      const artifactPath = path.join(
        HISTORICAL_OUTPUT_DIR,
        `${caseDef.case_id}_replay_${replay}.json`
      );

      if (!fs.existsSync(artifactPath)) {
        diagnostics.push({
          case_id: caseDef.case_id,
          replay,
          status: 'ARTIFACT_MISSING',
          artifact_path: artifactPath,
        });
        continue;
      }

      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      const parsedEvidence: any[] = Array.isArray(artifact.parsedEvidence)
        ? artifact.parsedEvidence
        : [];

      // Phase A: fixture kecil, satu chunk. Gunakan seluruh segments.
      const chunkText = artifact.chunkText ?? buildChunkText(segments);
      const context: EvidenceContext = {
        chunkIndex: 0,
        chunkText,
        chunkSegments: segments,
      };

      const eligible: any[] = [];
      const skipped: any[] = [];
      for (const ev of parsedEvidence) {
        if (isValidEvidence(ev)) eligible.push(ev);
        else skipped.push(ev);
      }

      const evidenceRecords: EvidenceRecord[] = [];
      for (let i = 0; i < eligible.length; i++) {
        const ev: EvidenceItem = { ...eligible[i] };
        evidenceRecords.push(processEvidence(ev, context, i));
      }

      const chunkRecord: ChunkRecord = {
        chunk_index: 0,
        chunk_text: chunkText,
        raw_output: artifact.rawOutput ?? '', // UNSANITIZED
        parsed_evidence: parsedEvidence, // UNSANITIZED
        parsed_count: parsedEvidence.length,
        eligible_count: eligible.length,
        skipped_count: skipped.length,
        skipped_evidence: skipped,
      };

      const result: CaseReplayArtifact = {
        harness: HARNESS_NAME,
        label: LABEL,
        checkpoint: CHECKPOINT,
        phase: 'A',
        generated_at: new Date().toISOString(),
        source: 'existing_artifact',
        case_id: caseDef.case_id,
        replay,
        fixture: caseDef.fixture,
        model: artifact.model ?? null,
        temperature: artifact.temperature ?? null,
        prompt_version: artifact.prompt_version ?? null,
        chunk_count: 1,
        chunks: [chunkRecord],
        evidence: evidenceRecords,
        summary: buildSummary(evidenceRecords, [chunkRecord]),
      };

      artifacts.push(result);
      diagnostics.push({
        case_id: caseDef.case_id,
        replay,
        status: 'PROCESSED',
      });
    }
  }

  return { diagnostics, artifacts };
}

// ============================================================
// PHASE B — FRESH PRODUCTION OBSERVATION (LLM @ T=0.0)
// ============================================================

async function callLLM(
  chunkText: string,
  instruction: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY tidak ditemukan.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: `${instruction}\n\n--- TEKS UNTUK DIKOREKSI ---\n${chunkText}`,
          },
        ],
      },
    ],
    system_instruction: {
      parts: [{ text: PRODUCTION_SYSTEM_INSTRUCTION_EVIDENCE }],
    },
    generationConfig: { temperature: TEMPERATURE },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini mengembalikan response kosong.');
  return text.trim();
}

async function runPhaseB(): Promise<CaseReplayArtifact[]> {
  const EXT_MANIFEST = path.join(CORPUS_DIR, 'manifest-extended.json');
  const EXT_FIXTURE_DIR = path.join(__dirname, 'fixtures-extended');

  if (!fs.existsSync(EXT_MANIFEST)) {
    throw new Error(`Extended manifest tidak ditemukan: ${EXT_MANIFEST}`);
  }
  const manifest = JSON.parse(fs.readFileSync(EXT_MANIFEST, 'utf8'));
  const artifacts: CaseReplayArtifact[] = [];

  for (const caseDef of manifest.cases) {
    const fixturePath = path.join(EXT_FIXTURE_DIR, caseDef.fixture);
    if (!fs.existsSync(fixturePath)) {
      console.error(`   ❌ Fixture tidak ditemukan: ${caseDef.fixture}`);
      continue;
    }
    const fixtureText = fs.readFileSync(fixturePath, 'utf8');
    const segments = parseSRT(fixtureText);
    if (segments.length === 0) {
      console.error(`   ❌ parseSRT() gagal untuk: ${caseDef.fixture}`);
      continue;
    }

    const chunkText = buildChunkText(segments);
    const instruction = buildEvidenceInstruction(
      {},
      'Reviewer',
      1,
      1
    );

    for (let replay = 1; replay <= REPLAYS_PER_CASE; replay++) {
      console.log(`   🔄 ${caseDef.case_id} replay #${replay} ...`);
      let rawOutput = '';
      let parsed: any[] = [];
      try {
        rawOutput = await callLLM(chunkText, instruction);
        const parseResult = parseEvidenceJSONDetailed(rawOutput);
        parsed = parseResult.evidence;
        if (parseResult.status === 'FAILED') {
          console.warn(`   ⚠️ ${caseDef.case_id} replay #${replay}: parse FAILED (${parseResult.error ?? 'tanpa pesan'})`);
        }
      } catch (err: any) {
        console.error(`   ❌ ${caseDef.case_id} replay #${replay} gagal:`, err.message);
        continue;
      }

      const eligible: any[] = [];
      const skipped: any[] = [];
      for (const ev of parsed) {
        if (isValidEvidence(ev)) eligible.push(ev);
        else skipped.push(ev);
      }

      const context: EvidenceContext = {
        chunkIndex: 0,
        chunkText,
        chunkSegments: segments,
      };

      const evidenceRecords: EvidenceRecord[] = [];
      for (let i = 0; i < eligible.length; i++) {
        const ev: EvidenceItem = { ...eligible[i] };
        evidenceRecords.push(processEvidence(ev, context, i));
      }

      const chunkRecord: ChunkRecord = {
        chunk_index: 0,
        chunk_text: chunkText,
        raw_output: rawOutput, // UNSANITIZED
        parsed_evidence: parsed, // UNSANITIZED
        parsed_count: parsed.length,
        eligible_count: eligible.length,
        skipped_count: skipped.length,
        skipped_evidence: skipped,
      };

      const artifact: CaseReplayArtifact = {
        harness: HARNESS_NAME,
        label: LABEL,
        checkpoint: CHECKPOINT,
        phase: 'B',
        generated_at: new Date().toISOString(),
        source: 'fresh_llm_call',
        case_id: caseDef.case_id,
        replay,
        fixture: caseDef.fixture,
        model: MODEL,
        temperature: TEMPERATURE,
        prompt_version: PROMPT_VERSION,
        chunk_count: 1,
        chunks: [chunkRecord],
        evidence: evidenceRecords,
        summary: buildSummary(evidenceRecords, [chunkRecord]),
      };

      artifacts.push(artifact);
    }
  }

  return artifacts;
}

// ============================================================
// OUTPUT WRITERS
// ============================================================

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(filePath: string, obj: any) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeRSanity(result: { all_pass: boolean; results: RResult[] }) {
  ensureDir(NEW_OUTPUT_DIR);
  const out = {
    generated_at: new Date().toISOString(),
    label: LABEL,
    checkpoint: CHECKPOINT,
    all_pass: result.all_pass,
    results: result.results,
  };
  writeJSON(path.join(NEW_OUTPUT_DIR, 'deterministic-sanity.json'), out);
  console.log(`\n💾 Deterministic sanity disimpan: ${path.join(NEW_OUTPUT_DIR, 'deterministic-sanity.json')}`);
}

function writePhaseA(
  diagnostics: PhaseADiagnostic[],
  artifacts: CaseReplayArtifact[]
) {
  ensureDir(NEW_OUTPUT_DIR);
  ensureDir(NEW_PHASE_A_DIR);

  const summary = {
    generated_at: new Date().toISOString(),
    label: LABEL,
    checkpoint: CHECKPOINT,
    total_diagnostics: diagnostics.length,
    by_status: diagnostics.reduce((acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    diagnostics,
  };

  writeJSON(path.join(NEW_OUTPUT_DIR, 'phase-a-diagnostic.json'), summary);
  console.log(`💾 Phase A diagnostic disimpan: ${path.join(NEW_OUTPUT_DIR, 'phase-a-diagnostic.json')}`);

  for (const a of artifacts) {
    const file = path.join(NEW_PHASE_A_DIR, `${a.case_id}_replay_${a.replay}.json`);
    writeJSON(file, a);
  }
  if (artifacts.length > 0) {
    console.log(`💾 Phase A artifacts (${artifacts.length}) disimpan di: ${NEW_PHASE_A_DIR}`);
  }
}

function writePhaseB(artifacts: CaseReplayArtifact[]) {
  ensureDir(NEW_OUTPUT_DIR);
  ensureDir(NEW_PHASE_B_DIR);
  for (const a of artifacts) {
    const file = path.join(NEW_PHASE_B_DIR, `${a.case_id}_replay_${a.replay}.json`);
    writeJSON(file, a);
  }
  console.log(`💾 Phase B artifacts (${artifacts.length}) disimpan di: ${NEW_PHASE_B_DIR}`);
}

// ============================================================
// MAIN
// ============================================================

interface CliArgs {
  phase: 'r' | 'a' | 'b' | 'all';
  caseId?: string;
}

function parseCli(): CliArgs {
  const args = process.argv.slice(2);
  let phase: CliArgs['phase'] = 'r';
  let caseId: string | undefined;

  for (const a of args) {
    if (a.startsWith('--phase=')) {
      const v = a.split('=')[1];
      if (v === 'r' || v === 'a' || v === 'b' || v === 'all') phase = v;
    } else if (a.startsWith('--case=')) {
      caseId = a.split('=')[1];
    }
  }
  return { phase, caseId };
}

async function main() {
  const cli = parseCli();

  console.log(`\n============================================`);
  console.log(`  VALIDATION-INSTRUMENTED HARNESS`);
  console.log(`  Label    : ${LABEL}`);
  console.log(`  Checkpoint: ${CHECKPOINT}`);
  console.log(`  Phase    : ${cli.phase}`);
  if (cli.caseId) console.log(`  Case     : ${cli.caseId}`);
  console.log(`============================================\n`);

  if (cli.phase === 'r' || cli.phase === 'all') {
    console.log(`\n▶ R — Deterministic Instrumentation Sanity`);
    const r = runRSanity();
    writeRSanity(r);
    if (!r.all_pass) {
      console.error(`\n❌ R1–R6 FAILED. STOP. Jangan lanjut ke Phase A/B.`);
      process.exit(1);
    }
    console.log(`\n✅ R1–R6 PASS (${r.results.length} checks)`);
  }

  if (cli.phase === 'a' || cli.phase === 'all') {
    console.log(`\n▶ A — Historical Artifact Replay`);
    const { diagnostics, artifacts } = runPhaseA(cli.caseId);
    writePhaseA(diagnostics, artifacts);
    const processed = diagnostics.filter(d => d.status === 'PROCESSED').length;
    const incompatible = diagnostics.filter(d => d.status === 'PHASE_A_INCOMPATIBLE_FIXTURE').length;
    console.log(`\n📊 Phase A: ${processed} processed, ${incompatible} incompatible, ${diagnostics.length} total`);
  }

  if (cli.phase === 'b') {
    console.log(`\n▶ B — Fresh Production Observation`);
    if (!process.env.GEMINI_API_KEY) {
      console.error(`❌ GEMINI_API_KEY tidak di-set. Phase B butuh API key.`);
      process.exit(1);
    }
    const artifacts = await runPhaseB();
    writePhaseB(artifacts);
  }

  console.log(`\n============================================`);
  console.log(`  DONE`);
  console.log(`============================================\n`);
}

main().catch(err => {
  console.error('❌ Harness error:', err);
  process.exit(1);
});
