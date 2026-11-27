-- 27 Nov (owner): a certificate type's sequence may restart every month ("COCAF{YY}0{MM}{SEQ3}": 010 in October
-- is October's 10th). Per company and type, on by default; seq_period is the month ("2026-11") last_seq counts
-- in — null for a counter set before this (it goes on in the month it is next used). Additive.
ALTER TABLE "numbering_schemes" ADD COLUMN "reset_monthly" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "numbering_schemes" ADD COLUMN "seq_period" TEXT;
