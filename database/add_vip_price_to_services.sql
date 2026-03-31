-- Migration: Add VIP pricing support to services table
-- Fixes schema cache error for admin service editing

-- Ensure column doesn't exist before adding (idempotent)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.columns 
        WHERE table_name = 'services' AND column_name = 'price_vip_php'
    ) THEN
        ALTER TABLE services 
        ADD COLUMN price_vip_php numeric DEFAULT NULL;
        
        RAISE NOTICE 'Added price_vip_php column to services table';
    ELSE
        RAISE NOTICE 'price_vip_php column already exists in services table';
    END IF;
END $$;

-- Update existing services: set VIP price = base price (reasonable default)
UPDATE services 
SET price_vip_php = price_php 
WHERE price_vip_php IS NULL AND price_php IS NOT NULL;

-- Add index for performance (optional)
CREATE INDEX IF NOT EXISTS idx_services_price_vip_php ON services(price_vip_php);

-- Verify migration
SELECT 
    name,
    price_php,
    price_vip_php,
    CASE 
        WHEN price_vip_php IS NULL THEN 'Needs VIP price'
        WHEN price_vip_php = price_php THEN 'VIP = Base'
        ELSE 'VIP Premium: +₱' || (price_vip_php - price_php)
    END as vip_status
FROM services 
ORDER BY id;

