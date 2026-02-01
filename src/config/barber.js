require('dotenv').config();

const BARBER_SIGNUP_CODE = process.env.BARBER_SIGNUP_CODE || '080825';
const BARBER_LOGIN_PIN = process.env.BARBER_LOGIN_PIN || "080825";

if (!BARBER_SIGNUP_CODE || !BARBER_LOGIN_PIN) {
  throw new Error(
    'Missing BARBER_SIGNUP_CODE or BARBER_LOGIN_PIN in environment variables'
  );
}

module.exports = {
    BARBER_SIGNUP_CODE,
    BARBER_LOGIN_PIN
};