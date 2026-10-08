// ============================================================
// EXCERPT SUPPORT — apakah claim didukung source_excerpt? (replay, tanpa API)
// ============================================================
// Letakkan di: scripts/excerpt-support.ts
//
// Validator yang ada memastikan excerpt LITERAL ada di transkrip, tetapi tidak
// memeriksa apakah excerpt itu MENOPANG claim-nya. Skrip ini mengukurnya secara
// deterministik pada semua raw output yang tersimpan di runs/.
//
// Tiga metrik per item (hanya item yang LOLOS validator):
//   skor_excerpt : porsi kata isi claim (di-stem kasar, tanpa stopword/kata atribusi)
//                  yang ada di excerpt
//   skor_konteks : sama, tetapi terhadap excerpt + 1 segmen sebelum/sesudahnya
//   angka hilang : angka di claim yang tidak ada di excerpt (atau konteks)
//
// Kategori:
//   ok                  skor_excerpt >= --thr (0.5) dan semua angka claim ada di excerpt
//   bergantung-konteks  tidak ok, tapi skor_konteks >= --ctxthr (0.7) dan angka ada di konteks
//                       -> klaim benar, tetapi excerpt tidak bisa berdiri sendiri sebagai bukti
//   tak-didukung        tidak ok dan konteks pun tidak menopang
//                       -> kandidat kuat klaim yang salah / dikarang / dari tempat lain
//
// CATATAN: ini heuristik leksikal, bukan penilaian makna. Parafrase sah ("memakai" vs
// "menggunakan") bisa terhitung rendah; stem kasar hanya mengurangi, tidak menghapus
// masalah itu. Perlakukan hasil sebagai KANDIDAT untuk ditinjau, bukan vonis.
//
// Pakai:
//   npx tsx scripts/excerpt-support.ts
//   opsi: --reviews a,b  --since 2026-10-07  --variant 4000/2  --thr 0.5  --ctxthr 0.7
//         --show 25 (jumlah contoh tak-didukung)  --json out.json
//         --csv audit.csv --sample 40 --control 15 --seed 42 --sep ';'
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

type Category = 'ok' | 'bergantung-konteks' | 'tak-didukung';

interface Scored {
  review: string;
  variant: string;
  run_id: string;
  chunk: number;
  type: string;
  subtopic: string;
  claim: string;
  excerpt: string;
  context: string;
  exScore: number;
  ctxScore: number;
  numMissing: string[];
  ctxNumMissing: string[];
  excerptWords: number;
  cat: Category;
}

const args = process.argv.slice(2);
const valueOf = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const reviewFilter = (valueOf('--reviews') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const since = valueOf('--since');
const variantFilter = valueOf('--variant');
const THR = Number(valueOf('--thr') ?? 0.5);
const CTXTHR = Number(valueOf('--ctxthr') ?? 0.7);
const SHOW = Number(valueOf('--show') ?? 25);
const seed = Number(valueOf('--seed') ?? 42);
const sepArg = valueOf('--sep') ?? ',';
const sep = sepArg === 'tab' ? '\t' : sepArg;

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const pct = (x: number) => (x * 100).toFixed(1) + '%';
const trunc = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// ------------------------------------------------------------
// Tokenisasi
// ------------------------------------------------------------
const STOP = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'adalah', 'ini', 'itu', 'juga', 'atau',
  'akan', 'bisa', 'dapat', 'ada', 'tidak', 'lebih', 'sudah', 'masih', 'saat', 'serta', 'oleh', 'karena',
  'sebagai', 'dalam', 'sangat', 'cukup', 'nya', 'ya', 'sih', 'aja', 'saja', 'kita', 'kami', 'kamu',
  // kata atribusi buatan model (tidak harus ada di excerpt)
  'reviewer', 'menilai', 'menyebut', 'menyatakan', 'mengatakan', 'menganggap', 'menurut', 'disebut',
  'dinilai', 'dianggap', 'disarankan', 'menyarankan', 'memiliki', 'mempunyai', 'terdapat', 'hasil'
]);

function stem(w: string): string {
  let s = w;
  if (s.length > 5) s = s.replace(/(nya|kan|lah|kah)$/, '');
  if (s.length > 5) s = s.replace(/(an|i)$/, '');
  if (s.length > 5) s = s.replace(/^(meng|meny|men|mem|me|di|ter|ber|per|pen|pe|se|ke)/, '');
  return s;
}

function analyzeText(text: string): { words: Set<string>; numbers: Set<string> } {
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const t of normalizeForSearch(text).split(' ')) {
    if (!t) continue;
    if (/^\d+$/.test(t)) { numbers.add(t); continue; }
    if (t.length < 3 || STOP.has(t)) continue;
    words.add(stem(t));
  }
  return { words, numbers };
}

// Semua token (bukan hanya kata isi) -- untuk mengecek keberadaan kata klaim di sumber.
function sourceTokens(text: string): { words: Set<string>; numbers: Set<string> } {
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const t of normalizeForSearch(text).split(' ')) {
    if (!t) continue;
    if (/^\d+$/.test(t)) numbers.add(t);
    else words.add(stem(t));
  }
  return { words, numbers };
}

function score(claim: ReturnType<typeof analyzeText>, source: ReturnType<typeof sourceTokens>) {
  const total = claim.words.size;
  let hit = 0;
  for (const w of claim.words) if (source.words.has(w)) hit++;
  const missing = [...claim.numbers].filter(n => !source.numbers.has(n));
  return { score: total === 0 ? 1 : hit / total, numMissing: missing };
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

function scoreRun(run: RunRecord): Scored[] {
  const runDir = path.join(RUN_LOG_DIR, run.run_id);
  const srtPath = path.join(RUN_LOG_DIR, '_srt', `${run.srt_sha}.srt`);
  if (!fs.existsSync(runDir) || !fs.existsSync(srtPath)) return [];
  if (run.chunk_chars === undefined || run.chunk_overlap === undefined) return [];

  const all = parseSRT(fs.readFileSync(srtPath, 'utf8'));
  const chunks = buildEvidenceChunks(all, run.chunk_chars, run.chunk_overlap);
  const variant = `${run.chunk_chars}/${run.chunk_overlap}`;
  const out: Scored[] = [];

  chunks.forEach((chunk, ci) => {
    const rawPath = path.join(runDir, `chunk-${ci + 1}.raw.txt`);
    if (!fs.existsSync(rawPath)) return;

    const context: EvidenceContext = { chunkIndex: ci, chunkText: buildChunkText(chunk), chunkSegments: chunk };
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

    const parsed = parseEvidenceJSONDetailed(fs.readFileSync(rawPath, 'utf8')).evidence as EvidenceItem[];
    for (const ev of parsed.filter(isValidEvidence)) {
      normalizeNullishFields(ev);
      const reconciled = reconcile(ev);
      const report = EvidenceValidator.validate(reconciled, context);
      if (!report.accepted) continue;

      const excerpt = String(ev.source_excerpt ?? '');
      const key = normalizeForSearch(excerpt);
      if (!key) continue;

      // konteks = excerpt + 1 segmen sebelum/sesudah (dalam chunk yang sama)
      let ctxText = excerpt;
      const p = hay.indexOf(key);
      if (p >= 0) {
        const k1 = Math.max(0, segAt(p) - 1);
        const k2 = Math.min(chunk.length - 1, segAt(p + key.length - 1) + 1);
        ctxText = chunk.slice(k1, k2 + 1).map(s => s.text).join(' ');
      }

      const claimTok = analyzeText(String(ev.claim ?? ''));
      const ex = score(claimTok, sourceTokens(excerpt));
      const cx = score(claimTok, sourceTokens(ctxText));

      let cat: Category;
      if (ex.score >= THR && ex.numMissing.length === 0) cat = 'ok';
      else if (cx.score >= CTXTHR && cx.numMissing.length === 0) cat = 'bergantung-konteks';
      else cat = 'tak-didukung';

      out.push({
        review: run.review_id ?? 'noid',
        variant,
        run_id: run.run_id,
        chunk: ci + 1,
        type: String(reconciled.type ?? ''),
        subtopic: String(ev.subtopic ?? ''),
        claim: String(ev.claim ?? ''),
        excerpt,
        context: trunc(ctxText, 400),
        exScore: ex.score,
        ctxScore: cx.score,
        numMissing: ex.numMissing,
        ctxNumMissing: cx.numMissing,
        excerptWords: key.split(' ').length,
        cat
      });
    }
  });
  return out;
}

// ------------------------------------------------------------
// Pelaporan
// ------------------------------------------------------------
function summarize(label: string, items: Scored[]): string {
  const n = items.length;
  if (n === 0) return `${pad(label, 14)}(kosong)`;
  const c = (k: Category) => items.filter(i => i.cat === k).length;
  const short = items.filter(i => i.excerptWords < 5).length;
  return (
    pad(label, 14) + pad(n, 8) + pad(pct(c('ok') / n), 10) + pad(pct(c('bergantung-konteks') / n), 20) +
    pad(pct(c('tak-didukung') / n), 15) + pad(pct(short / n), 12) +
    (items.reduce((s, i) => s + i.excerptWords, 0) / n).toFixed(1)
  );
}

function rng(s: number): () => number {            // mulberry32
  let a = s >>> 0;
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

function csvCell(v: unknown): string {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return s.includes(sep) || s.includes('"') || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main(): void {
  let runs = readRuns().filter(r => fs.existsSync(path.join(RUN_LOG_DIR, r.run_id)));
  if (since) runs = runs.filter(r => r.run_id >= since);
  if (reviewFilter.length > 0) runs = runs.filter(r => reviewFilter.some(f => (r.review_id ?? '').startsWith(f)));
  if (variantFilter) runs = runs.filter(r => `${r.chunk_chars}/${r.chunk_overlap}` === variantFilter);
  if (runs.length === 0) {
    console.error('Tidak ada run yang cocok (cek --reviews / --since / --variant).');
    process.exit(1);
  }

  const items: Scored[] = [];
  for (const r of runs) items.push(...scoreRun(r));
  if (items.length === 0) {
    console.error('Tidak ada item yang bisa dinilai (SRT di runs/_srt hilang?).');
    process.exit(1);
  }

  console.log('='.repeat(100));
  console.log(`DUKUNGAN EXCERPT TERHADAP CLAIM — ${runs.length} run, ${items.length} item lolos validator (thr=${THR}, ctxthr=${CTXTHR})`);
  console.log(pad('kelompok', 14) + pad('n', 8) + pad('ok', 10) + pad('bergantung-konteks', 20) + pad('tak-didukung', 15) + pad('excerpt<5kt', 12) + 'rata kata excerpt');

  console.log(summarize('SEMUA', items));
  const variants = [...new Set(items.map(i => i.variant))].sort();
  for (const v of variants) console.log(summarize(`varian ${v}`, items.filter(i => i.variant === v)));
  const types = [...new Set(items.map(i => i.type))].sort();
  console.log('-'.repeat(100));
  for (const t of types) console.log(summarize(`type ${t}`, items.filter(i => i.type === t)));

  const numBad = items.filter(i => i.numMissing.length > 0);
  const numBadCtx = items.filter(i => i.ctxNumMissing.length > 0);
  console.log('-'.repeat(100));
  console.log(
    `Claim dengan angka yang TIDAK ada di excerpt: ${numBad.length} (${pct(numBad.length / items.length)}); ` +
    `tidak ada bahkan di konteks: ${numBadCtx.length} (${pct(numBadCtx.length / items.length)})`
  );

  const bad = items.filter(i => i.cat === 'tak-didukung').sort((a, b) => a.ctxScore - b.ctxScore);
  console.log('');
  console.log(`${Math.min(SHOW, bad.length)} contoh "tak-didukung" (skor konteks terendah dulu):`);
  for (const b of bad.slice(0, SHOW)) {
    console.log(`  [${b.review.slice(0, 6)} ${b.variant} c${b.chunk}] ex=${b.exScore.toFixed(2)} ctx=${b.ctxScore.toFixed(2)}${b.numMissing.length ? ' angka-hilang=' + b.numMissing.join(',') : ''}`);
    console.log(`     claim  : ${trunc(b.claim, 110)}`);
    console.log(`     excerpt: ${trunc(b.excerpt, 110)}`);
  }

  const jsonOut = valueOf('--json');
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(items.map(i => ({ ...i, context: undefined })), null, 2), 'utf8');
    console.log(`\nHasil per item disimpan ke ${jsonOut}`);
  }

  const csvOut = valueOf('--csv');
  if (csvOut) {
    const rand = rng(seed);
    // dedup per (review, claim) supaya item yang sama dari banyak run tidak mendominasi sampel
    const uniq = <T extends Scored>(arr: T[]) => {
      const seen = new Set<string>();
      return arr.filter(i => {
        const k = `${i.review}|${normalizeForSearch(i.claim)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    const nSample = Number(valueOf('--sample') ?? 40);
    const nControl = Number(valueOf('--control') ?? 15);
    const flagged = uniq(items.filter(i => i.cat !== 'ok'));
    const control = uniq(items.filter(i => i.cat === 'ok'));
    const rows = shuffle([
      ...shuffle(flagged, rand).slice(0, nSample),
      ...shuffle(control, rand).slice(0, nControl)
    ], rand);

    const header = [
      'no', 'review', 'varian', 'run_id', 'chunk', 'type', 'subtopic', 'claim', 'source_excerpt', 'konteks_srt',
      'label_klaim_benar(1/0)', 'label_excerpt_menopang(1/0)', 'catatan', 'skor_excerpt', 'skor_konteks', 'angka_hilang', 'kategori'
    ];
    const lines = [header.map(csvCell).join(sep)];
    rows.forEach((r, i) => {
      lines.push([
        i + 1, r.review, r.variant, r.run_id, r.chunk, r.type, r.subtopic, r.claim, r.excerpt, r.context,
        '', '', '', r.exScore.toFixed(2), r.ctxScore.toFixed(2), r.numMissing.join(' '), r.cat
      ].map(csvCell).join(sep));
    });
    fs.writeFileSync(csvOut, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
    console.log(
      `\nCSV: ${rows.length} baris (ditandai=${Math.min(nSample, flagged.length)} dari ${flagged.length} unik, ` +
      `kontrol-ok=${Math.min(nControl, control.length)} dari ${control.length} unik) → ${csvOut} [diacak, seed ${seed}]`
    );
    console.log('  Kolom skor_* dan kategori ada di paling kanan; sembunyikan sebelum melabeli agar buta.');
    console.log('  label_klaim_benar: claim didukung transkrip (excerpt atau konteks) tanpa info luar.');
    console.log('  label_excerpt_menopang: excerpt SAJA sudah cukup menopang claim.');
  }
}

main();