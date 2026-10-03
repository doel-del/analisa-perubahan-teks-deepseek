src/evidence/harness/
├── extraction-harness.ts
├── fixtures/
│   ├── chunk-failure-001.txt      ← E.1 existing
│   ├── chunk-failure-002.txt      ← E.1 existing
│   ├── chunk-failure-003.txt      ← E.1 existing
│   ├── failure-reg-001.txt        ← E046: cooling system + "..."
│   ├── failure-reg-002.txt        ← E301: FACT + assessment
│   ├── failure-reg-003.txt        ← E330: compound 8/256
│   ├── failure-reg-004.txt        ← E053: paraphrased excerpt
│   ├── failure-reg-005.txt        ← E023: cross-chunk excerpt
│   └── failure-reg-006.txt        ← E313: paraphrased excerpt
├── corpus/
│   └── manifest.json
└── output/
    └── ...

1. Buat file fixture:
   - failure-reg-001.txt (E046 — cooling system)
   - failure-reg-002.txt (E301 — FACT + assessment)
   - failure-reg-003.txt (E330 — compound 8/256)
   - failure-reg-004.txt (E053 — excerpt integrity)
   - failure-reg-005.txt (E023 — cross-chunk integrity)
   - failure-reg-006.txt (E313 — excerpt integrity)

2. Buat corpus/manifest.json dengan case_id:
   - REG-001A → failure-reg-001.txt
   - REG-001B → failure-reg-004.txt
   - REG-001C → failure-reg-006.txt
   - REG-002  → failure-reg-002.txt
   - REG-003  → failure-reg-003.txt
   - REG-004  → failure-reg-005.txt

3. Update extraction-harness.ts untuk membaca manifest.json
   dan menjalankan 3× replay per case.

4. Jalankan:
   npx tsx src/evidence/harness/extraction-harness.ts

5. Kirimkan:
   - Terminal log lengkap
   - Untuk setiap case × replay:
     * parsed evidence count
     * claim
     * type
     * value
     * unit
     * reviewer_assessment
     * source_excerpt
   - Jika ada perbedaan antar replay, tampilkan semuanya.

## E.3 Harness Validation Layer
src/evidence/harness/
├── regression-validator.ts   ← BARU
├── corpus/
│   └── manifest.json         ← UPDATE
└── output/
    └── regression-report.json ← OUTPUT BARU

**run*
npx tsx src/evidence/harness/regression-validator.ts

##  E.3D reproducibility-harness.ts
### Cara Menjalankan
npx tsx src/evidence/harness/reproducibility-harness.ts

### Output

src/evidence/harness/output/reproducibility/
├── REG-001B/
│   ├── run-01.json
│   ├── run-02.json
│   ├── run-03.json
│   ├── run-04.json
│   ├── run-05.json
│   └── summary.json
└── REG-002/
    ├── run-01.json
    ├── run-02.json
    ├── run-03.json
    ├── run-04.json
    ├── run-05.json
    └── summary.json