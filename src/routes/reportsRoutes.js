const express = require('express');
const router = express.Router();
const { unban_user, submit_reports, get_user_submitted_reports } = require('../controller/reportsController');

const { 
    submit_reports,
    get_all_reports,
    admin_reports_resolve,
    get_user_submitted_reports
} = require('../controller/reportsController');

// Change '/reports' to '/'
router.put('/unban/:userId', unban_user); 
router.post('/', submit_reports);
router.get('/my/:userId', get_user_submitted_reports);

module.exports = router;