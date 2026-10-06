import { describe, test, expect } from 'vitest';
import {
  AssessmentValidator,
  findEvaluativeWords,
  EVALUATIVE_WORDS,
  TECHNICAL_WHITELIST_PHRASES,
  ASSESSMENT_RULES_VERSION
} from '../assessment';

const V = AssessmentValidator.validate;

// ============================================================
// BAGIAN 1 — test asli (tidak diubah)
// ============================================================
describe('ASSESSMENT VALIDATOR', () => {
  test('PASS: FACT + null', () => {
    expect(V('FACT', null).status).toBe('PASS');
  });
  test('PASS: OPINION + positive', () => {
    expect(V('OPINION', 'positive').status).toBe('PASS');
  });
  test('PASS: OBSERVATION + null', () => {
    expect(V('OBSERVATION', null).status).toBe('PASS');
  });
  test('FAIL: FACT + positive', () => {
    expect(V('FACT', 'positive').status).toBe('FAIL');
  });
  test('FAIL: RECOMMENDATION + positive', () => {
    expect(V('RECOMMENDATION', 'positive').status).toBe('FAIL');
  });
  test('FAIL: FACT + negative', () => {
    expect(V('FACT', 'negative').status).toBe('FAIL');
  });
});

// ============================================================
// BAGIAN 2 — normalisasi input & wajib-assessment pada OPINION
// ============================================================
describe('ASSESSMENT VALIDATOR: normalisasi & OPINION wajib assessment', () => {
  test('FAIL: type huruf kecil dinormalisasi (fact + positive)', () => {
    expect(V('fact', 'positive').status).toBe('FAIL');
  });
  test('PASS: assessment berisi spasi saja dianggap kosong', () => {
    expect(V('FACT', '   ').status).toBe('PASS');
  });
  test('SUSPECT HIGH: OPINION tanpa assessment', () => {
    const r = V('OPINION', null);
    expect(r.status).toBe('SUSPECT');
    expect(r.severity).toBe('HIGH');
  });
  test('SUSPECT: type tidak diisi dianggap OPINION, assessment kosong', () => {
    expect(V(undefined, null).status).toBe('SUSPECT');
  });
  test('type di-trim: " opinion " tanpa assessment tetap SUSPECT (bukan lolos diam-diam)', () => {
    expect(V(' opinion ', null).status).toBe('SUSPECT');
  });
  test('type berisi spasi saja dianggap OPINION', () => {
    expect(V('   ', null).status).toBe('SUSPECT');
  });
  test.each(['null', 'NULL', 'None', 'n/a', '-'])('placeholder "%s" = kosong: FACT PASS', ph => {
    expect(V('FACT', ph).status).toBe('PASS');
  });
  test('placeholder "null" = kosong: OPINION tetap SUSPECT (tidak dianggap punya assessment)', () => {
    expect(V('OPINION', 'null').status).toBe('SUSPECT');
  });
  test('OPINION boleh memuat kata evaluatif', () => {
    expect(V('OPINION', 'positive', 'Layar bagus dan cukup terang', '').status).toBe('PASS');
  });
});

// ============================================================
// BAGIAN 3 — kebijakan severity pada non-OPINION (assessment-v2)
// ============================================================
describe('ASSESSMENT VALIDATOR: severity menurut type', () => {
  test('HIGH (karantina): FACT + kata evaluatif di klaim', () => {
    const r = V('FACT', null, 'Layar bagus', '');
    expect(r.status).toBe('SUSPECT');
    expect(r.severity).toBe('HIGH');
    expect(r.reason).toContain('"bagus"');
  });
  test('HIGH: MEASUREMENT + kata evaluatif di klaim', () => {
    expect(V('MEASUREMENT', null, 'Baterai cukup awet 8 jam', '').severity).toBe('HIGH');
  });
  test('HIGH: type tidak dikenal diperlakukan konservatif', () => {
    expect(V('FOO', null, 'Layar bagus', '').severity).toBe('HIGH');
  });
  test.each(['OBSERVATION', 'RECOMMENDATION', 'COMPARISON', 'CLAIM'])(
    'LOW (diterima + flag): %s + kata evaluatif di klaim', t => {
      const r = V(t, null, 'Layar terlihat bagus', '');
      expect(r.status).toBe('SUSPECT');
      expect(r.severity).toBe('LOW');
      expect(r.reason).toContain('"bagus"');
      expect(r.reason).toContain('tidak memblokir');
    });
  test('LOW: COMPARISON dengan "jauh lebih" tidak lagi memblokir', () => {
    expect(V('COMPARISON', null, 'Layar jauh lebih terang dari A25', '').severity).toBe('LOW');
  });
  test('LOW: kata hanya di excerpt (klaim netral), bahkan pada FACT', () => {
    // Sintetis: meniru c1#24 (FACT "Resolusi layar Full HD+" yang dulu dikarantina
    // karena kalimat tetangga di excerpt memuat "cukup"). Excerpt di sini rekaan.
    const r = V('FACT', null, 'Resolusi layar Full HD+', 'resolusinya Full HD+, terus warnanya cukup tajam');
    expect(r.status).toBe('SUSPECT');
    expect(r.severity).toBe('LOW');
    expect(r.reason).toContain('source_excerpt');
  });
  test('SUSPECT: kata evaluatif hanya di excerpt (klaim netral)', () => {
    const r = V('OBSERVATION', null, 'Frame rate stabil di 60 fps', 'gak cuma cakep di awal-awal doang');
    expect(r.status).toBe('SUSPECT');
    expect(r.severity).toBe('LOW');
  });
  test('huruf besar tetap terdeteksi', () => {
    expect(V('OBSERVATION', null, 'LAYAR BAGUS', '').status).toBe('SUSPECT');
  });
  test('PASS: word-boundary, "berkurang" bukan "kurang"', () => {
    expect(V('MEASUREMENT', null, 'Baterai berkurang 5%', 'baterai berkurang 5% selama setengah jam').status).toBe('PASS');
  });
  test('findEvaluativeWords: mengembalikan semua kata yang cocok', () => {
    expect(findEvaluativeWords('terasa cukup stabil').sort()).toEqual(['cukup', 'cukup stabil']);
  });
});

// ============================================================
// BAGIAN 4 — kebocoran yang diperbaiki di assessment-v2
// ============================================================
describe('ASSESSMENT VALIDATOR: whitelist & discourse hanya menetralkan frasanya sendiri', () => {
  test('"minim noise" dinetralkan, "jelek" di teks yang sama tetap tertangkap', () => {
    const r = V('OBSERVATION', null, 'Hasil foto minim noise dan jelek banget', '');
    expect(r.status).toBe('SUSPECT');
    expect(r.reason).toContain('"jelek"');
    expect(r.reason).not.toContain('"minim"');
  });
  test('kebocoran whitelist pada FACT = HIGH', () => {
    expect(V('FACT', null, 'Hasil foto minim noise dan sangat mantap', 'minim noise dan mantap banget').severity).toBe('HIGH');
  });
  test('"minim noise" saja tetap PASS', () => {
    expect(V('OBSERVATION', null, 'Hasil foto minim noise', '').status).toBe('PASS');
  });
  test('findEvaluativeWords: whitelist dibuang, sisanya tetap', () => {
    expect(findEvaluativeWords('hasil minim noise dan mantap banget')).toEqual(['mantap']);
  });
  test('"cukup kalian ..." tetap PASS (discourse marker)', () => {
    expect(V('RECOMMENDATION', null, 'Cukup kalian pakai mode ini', '').status).toBe('PASS');
  });
  test('discourse marker tidak lagi meloloskan kata evaluatif lain', () => {
    const r = V('OBSERVATION', null, 'Cukup kalian pakai ini, hasilnya bagus', '');
    expect(r.status).toBe('SUSPECT');
    expect(r.reason).toContain('"bagus"');
    expect(r.reason).not.toContain('"cukup"');
  });
  test('awal kalimat: "Cukup <kata> kalian" adalah discourse marker', () => {
    expect(findEvaluativeWords('Jadi begitu. Cukup pasang kalian aja')).toEqual([]);
  });
  test('"cukup" di tengah kalimat dengan kata sisip BUKAN discourse marker', () => {
    expect(findEvaluativeWords('layar cukup tajam kalian')).toEqual(['cukup']);
  });
  test.each([
    ['Baterai cukup untuk seharian'],
    ['Kamera cukup bisa diandalkan'],
    ['Layar cukup kalau dipakai di luar ruangan']
  ])('"cukup" evaluatif tertangkap: %s', claim => {
    expect(V('OBSERVATION', null, claim, '').status).toBe('SUSPECT');
    expect(findEvaluativeWords(claim)).toEqual(['cukup']);
  });
  test('setiap entri whitelist benar-benar mengandung kata leksikon (tidak ada entri mati)', () => {
    for (const p of TECHNICAL_WHITELIST_PHRASES) {
      const live = EVALUATIVE_WORDS.some(w =>
        new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(p));
      expect(live).toBe(true);
    }
  });
  test('setiap entri whitelist dinetralkan sepenuhnya', () => {
    for (const p of TECHNICAL_WHITELIST_PHRASES) {
      expect(findEvaluativeWords(`Hasilnya ${p} sekali`)).toEqual([]);
    }
  });
});

describe('ASSESSMENT VALIDATOR: idiom angka/pendekatan', () => {
  test('idiom "kurang lebih" dinetralkan', () => {
    expect(findEvaluativeWords('hasilnya kurang lebih mirip')).toEqual([]);
  });
  test('"kurang dari" (perbandingan angka) dinetralkan', () => {
    expect(findEvaluativeWords('Harga kurang dari 3 juta')).toEqual([]);
    expect(V('MEASUREMENT', null, 'Waktu isi daya kurang dari 1 jam', '').status).toBe('PASS');
  });
  test('"kurang" di luar idiom tetap tertangkap meski ada idiom di kalimat yang sama', () => {
    expect(findEvaluativeWords('kurang lebih mirip, tapi HDR kurang konsisten')).toEqual(['kurang']);
    expect(findEvaluativeWords('harga kurang dari 3 juta, tapi layar kurang terang')).toEqual(['kurang']);
  });
  test('"agak" saja bukan kata evaluatif', () => {
    expect(V('OBSERVATION', null, 'Bagian belakang agak hitam', '').status).toBe('PASS');
  });
  test('penilaian sungguhan setelah "agak" tetap tertangkap lewat kata lain', () => {
    const r = V('OBSERVATION', null, 'Hasilnya agak jelek', '');
    expect(r.status).toBe('SUSPECT');
    expect(r.reason).toContain('"jelek"');
  });
});

// ============================================================
// BAGIAN 5 — karakterisasi pemicu pada data nyata
// ============================================================
// Catatan: pencocokan kata pemicu memakai toContain pada reason (bukan
// kesamaan persis), supaya penambahan leksikon tidak merusak tes yang status-nya
// tidak berubah. Daftar kata persis hanya dikunci lewat findEvaluativeWords.
type Row = {
  id: string;
  type: string;
  claim: string;
  excerpt: string;
  words: string[];
  note: 'wajar' | 'campuran' | 'bukan-penilaian';
};

// 3 video pertama (audit 8 run). Tetap SUSPECT; severity LOW karena OBSERVATION.
const ROWS_SUSPECT: Row[] = [
  { id: 'V2r2-Q002', type: 'OBSERVATION', note: 'wajar',
    claim: 'Performa frame rate Mobile Legends stabil di 60 fps saat dimainkan beberapa kali',
    excerpt: 'Dan 60 fps-nya tuh gak cuma cakep di awal-awal doang ya. Ini dipake main beberapa kali juga masih stabil di 60 fps, gak bakal turun atau gak bakal goyang.',
    words: ['cakep'] },
  { id: 'V2r2-Q006', type: 'OBSERVATION', note: 'wajar',
    claim: 'HDR masih kurang konsisten',
    excerpt: 'Cuma HDR-nya aja sih yang masih kurang konsisten',
    words: ['kurang'] },
  { id: 'V2r2-Q008', type: 'OBSERVATION', note: 'wajar',
    claim: 'Perekaman video sambil jalan dengan kamera depan berasa cukup stabil',
    excerpt: 'Ini saya pake rekam sambil jalan tuh masih berasa cukup stabil',
    words: ['cukup', 'cukup stabil'] },
  { id: 'V2r1-Q001', type: 'OBSERVATION', note: 'wajar',
    claim: 'Tingkat kecerahan layar masih sangat memadai saat digunakan di luar ruangan',
    excerpt: 'dan dipake di luar ruangan juga masih nampol banget brightness-nya.',
    words: ['memadai'] },
  { id: 'V1r1-Q003', type: 'OBSERVATION', note: 'wajar',
    claim: 'Mobile Legends dapat dimainkan dengan setting grafis Ultra 90 fps',
    excerpt: 'Setting grafis yang terbuka di sini sampai Ultra 90 fps. Ini sudah mantap, sudah lumayan. Dan saat dimainkan, game ini bisa jalan lancar di 90 fps',
    words: ['mantap'] },
  { id: 'V2r2-Q007', type: 'OBSERVATION', note: 'campuran',
    claim: 'Foto malam masih aman dan OIS membantu menjaga kamera tetap stabil pada kondisi minim cahaya',
    excerpt: 'Terus buat foto-foto malem juga masih aman ya, di sini OIS-nya tuh ngebantu banget buat ngejagain kameranya tetep stabil pas ngebagiin momen yang cahayanya kurang',
    words: ['kurang', 'minim'] },
];

// Dari replay run SqmQtAFjIW8 dan kwoPr9769gc (hanya klaim yang tampil utuh di
// keluaran replay; excerpt dikosongkan). Dulu semuanya dikarantina (SUSPECT HIGH).
const ROWS_REAL_2: Row[] = [
  { id: 'S-c2#7', type: 'OBSERVATION', note: 'wajar', claim: 'Layar cukup responsif', excerpt: '', words: ['cukup'] },
  { id: 'S-c2#8', type: 'OBSERVATION', note: 'wajar', claim: 'Coatingan layar berasa kurang licin', excerpt: '', words: ['kurang'] },
  { id: 'S-c2#26', type: 'OBSERVATION', note: 'wajar', claim: 'Fitur kamera cukup banyak', excerpt: '', words: ['cukup'] },
  { id: 'S-c2#51', type: 'OBSERVATION', note: 'wajar', claim: 'Samsung Galaxy A26 5G membawa konektivitas yang cukup lengkap', excerpt: '', words: ['cukup'] },
  { id: 'S-c2#57', type: 'OBSERVATION', note: 'campuran', claim: 'Speed untuk pindah data USB Type-C tergolong biasa saja', excerpt: '', words: ['tergolong'] },
  { id: 'S-c2#1', type: 'OBSERVATION', note: 'campuran', claim: 'Pengujian Mobile Legends menunjukkan handphone tergolong aman', excerpt: '', words: ['tergolong'] },
  { id: 'S-c2#9', type: 'RECOMMENDATION', note: 'campuran', claim: 'Disarankan menggunakan screen guard yang agak bagus', excerpt: '', words: ['bagus'] },
  { id: 'S-c2#58', type: 'RECOMMENDATION', note: 'campuran', claim: 'Pengguna akan mendapatkan layar bagus Super AMOLED', excerpt: '', words: ['bagus'] },
  // Dulu lolos diam-diam (kebocoran discourse "cukup untuk"); sekarang ditandai. Ini penilaian kecukupan.
  { id: 'S-c2#60', type: 'RECOMMENDATION', note: 'wajar', claim: 'Performa cukup untuk kebutuhan harian', excerpt: '', words: ['cukup'] },
];

describe('ASSESSMENT VALIDATOR: penilaian sungguhan tetap ditandai (karakterisasi)', () => {
  test.each([...ROWS_SUSPECT, ...ROWS_REAL_2])('$id [$note] -> SUSPECT LOW dengan kata pemicu', row => {
    const r = V(row.type, null, row.claim, row.excerpt);
    expect(r.status).toBe('SUSPECT');
    expect(r.severity).toBe('LOW');          // diterima + flag, tidak lagi dikarantina
    expect(findEvaluativeWords(row.claim + ' ' + row.excerpt).sort()).toEqual([...row.words].sort());
    for (const w of row.words) expect(r.reason).toContain(`"${w}"`);
  });
});

// Dulu SUSPECT karena 'agak' / "kurang lebih"; sekarang PASS.
const ROWS_NOW_PASS: Row[] = [
  { id: 'V2r2-Q004', type: 'RECOMMENDATION', note: 'bukan-penilaian',
    claim: 'Disarankan memasang kipas atau fan cooler untuk penggunaan agak lama',
    excerpt: 'Jadi, kalau pengen mainnya agak lamaan, mending saran saya sih pasangin kipas aja atau fan cooler',
    words: [] },
  { id: 'V2r3-Q005', type: 'RECOMMENDATION', note: 'bukan-penilaian',
    claim: 'Disarankan memasang kipas atau fan cooler jika ingin bermain agak lama',
    excerpt: 'mending saran saya sih pasangin kipas aja atau fan cooler',
    words: [] },
  { id: 'V2r2-Q009', type: 'OBSERVATION', note: 'bukan-penilaian',
    claim: 'Bagian belakang agak hitam dikit saat diarahkan ke backlight dan tidak highlight di muka',
    excerpt: 'Kalau diarahin ke backlight, belakang agak hitam dikit sih, enggak yang highlight yang lebih di muka',
    words: [] },
  { id: 'V2r3-Q010', type: 'OBSERVATION', note: 'bukan-penilaian',
    claim: 'Saat diarahkan ke backlight, bagian belakang agak hitam dikit dan bukan highlight yang lebih di muka',
    excerpt: 'Kalau diarahin ke backlight, belakang agak hitam dikit sih, enggak yang highlight yang lebih di muka',
    words: [] },
  { id: 'V1r1-Q008', type: 'OBSERVATION', note: 'bukan-penilaian',
    claim: 'Video kamera utama pada resolusi 4K 30 fps memiliki hasil yang kurang lebih mirip seperti di FHD60',
    excerpt: 'Sementara di 4K 30 fps, hasilnya juga kurang lebih mirip seperti di FHD60 tadi',
    words: [] },
  { id: 'V1r4-Q007', type: 'OBSERVATION', note: 'bukan-penilaian',
    claim: 'Hasil video 4K 30 fps mirip seperti di FHD60',
    excerpt: 'Sementara di 4K 30 fps, hasilnya juga kurang lebih mirip seperti di FHD60 tadi',
    words: [] },
  { id: 'V1r1-Q014', type: 'MEASUREMENT', note: 'bukan-penilaian',
    claim: 'Penggunaan TikTok selama setengah jam pada mode 120Hz mengurangi baterai sebanyak 5%',
    excerpt: 'Untuk TikTok selama setengah jam, ini agak berbeda. Di mode 120Hz baterai berkurang 5% selama setengah jam',
    words: [] },
];

describe('ASSESSMENT VALIDATOR: bukan penilaian -> PASS', () => {
  test.each(ROWS_NOW_PASS)('$id [$note] -> PASS', row => {
    const r = V(row.type, null, row.claim, row.excerpt);
    expect(r.status).toBe('PASS');
    expect(findEvaluativeWords(row.claim + ' ' + row.excerpt)).toEqual([]);
  });
});

// ============================================================
// BAGIAN 6 — celah yang sudah diketahui (test.fails = harus gagal sekarang)
// ============================================================
// Jika celah ditutup, tes di bawah mulai LOLOS dan test.fails melaporkan
// kegagalan; saat itu pindahkan ke bagian biasa.
describe('ASSESSMENT VALIDATOR: celah yang diketahui', () => {
  test.fails('kata evaluatif di luar leksikon (nyaman/aman/enak) seharusnya ditandai', () => {
    const r = V('OBSERVATION', null,
      'Kamera terasa nyaman dan aman dipakai harian',
      'Kameranya enak banget dan nyaman');
    expect(r.status).toBe('SUSPECT');
  });
});

describe('ASSESSMENT VALIDATOR: celah yang diketahui (false positive, hanya flag)', () => {
  // Dari replay 07DQ9c 2:26 (klaim asli terpotong di keluaran replay). "Cukup" di awal
  // kalimat di sini berarti "cukup dengan / tinggal", bukan penilaian. Tidak dinetralkan
  // sengaja: "Cukup memuaskan" / "Cukup stabil" di awal klaim adalah penilaian sungguhan,
  // dan awalan kata kerja (me-/ber-) tidak bisa membedakannya. Biaya flag keliru kecil
  // (tidak memblokir); biaya penilaian yang terlewat lebih besar.
  test.fails('"Cukup melakukan ..." (= "tinggal/cukup dengan") seharusnya bukan penilaian', () => {
    const r = V('RECOMMENDATION', null, 'Cukup melakukan pengisian daya 1 kali dalam sehari', '');
    expect(r.status).toBe('PASS');
  });
});

describe('ASSESSMENT VALIDATOR: versi aturan', () => {
  test('label versi (naikkan bersama perubahan perilaku + catat di riwayat versi)', () => {
    expect(ASSESSMENT_RULES_VERSION).toBe('assessment-v2.1');
  });
});
