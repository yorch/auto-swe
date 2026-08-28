-- ----------------------------------------------------------------------------
-- Organization-level budget alert threshold. When set, the admin budget view
-- and any downstream consumers can warn once monthly spend crosses the
-- configured percentage of the monthly cap.
-- ----------------------------------------------------------------------------

ALTER TABLE "organizations"
    ADD COLUMN IF NOT EXISTS "budget_alert_threshold_percent" INTEGER NULL,
    ADD CONSTRAINT "chk_organizations_budget_alert_threshold_percent"
        CHECK ("budget_alert_threshold_percent" IS NULL
               OR ("budget_alert_threshold_percent" >= 0 AND "budget_alert_threshold_percent" <= 100));
