# Backlog: certificates (does not block CERT_DONE_CHECKLIST.md)

- **ADDVET COC page 6:** it prints the trade name "ADD-E120" over a multivitamin composition. Page 5 is the real ADD-E120 (vitamin E plus selenium). The drop's card suggests AMINOVITA, which matches the COA's page order. Ask the client to correct the file.
- **MO notes column:** MADADD2610001 marks H-DURIN, CURCUMARIN and ADDHEPA as "BAHRAIN" in its notes, while the shipment's customer is in Oman. Find out whether these go to another consignee.
- **Origin chip:** a value filled from a document (origin `document`, with file and page) has no chip of its own in the certificate editor yet. The provenance is stored.
- **Matrix languages:** request-matrix reasons other than "template not ready" are still Arabic only (UI plan, Phase B).
- **Flaky in the full suite:** `tests/assistant.actions.test.js` and `tests/certificates-v2/a3.matching.test.js` fail only when the whole suite runs, and pass alone (twice each, 27 Nov). `assistant.actions` fails at "the progress comes from the existing task; done when it completes", which looks like a race with the invoice worker over the same task. The cause of a3's failure is not found yet.
