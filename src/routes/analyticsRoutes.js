const express = require('express');
const router = express.Router();
const analyticsController = require('../controller/analyticsController');

// The error is happening here because the second argument is likely undefined
router.get('/:barberId', analyticsController.get_analytics);

module.exports = router;