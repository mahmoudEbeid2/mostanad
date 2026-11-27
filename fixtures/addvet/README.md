# ADDVET acceptance fixtures (not committed)

`scripts/acceptance/certificates.mjs` drops these 5 files in the chat with «شهادات», as the client does.
They are ADDVET's real documents, so they stay out of git (`.gitignore`). Put them here before a run:

| File | What it is | Where it comes from |
|---|---|---|
| `ADDVET OMAN COC 10-26.pdf` | Certificates of Composition, 10 products | `ADDVET DATA.zip` |
| `ADDVET OMAN COA 10-26.pdf` | Certificates of Analysis, 10 products | `ADDVET DATA.zip` |
| `ADDVET HC OMAN 10-26.pdf` | Health certificate of the shipment | `ADDVET DATA.zip` |
| `MADADD2610001.pdf` | Manufacturing order: the shipment's 10 products, packs, batches, consignee | `ADDVET DATA.zip` |
| `BRN2025002 - ROSHAN.pdf` | An unrelated invoice (Pakistan) sent in the same batch: never the shipment | `ADDVET Catalogues & invoices.zip` |

Run: `bash scripts/acceptance/run-prod.sh` (copies them into the app container and runs the script there).
