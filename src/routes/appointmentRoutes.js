const express = require('express');
const router = express.Router();

const { 
    
    slots, 
    book, 
    reject, 
    approve,
    get_customer_appointments,
    get_all_appointments,
    get_barber_appointments,
    process_appointments

} = require('../controller/appointmentController');

router.get('/slots', slots);
router.post('/book', book);
router.put('/reject', reject);
router.put('/approve', approve);
router.get('/my/:userId', get_customer_appointments);
router.get('/admin/appointments', get_all_appointments);
router.get('/appointments/barber/:barberId', get_barber_appointments);
router.get('/test/process-appointments', process_appointments);

module.exports = router;