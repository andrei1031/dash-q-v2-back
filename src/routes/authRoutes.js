const express = require('express');
const router = express.Router();

const { check_email, signup, login, guest_login } = require('../controller/authController');

router.post('/check-email', check_email)
router.post('/signup/username', signup);
router.post('/login/username', login);
router.post('/auth/guest', guest_login);

module.exports = router;