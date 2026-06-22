const express = require('express');
const router = express.Router();

const { 
    confirm, 
    location, 
    queue, 
    photo, 
    details,
    next,
    cancel,
    complete,
    public_barber,
    remove,
    pingCustomer
} = require('../controller/queueController');

// --- QUEUE ROUTES (Mounted at /api/queue) ---

router.put('/confirm', confirm);
router.put('/location', location);

// FIX 1: Change '/queue' to '/' so it becomes POST /api/queue
router.post('/', queue); 

router.put('/photo', photo);
router.get('/details/:barberId', details);
router.put('/next', next);
router.put('/cancel', cancel);
router.post('/complete', complete);
router.get('/public/:barberId', public_barber);
router.post('/ping', pingCustomer);

// FIX 2: Change '/queue/:queueId' to '/:queueId' so it becomes DELETE /api/queue/:queueId
router.delete('/:queueId', remove); 

module.exports = router;
