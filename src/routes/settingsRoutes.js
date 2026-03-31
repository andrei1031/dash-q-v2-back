const express = require('express');
const router = express.Router();

const { 
    get_settings, 
    update_setting
} = require('../controller/settingsController');

router.get('/settings', get_settings);
router.put('/settings', update_setting);

module.exports = router;

