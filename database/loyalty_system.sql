-- ============================================
-- LOYALTY & REWARDS SYSTEM DATABASE TABLES
-- ============================================

-- 1. Customer Loyalty Points Table
-- Tracks points earned and redeemed per customer
CREATE TABLE IF NOT EXISTS customer_loyalty (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    total_points INTEGER DEFAULT 0 NOT NULL,
    lifetime_points INTEGER DEFAULT 0 NOT NULL,
    current_tier VARCHAR(50) DEFAULT 'bronze' NOT NULL,
    -- Tier benefits:
    -- bronze: 0-499 points (1 point per 10php spent)
    -- silver: 500-1499 points (1.25 points per 10php)
    -- gold: 1500-2999 points (1.5 points per 10php)  
    -- platinum: 3000+ points (2 points per 10php)
    total_spent DECIMAL(10,2) DEFAULT 0 NOT NULL,
    total_visits INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Points Transaction History
-- Tracks every point earned/redeemed
CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    points INTEGER NOT NULL,
    transaction_type VARCHAR(20) NOT NULL, -- 'earned', 'redeemed', 'expired', 'bonus', 'adjustment'
    description VARCHAR(255),
    reference_id VARCHAR(100), -- Can link to queue_entry_id, reward_id, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Rewards Catalog
-- Available rewards that customers can redeem
CREATE TABLE IF NOT EXISTS rewards_catalog (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    points_required INTEGER NOT NULL,
    discount_percentage INTEGER DEFAULT 0, -- 0 means fixed discount
    discount_fixed INTEGER DEFAULT 0, -- Fixed peso discount
    service_id INTEGER, -- Optional: link to specific service
    is_active BOOLEAN DEFAULT true,
    is_limited BOOLEAN DEFAULT false,
    limited_quantity INTEGER,
    redeemed_count INTEGER DEFAULT 0,
    image_url VARCHAR(500),
    valid_until DATE, -- Optional expiration
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Customer Reward Redemptions
-- Tracks which rewards customers have redeemed
CREATE TABLE IF NOT EXISTS reward_redemptions (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    reward_id INTEGER REFERENCES rewards_catalog(id),
    points_spent INTEGER NOT NULL,
    discount_received DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'applied', 'expired', 'cancelled'
    queue_entry_id INTEGER, -- Link to where it was applied
    redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at DATE
);

-- 5. Referral Program Table
CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    referrer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    referred_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    referrer_points_earned INTEGER DEFAULT 0,
    referred_points_earned INTEGER DEFAULT 0,
    referral_code VARCHAR(20) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'completed', 'expired'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- 6. Birthday Rewards
-- Track birthday reward eligibility
CREATE TABLE IF NOT EXISTS birthday_rewards (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    birthday_month INTEGER, -- Extracted from DOB
    reward_claimed_this_year BOOLEAN DEFAULT false,
    last_claimed_year INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

CREATE INDEX IF NOT EXISTS idx_loyalty_user_id ON customer_loyalty(user_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_user ON loyalty_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_type ON loyalty_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_rewards_catalog_active ON rewards_catalog(is_active);
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_user ON reward_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);

-- ============================================
-- FUNCTION: Calculate Tier from Points
-- ============================================

CREATE OR REPLACE FUNCTION calculate_tier(total_points INTEGER)
RETURNS VARCHAR(50) AS $$
BEGIN
    CASE
        WHEN total_points >= 3000 THEN RETURN 'platinum';
        WHEN total_points >= 1500 THEN RETURN 'gold';
        WHEN total_points >= 500 THEN RETURN 'silver';
        ELSE RETURN 'bronze';
    END CASE;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- FUNCTION: Get Points Multiplier by Tier
-- ============================================

CREATE OR REPLACE FUNCTION get_tier_multiplier(tier VARCHAR(50))
RETURNS DECIMAL(3,2) AS $$
BEGIN
    CASE tier
        WHEN 'platinum' THEN RETURN 2.00;
        WHEN 'gold' THEN RETURN 1.50;
        WHEN 'silver' THEN RETURN 1.25;
        ELSE RETURN 1.00;
    END CASE;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- FUNCTION: Add Points to Customer
-- ============================================

CREATE OR REPLACE FUNCTION add_loyalty_points(
    p_user_id UUID,
    p_points INTEGER,
    p_transaction_type VARCHAR(20),
    p_description VARCHAR(255),
    p_reference_id VARCHAR(100)
)
RETURNS VOID AS $$
DECLARE
    v_current_points INTEGER;
    v_new_tier VARCHAR(50);
    v_multiplier DECIMAL(3,2);
BEGIN
    -- Get current points
    SELECT COALESCE(total_points, 0) INTO v_current_points
    FROM customer_loyalty WHERE user_id = p_user_id;

    -- Insert transaction record
    INSERT INTO loyalty_transactions (user_id, points, transaction_type, description, reference_id)
    VALUES (p_user_id, p_points, p_transaction_type, p_description, p_reference_id);

    -- Update or insert customer loyalty record
    IF v_current_points > 0 THEN
        -- Update existing
        UPDATE customer_loyalty 
        SET total_points = total_points + p_points,
            lifetime_points = lifetime_points + p_points,
            current_tier = calculate_tier(total_points + p_points),
            updated_at = NOW()
        WHERE user_id = p_user_id;
    ELSE
        -- Insert new
        INSERT INTO customer_loyalty (user_id, total_points, lifetime_points, current_tier)
        VALUES (p_user_id, p_points, p_points, calculate_tier(p_points));
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- FUNCTION: Redeem Points for Reward
-- ============================================

CREATE OR REPLACE FUNCTION redeem_reward(
    p_user_id UUID,
    p_reward_id INTEGER,
    p_queue_entry_id INTEGER DEFAULT NULL
)
RETURNS DECIMAL(10,2) AS $$
DECLARE
    v_reward RECORD;
    v_current_points INTEGER;
    v_discount DECIMAL(10,2);
BEGIN
    -- Get reward details
    SELECT * INTO v_reward FROM rewards_catalog 
    WHERE id = p_reward_id AND is_active = true;

    IF v_reward IS NULL THEN
        RAISE EXCEPTION 'Reward not found or inactive';
    END IF;

    -- Check stock for limited rewards
    IF v_reward.is_limited AND v_reward.redeemed_count >= v_reward.limited_quantity THEN
        RAISE EXCEPTION 'Reward out of stock';
    END IF;

    -- Get current points
    SELECT COALESCE(total_points, 0) INTO v_current_points
    FROM customer_loyalty WHERE user_id = p_user_id;

    IF v_current_points < v_reward.points_required THEN
        RAISE EXCEPTION 'Insufficient points';
    END IF;

    -- Calculate discount
    IF v_reward.discount_percentage > 0 THEN
        -- Percentage discount - we'd need service price, so return as info
        v_discount := v_reward.discount_percentage;
    ELSE
        v_discount := v_reward.discount_fixed;
    END IF;

    -- Deduct points
    UPDATE customer_loyalty 
    SET total_points = total_points - v_reward.points_required,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- Insert redemption record
    INSERT INTO reward_redemptions (user_id, reward_id, points_spent, discount_received, queue_entry_id, status, expires_at)
    VALUES (p_user_id, p_reward_id, v_reward.points_spent, v_discount, p_queue_entry_id, 'pending', 
            NOW() + INTERVAL '30 days');

    -- Update redeemed count
    UPDATE rewards_catalog SET redeemed_count = redeemed_count + 1 WHERE id = p_reward_id;

    -- Insert points transaction
    INSERT INTO loyalty_transactions (user_id, points, transaction_type, description, reference_id)
    VALUES (p_user_id, -v_reward.points_required, 'redeemed', 
            'Redeemed reward: ' || v_reward.name, p_reward_id::varchar);

    RETURN v_discount;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- SEED DATA: Sample Rewards
-- ============================================

INSERT INTO rewards_catalog (name, description, points_required, discount_fixed, is_active) VALUES
('Free Haircut', 'Redeem for a free standard haircut', 500, 150, true),
('10% Off Next Cut', 'Get 10% off your next service', 200, 0, true),
('15% Off Next Cut', 'Get 15% off your next service', 350, 0, true),
('Free Beard Trim', 'Redeem for a free beard trim service', 250, 80, true),
('₱50 Off Any Service', 'Get ₱50 off any service', 150, 50, true),
('VIP Priority Pass', 'Jump to front of queue once', 400, 0, true),
('Free Hair Product', 'Choose any hair product under ₱200', 600, 200, true);

-- ============================================
-- RLS POLICIES (Row Level Security)
-- ============================================

ALTER TABLE customer_loyalty ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rewards_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE birthday_rewards ENABLE ROW LEVEL SECURITY;

-- Customers can view their own loyalty data
CREATE POLICY "Users can view own loyalty" ON customer_loyalty
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own transactions" ON loyalty_transactions
    FOR SELECT USING (auth.uid() = user_id);

-- Everyone can view active rewards
CREATE POLICY "Anyone can view active rewards" ON rewards_catalog
    FOR SELECT USING (is_active = true);

-- Users can view their own redemptions
CREATE POLICY "Users can view own redemptions" ON reward_redemptions
    FOR SELECT USING (auth.uid() = user_id);

-- Admins can manage all
CREATE POLICY "Admins can manage loyalty" ON customer_loyalty
    FOR ALL USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
    );

