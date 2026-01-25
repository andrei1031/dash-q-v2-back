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
    remove
} = require('../controller/queueController');

router.put('/confirm', confirm);
router.put('/location', location);
router.post('/queue', queue);
router.put('/photo', photo);
router.get('/details/:barberId', details);
router.put('/next', next);
router.put('/cancel', cancel);
router.post('/complete', complete);
router.get('/public/:barberId', public_barber);
router.delete('/queue/:queueId', remove);

module.exports = router;
