const express = require('express');
const router = express.Router();

const { 
    block_device, 
    unblock_device, 
    get_blocked_devices,
    check_device_status 
} = require('../controller/deviceController');

// Admin routes (require admin authentication - handled by frontend)
router.post('/admin/block-device', block_device);
router.post('/admin/unblock-device', unblock_device);
router.get('/admin/blocked-devices', get_blocked_devices);

// Client check (for pre-login validation)
router.get('/check-device', check_device_status);

module.exports = router;

