const express = require('express');
const router = express.Router();

const { join_as_guest } = require('../controller/guestController');

// Guest join queue endpoint
// Route: POST /api/guest/join
router.post('/join', join_as_guest);

module.exports = router;

