-- Set VIP Price to 150 (dynamic)
-- Run in Supabase SQL Editor

INSERT INTO app_settings (key, value) 
VALUES ('vip_price', '150')
ON CONFLICT (key) DO UPDATE SET value = '150';

SELECT * FROM app_settings WHERE key = 'vip_price';
