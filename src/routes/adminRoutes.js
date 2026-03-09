const express = require('express');
const router = express.Router();

const { 
    next_customer, 
    add_admin_services,
    update_admin_service,
    all_services,
    restore_admin_service,
    remove_admin_service,
    get_admin_stats,
    queue_transfer,
    get_admin_analytics,
    get_all_users,
    remove_user,
    force_next,
    get_analytics_with_filter,
    get_customers_database,
    export_analytics_csv

} = require('../controller/adminController');

// Import from other controllers
const { get_all_barbers: fetchAllBarbers, barbers_status: toggleBarberStatus } = require('../controller/barberController');
const { get_all_appointments: fetchAllAppointments } = require('../controller/appointmentController');
const { admin_active_chats: fetchActiveChats, admin_chats_reply: replyToChat } = require('../controller/chatController');
const { get_all_reports: fetchAllReports, admin_reports_resolve: resolveReport } = require('../controller/reportsController');

router.post('/next-customer', next_customer);
router.post('/services', add_admin_services);
router.put('/services/:id', update_admin_service);
router.get('/services', all_services);
router.put('/services/:id/restore', restore_admin_service);
router.delete('/services/:id', remove_admin_service);
router.get('/stats', get_admin_stats);
router.put('/transfer', queue_transfer);
router.get('/analytics/advanced', get_admin_analytics);
router.get('/analytics/filtered', get_analytics_with_filter);
router.get('/customers', get_customers_database);
router.get('/analytics/export', export_analytics_csv);
router.get('/users', get_all_users);
router.delete('/users/:targetId', remove_user);
router.post('/force-next', force_next);

// Admin barbers routes
router.get('/barbers', fetchAllBarbers);
router.put('/barbers/:id/status', toggleBarberStatus);

// Admin appointments routes
router.get('/appointments', fetchAllAppointments);

// Admin chat routes
router.get('/active-chats', fetchActiveChats);
router.post('/chat/reply', replyToChat);

// Admin reports routes
router.get('/reports', fetchAllReports);
router.put('/reports/resolve', resolveReport);

module.exports = router;
