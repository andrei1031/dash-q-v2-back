const express = require('express');
const router = express.Router();

const { 
    get_settings, 
    update_setting,
    get_vip_price
} = require('../controller/settingsController');

router.get('/settings', get_settings);
router.put('/settings', update_setting);
router.get('/settings/vip-price', get_vip_price);

module.exports = router;

