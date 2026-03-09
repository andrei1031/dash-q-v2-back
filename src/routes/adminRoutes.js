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

router.post('/next-customer', next_customer);
router.post('/admin/services', add_admin_services);
router.put('/admin/services/:id', update_admin_service);
router.get('/admin/services', all_services);
router.put('/admin/services/:id/restore', restore_admin_service);
router.delete('/admin/services/:id', remove_admin_service);
router.get('/admin/stats', get_admin_stats);
router.put('/admin/transfer', queue_transfer);
router.get('/admin/analytics/advanced', get_admin_analytics);
router.get('/admin/analytics/filtered', get_analytics_with_filter);
router.get('/admin/customers', get_customers_database);
router.get('/admin/analytics/export', export_analytics_csv);
router.get('/admin/users', get_all_users);
router.delete('/admin/users/:targetId', remove_user);
router.post('/admin/force-next', force_next);

module.exports = router;
