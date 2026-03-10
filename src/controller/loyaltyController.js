const { supabaseAdmin } = require('../database/supabase');

// ============================================
// LOYALTY & REWARDS CONTROLLER
// ============================================

// GET /api/loyalty/:userId - Get customer's loyalty info
exports.getCustomerLoyalty = async (req, res) => {
    try {
        const { userId } = req.params;

        // Get customer loyalty data
        const { data: loyalty, error: loyaltyError } = await supabaseAdmin
            .from('customer_loyalty')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (loyaltyError && loyaltyError.code !== 'PGRST116') {
            throw loyaltyError;
        }

        // Get recent transactions
        const { data: transactions, error: transError } = await supabaseAdmin
            .from('loyalty_transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(20);

        if (transError) throw transError;

        // Get tier benefits based on current tier
        const tierBenefits = {
            bronze: { multiplier: 1.0, name: 'Bronze', nextTier: 'silver', pointsToNext: 500 },
            silver: { multiplier: 1.25, name: 'Silver', nextTier: 'gold', pointsToNext: 1000 },
            gold: { multiplier: 1.5, name: 'Gold', nextTier: 'platinum', pointsToNext: 1500 },
            platinum: { multiplier: 2.0, name: 'Platinum', nextTier: null, pointsToNext: 0 }
        };

        const currentTier = loyalty?.current_tier || 'bronze';
        const benefits = tierBenefits[currentTier];

        res.json({
            loyalty: loyalty || {
                total_points: 0,
                lifetime_points: 0,
                current_tier: 'bronze',
                total_spent: 0,
                total_visits: 0
            },
            transactions: transactions || [],
            tierBenefits: benefits,
            pointsToNextTier: benefits.pointsToNext - ((loyalty?.total_points || 0) % (benefits.nextTier === 'platinum' ? 3000 : benefits.pointsToNext))
        });
    } catch (error) {
        console.error('Get loyalty error:', error);
        res.status(500).json({ error: 'Failed to load loyalty data' });
    }
};

// GET /api/loyalty/rewards - Get available rewards catalog
exports.getRewardsCatalog = async (req, res) => {
    try {
        const { data: rewards, error } = await supabaseAdmin
            .from('reward_redemptions')
            .select('*')
            .eq('user_id', req.query.userId)
            .order('redeemed_at', { ascending: false });

        // Get available rewards
        const { data: catalog, error: catalogError } = await supabaseAdmin
            .from('rewards_catalog')
            .select('*')
            .eq('is_active', true)
            .order('points_required', { ascending: true });

        if (catalogError) throw catalogError;

        res.json({
            availableRewards: catalog || [],
            myRedemptions: rewards || []
        });
    } catch (error) {
        console.error('Get rewards error:', error);
        res.status(500).json({ error: 'Failed to load rewards' });
    }
};

// POST /api/loyalty/redeem - Redeem points for a reward
exports.redeemReward = async (req, res) => {
    try {
        const { userId, rewardId, queueEntryId } = req.body;

        // Get reward details first
        const { data: reward, error: rewardError } = await supabaseAdmin
            .from('rewards_catalog')
            .select('*')
            .eq('id', rewardId)
            .eq('is_active', true)
            .single();

        if (rewardError || !reward) {
            return res.status(404).json({ error: 'Reward not found or inactive' });
        }

        // Check stock
        if (reward.is_limited && reward.redeemed_count >= reward.limited_quantity) {
            return res.status(400).json({ error: 'Reward out of stock' });
        }

        // Get customer loyalty
        const { data: loyalty, error: loyaltyError } = await supabaseAdmin
            .from('customer_loyalty')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (loyaltyError || !loyalty) {
            return res.status(404).json({ error: 'Loyalty account not found' });
        }

        if (loyalty.total_points < reward.points_required) {
            return res.status(400).json({ 
                error: 'Insufficient points',
                currentPoints: loyalty.total_points,
                requiredPoints: reward.points_required
            });
        }

        // Calculate discount
        const discount = reward.discount_fixed || 0;
        const discountPercent = reward.discount_percentage || 0;

        // Start transaction
        const { error: deductError } = await supabaseAdmin
            .from('customer_loyalty')
            .update({ 
                total_points: loyalty.total_points - reward.points_required,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId);

        if (deductError) throw deductError;

        // Record redemption
        const { data: redemption, error: redeemError } = await supabaseAdmin
            .from('reward_redemptions')
            .insert({
                user_id: userId,
                reward_id: rewardId,
                points_spent: reward.points_required,
                discount_received: discount || discountPercent,
                queue_entry_id: queueEntryId || null,
                status: 'pending',
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            })
            .select()
            .single();

        if (redeemError) throw redeemError;

        // Update redeemed count
        await supabaseAdmin
            .from('rewards_catalog')
            .update({ redeemed_count: reward.redeemed_count + 1 })
            .eq('id', rewardId);

        // Record transaction
        await supabaseAdmin
            .from('loyalty_transactions')
            .insert({
                user_id: userId,
                points: -reward.points_required,
                transaction_type: 'redeemed',
                description: `Redeemed: ${reward.name}`,
                reference_id: rewardId.toString()
            });

        res.json({
            success: true,
            message: `Successfully redeemed ${reward.name}!`,
            redemption: redemption,
            discount: discount || `${discountPercent}%`,
            remainingPoints: loyalty.total_points - reward.points_required
        });
    } catch (error) {
        console.error('Redeem reward error:', error);
        res.status(500).json({ error: error.message || 'Failed to redeem reward' });
    }
};

// POST /api/loyalty/apply - Apply redeemed reward to a service
exports.applyRewardToService = async (req, res) => {
    try {
        const { userId, redemptionId, queueEntryId } = req.body;

        // Get redemption details
        const { data: redemption, error: redemptionError } = await supabaseAdmin
            .from('reward_redemptions')
            .select('*, rewards_catalog(*)')
            .eq('id', redemptionId)
            .eq('user_id', userId)
            .eq('status', 'pending')
            .single();

        if (redemptionError || !redemption) {
            return res.status(404).json({ error: 'Redemption not found or already used' });
        }

        // Check expiration
        if (redemption.expires_at && new Date(redemption.expires_at) < new Date()) {
            return res.status(400).json({ error: 'Redemption has expired' });
        }

        // Update redemption status
        const { error: updateError } = await supabaseAdmin
            .from('reward_redemptions')
            .update({ 
                status: 'applied',
                queue_entry_id: queueEntryId
            })
            .eq('id', redemptionId);

        if (updateError) throw updateError;

        res.json({
            success: true,
            discount: redemption.discount_received,
            rewardName: redemption.rewards_catalog?.name,
            message: 'Reward applied to your service!'
        });
    } catch (error) {
        console.error('Apply reward error:', error);
        res.status(500).json({ error: 'Failed to apply reward' });
    }
};

// POST /api/loyalty/earn - Earn points after service completion (called from queue completion)
exports.earnPointsOnService = async (req, res) => {
    try {
        const { userId, queueEntryId, servicePrice, serviceId, headCount, vipCharge, tipAmount } = req.body;

        if (!userId || !servicePrice) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Get or create loyalty record
        let { data: loyalty, error: loyaltyError } = await supabaseAdmin
            .from('customer_loyalty')
            .select('*')
            .eq('user_id', userId)
            .single();

        // Calculate points: 1 point per 10php spent, with tier multiplier
        // Points are based on base service price (before tip/vip)
        let multiplier = 1.0;
        if (loyalty) {
            switch (loyalty.current_tier) {
                case 'platinum': multiplier = 2.0; break;
                case 'gold': multiplier = 1.5; break;
                case 'silver': multiplier = 1.25; break;
            }
        }

        // Use headCount if provided, otherwise default to 1
        const heads = headCount || 1;
        const basePrice = parseFloat(servicePrice) * heads;
        
        // Calculate total spent: base price + VIP charge + tip
        const vipFee = parseFloat(vipCharge) || 0;
        const tip = parseFloat(tipAmount) || 0;
        const totalSpent = basePrice + vipFee + tip;

        const pointsEarned = Math.floor((basePrice / 10) * multiplier);

        if (loyalty) {
            // Update existing
            const newTotalPoints = loyalty.total_points + pointsEarned;
            const newTier = newTotalPoints >= 3000 ? 'platinum' : 
                           newTotalPoints >= 1500 ? 'gold' : 
                           newTotalPoints >= 500 ? 'silver' : 'bronze';

            await supabaseAdmin
                .from('customer_loyalty')
                .update({
                    total_points: newTotalPoints,
                    lifetime_points: loyalty.lifetime_points + pointsEarned,
                    current_tier: newTier,
                    total_spent: parseFloat(loyalty.total_spent) + totalSpent,
                    total_visits: loyalty.total_visits + heads,
                    updated_at: new Date().toISOString()
                })
                .eq('user_id', userId);
        } else {
            // Create new
            await supabaseAdmin
                .from('customer_loyalty')
                .insert({
                    user_id: userId,
                    total_points: pointsEarned,
                    lifetime_points: pointsEarned,
                    current_tier: 'bronze',
                    total_spent: totalSpent,
                    total_visits: heads
                });
        }

        // Record transaction
        await supabaseAdmin
            .from('loyalty_transactions')
            .insert({
                user_id: userId,
                points: pointsEarned,
                transaction_type: 'earned',
                description: 'Points earned from service',
                reference_id: queueEntryId?.toString()
            });

        res.json({
            success: true,
            pointsEarned: pointsEarned,
            multiplier: multiplier,
            newTier: loyalty?.current_tier || 'bronze',
            totalPoints: (loyalty?.total_points || 0) + pointsEarned
        });
    } catch (error) {
        console.error('Earn points error:', error);
        res.status(500).json({ error: 'Failed to earn points' });
    }
};

// GET /api/loyalty/referral/:userId - Get referral info
exports.getReferralInfo = async (req, res) => {
    try {
        const { userId } = req.params;

        // Get user's referral code or create one
        let { data: referral, error } = await supabaseAdmin
            .from('referrals')
            .select('*')
            .eq('referrer_id', userId)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw error;
        }

        if (!referral) {
            // Create new referral code
            const referralCode = 'DQ' + Math.random().toString(36).substring(2, 8).toUpperCase();
            
            const { data: newReferral, insertError } = await supabaseAdmin
                .from('referrals')
                .insert({
                    referrer_id: userId,
                    referral_code: referralCode,
                    status: 'pending'
                })
                .select()
                .single();

            if (insertError) throw insertError;
            referral = newReferral;
        }

        // Count successful referrals
        const { count } = await supabaseAdmin
            .from('referrals')
            .select('*', { count: 'exact', head: true })
            .eq('referrer_id', userId)
            .eq('status', 'completed');

        res.json({
            referralCode: referral.referral_code,
            totalReferrals: count || 0,
            referrerPoints: referral.referrer_points_earned
        });
    } catch (error) {
        console.error('Get referral error:', error);
        res.status(500).json({ error: 'Failed to get referral info' });
    }
};

// POST /api/loyalty/referral/use - Use a referral code
exports.useReferralCode = async (req, res) => {
    try {
        const { userId, referralCode } = req.body;

        // Find referral by code
        const { data: referral, error } = await supabaseAdmin
            .from('referrals')
            .select('*')
            .eq('referral_code', referralCode.toUpperCase())
            .single();

        if (error || !referral) {
            return res.status(404).json({ error: 'Invalid referral code' });
        }

        // Can't refer yourself
        if (referral.referrer_id === userId) {
            return res.status(400).json({ error: 'Cannot use your own referral code' });
        }

        // Check if already referred
        const { data: existingRef } = await supabaseAdmin
            .from('referrals')
            .select('*')
            .eq('referred_id', userId)
            .single();

        if (existingRef) {
            return res.status(400).json({ error: 'You have already used a referral code' });
        }

        // Create referral record for new user
        await supabaseAdmin
            .from('referrals')
            .insert({
                referrer_id: referral.referrer_id,
                referred_id: userId,
                referral_code: referralCode.toUpperCase(),
                referred_points_earned: 100, // Points for new user
                status: 'completed',
                completed_at: new Date().toISOString()
            });

        // Update referrer's points
        const { data: referrerLoyalty } = await supabaseAdmin
            .from('customer_loyalty')
            .select('*')
            .eq('user_id', referral.referrer_id)
            .single();

        if (referrerLoyalty) {
            await supabaseAdmin
                .from('customer_loyalty')
                .update({
                    total_points: referrerLoyalty.total_points + 100,
                    lifetime_points: referrerLoyalty.lifetime_points + 100
                })
                .eq('user_id', referral.referrer_id);
        }

        // Give bonus points to new user
        const { data: newUserLoyalty } = await supabaseAdmin
            .from('customer_loyalty')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (newUserLoyalty) {
            await supabaseAdmin
                .from('customer_loyalty')
                .update({
                    total_points: newUserLoyalty.total_points + 100,
                    lifetime_points: newUserLoyalty.lifetime_points + 100
                })
                .eq('user_id', userId);
        } else {
            await supabaseAdmin
                .from('customer_loyalty')
                .insert({
                    user_id: userId,
                    total_points: 100,
                    lifetime_points: 100,
                    current_tier: 'bronze',
                    total_spent: 0,
                    total_visits: 0
                });
        }

        // Record transactions
        await supabaseAdmin
            .from('loyalty_transactions')
            .insert([
                {
                    user_id: referral.referrer_id,
                    points: 100,
                    transaction_type: 'bonus',
                    description: 'Referral bonus - friend joined',
                    reference_id: userId
                },
                {
                    user_id: userId,
                    points: 100,
                    transaction_type: 'bonus',
                    description: 'Welcome bonus - used referral code',
                    reference_id: referral.referrer_id
                }
            ]);

        res.json({
            success: true,
            message: 'Referral code applied! You earned 100 bonus points!',
            pointsEarned: 100
        });
    } catch (error) {
        console.error('Use referral error:', error);
        res.status(500).json({ error: 'Failed to use referral code' });
    }
};

// ADMIN: Get all loyalty stats
exports.getAdminLoyaltyStats = async (req, res) => {
    try {
        // Total points in system
        const { data: allLoyalty } = await supabaseAdmin
            .from('customer_loyalty')
            .select('*');

        // Tier distribution
        const tierCounts = {
            bronze: 0,
            silver: 0,
            gold: 0,
            platinum: 0
        };

        let totalPoints = 0;
        let totalSpent = 0;

        allLoyalty?.forEach(l => {
            tierCounts[l.current_tier] = (tierCounts[l.current_tier] || 0) + 1;
            totalPoints += l.total_points || 0;
            totalSpent += parseFloat(l.total_spent) || 0;
        });

        // Top customers
        const topCustomers = allLoyalty
            ?.sort((a, b) => b.total_points - a.total_points)
            .slice(0, 10);

        // Popular rewards
        const { data: popularRewards } = await supabaseAdmin
            .from('rewards_catalog')
            .select('name, redeemed_count')
            .order('redeemed_count', { ascending: false })
            .limit(5);

        res.json({
            totalMembers: allLoyalty?.length || 0,
            tierDistribution: tierCounts,
            totalPointsInSystem: totalPoints,
            totalSpentInSystem: totalSpent,
            topCustomers: topCustomers || [],
            popularRewards: popularRewards || []
        });
    } catch (error) {
        console.error('Admin loyalty stats error:', error);
        res.status(500).json({ error: 'Failed to load loyalty stats' });
    }
};

// ADMIN: Add/edit rewards
exports.manageReward = async (req, res) => {
    try {
        const { rewardId, ...rewardData } = req.body;

        if (rewardId) {
            // Update existing
            const { data, error } = await supabaseAdmin
                .from('rewards_catalog')
                .update(rewardData)
                .eq('id', rewardId)
                .select()
                .single();

            if (error) throw error;
            res.json({ success: true, message: 'Reward updated', reward: data });
        } else {
            // Create new
            const { data, error } = await supabaseAdmin
                .from('rewards_catalog')
                .insert(rewardData)
                .select()
                .single();

            if (error) throw error;
            res.json({ success: true, message: 'Reward created', reward: data });
        }
    } catch (error) {
        console.error('Manage reward error:', error);
        res.status(500).json({ error: 'Failed to manage reward' });
    }
};

