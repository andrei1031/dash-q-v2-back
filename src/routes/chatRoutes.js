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

module.exports = router;