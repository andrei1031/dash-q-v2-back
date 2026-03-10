const express = require('express');
const router = express.Router();
const loyaltyController = require('../controller/loyaltyController');

// ============================================
// LOYALTY & REWARDS ROUTES
// ============================================

// GET /api/loyalty/:userId - Get customer's loyalty info
router.get('/loyalty/:userId', loyaltyController.getCustomerLoyalty);

// GET /api/loyalty/rewards - Get available rewards catalog
router.get('/loyalty/rewards', loyaltyController.getRewardsCatalog);

// POST /api/loyalty/redeem - Redeem points for a reward
router.post('/loyalty/redeem', loyaltyController.redeemReward);

// POST /api/loyalty/apply - Apply redeemed reward to service
router.post('/loyalty/apply', loyaltyController.applyRewardToService);

// POST /api/loyalty/earn - Earn points after service completion
router.post('/loyalty/earn', loyaltyController.earnPointsOnService);

// GET /api/loyalty/referral/:userId - Get referral info
router.get('/loyalty/referral/:userId', loyaltyController.getReferralInfo);

// POST /api/loyalty/referral/use - Use a referral code
router.post('/loyalty/referral/use', loyaltyController.useReferralCode);

// ADMIN: Get all loyalty stats
router.get('/admin/loyalty/stats', loyaltyController.getAdminLoyaltyStats);

// ADMIN: Add/edit rewards
router.post('/admin/loyalty/reward', loyaltyController.manageReward);

module.exports = router;

