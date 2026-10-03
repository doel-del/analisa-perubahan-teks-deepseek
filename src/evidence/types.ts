// ============================================================
// EVIDENCE VALIDATOR V1 — TYPES
// ============================================================
// Tidak mendefinisikan ulang SRTSegment.
// Menggunakan single source of truth dari srt.ts.
// ============================================================

import type { SRTSegment } from './srt';

// ------------------------------------------------------------
// EVIDENCE ITEM — hasil extraction dari LLM
// ------------------------------------------------------------

export type CertaintyLevel =
  | 'explicit'
  | 'claimed_by_vendor'
  | 'standard_definition'
  | 'inferred'
  | 'ambiguous';

export interface EvidenceItem {
  evidence_id?: string;
  topic?: string;
  subtopic?: string | null;
  type?: string;
  claim?: string;
  value?: string | number | null;
  unit?: string | null;
  attribute?: string | null;            // BARU
  attribute_value?: string | number | null; // BARU
  context?: string | null;
  comparison_target?: string | null;
  related_evidence_ids?: string[] | null; // BARU
  reviewer_assessment?: string | null;
  certainty?: CertaintyLevel | string;   // diperketat, tapi tetap menerima string untuk backward-compat
  timestamp_start?: string | null;
  timestamp_end?: string | null;
  source_excerpt?: string | null;
  source?: string;
  source_coordinates?: SourceCoordinates | null;
  merged_subtopics?: string[] | null;
  merged_from_evidence_ids?: string[] | null;
  validation?: EvidenceValidationReport;
}

// ------------------------------------------------------------
// SOURCE COORDINATES — provenance dari evidence
// ------------------------------------------------------------

export interface SourceCoordinates {
  chunk_index: number;
  segment_start_index: number;
  segment_end_index: number;
  char_start?: number | null;
  char_end?: number | null;
}

// ------------------------------------------------------------
// TRANSIENT EVIDENCE CONTEXT — hanya hidup selama validation
// ------------------------------------------------------------

export interface EvidenceContext {
  chunkIndex: number;
  chunkText: string;
  chunkSegments: SRTSegment[];
}

// ------------------------------------------------------------
// EXTENDED EVIDENCE — internal selama validation
// ------------------------------------------------------------

export interface ExtractedEvidence extends EvidenceItem {
  _context: EvidenceContext; // mandatory selama validation
}

// ------------------------------------------------------------
// VALIDATION RESULT
// ------------------------------------------------------------

export type ValidationStatus = 'PASS' | 'FAIL' | 'SUSPECT';

export type ValidationSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ValidationResult {
  pass: boolean;
  status: ValidationStatus;
  rule: string;
  reason?: string;
  severity: ValidationSeverity;
}

// ------------------------------------------------------------
// VALIDATION REPORT
// ------------------------------------------------------------

export type FinalStatus = 'VALID' | 'VALID_WITH_NORMALIZATION' | 'SUSPECT' | 'QUARANTINE' | 'REJECT';

export interface EvidenceValidationReport {
  accepted: boolean;
  results: ValidationResult[];
  quarantineReason?: string;
  finalStatus?: FinalStatus; // 🔥 TAMBAHKAN INI
}

// ------------------------------------------------------------
// SEARCH HELPER TYPES
// ------------------------------------------------------------

export interface SegmentMatch {
  segmentStartIndex: number;
  segmentEndIndex: number;
}