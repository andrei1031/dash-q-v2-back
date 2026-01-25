const express = require('express');
const router = express.Router();

const { 
    
    flag, 
    history, 
    customer_loyalty,
    feedback,
    get_feedback_barber

    } = require('../controller/customerController');
    
router.put('/flag', flag);
router.get('/history/:userId', history);
router.get('/customer-loyalty/:customerEmail', customer_loyalty);
router.post('/feedback', feedback);
router.get('/feedback/:barberId', get_feedback_barber);

module.exports = router;