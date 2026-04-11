const express = require('express');
const router = express.Router();

const { 
    push_manual,
    subscribe
} = require('../controller/notificationController');

router.post('/push-manual', push_manual);
router.post('/subscribe', subscribe);

module.exports = router;