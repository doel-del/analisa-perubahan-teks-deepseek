import { describe, test, expect } from 'vitest';
import { AtomicityValidator } from '../atomicity';

const V = AtomicityValidator.validate;
const blocks = (c: string) => {
  const r = V(c);
  return r.status === 'SUSPECT' && r.severity === 'HIGH';
};

// ============================================================
// BAGIAN 1 — test asli (tidak diubah)
// ============================================================
describe('ATOMICITY VALIDATOR', () => {
  test('PASS: single proposition', () => {
    expect(V('Refresh rate 120Hz').status).toBe('PASS');
  });
  test('PASS: configurative compound', () => {
    expect(V('Samsung Knox lengkap dengan Knox Vault').status).toBe('PASS');
  });
  test('PASS: camera configuration', () => {
    expect(V('kamera 50 MP f/1.8 autofocus').status).toBe('PASS');
  });
  test('SUSPECT: multi-property', () => {
    expect(V('RAM 8 GB dan storage 256 GB').status).toBe('SUSPECT');
  });
  test('SUSPECT: two independent facts', () => {
    expect(V('NFC dan USB OTG').status).toBe('SUSPECT');
  });
});

// ============================================================
// BAGIAN 2 — severity (aturan inti: HIGH memblokir, MEDIUM hanya menandai)
// ============================================================
describe('ATOMICITY VALIDATOR: severity', () => {
  test('HIGH: dua properti berlabel dengan angka', () => {
    expect(blocks('RAM 8 GB dan storage 256 GB')).toBe(true);
  });
  test('HIGH: tiga spesifikasi dalam comma-list', () => {
    expect(blocks('RAM 8 GB, storage 256 GB, dan baterai 5000 mAh')).toBe(true);
  });
  test('MEDIUM (tidak memblokir): daftar fitur tanpa angka', () => {
    const r = V('NFC dan USB OTG');
    expect(r.severity).toBe('MEDIUM');
    expect(r.pass).toBe(true);
  });
  test('MEDIUM: "atau" untuk multi-value = alternatif penulisan', () => {
    const r = V('Kamera utama dapat merekam video hingga resolusi 4K 30fps atau Full HD 60fps');
    expect(r.severity).toBe('MEDIUM');
  });
});

// ============================================================
// BAGIAN 3 — rentang dihitung SATU nilai (data nyata, 15 video)
// ============================================================
describe('ATOMICITY VALIDATOR: rentang = satu nilai', () => {
  test.each([
    ['Frame rate Wuthering Waves setelah 10 menit mengalami penurunan di kisaran 30 hingga 45 fps'],
    ['Frame rate Genshin Impact pada 10 menit terakhir saat menggunakan kipas berada di sekitar 30 hingga 40 fps'],
    ['Pada rentang harga 3 hingga 4 juta, HP Infinix atau Poco dinilai menawarkan spesifikasi yang lebih menggiurkan dan ugal-ugalan'],
    ['Jarak antara handphone dan muka saat perekaman kamera depan adalah sekitar 40 sampai ke 50 cm'],
    ['Frame rate 30–45 fps pada game berat']
  ])('tidak memblokir: %s', claim => {
    expect(blocks(claim)).toBe(false);
  });
  test('satuan di antara rentang: "30 fps hingga 45 fps"', () => {
    expect(blocks('Frame rate berada di 30 fps hingga 45 fps pada game berat')).toBe(false);
    expect(blocks('Frame rate 30 fps - 45 fps')).toBe(false);
  });
  test('rentang GB/MB SENGAJA bukan rentang (lebih mungkin dua spek)', () => {
    expect(blocks('Penyimpanan 8 hingga 256 GB dan RAM 8 GB')).toBe(true);
  });
  test('rentang + spesifikasi lain tetap compound', () => {
    expect(blocks('Frame rate 30 hingga 45 fps dan baterai 5000 mAh')).toBe(true);
  });
});

// ============================================================
// BAGIAN 4 — "setting X dan frame rate Y" = kondisi uji (N3b)
// ============================================================
describe('ATOMICITY VALIDATOR: konfigurasi uji + satu nilai ukur', () => {
  test.each([
    ['Frame rate rata-rata Mobile Legends pada setting Ultra dan frame rate Super adalah 88,4 fps'],
    ['Frame rate rata-rata PUBG Mobile pada setting Smooth dan frame rate Extreme adalah 59 fps'],
    ['Frame rate rata-rata Call of Duty Mobile pada setting low dan frame rate max adalah 59,8 fps'],
    ['Frame rate rata-rata Free Fire pada setting ultra dan frame rate high adalah 59,4 fps'],
    ['Frame rate rata-rata game Hauka pada setting ultra dan frame rate ultra adalah 92,8 fps'],
    ['Frame rate rata-rata FC Mobile pada setting high dan frame rate high adalah 60 fps'],
    ['Frame rate rata-rata Genshin Impact pada setting lowest dan frame rate 60 adalah 49 fps']
  ])('PASS bersih: %s', claim => {
    expect(V(claim).status).toBe('PASS');
  });
  test('compound lain di klaim yang sama tetap tertangkap (" dan suhu ...")', () => {
    expect(blocks('Performa pada setting Ultra dan frame rate Super adalah 50 fps dan suhu 38 derajat')).toBe(true);
  });
  test('fragmen konfigurasi tidak boleh menelan " dan " lain', () => {
    expect(blocks('Performa pada setting Ultra dan suhu 38 derajat dan frame rate Super adalah 50 fps')).toBe(true);
  });
  test('comma-list tersisa di luar fragmen konfigurasi tetap tertangkap', () => {
    expect(blocks('Pada setting Ultra dan frame rate Super hasilnya 50 fps, baterai 5000 mAh, layar 6,7 inci')).toBe(true);
  });
});

// ============================================================
// BAGIAN 5 — karakterisasi 9 karantina ATOMICITY yang tersisa (replay 15 video)
// ============================================================
// Penilaian manual (satu penilai). Yang sah tetap memblokir; yang salah
// ditandai test.fails: jika kelak aturan diperbaiki, test.fails melaporkan
// kegagalan dan tes dipindah ke bagian "tidak memblokir".
describe('ATOMICITY VALIDATOR: karantina tersisa, yang sah', () => {
  test('performa + suhu + protokol uji dalam satu klaim (compound sungguhan)', () => {
    expect(blocks('Performa gaming PUBG Mobile pada Galaxy A26 sangat lancar dan stabil dengan suhu maksimal 37 derajat Celsius pada settingan smooth extreme selama 30 menit')).toBe(true);
  });
  test('versi Android dan versi One UI (dua fakta)', () => {
    expect(blocks('Samsung Galaxy A26 mendapatkan jaminan update hingga Android 21 dan One UI versi 13')).toBe(true);
  });
});

// Empat klaim di bawah ini DIBLOKIR oleh aturan saat ini. Apakah itu benar atau
// false positive adalah KEPUTUSAN KEBIJAKAN yang masih terbuka (predikat bersama /
// daftar nilai numerik: satu proposisi atau beberapa?). Test ini mengunci perilaku
// SAAT INI agar perubahan kebijakan terlihat sebagai perubahan test, bukan kejutan.
// Jika kebijakan diputuskan "MEDIUM saja", ubah ekspektasi menjadi false.
describe('ATOMICITY VALIDATOR: perilaku saat ini, kebijakan terbuka', () => {
  test.each([
    'Reviewer menilai daya tahan baterai 25 jam pada 60 Hz sangat memuaskan',
    'Lensa ultrawide tidak tersedia pada perekaman video 4K 30 fps dan Full HD 60 fps',
    'Kamera utama dapat merekam video hingga resolusi 4K 30fps dan Full HD 60fps',
    'Video 1080p 60 fps mengalami penurunan detail, peningkatan noise, dan tampilan lebih gelap'
  ])('HIGH (saat ini): %s', c => {
    expect(V(c).severity).toBe('HIGH');
  });
  // Catatan konsistensi: dua efek ("penurunan detail dan noise") = MEDIUM, tiga efek = HIGH
  // karena angka "1080p 60 fps" ikut terhitung; "atau" = MEDIUM, "dan" = HIGH.
  test('konsistensi: "atau" MEDIUM vs "dan" HIGH pada daftar mode yang sama', () => {
    expect(V('Lensa ultrawide tidak tersedia pada video 4K 30 fps atau Full HD 60 fps').severity).toBe('MEDIUM');
  });
});

// ============================================================
// BAGIAN 6 — test dari implementasi pengguna (dipertahankan)
// ============================================================
describe('ATOMICITY VALIDATOR: rentang tanpa blokir (kasus pengguna)', () => {
  test.each([
    'Pada rentang harga 3 hingga 4 juta, HP Infinix atau Poco dinilai menawarkan spesifikasi yang lebih menggiurkan dan ugal-ugalan',
    'Jarak antara handphone dan muka saat perekaman kamera depan adalah sekitar 40 sampai ke 50 cm'
  ])('MEDIUM (diterima + flag): %s', c => {
    const r = V(c);
    expect(r.status).toBe('SUSPECT');
    expect(r.severity).toBe('MEDIUM');
  });
  // Klaim asli memuat typo "30hingga" (tanpa spasi); sengaja dipertahankan.
  test.each([
    'Frame rate Wuthering Waves setelah 10 menit mengalami penurunan di kisaran 30hingga 45 fps',
    'Frame rate Genshin Impact pada 10 menit terakhir saat menggunakan kipas berada di sekitar 30 hingga 40 fps',
    'Frame rate rata-rata Genshin Impact pada setting lowest dan frame rate 60 adalah 49 fps'
  ])('PASS bersih: %s', c => expect(V(c).status).toBe('PASS'));
  test.each([
    'Frame rate rata-rata Mobile Legends pada setting Ultra dan frame rate Super adalah 88,4 fps',
    'Frame rate rata-rata Free Fire pada setting ultra dan frame rate high adalah 59,4 fps',
    'Frame rate rata-rata FC Mobile pada setting high dan frame rate high adalah 60 fps'
  ])('PASS bersih (preset, bukan angka): %s', c => expect(V(c).status).toBe('PASS'));
  test('guard: config + "dan suhu" tetap HIGH', () => {
    expect(V('Frame rate rata-rata PUBG pada setting smooth dan frame rate extreme adalah 59 fps dan suhu 38 derajat Celsius').severity).toBe('HIGH');
  });
  test('guard: bukan konfigurasi tetap HIGH', () => {
    expect(V('Refresh rate 120 Hz dan frame rate 60 fps').severity).toBe('HIGH');
  });
  test.each([
    'Kecerahan layar 400 sampai 800 nits dan refresh rate 120 Hz',
    'Refresh rate 60 hingga 120 Hz dan baterai 5000 mAh',
    'Harga 3 hingga 4 juta dan RAM 8 GB',
    'RAM 8 hingga 256 GB tersedia dan storage 128 GB'
  ])('guard rentang: tetap HIGH: %s', c => expect(V(c).severity).toBe('HIGH'));
  test('Android + One UI: dua fakta, HIGH', () => {
    expect(V('Samsung Galaxy A26 mendapatkan jaminan update hingga Android 21 dan One UI versi 13').severity).toBe('HIGH');
  });
});

describe('ATOMICITY VALIDATOR: celah recall (compound kualitatif tidak ditandai)', () => {
  test.fails('polaritas campuran dengan "tetapi" seharusnya ditandai', () => {
    expect(V('Suara speaker bisa keras tetapi pada volume tinggi mengalami distorsi').status).toBe('SUSPECT');
  });
});
