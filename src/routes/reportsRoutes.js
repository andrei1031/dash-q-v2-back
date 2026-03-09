const express = require('express');
const router = express.Router();

const { 
    
    submit_reports,
    get_all_reports,
    admin_reports_resolve,
    get_user_submitted_reports

} = require('../controller/reportsController');

router.post('/reports', submit_reports);
router.get('/reports/my/:userId', get_user_submitted_reports);

module.exports = router;