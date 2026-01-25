const express = require('express');
const router = express.Router();

const { missed_events } = require('../controller/eventController');

router.get('/missed-events/:userId', missed_events);

module.exports = router;