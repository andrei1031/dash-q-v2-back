const express = require('express');
const router = express.Router();
const customerController = require('../controller/customerController');

router.get('/history/:userId', customerController.history);
router.get('/customer-loyalty/:customerEmail', customerController.customer_loyalty);
// These MUST match the frontend!
router.post('/feedback', customerController.feedback); 
router.get('/feedback/:barberId', customerController.get_feedback_barber); 

module.exports = router;