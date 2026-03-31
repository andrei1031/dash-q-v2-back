const express = require('express');
const router = express.Router();
const customerController = require('../controller/customerController');

// Customer History
router.get('/history/:userId', customerController.history);
router.get('/customer-loyalty/:customerEmail', customerController.customer_loyalty);

// 🟢 FIX: Correctly mapped Feedback Routes 
router.post('/feedback', customerController.feedback); // Matches frontend axios.post('/api/feedback')
router.get('/feedback/:barberId', customerController.get_feedback_barber); // Matches frontend axios.get('/api/feedback/1')

module.exports = router;