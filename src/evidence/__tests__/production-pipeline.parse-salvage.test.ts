import { describe, test, expect } from 'vitest';
import {
  parseEvidenceJSON,
  parseEvidenceJSONDetailed,
  normalizeNullishFields
} from '../production-pipeline';

// ============================================================
// Bentuk kerusakan NYATA dari output Gemini (video 07DQ9c6-KxA):
// kunci tanpa tanda kutip berawalan "_" di akhir item membuat JSON.parse
// menolak SELURUH respons, sehingga seluruh chunk hilang.
// ============================================================

const item = (n: number, tail = '      "related_evidence_ids": null') => `    {
      "evidence_id": "E00${n}",
      "claim": "Klaim ${n}",
      "source_excerpt": "kutipan ${n}",
${tail}
    }`;

const wrap = (...items: string[]) => `{\n  "evidence": [\n${items.join(',\n')}\n  ]\n}`;

describe('PARSER: strategi lama TIDAK berubah (regresi)', () => {
  const good = wrap(item(1), item(2));

  test('direct_object', () => {
    const r = parseEvidenceJSONDetailed(good);
    expect(r.status).toBe('SUCCESS');
    expect(r.strategy).toBe('direct_object');
    expect(r.evidence.length).toBe(2);
    expect(r.salvage).toBe(undefined);
  });

  test('direct_array', () => {
    const r = parseEvidenceJSONDetailed('[{"claim":"a"},{"claim":"b"}]');
    expect(r.strategy).toBe('direct_array');
    expect(r.evidence.length).toBe(2);
  });

  test('fenced', () => {
    const r = parseEvidenceJSONDetailed('```json\n' + good + '\n```');
    expect(r.strategy).toBe('fenced');
    expect(r.evidence.length).toBe(2);
  });

  test('evidence_key_scan (ada pembuka sebelum JSON)', () => {
    const r = parseEvidenceJSONDetailed('Berikut hasilnya:\n' + good);
    expect(r.strategy).toBe('evidence_key_scan');
    expect(r.evidence.length).toBe(2);
  });

  test('array_bracket_scan (ada teks setelah JSON)', () => {
    const r = parseEvidenceJSONDetailed(good + '\n\nCatatan: selesai.');
    expect(r.strategy).toBe('array_bracket_scan');
    expect(r.evidence.length).toBe(2);
  });
});

describe('PARSER: penyelamatan objek (object_salvage)', () => {
  test('A: kunci "_comment" tanpa kutip + kunci asli sesudahnya', () => {
    const raw = wrap(
      item(1, '      _comment: "Chipset Exynos 1380",\n      "related_evidence_ids": null'),
      item(2)
    );
    const r = parseEvidenceJSONDetailed(raw);
    expect(r.status).toBe('SUCCESS');
    expect(r.strategy).toBe('object_salvage');
    expect(r.evidence.length).toBe(2);
    expect(r.evidence[0]._comment).toBe(undefined);
    expect(r.evidence[0].claim).toBe('Klaim 1');
    expect(r.salvage?.recovered).toBe(2);
    expect(r.salvage?.repaired).toBe(1);
    expect(r.salvage?.skipped).toBe(0);
  });

  test('B: "_related_evidence_ids: null" menggantikan kunci asli', () => {
    const r = parseEvidenceJSONDetailed(wrap(item(1, '      _related_evidence_ids: null'), item(2)));
    expect(r.strategy).toBe('object_salvage');
    expect(r.evidence.length).toBe(2);
    expect(r.evidence[0].related_evidence_ids).toBe(null);
    expect(r.evidence[0]._related_evidence_ids).toBe(undefined);
  });

  test('C: "_related_evidence_ids: [..]" nilainya dipulihkan ke related_evidence_ids', () => {
    const r = parseEvidenceJSONDetailed(
      wrap(item(1, '      _related_evidence_ids: [\n        "E025"\n      ]'), item(2))
    );
    expect(r.strategy).toBe('object_salvage');
    expect(r.evidence[0].related_evidence_ids).toEqual(['E025']);
  });

  test('di dalam pagar kode juga diselamatkan', () => {
    const raw = '```json\n' + wrap(item(1, '      _related_evidence_ids: null'), item(2)) + '\n```';
    const r = parseEvidenceJSONDetailed(raw);
    expect(r.strategy).toBe('object_salvage');
    expect(r.evidence.length).toBe(2);
  });

  test('objek yang tak bisa diperbaiki dilewati, objek lain selamat', () => {
    const broken = `    {
      "evidence_id": "E002",
      "claim": "rusak parah ???,
      "source_excerpt": = = =
    }`;
    const r = parseEvidenceJSONDetailed(wrap(item(1), broken, item(3)));
    expect(r.strategy).toBe('object_salvage');
    expect(r.evidence.map(e => e.claim)).toEqual(['Klaim 1', 'Klaim 3']);
    expect(r.salvage?.skipped).toBe(1);
  });

  test('output terpotong di tengah objek: objek utuh sebelumnya selamat', () => {
    const full = wrap(item(1), item(2), item(3));
    const cut = full.slice(0, full.indexOf('"claim": "Klaim 3"') + 12);
    const r = parseEvidenceJSONDetailed(cut);
    expect(r.strategy).toBe('object_salvage');
    expect(r.evidence.length).toBe(2);
    expect(r.salvage?.truncated).toBe(true);
  });

  test('tanda kutip nyasar pada satu baris tidak merusak objek berikutnya', () => {
    const stray = item(2).replace('"Klaim 2"', '"Klaim "2"');
    const r = parseEvidenceJSONDetailed(wrap(item(1), stray, item(3)));
    expect(r.strategy).toBe('object_salvage');
    expect(r.evidence.map(e => e.claim)).toEqual(['Klaim 1', 'Klaim 3']);
  });

  test('parseEvidenceJSON (signature production) ikut menyelamatkan', () => {
    const items = parseEvidenceJSON(wrap(item(1, '      _related_evidence_ids: null'), item(2)));
    expect(items.length).toBe(2);
  });

  test('bukan JSON sama sekali tetap FAILED dan kosong', () => {
    const r = parseEvidenceJSONDetailed('Maaf, saya tidak bisa memproses permintaan ini.');
    expect(r.status).toBe('FAILED');
    expect(r.strategy).toBe(null);
    expect(r.evidence.length).toBe(0);
  });

  test('kunci "_" yang tidak dikenal dibuang, kunci lain yang tak dikenal dibiarkan', () => {
    const raw = wrap(
      item(1, '      _catatan: "x",\n      "kunci_baru": 5,\n      "related_evidence_ids": null'),
      item(2)
    );
    const r = parseEvidenceJSONDetailed(raw);
    expect(r.strategy).toBe('object_salvage');
    expect(r.evidence[0]._catatan).toBe(undefined);
    expect(r.evidence[0].kunci_baru).toBe(5);
  });
});

describe('NORMALISASI: string kosong / "null" -> null (kasus nyata: value "" + unit "null")', () => {
  test('value "" dan unit "null" menjadi null', () => {
    const ev: any = { claim: 'x', value: '', unit: 'null', reviewer_assessment: 'positive' };
    expect(normalizeNullishFields(ev)).toBe(2);
    expect(ev.value).toBe(null);
    expect(ev.unit).toBe(null);
    expect(ev.reviewer_assessment).toBe('positive');
  });

  test('placeholder unit "unit" (kasus lama) menjadi null, tetapi hanya pada field unit', () => {
    const ev: any = { claim: 'x', value: 'unit', unit: 'unit' };
    expect(normalizeNullishFields(ev)).toBe(1);
    expect(ev.unit).toBe(null);
    expect(ev.value).toBe('unit');
  });

  test('spasi dan huruf besar tidak mempengaruhi (" NULL ", "N/A", "None")', () => {
    const ev: any = { attribute: ' NULL ', context: 'N/A', comparison_target: 'None', reviewer_assessment: '' };
    expect(normalizeNullishFields(ev)).toBe(4);
    expect(ev.attribute).toBe(null);
    expect(ev.context).toBe(null);
    expect(ev.comparison_target).toBe(null);
    expect(ev.reviewer_assessment).toBe(null);
  });

  test('nilai sah tidak diubah (angka 0, "5000", "fps", null asli)', () => {
    const ev: any = { value: 0, unit: 'fps', attribute_value: '5000', context: null };
    expect(normalizeNullishFields(ev)).toBe(0);
    expect(ev.value).toBe(0);
    expect(ev.unit).toBe('fps');
    expect(ev.attribute_value).toBe('5000');
  });

  test('claim dan source_excerpt TIDAK disentuh', () => {
    const ev: any = { claim: 'null', source_excerpt: '' };
    expect(normalizeNullishFields(ev)).toBe(0);
    expect(ev.claim).toBe('null');
    expect(ev.source_excerpt).toBe('');
  });

  test('input bukan objek aman', () => {
    expect(normalizeNullishFields(null)).toBe(0);
    expect(normalizeNullishFields('x')).toBe(0);
    expect(normalizeNullishFields([1, 2])).toBe(0);
  });
});