const express = require('express');
const router = express.Router();

const { 
    submit_reports,
    get_all_reports,
    admin_reports_resolve,
    get_user_submitted_reports,
    unban_user
} = require('../controller/reportsController');

// Define your routes...
router.post('/', submit_reports);
router.put('/unban/:userId', unban_user);
router.get('/my/:userId', get_user_submitted_reports);

module.exports = router;