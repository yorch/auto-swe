-- A launch's label is what lists show as the request's title, but it lived only
-- inside request_payload, so a text search could not reach it. Generate it as its
-- own column: every launch path and every existing row gets it, and nothing
-- writes it. The trim and the 200-character cut match what the gateway shows.
-- Prisma's DSL cannot express a generated column; the schema declares it as a
-- plain optional field, which is how it introspects.
ALTER TABLE "run_inputs" ADD COLUMN "title" TEXT GENERATED ALWAYS AS (
  CASE
    WHEN "request_payload" IS JSON OBJECT
      AND jsonb_typeof(("request_payload")::jsonb -> 'label') = 'string'
    THEN NULLIF(
      left(regexp_replace(("request_payload")::jsonb ->> 'label', '^\s+|\s+$', '', 'g'), 200),
      ''
    )
  END
) STORED;
