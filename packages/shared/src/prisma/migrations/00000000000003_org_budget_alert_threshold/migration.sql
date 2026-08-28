-- ----------------------------------------------------------------------------
-- Organization-level budget alert threshold. When set, the admin budget view
-- and any downstream consumers can warn once monthly spend crosses the
-- configured percentage of the monthly cap.
-- ----------------------------------------------------------------------------

ALTER TABLE "organizations"
    ADD COLUMN IF NOT EXISTS "budget_alert_threshold_percent" INTEGER NULL;
