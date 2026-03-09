
const http = require('http');
const express = require('express')
const bodyParser = require('body-parser');
const barber = require('./config/barber');
const { startCronJobs } = require('./cron');
const cors = require('cors');


// --- Configure our "tools" ---
const app = express();
const corsOptions = {
    origin: ['https://dash-q-sigma.vercel.app', 'http://localhost:3000', 'https://dash-q-sigma.vercel.app'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// example: log or sanity check (optional)
console.log("🔐 Barber config loaded:", {
    signupCodeSet: !!barber.BARBER_SIGNUP_CODE,
    loginPinSet: !!barber.BARBER_LOGIN_PIN,
});

// --- CRON: Process Upcoming Appointments (Smart Auto-Chair) ---

startCronJobs()

// API ENDPOINTS START
const home = require('./routes/homeRoutes');
app.use('/api', home);

const confirm = require('./routes/queueRoutes');
app.use('/api/queue', confirm);

const push_manual = require('./routes/notificationRoutes');
app.use('/api/test', push_manual);

const subscribe = require('./routes/notificationRoutes');
app.use('/api', subscribe);

const check_email = require('./routes/authRoutes');
app.use('/api', check_email);

const location = require('./routes/queueRoutes');
app.use('/api/queue', location);

const flag = require('./routes/customerRoutes');
app.use('/api/logout', flag);   

const history = require('./routes/customerRoutes');
app.use('/api/customer', history);

const slots = require('./routes/appointmentRoutes');
app.use('/api/appointments', slots);

const book = require('./routes/appointmentRoutes');
app.use('/api/appointments', book);

const reject = require('./routes/appointmentRoutes');
app.use('/api/appointments', reject);

const approve = require('./routes/appointmentRoutes');
app.use('/api/appointments', approve);

const send = require('./routes/chatRoutes');
app.use('/api/chat', send);

const read = require('./routes/chatRoutes');
app.use('/api/chat', read);

const customer_loyalty = require('./routes/customerRoutes');
app.use('/api/barber', customer_loyalty);

const services = require('./routes/serviceRoutes');
app.use('/api', services);

const barbers = require('./routes/barberRoutes');
app.use('/api', barbers);

const profile = require('./routes/barberRoutes');
app.use('/api', profile);

const availability = require('./routes/barberRoutes');
app.use('/api', availability);

const earnings = require('./routes/barberRoutes');
app.use('/api', earnings);

const signup = require('./routes/authRoutes');
app.use('/api', signup);

const login = require('./routes/authRoutes');
app.use('/api', login);

const guest_login = require('./routes/authRoutes');
app.use('/api', guest_login);

const queue = require('./routes/queueRoutes');
app.use('/api', queue);

const push = require('./routes/notificationRoutes');
app.use('/api/test', push);

const photo = require('./routes/queueRoutes');
app.use('/api/queue', photo);

const details = require('./routes/queueRoutes');
app.use('/api/queue', details);

const next = require('./routes/queueRoutes');
app.use('/api/queue', next);

const cancel = require('./routes/queueRoutes');
app.use('/api/queue', cancel);

const complete = require('./routes/queueRoutes');
app.use('/api/queue', complete);

const analytics_barber = require('./routes/analyticsRoutes');
app.use('/api', analytics_barber);

const public_barber = require('./routes/queueRoutes');
app.use('/api/queue', public_barber);

const remove = require('./routes/queueRoutes');
app.use('/api', remove);

const get_customer_appointments = require('./routes/appointmentRoutes');
app.use('/api/appointments', get_customer_appointments);

const feedback = require('./routes/customerRoutes');
app.use('/api', feedback)

const get_feedback_barber = require('./routes/customerRoutes');
app.use('/api', get_feedback_barber)

const missed_events = require('./routes/eventRoutes');
app.use('/api', missed_events);

// Admin routes - mounted once at /api/admin
const adminRoutes = require('./routes/adminRoutes');
app.use('/api/admin', adminRoutes);

const submit_reports = require('./routes/reportsRoutes');
app.use('/api', submit_reports);

const get_user_submitted_reports = require('./routes/reportsRoutes');
app.use('/api', get_user_submitted_reports);

const get_barber_appointments = require('./routes/appointmentRoutes');
app.use('/api', get_barber_appointments);

const process_appointments = require('./routes/appointmentRoutes');
app.use('/api', process_appointments);

const settings = require('./routes/settingsRoutes');
app.use('/api', settings);

// Device blocking routes
const deviceRoutes = require('./routes/deviceRoutes');
app.use('/api', deviceRoutes);

// API ENDPOINTS END

const server = http.createServer(app);

// --- API Endpoints ---


[server.js] 


// --- Start the server ---

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Dash-Q Backend Server is running on port ${PORT}`);
});