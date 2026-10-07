// ============================================================
// OVERLAP RUNS v2 — stabilitas antar-run (tanpa API)
// ============================================================
// Letakkan di: scripts/overlap-runs.ts  (sejajar dengan replay-run.ts)
//
// Membaca runs/runs.jsonl + runs/<run_id>/chunk-N.raw.txt + runs/_srt/<sha>.srt,
// lalu untuk setiap review_id yang punya >= 2 run, membandingkan sepasang run
// pada tiga level:
//
//   1. EXCERPT : himpunan source_excerpt (exact / contained / only).   [sama seperti v1]
//   2. CHUNK   : parsed, raw_chars, salvage/truncated per chunk (dari runs.jsonl).
//                Menjawab: selisih jumlah item terkonsentrasi di satu chunk atau tersebar?
//   3. SEGMEN  : segmen SRT mana yang punya >= 1 evidence. Tidak peka terhadap
//                batas kutipan, jadi menunjukkan DI MANA recall berbeda.
//
// Pakai:
//   npx tsx scripts/overlap-runs.ts --since 2026-10-06            semua review, run >= string ini
//   npx tsx scripts/overlap-runs.ts --since 2026-10-06 --accepted hanya item LOLOS validator
//   npx tsx scripts/overlap-runs.ts --review 07DQ9c6-KxA          satu review (prefix)
//   npx tsx scripts/overlap-runs.ts --full                        contoh excerpt yang hanya ada di satu run
//   npx tsx scripts/overlap-runs.ts --bin 10 --gap 5              ukuran bin zona asimetris & ambang selisih
//   npx tsx scripts/overlap-runs.ts --posbins 5 --edge 10 --minchunk 20
//        [4] posisi relatif dalam chunk: jumlah bin, lebar "ujung" (segmen), panjang chunk minimum
//   npx tsx scripts/overlap-runs.ts --json out.json               simpan hasil
//   npx tsx scripts/overlap-runs.ts --accepted --csv audit.csv --sample 30 --control 15
//        ekspor lembar audit manual: 30 item "hanya satu run" + 15 item kontrol
//        (muncul di kedua run), diacak, kolom label dikosongkan.
//        --seed N (default 42) untuk acak yang bisa diulang, --sep ';' atau --sep tab
//        untuk Excel berlokal Indonesia (pemisah daftar ';').
//
// ASUMSI yang tidak bisa saya verifikasi dari sini (cek bila angka segmen aneh):
//   - segmen hasil parseSRT punya properti teks bernama text (fallback content/body).
//     Kalau namanya lain, ubah segText() di bawah. Skrip akan memperingatkan bila semua teks kosong.
//   - nomor segmen pada runs.jsonl ("segments":[1,79]) = posisi 1-based di hasil parseSRT.
//
// CATATAN: chunk saling tumpang, jadi excerpt yang sama bisa muncul dari dua chunk dalam
// SATU run. Perbandingan excerpt memakai himpunan unik per run. Hitungan item per bin
// (zona asimetris) memakai item apa adanya, jadi area tumpang-tindih terhitung dari dua chunk.
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

// ------------------------------------------------------------
// Tipe
// ------------------------------------------------------------
interface ChunkLog {
  chunk: number;
  segments?: [number, number];
  raw_chars?: number;
  parse_status?: string;
  parse_strategy?: string;
  parsed?: number;
  accepted?: number;
  quarantine?: number;
  salvage?: { recovered?: number; repaired?: number; skipped?: number; truncated?: boolean };
}

interface RunRecord {
  run_id: string;
  review_id?: string | null;
  srt_sha: string;
  chunk_chars?: number;
  chunk_overlap?: number;
  chunks?: ChunkLog[];
}

interface ItemRec {
  runId: string;
  chunk: number;
  excerpt: string;
  key: string;
  claim: string;
  type: string;
  subtopic: string;
  accepted: boolean | null;     // null = tidak bisa divalidasi (SRT tidak ada)
  segFirst: number | null;      // nomor segmen global (1-based)
  segLast: number | null;
  ambiguous: boolean;           // excerpt muncul >1x di chunk; segmen = kemunculan pertama
  chunkStart: number | null;    // nomor segmen global awal chunk
  chunkLen: number | null;      // jumlah segmen di chunk
  relPos: number | null;        // posisi relatif segFirst di chunk, 0..1 (0 = awal)
}

interface RunData {
  run_id: string;
  srt_sha: string;
  rec: RunRecord;
  items: ItemRec[];                       // item setelah filter (--accepted bila aktif)
  byKey: Map<string, ItemRec[]>;
  segTexts: Map<number, string>;          // nomor segmen global -> teks asli
  segTotal: number | null;
  covered: Set<number> | null;            // segmen yang punya >= 1 evidence
  unlocated: number;                      // excerpt yang tidak ketemu di teks segmen chunk-nya
  chunkSpans: { chunk: number; start: number; len: number }[];   // untuk analisis posisi
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
  containedA: number;
  containedB: number;
  onlyA: number;
  onlyB: number;
  union: number;
  jaccardExact: number;
  coverageAinB: number;
  coverageBinA: number;
  samplesOnlyA: string[];
  samplesOnlyB: string[];
}

interface ChunkRow {
  chunk: number;
  range: string;
  pA: number;
  pB: number;
  rawA: number;
  rawB: number;
  flags: string[];
}

interface BinDiff { from: number; to: number; a: number; b: number; diff: number }

interface SegResult {
  segTotal: number;
  covA: number;
  covB: number;
  both: number;
  onlyA: number;
  onlyB: number;
  jaccard: number;
  unlocA: number;
  unlocB: number;
  bins: BinDiff[];
}

interface PairDetail {
  res: PairResult;
  A: RunData;
  B: RunData;
  onlyAKeys: string[];
  onlyBKeys: string[];
  exactKeys: string[];
  seg: SegResult | null;
  chunks: ChunkRow[] | null;
}

// ------------------------------------------------------------
// Util
// ------------------------------------------------------------
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const pct = (x: number) => (x * 100).toFixed(0) + '%';
const trunc = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const shortId = (id: string) => id.slice(11, 16);          // "00-30"
const pairLabel = (a: string, b: string) => `${shortId(a)}→${shortId(b)}`;

// Ubah di sini bila properti teks segmen bukan text.
const segText = (s: any): string => String(s?.text ?? s?.content ?? s?.body ?? '');

function rng(seed: number): () => number {            // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
// Lokalisasi excerpt ke segmen
// ------------------------------------------------------------
function buildHay(norms: string[]): { hay: string; starts: number[] } {
  const starts: number[] = [];
  let hay = '';
  for (const n of norms) {
    starts.push(hay.length);
    if (n) hay += n + ' ';
  }
  return { hay, starts };
}

// indeks segmen terakhir yang awalnya <= pos
function segAt(starts: number[], pos: number): number {
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// ------------------------------------------------------------
// Muat satu run
// ------------------------------------------------------------
function loadRun(run: RunRecord, acceptedOnly: boolean, warned: Set<string>): RunData | null {
  const runDir = path.join(RUN_LOG_DIR, run.run_id);
  if (!fs.existsSync(runDir)) return null;

  const srtPath = path.join(RUN_LOG_DIR, '_srt', `${run.srt_sha}.srt`);
  const hasSrt = fs.existsSync(srtPath);
  if (!hasSrt && acceptedOnly) {
    console.warn(`  ! ${run.run_id}: SRT tidak ada, dilewati (mode --accepted)`);
    return null;
  }
  if (!hasSrt && !warned.has(run.srt_sha)) {
    warned.add(run.srt_sha);
    console.warn(`  ! SRT ${run.srt_sha} tidak ada: metrik segmen/lokasi untuk review ini dilewati`);
  }

  let all: any[] = [];
  let chunks: any[][] = [];
  if (hasSrt) {
    all = parseSRT(fs.readFileSync(srtPath, 'utf8')) as any[];
    chunks = buildEvidenceChunks(all as any, run.chunk_chars ?? 18000, run.chunk_overlap ?? 3) as any[][];
  }

  const items: ItemRec[] = [];
  const segTexts = new Map<number, string>();
  const covered = new Set<number>();
  let unlocated = 0;
  const chunkSpans: { chunk: number; start: number; len: number }[] = [];
  let totalSegs = 0;
  let emptySegs = 0;

  for (const n of listRawChunks(runDir)) {
    const raw = fs.readFileSync(path.join(runDir, `chunk-${n}.raw.txt`), 'utf8');
    const parsed = parseEvidenceJSONDetailed(raw).evidence as EvidenceItem[];

    const chunk = hasSrt ? chunks[n - 1] : undefined;
    if (acceptedOnly && !chunk) continue;

    let context: EvidenceContext | null = null;
    let hay = '';
    let starts: number[] = [];
    let start = 0;

    if (chunk) {
      context = { chunkIndex: n - 1, chunkText: buildChunkText(chunk as any), chunkSegments: chunk as any };
      const logChunk = run.chunks?.find(c => c.chunk === n);
      start = logChunk?.segments?.[0] ?? (all.indexOf(chunk[0]) + 1);
      if (start >= 1) chunkSpans.push({ chunk: n, start, len: chunk.length });
      const norms = chunk.map(s => normalizeForSearch(segText(s)));
      ({ hay, starts } = buildHay(norms));
      chunk.forEach((s, k) => {
        const t = segText(s);
        totalSegs++;
        if (!t.trim()) emptySegs++;
        if (start >= 1) segTexts.set(start + k, t);
      });
    }

    for (const ev of parsed.filter(isValidEvidence)) {
      let accepted: boolean | null = null;
      if (context) {
        normalizeNullishFields(ev);
        const report = EvidenceValidator.validate(reconcileTypeWithAssessment(ev), context);
        accepted = !!report.accepted;
      }
      if (acceptedOnly && accepted !== true) continue;

      const excerpt = String((ev as any).source_excerpt ?? '');
      const key = normalizeForSearch(excerpt);
      if (!key) continue;

      let segFirst: number | null = null;
      let segLast: number | null = null;
      let ambiguous = false;
      if (chunk && start >= 1 && hay) {
        const p = hay.indexOf(key);
        if (p >= 0) {
          ambiguous = hay.indexOf(key, p + 1) >= 0;
          segFirst = start + segAt(starts, p);
          segLast = start + segAt(starts, p + key.length - 1);
          for (let s = segFirst; s <= segLast; s++) covered.add(s);
        } else {
          unlocated++;
        }
      }

      items.push({
        runId: run.run_id,
        chunk: n,
        excerpt,
        key,
        claim: String((ev as any).claim ?? ''),
        type: String((ev as any).type ?? ''),
        subtopic: String((ev as any).subtopic ?? ''),
        accepted,
        segFirst,
        segLast,
        ambiguous,
        chunkStart: start >= 1 ? start : null,
        chunkLen: chunk ? chunk.length : null,
        relPos: segFirst != null && chunk && start >= 1 ? (segFirst - start + 0.5) / chunk.length : null
      });
    }
  }

  const byKey = new Map<string, ItemRec[]>();
  for (const it of items) {
    if (!byKey.has(it.key)) byKey.set(it.key, []);
    byKey.get(it.key)!.push(it);
  }

  let usableCovered: Set<number> | null = hasSrt ? covered : null;
  if (hasSrt && totalSegs > 0 && emptySegs === totalSegs) {
    if (!warned.has('segtext')) {
      warned.add('segtext');
      console.warn('  ! teks segmen kosong semua: properti teks bukan text/content/body. Ubah segText(); metrik segmen dimatikan.');
    }
    usableCovered = null;
  }

  return {
    run_id: run.run_id,
    srt_sha: run.srt_sha,
    rec: run,
    items,
    byKey,
    segTexts,
    segTotal: hasSrt ? all.length : null,
    covered: usableCovered,
    unlocated,
    chunkSpans
  };
}

// ------------------------------------------------------------
// Level 1: excerpt
// ------------------------------------------------------------
function related(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

function comparePair(review: string, A: RunData, B: RunData) {
  const keysA = [...A.byKey.keys()];
  const keysB = [...B.byKey.keys()];
  const setB = new Set(keysB);
  const setA = new Set(keysA);

  const exactKeys = keysA.filter(k => setB.has(k));
  const restA = keysA.filter(k => !setB.has(k));
  const restB = keysB.filter(k => !setA.has(k));

  const containedA = restA.filter(a => restB.some(b => related(a, b)));
  const containedB = restB.filter(b => restA.some(a => related(a, b)));
  const cA = new Set(containedA);
  const cB = new Set(containedB);
  const onlyAKeys = restA.filter(a => !cA.has(a));
  const onlyBKeys = restB.filter(b => !cB.has(b));

  const union = exactKeys.length +
    Math.max(containedA.length, containedB.length) +
    onlyAKeys.length + onlyBKeys.length;
  const unionStrict = keysA.length + keysB.length - exactKeys.length;

  const first = (rd: RunData, k: string) => rd.byKey.get(k)![0].excerpt;

  const res: PairResult = {
    review,
    a: A.run_id,
    b: B.run_id,
    itemsA: A.items.length,
    itemsB: B.items.length,
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
    samplesOnlyA: onlyAKeys.slice(0, 8).map(k => first(A, k)),
    samplesOnlyB: onlyBKeys.slice(0, 8).map(k => first(B, k))
  };
  return { res, onlyAKeys, onlyBKeys, exactKeys };
}

// ------------------------------------------------------------
// Level 2: chunk
// ------------------------------------------------------------
function compareChunks(A: RunData, B: RunData, acceptedOnly: boolean): ChunkRow[] | null {
  const ca = A.rec.chunks;
  const cb = B.rec.chunks;
  if (!ca || !cb) return null;
  if (A.rec.srt_sha !== B.rec.srt_sha ||
      (A.rec.chunk_chars ?? 0) !== (B.rec.chunk_chars ?? 0) ||
      (A.rec.chunk_overlap ?? 0) !== (B.rec.chunk_overlap ?? 0)) return null;

  const cnt = (c?: ChunkLog) => (c ? ((acceptedOnly ? c.accepted : c.parsed) ?? 0) : 0);
  const nums = [...new Set([...ca.map(c => c.chunk), ...cb.map(c => c.chunk)])].sort((x, y) => x - y);
  const rows: ChunkRow[] = [];

  for (const n of nums) {
    const a = ca.find(c => c.chunk === n);
    const b = cb.find(c => c.chunk === n);
    const pA = cnt(a);
    const pB = cnt(b);
    const d = Math.abs(pB - pA);
    const mx = Math.max(pA, pB);
    const flags: string[] = [];
    if (d >= 8 && d / Math.max(1, mx) >= 0.25) flags.push('SELISIH');
    if (Math.min(pA, pB) === 0 && mx > 0) flags.push('KOSONG');
    if (a?.salvage?.truncated || b?.salvage?.truncated) flags.push('TRUNC');
    if ((a?.parse_strategy ?? '').includes('salvage') || (b?.parse_strategy ?? '').includes('salvage')) flags.push('SALV');
    const seg = (a ?? b)?.segments;
    rows.push({
      chunk: n,
      range: seg ? `${seg[0]}-${seg[1]}` : '?',
      pA,
      pB,
      rawA: a?.raw_chars ?? 0,
      rawB: b?.raw_chars ?? 0,
      flags
    });
  }
  return rows;
}

// ------------------------------------------------------------
// Level 3: segmen SRT
// ------------------------------------------------------------
function compareSegments(A: RunData, B: RunData, binSize: number): SegResult | null {
  if (!A.covered || !B.covered || !A.segTotal || A.srt_sha !== B.srt_sha) return null;

  let both = 0, onlyA = 0, onlyB = 0;
  for (const s of A.covered) (B.covered.has(s) ? both++ : onlyA++);
  for (const s of B.covered) if (!A.covered.has(s)) onlyB++;
  const union = both + onlyA + onlyB;

  const nBins = Math.max(1, Math.ceil(A.segTotal / binSize));
  const ca = new Array<number>(nBins).fill(0);
  const cb = new Array<number>(nBins).fill(0);
  const bump = (arr: number[], it: ItemRec) => {
    if (it.segFirst == null) return;
    const b = Math.min(nBins - 1, Math.max(0, Math.floor((it.segFirst - 1) / binSize)));
    arr[b]++;
  };
  A.items.forEach(it => bump(ca, it));
  B.items.forEach(it => bump(cb, it));

  const bins: BinDiff[] = ca.map((a, i) => ({
    from: i * binSize + 1,
    to: Math.min(A.segTotal!, (i + 1) * binSize),
    a,
    b: cb[i],
    diff: cb[i] - a
  }));

  return {
    segTotal: A.segTotal,
    covA: A.covered.size,
    covB: B.covered.size,
    both,
    onlyA,
    onlyB,
    jaccard: union > 0 ? both / union : 0,
    unlocA: A.unlocated,
    unlocB: B.unlocated,
    bins
  };
}

// ------------------------------------------------------------
// Pelaporan
// ------------------------------------------------------------
function printExcerptTable(results: PairResult[], full: boolean, acceptedOnly: boolean): void {
  console.log('='.repeat(100));
  console.log(
    `[1] OVERLAP source_excerpt ANTAR-RUN (${acceptedOnly ? 'hanya item LOLOS validator' : 'semua item hasil parse'})`
  );
  console.log(
    pad('review', 13) + pad('run A→B', 14) + pad('itemA', 7) + pad('itemB', 7) +
    pad('uniqA', 7) + pad('uniqB', 7) + pad('exact', 7) + pad('cont', 6) +
    pad('onlyA', 7) + pad('onlyB', 7) + pad('jaccard', 9) + pad('A∈B', 6) + pad('B∈A', 6)
  );

  for (const r of results) {
    console.log(
      pad(r.review.slice(0, 11), 13) +
      pad(pairLabel(r.a, r.b), 14) +
      pad(r.itemsA, 7) + pad(r.itemsB, 7) +
      pad(r.uniqueA, 7) + pad(r.uniqueB, 7) +
      pad(r.exact, 7) + pad(Math.max(r.containedA, r.containedB), 6) +
      pad(r.onlyA, 7) + pad(r.onlyB, 7) +
      pad(pct(r.jaccardExact), 9) + pad(pct(r.coverageAinB), 6) + pad(pct(r.coverageBinA), 6)
    );
  }

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
  console.log(`Stabilitas : exact=${totExact}  contained=${totCont}  only-A=${totOnlyA}  only-B=${totOnlyB}`);
  const matched = (totExact + totCont) / Math.max(1, Math.max(totUniqA, totUniqB));
  console.log(
    `  → ${pct(matched)} excerpt punya padanan di run lain; ${pct(1 - matched)} muncul hanya di satu run`
  );

  const worst = [...results].sort((x, y) => x.jaccardExact - y.jaccardExact).slice(0, 5);
  console.log('');
  console.log('5 pasangan paling tidak stabil (jaccard exact terendah):');
  for (const r of worst) {
    console.log(`  ${pad(r.review.slice(0, 11), 13)} ${pad(pairLabel(r.a, r.b), 14)} jaccard=${pct(r.jaccardExact)}  onlyA=${r.onlyA} onlyB=${r.onlyB}`);
  }

  if (full) {
    for (const r of results) {
      if (r.samplesOnlyA.length === 0 && r.samplesOnlyB.length === 0) continue;
      console.log('');
      console.log(`[${r.review.slice(0, 11)} ${pairLabel(r.a, r.b)}]`);
      for (const s of r.samplesOnlyA) console.log(`  hanya A: ${trunc(s, 110)}`);
      for (const s of r.samplesOnlyB) console.log(`  hanya B: ${trunc(s, 110)}`);
    }
  }
}

function printChunkTable(details: PairDetail[], acceptedOnly: boolean): void {
  const withChunks = details.filter(d => d.chunks && d.chunks.length > 0);
  console.log('');
  console.log('='.repeat(100));
  console.log(`[2] PER CHUNK dari runs.jsonl (jumlah = ${acceptedOnly ? 'accepted' : 'parsed'}; Δ = B − A)`);
  if (withChunks.length === 0) {
    console.log('  (tidak ada data chunk yang sebanding: runs.jsonl tanpa chunks[] atau parameter chunk berbeda)');
    return;
  }
  console.log(
    pad('review', 13) + pad('run A→B', 14) + pad('chunk', 7) + pad('segmen', 10) +
    pad('A', 5) + pad('B', 5) + pad('Δ', 6) + pad('rawA', 8) + pad('rawB', 8) + 'tanda'
  );

  for (const d of withChunks) {
    for (const c of d.chunks!) {
      const delta = c.pB - c.pA;
      console.log(
        pad(d.res.review.slice(0, 11), 13) + pad(pairLabel(d.res.a, d.res.b), 14) +
        pad(c.chunk, 7) + pad(c.range, 10) +
        pad(c.pA, 5) + pad(c.pB, 5) + pad((delta > 0 ? '+' : '') + delta, 6) +
        pad(c.rawA, 8) + pad(c.rawB, 8) + c.flags.join(',')
      );
    }
  }

  // Konsentrasi selisih per review
  const conc = withChunks.map(d => {
    const deltas = d.chunks!.map(c => ({ chunk: c.chunk, abs: Math.abs(c.pB - c.pA), d: c.pB - c.pA }));
    const total = deltas.reduce((s, x) => s + x.abs, 0);
    const top = deltas.reduce((m, x) => (x.abs > m.abs ? x : m), deltas[0]);
    return { review: d.res.review, pair: pairLabel(d.res.a, d.res.b), total, top };
  }).filter(x => x.total >= 10).sort((x, y) => y.total - x.total);

  console.log('');
  console.log('Konsentrasi selisih (hanya pasangan dengan Σ|Δ| >= 10):');
  if (conc.length === 0) console.log('  (tidak ada)');
  for (const x of conc) {
    console.log(
      `  ${pad(x.review.slice(0, 11), 13)} ${pad(x.pair, 14)} Σ|Δ|=${pad(x.total, 4)} ` +
      `chunk terbesar=${x.top.chunk} (Δ ${x.top.d > 0 ? '+' : ''}${x.top.d}, ${pct(x.top.abs / x.total)} dari total)`
    );
  }
  console.log('  → >70% di satu chunk: kandidat chunk bermasalah. Tersebar rata: variasi granularitas pemecahan.');

  const flagged = withChunks.reduce((s, d) => s + d.chunks!.filter(c => c.flags.includes('TRUNC') || c.flags.includes('SALV')).length, 0);
  console.log(`  chunk dengan TRUNC/SALV: ${flagged}`);
}

function printSegmentSection(details: PairDetail[], binSize: number, gap: number): void {
  const withSeg = details.filter(d => d.seg);
  console.log('');
  console.log('='.repeat(100));
  console.log('[3] CAKUPAN PER SEGMEN SRT (segmen yang memuat >= 1 excerpt; tidak peka batas kutipan)');
  if (withSeg.length === 0) {
    console.log('  (tidak ada data segmen: SRT tidak ada di runs/_srt atau teks segmen kosong)');
    return;
  }
  console.log(
    pad('review', 13) + pad('run A→B', 14) + pad('segTot', 8) + pad('covA', 6) + pad('covB', 6) +
    pad('both', 6) + pad('onlyA', 7) + pad('onlyB', 7) + pad('jacc', 6) + pad('tdkKetemu A/B', 14)
  );
  let tBoth = 0, tA = 0, tB = 0;
  for (const d of withSeg) {
    const s = d.seg!;
    tBoth += s.both; tA += s.onlyA; tB += s.onlyB;
    console.log(
      pad(d.res.review.slice(0, 11), 13) + pad(pairLabel(d.res.a, d.res.b), 14) +
      pad(s.segTotal, 8) + pad(s.covA, 6) + pad(s.covB, 6) + pad(s.both, 6) +
      pad(s.onlyA, 7) + pad(s.onlyB, 7) + pad(pct(s.jaccard), 6) + `${s.unlocA}/${s.unlocB}`
    );
  }
  const tot = tBoth + tA + tB;
  console.log('-'.repeat(100));
  console.log(
    `Segmen tercakup: both=${tBoth}  hanya-A=${tA}  hanya-B=${tB}  → ` +
    `${pct(tot ? (tA + tB) / tot : 0)} segmen yang tercakup hanya dicakup satu run`
  );
  console.log('  "tdkKetemu" = excerpt yang tidak terlokalisasi ke segmen (normalisasi beda); bila besar, angka segmen kurang dapat dipercaya.');

  // Zona asimetris
  const zones: { review: string; pair: string; bin: BinDiff }[] = [];
  for (const d of withSeg) {
    for (const b of d.seg!.bins) {
      if (Math.abs(b.diff) >= gap) zones.push({ review: d.res.review, pair: pairLabel(d.res.a, d.res.b), bin: b });
    }
  }
  zones.sort((x, y) => Math.abs(y.bin.diff) - Math.abs(x.bin.diff));
  console.log('');
  console.log(`Zona asimetris (bin ${binSize} segmen, |item B − item A| >= ${gap}), 15 teratas dari ${zones.length}:`);
  if (zones.length === 0) console.log('  (tidak ada)');
  for (const z of zones.slice(0, 15)) {
    console.log(
      `  ${pad(z.review.slice(0, 11), 13)} ${pad(z.pair, 14)} segmen ${pad(z.bin.from + '-' + z.bin.to, 10)} ` +
      `A=${pad(z.bin.a, 3)} B=${pad(z.bin.b, 3)} Δ=${z.bin.diff > 0 ? '+' : ''}${z.bin.diff}`
    );
  }
  console.log('  → bin dengan salah satu run = 0 tapi run lain banyak = recall hilang di zona itu.');
  console.log('    Selisih di bin yang sama-sama terisi = beda granularitas, bukan beda cakupan.');
}

// ------------------------------------------------------------
// Level 4: posisi relatif dalam chunk
// ------------------------------------------------------------
// Pertanyaan: apakah excerpt "hanya di satu run" lebih sering berada di ujung chunk?
// Unit: excerpt unik per run (kemunculan pertama). Status per excerpt terhadap run lawan:
//   exact = identik, cont = saling memuat, only = tanpa padanan.
// only% = only / (exact + cont + only) pada bin tersebut.
// Item di area tumpang-tindih chunk dihitung di chunk yang lebih awal (kemunculan pertama).
interface PosBin {
  label: string;
  exact: number;
  cont: number;
  only: number;
  onlyA: number;
  onlyB: number;
  items: number;    // semua excerpt unik di bin ini
  segs: number;     // jumlah segmen yang jatuh di bin ini (untuk kepadatan item/segmen)
}

interface PosAnalysis {
  bins: PosBin[];
  first: [number, number];   // [only, total] untuk `edge` segmen pertama chunk
  mid: [number, number];
  last: [number, number];    // `edge` segmen terakhir chunk
  chunksUsed: number;
  chunksSkipped: number;
  unplaced: number;
}

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

// z dua proporsi (pooled); positif bila proporsi 1 > proporsi 2.
function zTwoProp(k1: number, n1: number, k2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 0;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (k1 / n1 - k2 / n2) / se : 0;
}

function analyzePositions(details: PairDetail[], nb: number, edge: number, minLen: number): PosAnalysis {
  const bins: PosBin[] = Array.from({ length: nb }, (_, i) => ({
    label: `${Math.round((i * 100) / nb)}-${Math.round(((i + 1) * 100) / nb)}%`,
    exact: 0, cont: 0, only: 0, onlyA: 0, onlyB: 0, items: 0, segs: 0
  }));
  const first: [number, number] = [0, 0];
  const mid: [number, number] = [0, 0];
  const last: [number, number] = [0, 0];
  let chunksUsed = 0;
  let chunksSkipped = 0;
  let unplaced = 0;

  for (const d of details) {
    const exact = new Set(d.exactKeys);
    const sides: [RunData, Set<string>, 'onlyA' | 'onlyB'][] = [
      [d.A, new Set(d.onlyAKeys), 'onlyA'],
      [d.B, new Set(d.onlyBKeys), 'onlyB']
    ];

    for (const [rd, onlySet, tag] of sides) {
      for (const sp of rd.chunkSpans) {
        if (sp.len < minLen) { chunksSkipped++; continue; }
        chunksUsed++;
        for (let k = 0; k < sp.len; k++) {
          bins[Math.min(nb - 1, Math.floor(((k + 0.5) / sp.len) * nb))].segs++;
        }
      }

      for (const [key, arr] of rd.byKey) {
        const it = arr[0];
        if (it.relPos == null || it.chunkLen == null || it.chunkStart == null || it.segFirst == null) {
          unplaced++;
          continue;
        }
        if (it.chunkLen < minLen) continue;

        const b = bins[Math.min(nb - 1, Math.max(0, Math.floor(it.relPos * nb)))];
        const isExact = exact.has(key);
        const isOnly = !isExact && onlySet.has(key);
        b.items++;
        if (isExact) b.exact++;
        else if (isOnly) { b.only++; b[tag]++; }
        else b.cont++;

        const idx = it.segFirst - it.chunkStart;            // 0-based dalam chunk
        const fromEnd = it.chunkLen - 1 - idx;
        const slot = idx < edge ? first : fromEnd < edge ? last : mid;
        slot[1]++;
        if (isOnly) slot[0]++;
      }
    }
  }
  return { bins, first, mid, last, chunksUsed, chunksSkipped, unplaced };
}

function printPositionSection(details: PairDetail[], nb: number, edge: number, minLen: number): void {
  console.log('');
  console.log('='.repeat(100));
  console.log('[4] POSISI RELATIF DALAM CHUNK (0% = awal chunk, 100% = akhir; unit = excerpt unik per run)');

  const a = analyzePositions(details, nb, edge, minLen);
  const total = a.bins.reduce((s, b) => s + b.items, 0);
  if (total === 0) {
    console.log('  (tidak ada item yang terlokalisasi ke chunk)');
    return;
  }
  console.log(
    `  chunk-run dipakai=${a.chunksUsed}, dilewati (< ${minLen} segmen)=${a.chunksSkipped}, item tak terlokalisasi=${a.unplaced}`
  );
  console.log(
    pad('posisi', 10) + pad('n', 6) + pad('exact', 7) + pad('cont', 6) + pad('only', 6) +
    pad('only%', 7) + pad('CI95', 11) + pad('onlyA', 7) + pad('onlyB', 7) + 'item/seg'
  );
  for (const b of a.bins) {
    const [lo, hi] = wilson(b.only, b.items);
    console.log(
      pad(b.label, 10) + pad(b.items, 6) + pad(b.exact, 7) + pad(b.cont, 6) + pad(b.only, 6) +
      pad(b.items ? pct(b.only / b.items) : '-', 7) + pad(`${pct(lo)}-${pct(hi)}`, 11) +
      pad(b.onlyA, 7) + pad(b.onlyB, 7) + (b.segs ? (b.items / b.segs).toFixed(2) : '-')
    );
  }

  const rate = (k: number, n: number) => (n ? k / n : 0);
  const verdict = (z: number) => (Math.abs(z) >= 1.96 ? 'selisih cukup jelas' : 'belum cukup bukti');

  console.log('');
  console.log(`Ujung chunk (lebar ${edge} segmen):`);
  for (const [label, v] of [['awal', a.first], ['tengah', a.mid], ['akhir', a.last]] as [string, [number, number]][]) {
    console.log(`  ${pad(label, 8)} n=${pad(v[1], 5)} only=${pad(v[0], 4)} only%=${pct(rate(v[0], v[1]))}`);
  }

  const sumOnly = a.bins.reduce((s, b) => s + b.only, 0);
  const lastBin = a.bins[nb - 1];
  const firstBin = a.bins[0];
  const zLastBin = zTwoProp(lastBin.only, lastBin.items, sumOnly - lastBin.only, total - lastBin.items);
  const zFirstBin = zTwoProp(firstBin.only, firstBin.items, sumOnly - firstBin.only, total - firstBin.items);
  const zLastEdge = zTwoProp(a.last[0], a.last[1], a.mid[0], a.mid[1]);
  const zFirstEdge = zTwoProp(a.first[0], a.first[1], a.mid[0], a.mid[1]);

  console.log('');
  console.log('Uji kasar (z dua proporsi; positif = only% lebih tinggi di kelompok pertama):');
  console.log(`  bin terakhir vs bin lain : ${pct(rate(lastBin.only, lastBin.items))} vs ${pct(rate(sumOnly - lastBin.only, total - lastBin.items))}  z=${zLastBin.toFixed(2)}  (${verdict(zLastBin)})`);
  console.log(`  bin pertama vs bin lain  : ${pct(rate(firstBin.only, firstBin.items))} vs ${pct(rate(sumOnly - firstBin.only, total - firstBin.items))}  z=${zFirstBin.toFixed(2)}  (${verdict(zFirstBin)})`);
  console.log(`  ${edge} segmen akhir vs tengah: ${pct(rate(a.last[0], a.last[1]))} vs ${pct(rate(a.mid[0], a.mid[1]))}  z=${zLastEdge.toFixed(2)}  (${verdict(zLastEdge)})`);
  console.log(`  ${edge} segmen awal vs tengah : ${pct(rate(a.first[0], a.first[1]))} vs ${pct(rate(a.mid[0], a.mid[1]))}  z=${zFirstEdge.toFixed(2)}  (${verdict(zFirstEdge)})`);
  console.log('  Catatan: item dalam satu video/chunk tidak independen, jadi z cenderung terlalu optimistis. Anggap |z| < 3 sebagai indikasi lemah.');
  console.log('  → only% naik ke akhir chunk = ketidakstabilan ekstraksi di ujung chunk.');
  console.log('  → item/seg turun ke akhir chunk = model mengekstrak lebih jarang di bagian akhir input.');
  console.log('  → keduanya datar = selisih antar-run tidak berkaitan dengan posisi (lebih mirip variasi sampling biasa).');
}

// ------------------------------------------------------------
// CSV audit manual
// ------------------------------------------------------------
function csvCell(v: unknown, sep: string): string {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return s.includes(sep) || s.includes('"') || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface CsvRow {
  kelompok: string;
  review: string;
  pair: string;
  runId: string;
  chunk: number;
  segFirst: number | null;
  segLast: number | null;
  type: string;
  subtopic: string;
  claim: string;
  excerpt: string;
  konteks: string;
  lolos: string;
  ambiguous: string;
}

function contextOf(rd: RunData, it: ItemRec): string {
  if (it.segFirst == null || it.segLast == null) return '';
  const parts: string[] = [];
  for (let s = it.segFirst - 1; s <= it.segLast + 1; s++) {
    const t = rd.segTexts.get(s);
    if (t) parts.push(t.replace(/\s+/g, ' ').trim());
  }
  return trunc(parts.join(' | '), 400);
}

function writeCsv(
  file: string,
  details: PairDetail[],
  sample: number | undefined,
  control: number,
  seed: number,
  sep: string
): void {
  const rand = rng(seed);
  const onlyRows: CsvRow[] = [];
  const ctrlRows: CsvRow[] = [];

  const mk = (kelompok: string, d: PairDetail, rd: RunData, key: string): CsvRow => {
    const it = rd.byKey.get(key)![0];
    return {
      kelompok,
      review: d.res.review,
      pair: pairLabel(d.res.a, d.res.b),
      runId: rd.run_id,
      chunk: it.chunk,
      segFirst: it.segFirst,
      segLast: it.segLast,
      type: it.type,
      subtopic: it.subtopic,
      claim: it.claim,
      excerpt: it.excerpt,
      konteks: contextOf(rd, it),
      lolos: it.accepted === null ? '' : it.accepted ? 'ya' : 'tidak',
      ambiguous: it.ambiguous ? 'ya' : ''
    };
  };

  for (const d of details) {
    for (const k of d.onlyAKeys) onlyRows.push(mk('hanya-A', d, d.A, k));
    for (const k of d.onlyBKeys) onlyRows.push(mk('hanya-B', d, d.B, k));
    for (const k of d.exactKeys) ctrlRows.push(mk('kedua-run', d, d.A, k));
  }

  const pickOnly = sample !== undefined ? shuffle(onlyRows, rand).slice(0, sample) : onlyRows;
  const pickCtrl = control > 0 ? shuffle(ctrlRows, rand).slice(0, control) : [];
  const rows = shuffle([...pickOnly, ...pickCtrl], rand);

  const header = [
    'no', 'review', 'pasangan_run', 'run_id', 'chunk', 'seg_awal', 'seg_akhir', 'type', 'subtopic',
    'claim', 'source_excerpt', 'konteks_srt', 'lolos_validator', 'excerpt_ambigu',
    'label_benar(1/0)', 'label_informatif(1/0)', 'catatan', 'kelompok'
  ];
  const lines = [header.map(h => csvCell(h, sep)).join(sep)];
  rows.forEach((r, i) => {
    lines.push([
      i + 1, r.review, r.pair, r.runId, r.chunk, r.segFirst ?? '', r.segLast ?? '', r.type, r.subtopic,
      r.claim, r.excerpt, r.konteks, r.lolos, r.ambiguous, '', '', '', r.kelompok
    ].map(v => csvCell(v, sep)).join(sep));
  });
  fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');

  console.log('');
  console.log(
    `CSV audit: ${rows.length} baris (hanya-satu-run=${pickOnly.length} dari ${onlyRows.length}, ` +
    `kontrol kedua-run=${pickCtrl.length} dari ${ctrlRows.length}) → ${file}`
  );
  console.log('  Diacak (seed ' + seed + '). Kolom "kelompok" ada di paling kanan; sembunyikan sebelum melabeli agar buta.');
  if (control === 0) console.log('  Saran: tambahkan --control untuk pembanding presisi item yang muncul di kedua run.');
}

// ------------------------------------------------------------
// CLI
// ------------------------------------------------------------
const VALUE_FLAGS = new Set(['--since', '--review', '--json', '--csv', '--sample', '--control', '--seed', '--sep', '--bin', '--gap', '--posbins', '--edge', '--minchunk']);
const BOOL_FLAGS = new Set(['--accepted', '--full']);

function checkArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (BOOL_FLAGS.has(a)) continue;
    if (a.startsWith('--')) {
      console.warn(`! flag tidak dikenal, diabaikan: ${a}`);
    } else {
      console.warn(`! argumen posisional diabaikan: "${a}" (maksud Anda --since ${a} atau --accepted?)`);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  checkArgs(args);

  const flag = (n: string) => args.includes(n);
  const valueOf = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const numOf = (n: string, def: number) => {
    const v = valueOf(n);
    const x = v !== undefined ? Number(v) : NaN;
    return Number.isFinite(x) ? x : def;
  };

  const since = valueOf('--since');
  const reviewFilter = valueOf('--review');
  const acceptedOnly = flag('--accepted');
  const binSize = Math.max(1, Math.floor(numOf('--bin', 10)));
  const gap = Math.max(1, Math.floor(numOf('--gap', 5)));

  let runs = readRuns().filter(r => fs.existsSync(path.join(RUN_LOG_DIR, r.run_id)));
  if (since) runs = runs.filter(r => r.run_id >= since);
  if (reviewFilter) runs = runs.filter(r => (r.review_id ?? '').startsWith(reviewFilter));

  if (runs.length === 0) {
    console.error(`Tidak ada run dengan folder raw di ${RUN_LOG_DIR} (cek --since / --review).`);
    process.exit(1);
  }

  const byReview = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const k = r.review_id ?? 'noid';
    if (!byReview.has(k)) byReview.set(k, []);
    byReview.get(k)!.push(r);
  }

  const details: PairDetail[] = [];
  const skipped: string[] = [];
  const warned = new Set<string>();

  for (const [review, group] of byReview) {
    group.sort((x, y) => x.run_id.localeCompare(y.run_id));
    if (group.length < 2) { skipped.push(review); continue; }

    const sets = group
      .map(r => loadRun(r, acceptedOnly, warned))
      .filter((s): s is RunData => !!s);

    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const c = comparePair(review, sets[i], sets[j]);
        details.push({
          res: c.res,
          A: sets[i],
          B: sets[j],
          onlyAKeys: c.onlyAKeys,
          onlyBKeys: c.onlyBKeys,
          exactKeys: c.exactKeys,
          seg: compareSegments(sets[i], sets[j], binSize),
          chunks: compareChunks(sets[i], sets[j], acceptedOnly)
        });
      }
    }
  }

  if (details.length === 0) {
    console.error('Tidak ada review dengan >= 2 run yang bisa dibandingkan.');
    process.exit(1);
  }

  printExcerptTable(details.map(d => d.res), flag('--full'), acceptedOnly);
  printChunkTable(details, acceptedOnly);
  printSegmentSection(details, binSize, gap);
  printPositionSection(
    details,
    Math.max(2, Math.floor(numOf('--posbins', 5))),
    Math.max(1, Math.floor(numOf('--edge', 10))),
    Math.max(1, Math.floor(numOf('--minchunk', 20)))
  );

  if (skipped.length > 0) {
    console.log(`\nDilewati (hanya 1 run): ${skipped.join(', ')}`);
  }

  const csvOut = valueOf('--csv');
  if (csvOut) {
    const sampleArg = valueOf('--sample');
    const sample = sampleArg !== undefined && Number.isFinite(Number(sampleArg)) ? Number(sampleArg) : undefined;
    const sepArg = valueOf('--sep') ?? ',';
    const sep = sepArg === 'tab' ? '\t' : sepArg;
    writeCsv(csvOut, details, sample, Math.max(0, Math.floor(numOf('--control', 0))), numOf('--seed', 42), sep);
  }

  const jsonOut = valueOf('--json');
  if (jsonOut) {
    const out = details.map(d => ({
      ...d.res,
      chunks: d.chunks,
      segments: d.seg
        ? { ...d.seg, bins: [...d.seg.bins].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, 10) }
        : null
    }));
    fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2), 'utf8');
    console.log(`\nHasil disimpan ke ${jsonOut}`);
  }
}

main();
