const express = require('express');
const router = express.Router();

const { check_email, signup, login } = require('../controller/authController');

router.post('/check-email', check_email);
router.post('/signup/username', signup);
router.post('/login/username', login);

module.exports = router;