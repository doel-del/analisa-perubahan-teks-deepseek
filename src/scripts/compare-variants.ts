// ============================================================
// COMPARE VARIANTS — bandingkan varian chunking dari runs/ (tanpa API)
// ============================================================
// Letakkan di: scripts/compare-variants.ts
//
// Varian = pasangan (chunk_chars/chunk_overlap) yang dicatat di runs.jsonl,
// jadi run lama (baseline) dan run baru otomatis terpisah.
//
// Pakai:
//   npx tsx scripts/compare-variants.ts --reviews c1qTN1rmO2g,07DQ9c6-KxA,WD3wS0TCU7Q,SqmQtAFjIW8,kwoPr9769gc
//   opsi: --baseline 8000/2  --since 2026-10-06  --posbins 5  --minchunk 10  --json out.json
//
// Semua metrik cakupan memakai item yang LOLOS validator, dilokalisasi ke segmen SRT
// (tidak peka terhadap batas kutipan, dan valid lintas parameter chunk karena
// SRT-nya sama).
// ============================================================

import fs from 'fs';
import path from 'path';
import {
  parseSRT,
  buildEvidenceChunks,
  buildChunkText,
  parseEvidenceJSONDetailed,
  normalizeNullishFields
} from '../src/evidence/production-pipeline';
import { normalizeForSearch } from '../src/evidence/srt';
import { EvidenceValidator } from '../src/evidence/validators/evidence-validator';
import type { EvidenceContext, EvidenceItem } from '../src/evidence/types';

const RUN_LOG_DIR = path.resolve(process.env.EVIDENCE_RUN_LOG_DIR ?? './runs');

interface RunRecord {
  run_id: string;
  review_id?: string | null;
  srt_sha: string;
  chunk_chars?: number;
  chunk_overlap?: number;
  chunks?: unknown[];
  parsed_evidence?: number;
  quarantine?: number;
  duplicate_removed?: number;
  duplicate_merged?: number;
  final_evidence?: number;
}

interface RunStat {
  variant: string;
  review: string;
  run_id: string;
  calls: number;
  parsed: number;
  quarantine: number;
  final: number;
  dupRemoved: number;
  accepted: number;
  segTotal: number;
  covered: Set<number>;
  binItems: number[];
  binSegs: number[];
}

const args = process.argv.slice(2);
const valueOf = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const reviewFilter = (valueOf('--reviews') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const baseline = valueOf('--baseline') ?? '8000/2';
const since = valueOf('--since');
const NB = Math.max(2, Number(valueOf('--posbins') ?? 5));
const MIN_LEN = Math.max(1, Number(valueOf('--minchunk') ?? 10));

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const pct = (x: number) => (x * 100).toFixed(0) + '%';
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function readRuns(): RunRecord[] {
  const file = path.join(RUN_LOG_DIR, 'runs.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.run_id && r.srt_sha) out.push(r);
    } catch { /* lewati */ }
  }
  return out;
}

function isValidEvidence(ev: any): boolean {
  return !!ev && typeof ev === 'object' && !Array.isArray(ev) &&
    typeof ev.claim === 'string' && ev.claim.trim().length > 0;
}

// Salinan dari server.ts (lihat CATATAN DRIFT di replay-run.ts).
function reconcile(ev: EvidenceItem): EvidenceItem {
  const has = ev.reviewer_assessment !== null && ev.reviewer_assessment !== undefined &&
    String(ev.reviewer_assessment).trim() !== '';
  if (has && (ev.type || '').toUpperCase() !== 'OPINION') return { ...ev, type: 'OPINION' };
  return ev;
}

function analyzeRun(run: RunRecord): RunStat | null {
  const runDir = path.join(RUN_LOG_DIR, run.run_id);
  const srtPath = path.join(RUN_LOG_DIR, '_srt', `${run.srt_sha}.srt`);
  if (!fs.existsSync(runDir) || !fs.existsSync(srtPath)) return null;
  if (run.chunk_chars === undefined || run.chunk_overlap === undefined) {
    console.warn(`  ! ${run.run_id}: chunk_chars/overlap tidak tercatat, dilewati`);
    return null;
  }

  const all = parseSRT(fs.readFileSync(srtPath, 'utf8'));
  const chunks = buildEvidenceChunks(all, run.chunk_chars, run.chunk_overlap);

  const st: RunStat = {
    variant: `${run.chunk_chars}/${run.chunk_overlap}`,
    review: run.review_id ?? 'noid',
    run_id: run.run_id,
    calls: chunks.length,
    parsed: run.parsed_evidence ?? 0,
    quarantine: run.quarantine ?? 0,
    final: run.final_evidence ?? 0,
    dupRemoved: run.duplicate_removed ?? 0,
    accepted: 0,
    segTotal: all.length,
    covered: new Set<number>(),
    binItems: new Array(NB).fill(0),
    binSegs: new Array(NB).fill(0)
  };

  chunks.forEach((chunk, ci) => {
    const rawPath = path.join(runDir, `chunk-${ci + 1}.raw.txt`);
    if (!fs.existsSync(rawPath)) return;

    const context: EvidenceContext = { chunkIndex: ci, chunkText: buildChunkText(chunk), chunkSegments: chunk };
    const len = chunk.length;
    const usePos = len >= MIN_LEN;

    // hay ternormalisasi + offset awal tiap segmen
    const starts: number[] = [];
    let hay = '';
    for (const s of chunk) {
      starts.push(hay.length);
      const n = normalizeForSearch(s.text);
      if (n) hay += n + ' ';
    }
    const segAt = (pos: number) => {
      let lo = 0, hi = starts.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };

    if (usePos) for (let k = 0; k < len; k++) st.binSegs[Math.min(NB - 1, Math.floor(((k + 0.5) / len) * NB))]++;

    const parsed = parseEvidenceJSONDetailed(fs.readFileSync(rawPath, 'utf8')).evidence as EvidenceItem[];
    for (const ev of parsed.filter(isValidEvidence)) {
      normalizeNullishFields(ev);
      const report = EvidenceValidator.validate(reconcile(ev), context);
      if (!report.accepted) continue;
      st.accepted++;

      const key = normalizeForSearch(String(ev.source_excerpt ?? ''));
      if (!key) continue;
      const p = hay.indexOf(key);
      if (p < 0) continue;
      const k1 = segAt(p);
      const k2 = segAt(p + key.length - 1);
      for (let k = k1; k <= k2; k++) st.covered.add(chunk[k].index);
      if (usePos) st.binItems[Math.min(NB - 1, Math.floor(((k1 + 0.5) / len) * NB))]++;
    }
  });

  return st;
}

function jaccard(a: Set<number>, b: Set<number>): number {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  const union = a.size + b.size - both;
  return union > 0 ? both / union : 0;
}

function main(): void {
  let runs = readRuns().filter(r => fs.existsSync(path.join(RUN_LOG_DIR, r.run_id)));
  if (since) runs = runs.filter(r => r.run_id >= since);
  if (reviewFilter.length > 0) runs = runs.filter(r => reviewFilter.some(f => (r.review_id ?? '').startsWith(f)));
  if (runs.length === 0) {
    console.error('Tidak ada run yang cocok (cek --reviews / --since).');
    process.exit(1);
  }

  const stats = runs.map(analyzeRun).filter((s): s is RunStat => !!s);
  const variants = [...new Set(stats.map(s => s.variant))].sort();
  const reviews = [...new Set(stats.map(s => s.review))].sort();
  const byVR = (v: string, r: string) => stats.filter(s => s.variant === v && s.review === r);

  // ---------- [1] ringkasan per varian ----------
  console.log('='.repeat(100));
  console.log('[1] RINGKASAN PER VARIAN (rata-rata per run; cakupan = segmen SRT yang memuat >= 1 evidence LOLOS validator)');
  console.log(
    pad('varian', 10) + pad('run', 5) + pad('calls', 7) + pad('parsed', 8) + pad('accept', 8) +
    pad('quar%', 7) + pad('final', 7) + pad('dupRm', 7) + pad('cakupan', 9) + pad('union-run', 11) + pad('jacc-seg', 9)
  );
  const summary: Record<string, any> = {};
  for (const v of variants) {
    const vs = stats.filter(s => s.variant === v);
    const covPerRun = vs.map(s => s.covered.size / s.segTotal);
    const unionCov: number[] = [];
    const jacc: number[] = [];
    for (const r of reviews) {
      const g = byVR(v, r);
      if (g.length === 0) continue;
      const u = new Set<number>();
      g.forEach(s => s.covered.forEach(x => u.add(x)));
      unionCov.push(u.size / g[0].segTotal);
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) jacc.push(jaccard(g[i].covered, g[j].covered));
    }
    const qr = mean(vs.map(s => (s.parsed > 0 ? s.quarantine / s.parsed : 0)));
    summary[v] = {
      runs: vs.length, calls: mean(vs.map(s => s.calls)), parsed: mean(vs.map(s => s.parsed)),
      accepted: mean(vs.map(s => s.accepted)), final: mean(vs.map(s => s.final)),
      cov: mean(covPerRun), union: mean(unionCov), jacc: mean(jacc)
    };
    console.log(
      pad(v + (v === baseline ? '*' : ''), 10) + pad(vs.length, 5) + pad(mean(vs.map(s => s.calls)).toFixed(1), 7) +
      pad(mean(vs.map(s => s.parsed)).toFixed(0), 8) + pad(mean(vs.map(s => s.accepted)).toFixed(0), 8) +
      pad(pct(qr), 7) + pad(mean(vs.map(s => s.final)).toFixed(0), 7) + pad(mean(vs.map(s => s.dupRemoved)).toFixed(1), 7) +
      pad(pct(mean(covPerRun)), 9) + pad(pct(mean(unionCov)), 11) + pad(jacc.length ? pct(mean(jacc)) : '-', 9)
    );
  }
  console.log('  * = baseline. union-run = cakupan gabungan semua run dalam varian yang sama. jacc-seg = kesamaan cakupan antar-run dalam varian.');

  // ---------- [2] per video ----------
  console.log('');
  console.log('='.repeat(100));
  console.log('[2] CAKUPAN PER VIDEO (rata-rata run; [min-max] antar-run dalam varian)');
  console.log(pad('review', 13) + variants.map(v => pad(v, 20)).join(''));
  const perVideo: Record<string, Record<string, number>> = {};
  for (const r of reviews) {
    perVideo[r] = {};
    let line = pad(r.slice(0, 11), 13);
    for (const v of variants) {
      const g = byVR(v, r);
      if (g.length === 0) { line += pad('-', 20); continue; }
      const c = g.map(s => s.covered.size / s.segTotal);
      perVideo[r][v] = mean(c);
      line += pad(`${pct(mean(c))} [${pct(Math.min(...c))}-${pct(Math.max(...c))}]`, 20);
    }
    console.log(line);
  }

  // ---------- [3] kepadatan per posisi ----------
  console.log('');
  console.log('='.repeat(100));
  console.log(`[3] KEPADATAN ITEM/SEGMEN PER POSISI DALAM CHUNK (${NB} bin, chunk >= ${MIN_LEN} segmen)`);
  console.log(pad('varian', 10) + Array.from({ length: NB }, (_, i) => pad(`${Math.round((i * 100) / NB)}-${Math.round(((i + 1) * 100) / NB)}%`, 10)).join('') + 'akhir/awal');
  for (const v of variants) {
    const vs = stats.filter(s => s.variant === v);
    const dens = Array.from({ length: NB }, (_, b) => {
      const it = vs.reduce((s, x) => s + x.binItems[b], 0);
      const sg = vs.reduce((s, x) => s + x.binSegs[b], 0);
      return sg > 0 ? it / sg : 0;
    });
    console.log(pad(v, 10) + dens.map(d => pad(d.toFixed(2), 10)).join('') + (dens[0] > 0 ? (dens[NB - 1] / dens[0]).toFixed(2) : '-'));
  }
  console.log('  akhir/awal mendekati 1,00 = ekstraksi merata sepanjang chunk; lebih kecil = melemah di akhir.');

  // ---------- [4] ringkasan keputusan terhadap baseline ----------
  console.log('');
  console.log('='.repeat(100));
  console.log(`[4] SELISIH TERHADAP BASELINE ${baseline}`);
  if (!summary[baseline]) {
    console.log('  (baseline tidak ada di data; cek --baseline)');
  } else {
    // Derau baseline: selisih cakupan antar-run baseline per video (poin persen).
    const noise: number[] = [];
    for (const r of reviews) {
      const g = byVR(baseline, r);
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        noise.push(Math.abs(g[i].covered.size - g[j].covered.size) / g[i].segTotal);
      }
    }
    console.log(`  Derau baseline (rata-rata |selisih cakupan| antar-run per video): ${(mean(noise) * 100).toFixed(1)} poin persen`);
    for (const v of variants) {
      if (v === baseline) continue;
      const d = (k: string) => summary[v][k] - summary[baseline][k];
      const better = reviews.filter(r => perVideo[r][v] !== undefined && perVideo[r][baseline] !== undefined && perVideo[r][v] > perVideo[r][baseline]).length;
      const comparable = reviews.filter(r => perVideo[r][v] !== undefined && perVideo[r][baseline] !== undefined).length;
      console.log(
        `  ${pad(v, 8)} cakupan ${d('cov') >= 0 ? '+' : ''}${(d('cov') * 100).toFixed(1)}pp | ` +
        `video membaik ${better}/${comparable} | union-run ${d('union') >= 0 ? '+' : ''}${(d('union') * 100).toFixed(1)}pp | ` +
        `jacc-seg ${d('jacc') >= 0 ? '+' : ''}${(d('jacc') * 100).toFixed(1)}pp | ` +
        `final ${d('final') >= 0 ? '+' : ''}${d('final').toFixed(0)} | calls x${(summary[v].calls / summary[baseline].calls).toFixed(2)}`
      );
    }
    console.log('  Ingat: metrik ini hanya recall dan stabilitas. Presisi WAJIB dicek lewat audit CSV sebelum varian diadopsi.');
  }

  const jsonOut = valueOf('--json');
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ summary, perVideo }, null, 2), 'utf8');
    console.log(`\nHasil disimpan ke ${jsonOut}`);
  }
}

main();