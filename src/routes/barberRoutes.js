const express = require('express');
const router = express.Router();

const { 

    barbers, 
    profile, 
    availability, 
    earnings,
    get_all_barbers,
    barbers_status

} = require('../controller/barberController');

router.get('/barbers', barbers);
router.get('/barber/profile/:userId', profile);
router.put('/barber/availability', availability);
router.put('/barber/settings/earnings', earnings);

module.exports = router;
