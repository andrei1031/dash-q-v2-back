const express = require('express');
const router = express.Router();

// 1. Single import
const adminController = require('../controller/adminController');

// Import other controllers
const { get_all_barbers: fetchAllBarbers, barbers_status: toggleBarberStatus } = require('../controller/barberController');
const { get_all_appointments: fetchAllAppointments } = require('../controller/appointmentController');
const { admin_active_chats: fetchActiveChats, admin_chats_reply: replyToChat } = require('../controller/chatController');
const { get_all_reports: fetchAllReports, admin_reports_resolve: resolveReport } = require('../controller/reportsController');

// 2. Routes - Using the imported object directly
router.post('/next-customer', adminController.next_customer);
router.post('/services', adminController.add_admin_services);
router.put('/services/:id', adminController.update_admin_service);
router.get('/services', adminController.all_services);
router.put('/services/:id/restore', adminController.restore_admin_service);
router.delete('/services/:id', adminController.remove_admin_service);
router.delete('/services/:id/hard-delete', adminController.hard_delete_admin_service);
router.get('/stats', adminController.get_admin_stats);
router.put('/transfer', adminController.queue_transfer);
router.get('/analytics/advanced', adminController.get_admin_analytics);
router.get('/analytics/filtered', adminController.get_analytics_with_filter);
router.get('/customers', adminController.get_customers_database);
router.get('/analytics/export', adminController.export_analytics_csv);
router.get('/users', adminController.get_all_users);
router.delete('/users/:targetId', adminController.remove_user);
router.post('/force-next', adminController.force_next);
router.post('/recalculate-loyalty', adminController.recalculate_loyalty);
router.put('/staff/toggle/:barberId', adminController.toggle_barber_status);
router.put('/barber/booking-status', adminController.updateBarberBookingStatus);

// Other controllers
router.get('/barbers', fetchAllBarbers);
router.put('/barbers/:id/status', toggleBarberStatus);
router.get('/appointments', fetchAllAppointments);
router.get('/active-chats', fetchActiveChats);
router.post('/chat/reply', replyToChat);
router.get('/reports', fetchAllReports);
router.put('/reports/resolve', resolveReport);
router.post('/add-barber', adminController.add_barber);
router.post('/update-barber/:barberId', adminController.update_barber);

module.exports = router;