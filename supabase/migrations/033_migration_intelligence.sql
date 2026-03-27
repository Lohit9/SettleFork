-- ============================================================
-- Migration 033: Migration Intelligence
-- Stores generalizable patterns learned from completed migrations.
-- Patterns are injected into Claude prompts to improve future
-- mapping and transformation suggestions over time.
-- Run in Supabase SQL Editor
-- ============================================================

CREATE TABLE migration_intelligence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,

    -- Pattern category
    category TEXT NOT NULL CHECK (category IN (
        'transformation_recipe',
        'data_quality_pattern',
        'domain_knowledge',
        'source_system_hint'
    )),

    -- Human-readable label
    title TEXT NOT NULL,

    -- The actual text injected into Claude prompts as reference context
    pattern_description TEXT NOT NULL,

    -- Structured metadata about the pattern
    pattern_config JSONB NOT NULL DEFAULT '{}',

    -- Confidence score (0-1). Increases when confirmed across multiple projects.
    -- Patterns below 0.4 are excluded from prompt injection.
    confidence NUMERIC NOT NULL DEFAULT 0.5
        CHECK (confidence >= 0 AND confidence <= 1),

    -- How many completed projects contributed to this pattern
    times_seen INT NOT NULL DEFAULT 1,

    -- How many times the pattern was used and the user APPROVED the result
    times_confirmed INT NOT NULL DEFAULT 0,

    -- How many times the pattern was used but the user REJECTED the result
    times_rejected INT NOT NULL DEFAULT 0,

    -- Tags for efficient retrieval and relevance matching
    tags TEXT[] NOT NULL DEFAULT '{}',

    -- Which projects contributed to this pattern (for audit/debugging)
    source_project_ids UUID[] NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: users only see their own intelligence
ALTER TABLE migration_intelligence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own intelligence"
    ON migration_intelligence FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "Users can insert own intelligence"
    ON migration_intelligence FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own intelligence"
    ON migration_intelligence FOR UPDATE
    USING (user_id = auth.uid());

CREATE POLICY "Users can delete own intelligence"
    ON migration_intelligence FOR DELETE
    USING (user_id = auth.uid());

-- Indexes for efficient retrieval during AI calls
CREATE INDEX idx_mi_user_category
    ON migration_intelligence(user_id, category);
CREATE INDEX idx_mi_user_confidence
    ON migration_intelligence(user_id, confidence DESC);
CREATE INDEX idx_mi_tags
    ON migration_intelligence USING GIN(tags);
