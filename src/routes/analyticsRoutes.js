const express = require('express');
const router = express.Router();

const { analytics_barber } = require('../controller/analyticsController');

router.get('/analytics/:barberId', analytics_barber);

module.exports = router;