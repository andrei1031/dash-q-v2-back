const express = require('express');
const router = express.Router();
const appointmentController = require('../controller/appointmentController');
const authMiddleware = require('../middleware/auth');

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

// All routes here are automatically prefixed with /api/appointments by server.js

router.get('/slots', slots);
router.post('/book', book);
router.put('/reject', reject);
router.put('/approve', approve);
router.get('/my/:userId', get_customer_appointments);

// FIX 1: Change '/appointments/barber/:barberId' to '/barber/:barberId'
router.get('/barber/:barberId', get_barber_appointments);

// FIX 2: Change '/test/process-appointments' to '/process' (to match what your frontend likely expects)
router.get('/process', process_appointments); 
router.put('/:id/cancel', authMiddleware, appointmentController.cancelAppointment);
router.put('/:id/edit', authMiddleware, appointmentController.editAppointment);

module.exports = router;