import { describe, test, expect } from 'vitest';
import { AssessmentValidator, findEvaluativeWords } from '../assessment';

// ============================================================
// BAGIAN 1 — test asli (tidak diubah)
// ============================================================
describe('ASSESSMENT VALIDATOR', () => {
  test('PASS: FACT + null', () => {
    const result = AssessmentValidator.validate('FACT', null);
    expect(result.status).toBe('PASS');
  });

  test('PASS: OPINION + positive', () => {
    const result = AssessmentValidator.validate('OPINION', 'positive');
    expect(result.status).toBe('PASS');
  });

  test('PASS: OBSERVATION + null', () => {
    const result = AssessmentValidator.validate('OBSERVATION', null);
    expect(result.status).toBe('PASS');
  });

  test('FAIL: FACT + positive', () => {
    const result = AssessmentValidator.validate('FACT', 'positive');
    expect(result.status).toBe('FAIL');
  });

  test('FAIL: RECOMMENDATION + positive', () => {
    const result = AssessmentValidator.validate('RECOMMENDATION', 'positive');
    expect(result.status).toBe('FAIL');
  });

  test('FAIL: FACT + negative', () => {
    const result = AssessmentValidator.validate('FACT', 'negative');
    expect(result.status).toBe('FAIL');
  });
});

// ============================================================
// BAGIAN 2 — normalisasi input & wajib-assessment pada OPINION
// ============================================================
describe('ASSESSMENT VALIDATOR: normalisasi & OPINION wajib assessment', () => {
  test('FAIL: type huruf kecil dinormalisasi (fact + positive)', () => {
    const result = AssessmentValidator.validate('fact', 'positive');
    expect(result.status).toBe('FAIL');
  });

  test('PASS: assessment berisi spasi saja dianggap kosong', () => {
    const result = AssessmentValidator.validate('FACT', '   ');
    expect(result.status).toBe('PASS');
  });

  test('SUSPECT: OPINION tanpa assessment', () => {
    const result = AssessmentValidator.validate('OPINION', null);
    expect(result.status).toBe('SUSPECT');
  });

  test('SUSPECT: type tidak diisi dianggap OPINION, assessment kosong', () => {
    const result = AssessmentValidator.validate(undefined, null);
    expect(result.status).toBe('SUSPECT');
  });
});

// ============================================================
// BAGIAN 3 — non-OPINION yang mengandung kata evaluatif
// ============================================================
describe('ASSESSMENT VALIDATOR: kata evaluatif pada non-OPINION', () => {
  test('SUSPECT: kata evaluatif di klaim, reason menyebut kata pemicu', () => {
    const result = AssessmentValidator.validate('OBSERVATION', null, 'Layar terlihat bagus', '');
    expect(result.status).toBe('SUSPECT');
    expect(result.reason).toContain('"bagus"');
  });

  test('SUSPECT: kata evaluatif hanya di excerpt (klaim netral)', () => {
    const result = AssessmentValidator.validate(
      'OBSERVATION', null,
      'Frame rate stabil di 60 fps',
      'gak cuma cakep di awal-awal doang'
    );
    expect(result.status).toBe('SUSPECT');
  });

  test('PASS: word-boundary, "berkurang" bukan "kurang"', () => {
    const result = AssessmentValidator.validate(
      'MEASUREMENT', null,
      'Baterai berkurang 5%',
      'baterai berkurang 5% selama setengah jam'
    );
    expect(result.status).toBe('PASS');
  });

  test('PASS: frasa teknis di-whitelist ("minim noise")', () => {
    const result = AssessmentValidator.validate('OBSERVATION', null, 'Hasil foto minim noise', '');
    expect(result.status).toBe('PASS');
  });

  test('PASS: "cukup" sebagai discourse marker ("cukup kalian ...")', () => {
    const result = AssessmentValidator.validate('RECOMMENDATION', null, 'Cukup kalian pakai mode ini', '');
    expect(result.status).toBe('PASS');
  });

  test('findEvaluativeWords: mengembalikan semua kata yang cocok', () => {
    expect(findEvaluativeWords('terasa cukup stabil').sort()).toEqual(['cukup', 'cukup stabil']);
  });
});

// ============================================================
// BAGIAN 4 — karakterisasi pemicu pada quarantine nyata (2 video)
// ============================================================
// Mengunci perilaku SAAT INI, termasuk pemicu yang diduga salah
// (note: 'false-trigger'), supaya perubahan kebijakan di masa depan
// tampil sebagai diff di test ini.
type Row = {
  id: string;
  type: string;
  claim: string;
  excerpt: string;
  words: string[];
  note: 'wajar' | 'false-trigger' | 'campuran';
};

const ROWS: Row[] = [
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
  // --- diduga pemicu salah ---
  { id: 'V2r2-Q004', type: 'RECOMMENDATION', note: 'false-trigger',
    claim: 'Disarankan memasang kipas atau fan cooler untuk penggunaan agak lama',
    excerpt: 'Jadi, kalau pengen mainnya agak lamaan, mending saran saya sih pasangin kipas aja atau fan cooler',
    words: ['agak'] },
  { id: 'V2r2-Q009', type: 'OBSERVATION', note: 'false-trigger',
    claim: 'Bagian belakang agak hitam dikit saat diarahkan ke backlight dan tidak highlight di muka',
    excerpt: 'Kalau diarahin ke backlight, belakang agak hitam dikit sih, enggak yang highlight yang lebih di muka',
    words: ['agak'] },
  { id: 'V1r1-Q008', type: 'OBSERVATION', note: 'false-trigger',
    claim: 'Video kamera utama pada resolusi 4K 30 fps memiliki hasil yang kurang lebih mirip seperti di FHD60',
    excerpt: 'Sementara di 4K 30 fps, hasilnya juga kurang lebih mirip seperti di FHD60 tadi',
    words: ['kurang'] },
  { id: 'V1r1-Q014', type: 'MEASUREMENT', note: 'false-trigger',
    claim: 'Penggunaan TikTok selama setengah jam pada mode 120Hz mengurangi baterai sebanyak 5%',
    excerpt: 'Untuk TikTok selama setengah jam, ini agak berbeda. Di mode 120Hz baterai berkurang 5% selama setengah jam',
    words: ['agak'] },
  // --- campuran: pemicu deskriptif, tetapi isinya memang evaluatif ---
  { id: 'V2r2-Q007', type: 'OBSERVATION', note: 'campuran',
    claim: 'Foto malam masih aman dan OIS membantu menjaga kamera tetap stabil pada kondisi minim cahaya',
    excerpt: 'Terus buat foto-foto malem juga masih aman ya, di sini OIS-nya tuh ngebantu banget buat ngejagain kameranya tetep stabil pas ngebagiin momen yang cahayanya kurang',
    words: ['kurang', 'minim'] },
];

describe('ASSESSMENT VALIDATOR: pemicu pada quarantine nyata (karakterisasi)', () => {
  test.each(ROWS)('$id [$note] -> SUSPECT dengan kata pemicu', row => {
    const r = AssessmentValidator.validate(row.type, null, row.claim, row.excerpt);
    expect(r.status).toBe('SUSPECT');
    expect(findEvaluativeWords(row.claim + ' ' + row.excerpt).sort()).toEqual([...row.words].sort());
    for (const w of row.words) expect(r.reason).toContain(`"${w}"`);
  });
});

// ============================================================
// BAGIAN 5 — celah yang sudah diketahui (jangan dianggap benar)
// ============================================================
describe('ASSESSMENT VALIDATOR: celah yang diketahui', () => {
  test('kata evaluatif di luar leksikon lolos (nyaman/aman/enak)', () => {
    const r = AssessmentValidator.validate(
      'OBSERVATION', null,
      'Kamera terasa nyaman dan aman dipakai harian',
      'Kameranya enak banget dan nyaman'
    );
    expect(r.status).toBe('PASS');
  });

  test('whitelist frasa teknis meloloskan SELURUH teks, termasuk kata evaluatif lain', () => {
    const r = AssessmentValidator.validate(
      'OBSERVATION', null,
      'Hasil foto minim noise dan sangat mantap',
      'hasilnya minim noise dan mantap banget'
    );
    expect(r.status).toBe('PASS'); // seharusnya SUSPECT jika kebocoran ini diperbaiki
  });
});