// ============================================================
// EVIDENCE VALIDATOR — Orchestrator dengan Acceptance Policy
// ============================================================

import type {
  EvidenceContext,
  EvidenceItem,
  EvidenceValidationReport,
  ValidationResult,
  FinalStatus
} from '../types';
import { GroundingValidator } from './grounding';
import { ProvenanceValidator } from './provenance';
import { AssessmentValidator } from './assessment';
import { ValueValidator } from './value';
import { AtomicityValidator } from './atomicity';

export const EvidenceValidator = {
  validate(
    evidence: EvidenceItem,
    context: EvidenceContext
  ): EvidenceValidationReport {
    const results: ValidationResult[] = [];

    // 1. Grounding — existence only
    const groundingResult = GroundingValidator.validate(
      evidence.source_excerpt,
      context
    );
    results.push(groundingResult);

    // 2. Provenance — resolve menggunakan evidence.subtopic sebagai anchor
    const provenanceResult = ProvenanceValidator.resolve(
      evidence.source_excerpt,
      evidence.subtopic,
      context
    );
    results.push(provenanceResult.result);

    // Set source_coordinates ONLY jika resolved secara unik
    if (provenanceResult.coordinates) {
      evidence.source_coordinates = provenanceResult.coordinates;
    } else {
      evidence.source_coordinates = null;
    }

    // 3. Assessment
    results.push(
      AssessmentValidator.validate(
        evidence.type,
        evidence.reviewer_assessment,
        evidence.claim,
        evidence.source_excerpt
      )
    );

    // 4. Value
    results.push(
      ValueValidator.validate(
        evidence.value,
        evidence.unit,
        evidence.attribute,
        evidence.attribute_value
      )
    );

    // 5. Atomicity
    results.push(
      AtomicityValidator.validate(evidence.claim)
    );

    // ============================================================
    // ACCEPTANCE POLICY — Epistemic Gatekeeper
    // ============================================================

    // 1. FAIL → selalu quarantine
    const hasFail = results.some(r => r.status === 'FAIL');
    if (hasFail) {
      const failedReasons = results
        .filter(r => r.status === 'FAIL')
        .map(r => `${r.rule}: ${r.reason || r.rule}`)
        .join('; ');
      return quarantine(evidence, results, `FAIL: ${failedReasons}`);
    }

    // 2. SUSPECT severity HIGH → quarantine
    const hasSuspectHigh = results.some(
      r => r.status === 'SUSPECT' && r.severity === 'HIGH'
    );
    if (hasSuspectHigh) {
      const highReasons = results
        .filter(r => r.status === 'SUSPECT' && r.severity === 'HIGH')
        .map(r => `${r.rule}: ${r.reason || r.rule}`)
        .join('; ');
      return quarantine(evidence, results, `SUSPECT HIGH: ${highReasons}`);
    }

    // 3. PROVENANCE SUSPECT → quarantine (P0 invariant)
    //    GROUNDING pasca-redesign existence-only, tidak pernah SUSPECT.
    // const hasProvenanceSuspect = results.some(
      // r => r.rule === 'PROVENANCE' && r.status === 'SUSPECT'
    // );
    // if (hasProvenanceSuspect) {
      // return quarantine(
        // evidence,
        // results,
        // 'SUSPECT PROVENANCE: source_excerpt ambiguous (residual, tidak ter-resolve anchor)'
      // );
    // }

    // DIHAPUS: langkah lama "PROVENANCE SUSPECT → selalu quarantine" ini
    // redundan untuk severity HIGH (sudah tercakup langkah 2 di atas,
    // karena hasSuspectHigh mengecek SEMUA rule) dan secara tidak sengaja
    // MEMBATALKAN N8 di provenance.ts, yang sengaja menurunkan excerpt
    // pendek (<20 char) yang ambigu ke severity MEDIUM supaya tidak
    // dikarantina. Provenance SUSPECT dengan severity MEDIUM sekarang
    // mengikuti jalur yang sama seperti SUSPECT MEDIUM rule lain:
    // accepted=true, source_coordinates tetap null (lihat
    // evidence-validator.validate di atas), finalStatus tetap VALID
    // karena tidak ada pengecekan finalStatus khusus untuk PROVENANCE
    // MEDIUM — evidence tetap lolos dengan koordinat kosong sebagai
    // sinyal bahwa lokasi persisnya tidak bisa dipastikan.

    // 4. ATOMICITY SUSPECT → accepted=true, ditandai untuk atomicization
    const hasAtomicitySuspect = results.some(
      r => r.rule === 'ATOMICITY' && r.status === 'SUSPECT'
    );

    // 5. VALUE SUSPECT → accepted=true, perlu review (P1)
    const hasValueSuspect = results.some(
      r => r.rule === 'VALUE' && r.status === 'SUSPECT'
    );

    // BARU: PROVENANCE SUSPECT MEDIUM (N8 -- excerpt pendek ambigu)
    // juga accepted=true tapi source_coordinates null. Perlakukan sama
    // seperti VALUE/ATOMICITY suspect: tandai VALID_WITH_NORMALIZATION
    // supaya konsumen downstream tahu lokasi persisnya tidak pasti,
    // bukan diam-diam terlihat sama seperti evidence yang PASS bersih.
    const hasProvenanceSuspectMedium = results.some(
      r => r.rule === 'PROVENANCE' && r.status === 'SUSPECT' && r.severity === 'MEDIUM'
    );

    // 6. Semua PASS → accepted=true
    const accepted = true;
    const quarantineReason = undefined;

    //const finalStatus: FinalStatus = hasAtomicitySuspect || hasValueSuspect
    const finalStatus: FinalStatus =
      hasAtomicitySuspect || hasValueSuspect || hasProvenanceSuspectMedium
      ? 'VALID_WITH_NORMALIZATION'
      : 'VALID';

    evidence.validation = {
      accepted,
      results,
      quarantineReason,
      finalStatus
    };

    return {
      accepted,
      results,
      quarantineReason,
      finalStatus
    };
  }
};

function quarantine(
  evidence: EvidenceItem,
  results: ValidationResult[],
  reason: string
): EvidenceValidationReport {
  const finalStatus: FinalStatus = 'QUARANTINE';
  evidence.validation = {
    accepted: false,
    results,
    quarantineReason: reason,
    finalStatus
  };
  return {
    accepted: false,
    results,
    quarantineReason: reason,
    finalStatus
  };
}