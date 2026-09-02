CREATE TABLE IF NOT EXISTS feature_tracker_state (
    key TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT feature_tracker_state_default_key CHECK (key = 'default')
);
