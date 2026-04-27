const express = require('express');
const router = express.Router();

const { 
    submit_reports,
    get_all_reports,
    admin_reports_resolve,
    get_user_submitted_reports
} = require('../controller/reportsController');

// Change '/reports' to '/'
router.post('/', submit_reports); 

// Change '/reports/my/:userId' to '/my/:userId'
router.get('/my/:userId', get_user_submitted_reports); 

module.exports = router;