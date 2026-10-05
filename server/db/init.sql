CREATE TABLE IF NOT EXISTS telemetry (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    temp REAL,
    hum REAL,
    gas INTEGER,
    motion BOOLEAN,
    anomaly_score REAL,
    is_anomaly BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS telemetry_ts_idx ON telemetry (ts DESC);

CREATE TABLE IF NOT EXISTS alerts (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    message TEXT,
    data JSONB
);
CREATE INDEX IF NOT EXISTS alerts_ts_idx ON alerts (ts DESC);
