const express = require('express');
const router = express.Router();

const { 
    push_manual,
    subscribe,
    push
} = require('../controller/notificationController');

router.post('/push-manual', push_manual);
router.post('/subscribe', subscribe);
router.post('/push', push);

module.exports = router;
    