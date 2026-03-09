-- Run this SQL in your Supabase SQL Editor to create the blocked_devices table

-- Create blocked_devices table
CREATE TABLE IF NOT EXISTS blocked_devices (
    id SERIAL PRIMARY KEY,
    device_fingerprint VARCHAR(255) UNIQUE NOT NULL,
    reason TEXT NOT NULL,
    blocked_by VARCHAR(255),
    blocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- Enable RLS
ALTER TABLE blocked_devices ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read (for device check)
CREATE POLICY "Allow public read for device check"
ON blocked_devices FOR SELECT
USING (true);

-- Allow service role to insert/update (handled by admin endpoints)
CREATE POLICY "Allow service role for device management"
ON blocked_devices FOR ALL
USING (true)
WITH CHECK (true);

