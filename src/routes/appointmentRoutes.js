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

// All routes here are automatically prefixed with /api/appointments by server.js

const appointmentController = require('../controller/appointmentController');

// Define the routes using the imported object
router.get('/slots', appointmentController.slots);
router.post('/book', appointmentController.book);
router.put('/reject', appointmentController.reject);
router.put('/approve', appointmentController.approve);
router.get('/my/:userId', appointmentController.get_customer_appointments);
router.get('/barber/:barberId', appointmentController.get_barber_appointments);
router.get('/process', appointmentController.process_appointments);

// Fix: The routes
router.put('/cancel/:id', appointmentController.cancelAppointment);
router.put('/edit/:id', appointmentController.editAppointment);

module.exports = router;
