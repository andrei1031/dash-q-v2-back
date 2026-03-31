const express = require('express');
const router = express.Router();
const customerController = require('../controller/customerController');

// 🟢 These paths now perfectly match your frontend's axios requests!
router.get('/customer/history/:userId', customerController.history);
router.get('/barber/customer-loyalty/:customerEmail', customerController.customer_loyalty);
router.put('/logout/flag', customerController.flag); 

// Feedback Routes
router.post('/feedback', customerController.feedback); 
router.get('/feedback/:barberId', customerController.get_feedback_barber); 

module.exports = router;