const express = require('express');
const router = express.Router();

const { services } = require('../controller/serviceController');

router.get('/services', services);

module.exports = router;