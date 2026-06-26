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
    process_appointments,
    cancelAppointment, // MUST BE IMPORTED
    editAppointment    // MUST BE IMPORTED
} = require('../controller/appointmentController');

// All routes here are automatically prefixed with /api/appointments by server.js

router.get('/slots', slots);
router.post('/book', book);
router.put('/reject', reject);
router.put('/approve', approve);
router.get('/my/:userId', get_customer_appointments);

// FIX 1: Change '/appointments/barber/:barberId' to '/barber/:barberId'
router.get('/barber/:barberId', get_barber_appointments);

// FIX 2: Change '/test/process-appointments' to '/process'
router.get('/process', process_appointments); 

// Customer Edit & Cancel Routes
router.put('/:id/cancel', cancelAppointment);
router.put('/:id/edit', editAppointment);

module.exports = router;