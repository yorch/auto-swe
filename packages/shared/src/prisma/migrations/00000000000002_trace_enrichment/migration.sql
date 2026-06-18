-- Migration: trace_enrichment
-- Adds per-record model/token/cost attribution to agent_traces,
-- token totals to workflow_runs, and lesson lineage to memory_items.

-- agent_traces: per-LLM-call attribution + OTel correlation
ALTER TABLE agent_traces ADD COLUMN model TEXT;
ALTER TABLE agent_traces ADD COLUMN input_tokens INTEGER;
ALTER TABLE agent_traces ADD COLUMN output_tokens INTEGER;
ALTER TABLE agent_traces ADD COLUMN cost_usd DOUBLE PRECISION;
ALTER TABLE agent_traces ADD COLUMN otel_trace_id TEXT;
ALTER TABLE agent_traces ADD COLUMN otel_span_id TEXT;

-- workflow_runs: total token counts (populated by finalizeWorkflowRun)
ALTER TABLE workflow_runs ADD COLUMN tokens_input_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs ADD COLUMN tokens_output_total INTEGER NOT NULL DEFAULT 0;

-- memory_items: lesson lineage (which run/agent/model produced this lesson)
ALTER TABLE memory_items ADD COLUMN workflow_run_id UUID REFERENCES workflow_runs(id);
ALTER TABLE memory_items ADD COLUMN agent_key TEXT;
ALTER TABLE memory_items ADD COLUMN model TEXT;
ALTER TABLE memory_items ADD COLUMN cost_usd DOUBLE PRECISION;
