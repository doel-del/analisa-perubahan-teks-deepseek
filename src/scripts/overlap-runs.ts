// ============================================================
// OVERLAP RUNS — stabilitas source_excerpt antar-run (tanpa API)
// ============================================================
// Letakkan di: scripts/overlap-runs.ts  (sejajar dengan replay-run.ts)
//
// Membaca runs/runs.jsonl + runs/<run_id>/chunk-N.raw.txt, lalu untuk
// setiap review_id yang punya >= 2 run, membandingkan himpunan
// source_excerpt (setelah normalizeForSearch) antar pasangan run.
//
// Pakai:
//   npx tsx scripts/overlap-runs.ts                       semua review, semua run
//   npx tsx scripts/overlap-runs.ts --since 2026-10-06    hanya run_id berawalan >= string ini
//   npx tsx scripts/overlap-runs.ts --review 07DQ9c6-KxA  satu review (prefix)
//   npx tsx scripts/overlap-runs.ts --accepted            hanya item yang LOLOS validator
//   npx tsx scripts/overlap-runs.ts --full                tampilkan contoh excerpt yang hanya ada di satu run
//   npx tsx scripts/overlap-runs.ts --json out.json       simpan hasil
//
// Metrik per pasangan (A, B):
//   exact     : excerpt identik pasca-normalisasi di kedua run
//   contained : excerpt satu run berisi / terkandung di excerpt run lain
//               (kemungkinan proposisi sama, batas kutipan beda)
//   only      : tidak ada padanan sama sekali (kandidat recall hilang ATAU halusinasi)
//   union     : estimasi jumlah excerpt unik bila kedua run digabung
//
// CATATAN: chunk saling tumpang (overlap segmen), jadi excerpt yang sama bisa
// muncul dari dua chunk dalam SATU run. Perbandingan memakai himpunan excerpt
// unik per run, sehingga duplikasi itu tidak menggelembungkan angka.
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
}

interface ExcerptSet {
  run_id: string;
  items: number;                 // jumlah item (bukan unik)
  keys: Map<string, string>;     // key ternormalisasi -> excerpt asli (contoh)
}

interface PairResult {
  review: string;
  a: string;
  b: string;
  itemsA: number;
  itemsB: number;
  uniqueA: number;
  uniqueB: number;
  exact: number;
  containedA: number;            // excerpt A tanpa exact, tapi contained dengan B
  containedB: number;
  onlyA: number;
  onlyB: number;
  union: number;
  jaccardExact: number;
  coverageAinB: number;          // (exact + containedA) / uniqueA
  coverageBinA: number;
  samplesOnlyA: string[];
  samplesOnlyB: string[];
}

// ------------------------------------------------------------
// I/O
// ------------------------------------------------------------
function readRuns(): RunRecord[] {
  const file = path.join(RUN_LOG_DIR, 'runs.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.run_id && r.srt_sha) out.push(r);
    } catch { /* baris rusak dilewati */ }
  }
  return out;
}

function isValidEvidence(ev: any): boolean {
  return !!ev && typeof ev === 'object' && !Array.isArray(ev) &&
    typeof ev.claim === 'string' && ev.claim.trim().length > 0;
}

// Salinan dari server.ts (sama seperti replay-run.ts; lihat CATATAN DRIFT di sana).
function reconcileTypeWithAssessment(ev: EvidenceItem): EvidenceItem {
  const has =
    ev.reviewer_assessment !== null &&
    ev.reviewer_assessment !== undefined &&
    String(ev.reviewer_assessment).trim() !== '';
  if (has && (ev.type || '').toUpperCase() !== 'OPINION') return { ...ev, type: 'OPINION' };
  return ev;
}

function listRawChunks(runDir: string): number[] {
  return fs.readdirSync(runDir)
    .map(f => /^chunk-(\d+)\.raw\.txt$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map(m => Number(m[1]))
    .sort((x, y) => x - y);
}

// ------------------------------------------------------------
// Bangun himpunan excerpt satu run
// ------------------------------------------------------------
function buildExcerptSet(run: RunRecord, acceptedOnly: boolean): ExcerptSet | null {
  const runDir = path.join(RUN_LOG_DIR, run.run_id);
  if (!fs.existsSync(runDir)) return null;

  const keys = new Map<string, string>();
  let items = 0;

  // Hanya perlu rekonstruksi chunk bila mode --accepted (butuh EvidenceContext).
  let chunks: ReturnType<typeof buildEvidenceChunks> = [];
  if (acceptedOnly) {
    const srtPath = path.join(RUN_LOG_DIR, '_srt', `${run.srt_sha}.srt`);
    if (!fs.existsSync(srtPath)) {
      console.warn(`  ! ${run.run_id}: SRT tidak ada, dilewati (mode --accepted)`);
      return null;
    }
    chunks = buildEvidenceChunks(
      parseSRT(fs.readFileSync(srtPath, 'utf8')),
      run.chunk_chars ?? 18000,
      run.chunk_overlap ?? 3
    );
  }

  for (const n of listRawChunks(runDir)) {
    const raw = fs.readFileSync(path.join(runDir, `chunk-${n}.raw.txt`), 'utf8');
    const parsed = parseEvidenceJSONDetailed(raw).evidence as EvidenceItem[];

    let context: EvidenceContext | null = null;
    if (acceptedOnly) {
      const chunk = chunks[n - 1];
      if (!chunk) continue;
      context = { chunkIndex: n - 1, chunkText: buildChunkText(chunk), chunkSegments: chunk };
    }

    for (const ev of parsed.filter(isValidEvidence)) {
      if (acceptedOnly && context) {
        normalizeNullishFields(ev);
        const report = EvidenceValidator.validate(reconcileTypeWithAssessment(ev), context);
        if (!report.accepted) continue;
      }
      const excerpt = String(ev.source_excerpt ?? '');
      const key = normalizeForSearch(excerpt);
      if (!key) continue;
      items++;
      if (!keys.has(key)) keys.set(key, excerpt);
    }
  }

  return { run_id: run.run_id, items, keys };
}

// ------------------------------------------------------------
// Perbandingan sepasang run
// ------------------------------------------------------------
function related(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

function comparePair(review: string, A: ExcerptSet, B: ExcerptSet): PairResult {
  const keysA = [...A.keys.keys()];
  const keysB = [...B.keys.keys()];
  const setB = new Set(keysB);
  const setA = new Set(keysA);

  const exactKeys = keysA.filter(k => setB.has(k));
  const restA = keysA.filter(k => !setB.has(k));
  const restB = keysB.filter(k => !setA.has(k));

  const containedA = restA.filter(a => restB.some(b => related(a, b)));
  const containedB = restB.filter(b => restA.some(a => related(a, b)));
  const onlyAKeys = restA.filter(a => !containedA.includes(a));
  const onlyBKeys = restB.filter(b => !containedB.includes(b));

  // union: exact dihitung 1x; pasangan contained dihitung ~1 (ambil maksimum kedua sisi).
  const union = exactKeys.length +
    Math.max(containedA.length, containedB.length) +
    onlyAKeys.length + onlyBKeys.length;

  const unionStrict = keysA.length + keysB.length - exactKeys.length;

  return {
    review,
    a: A.run_id,
    b: B.run_id,
    itemsA: A.items,
    itemsB: B.items,
    uniqueA: keysA.length,
    uniqueB: keysB.length,
    exact: exactKeys.length,
    containedA: containedA.length,
    containedB: containedB.length,
    onlyA: onlyAKeys.length,
    onlyB: onlyBKeys.length,
    union,
    jaccardExact: unionStrict > 0 ? exactKeys.length / unionStrict : 0,
    coverageAinB: keysA.length ? (exactKeys.length + containedA.length) / keysA.length : 0,
    coverageBinA: keysB.length ? (exactKeys.length + containedB.length) / keysB.length : 0,
    samplesOnlyA: onlyAKeys.slice(0, 8).map(k => A.keys.get(k)!),
    samplesOnlyB: onlyBKeys.slice(0, 8).map(k => B.keys.get(k)!)
  };
}

// ------------------------------------------------------------
// Pelaporan
// ------------------------------------------------------------
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const pct = (x: number) => (x * 100).toFixed(0) + '%';
const trunc = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function printTable(results: PairResult[], full: boolean, acceptedOnly: boolean): void {
  console.log('='.repeat(100));
  console.log(
    `OVERLAP source_excerpt ANTAR-RUN (${acceptedOnly ? 'hanya item LOLOS validator' : 'semua item hasil parse'})`
  );
  console.log(
    pad('review', 13) + pad('run A→B', 14) + pad('itemA', 7) + pad('itemB', 7) +
    pad('uniqA', 7) + pad('uniqB', 7) + pad('exact', 7) + pad('cont', 6) +
    pad('onlyA', 7) + pad('onlyB', 7) + pad('jaccard', 9) + pad('A∈B', 6) + pad('B∈A', 6)
  );

  for (const r of results) {
    console.log(
      pad(r.review.slice(0, 11), 13) +
      pad(`${r.a.slice(11, 16)}→${r.b.slice(11, 16)}`, 14) +
      pad(r.itemsA, 7) + pad(r.itemsB, 7) +
      pad(r.uniqueA, 7) + pad(r.uniqueB, 7) +
      pad(r.exact, 7) + pad(Math.max(r.containedA, r.containedB), 6) +
      pad(r.onlyA, 7) + pad(r.onlyB, 7) +
      pad(pct(r.jaccardExact), 9) + pad(pct(r.coverageAinB), 6) + pad(pct(r.coverageBinA), 6)
    );
  }

  // Agregat
  const sum = (f: (r: PairResult) => number) => results.reduce((s, r) => s + f(r), 0);
  const totUniqA = sum(r => r.uniqueA);
  const totUniqB = sum(r => r.uniqueB);
  const totExact = sum(r => r.exact);
  const totCont = sum(r => Math.max(r.containedA, r.containedB));
  const totOnlyA = sum(r => r.onlyA);
  const totOnlyB = sum(r => r.onlyB);
  const totUnion = sum(r => r.union);
  const avgSingle = (totUniqA + totUniqB) / 2;

  console.log('-'.repeat(100));
  console.log(`Pasangan dibandingkan : ${results.length}`);
  console.log(`Excerpt unik rata-rata per run : ${avgSingle.toFixed(0)}  | union dua run : ${totUnion}`);
  console.log(
    `  → menggabungkan run menambah ~${totUnion > 0 && avgSingle > 0 ? pct(totUnion / avgSingle - 1) : '0%'} ` +
    `informasi dibanding satu run (indikasi besarnya recall yang hilang per run)`
  );
  console.log(
    `Stabilitas : exact=${totExact}  contained=${totCont}  only-A=${totOnlyA}  only-B=${totOnlyB}`
  );
  console.log(
    `  → ${pct((totExact + totCont) / Math.max(1, Math.max(totUniqA, totUniqB)))} excerpt punya padanan di run lain; ` +
    `${pct(1 - (totExact + totCont) / Math.max(1, Math.max(totUniqA, totUniqB)))} muncul hanya di satu run`
  );

  // Review paling tidak stabil
  const worst = [...results].sort((x, y) => x.jaccardExact - y.jaccardExact).slice(0, 5);
  console.log('');
  console.log('5 pasangan paling tidak stabil (jaccard exact terendah):');
  for (const r of worst) {
    console.log(`  ${pad(r.review.slice(0, 11), 13)} ${pad(`${r.a.slice(11, 16)}→${r.b.slice(11, 16)}`, 14)} jaccard=${pct(r.jaccardExact)}  onlyA=${r.onlyA} onlyB=${r.onlyB}`);
  }

  if (full) {
    for (const r of results) {
      if (r.samplesOnlyA.length === 0 && r.samplesOnlyB.length === 0) continue;
      console.log('');
      console.log(`[${r.review.slice(0, 11)} ${r.a.slice(11, 16)}→${r.b.slice(11, 16)}]`);
      for (const s of r.samplesOnlyA) console.log(`  hanya A: ${trunc(s, 110)}`);
      for (const s of r.samplesOnlyB) console.log(`  hanya B: ${trunc(s, 110)}`);
    }
  }
}

// ------------------------------------------------------------
// CLI
// ------------------------------------------------------------
function main(): void {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(n);
  const valueOf = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const since = valueOf('--since');
  const reviewFilter = valueOf('--review');
  const acceptedOnly = flag('--accepted');

  let runs = readRuns().filter(r => fs.existsSync(path.join(RUN_LOG_DIR, r.run_id)));
  if (since) runs = runs.filter(r => r.run_id >= since);
  if (reviewFilter) runs = runs.filter(r => (r.review_id ?? '').startsWith(reviewFilter));

  if (runs.length === 0) {
    console.error(`Tidak ada run dengan folder raw di ${RUN_LOG_DIR} (cek --since / --review).`);
    process.exit(1);
  }

  // Kelompokkan per review_id, urut waktu.
  const byReview = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const k = r.review_id ?? 'noid';
    if (!byReview.has(k)) byReview.set(k, []);
    byReview.get(k)!.push(r);
  }

  const results: PairResult[] = [];
  const skipped: string[] = [];

  for (const [review, group] of byReview) {
    group.sort((x, y) => x.run_id.localeCompare(y.run_id));
    if (group.length < 2) { skipped.push(review); continue; }

    const sets = group
      .map(r => buildExcerptSet(r, acceptedOnly))
      .filter((s): s is ExcerptSet => !!s);

    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        results.push(comparePair(review, sets[i], sets[j]));
      }
    }
  }

  if (results.length === 0) {
    console.error('Tidak ada review dengan >= 2 run yang bisa dibandingkan.');
    process.exit(1);
  }

  printTable(results, flag('--full'), acceptedOnly);
  if (skipped.length > 0) {
    console.log(`\nDilewati (hanya 1 run): ${skipped.join(', ')}`);
  }

  const jsonOut = valueOf('--json');
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\nHasil disimpan ke ${jsonOut}`);
  }
}

main();