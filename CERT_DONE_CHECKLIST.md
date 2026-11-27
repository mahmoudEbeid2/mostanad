# Certificates: definition of done + automatic acceptance test

The certificates feature is **DONE** when every scenario below passes on production. Anything new found after that goes to `BACKLOG.md` and does not block.

- **The test:** `scripts/acceptance/certificates.mjs`. It prints PASS / FAIL per scenario.
- **Run it** after every certificates-related deploy: `bash scripts/acceptance/run-prod.sh`.
- **A FAIL blocks** the "done" report.
- **Where it runs:** on production, against ADDVET, with the client's real files from `fixtures/addvet/` (not in git; see its README).
- **Cleanup:** everything the run creates is deleted at the end by the ids it recorded, and the numbering counters go back to their values before the run.

| # | Scenario | Pass when |
|---|---|---|
| 1 | Chat drop of COC + COA + HC + MO + invoice with «شهادات» | Goes to Express by code; one request; products = exactly the MO's products **and packs** (no extra pack) |
| 2 | Same drop again within 24 h | Reuses the same request; no new duplicate drafts |
| 3 | COC of every product | 0 blanks; composition identical to the source page (names, amounts, order, "ad 1 L", "Quantity not stated"); basis only when the source page prints one |
| 4 | COC render | No overflow / shrunk flags on amounts; no stray ":" |
| 5 | COA of every product | Blanks are only lab results + batch size (+ Sterility / Pyrogen for injectables); production / expiry dates and batch number filled **with source file + page** |
| 6 | COA content | No result printed from the sample; no result word inside a spec; results column shows amounts, not names |
| 7 | One-line answer «PRODUCT حجم 240 KG — Appearance Conforms, Identification Positive, pH 5.2, assay 99%» | All values filled, batch size keeps its unit |
| 8 | pH outside spec | Warning in the card; finalize refused without a comment |
| 9 | HC | One HC for the shipment; product rows = the request's products; consignee taken from the MO / invoice covering the shipment (never the sample's); exporter from the company |
| 10 | FSC (template not ready) | No FSC made; the card and the matrix say "FSC template isn't ready", in the UI language |
| 11 | Request from names «OLIGOVET 100ML / OLIGOVET 1L / addhepa» | 100ML matched; 1L offered as a new pack; lowercase matched |
| 12 | Numbering | Drafts take no number; finalize gives the next number with no gap and no repeat; COC / COA restart monthly; delete the test finals afterwards and reset the counters |
| 13 | Review chain | draft → in review → approved → final; edit after final → revision 2, and revision 1 stays read-only |
| 14 | Deep link with another company selected | Opens and switches company |

## How each scenario is checked

- **#1:** the 5-file drop goes through the app's services as the admin user. The card's suggestions are accepted, as with «اقبل الاقتراحات», and «طلّع الشهادات» is pressed. The request's lines are compared with the MO's 10 lines, product and pack.
- **#3:** each COC draft's composition rows are found, in order, on that product's page of the dropped COC file.
- **#7, #8:** these use the chat's real model (the one-line answer), then the card's button.
- **#11:** if ADDVET already has an OLIGOVET 1 L product, "1L" must match that pack. Otherwise it must be offered as a new pack.
- **#14:** the API the pages rely on (`/entity-company`) is checked. The switch itself is `useFollowEntityCompany` on the request and certificate pages.

Out of scope, not blocking:
- the FSC engine fix (separate task);
- the UI / language plan;
- pack variants as one product (UI plan).
