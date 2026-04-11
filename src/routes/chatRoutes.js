// src/routes/chatRoutes.js
const express = require('express');
const router = express.Router();
const { 
    send, 
    read,
    admin_active_chats,
    admin_chats_reply
} = require('../controller/chatController');

router.post('/send', send);
router.put('/read', read);

// Add these missing admin routes
router.get('/admin/active-chats', admin_active_chats);
router.post('/admin/chat/reply', admin_chats_reply);

module.exports = router;