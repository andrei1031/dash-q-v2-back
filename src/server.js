
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

// Auth middleware
const { auth, adminAuth } = require('./middleware/auth');

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

// Protected queue routes
const queueRoutes = require('./routes/queueRoutes');
app.use('/api/queue', queueRoutes);

// Protected routes (cleaned - no duplicates)
const settingsRoutes = require('./routes/settingsRoutes');
app.use('/api', settingsRoutes); // PUBLIC: customers need vip-price!

const chatRoutes = require('./routes/chatRoutes');
app.use('/api/chat', auth, chatRoutes);

const appointmentRoutes = require('./routes/appointmentRoutes');
app.use('/api/appointments', auth, appointmentRoutes);

const customerRoutes = require('./routes/customerRoutes');
app.use('/api/customer', customerRoutes);

const loyaltyRoutes = require('./routes/loyaltyRoutes');
app.use('/api/loyalty', auth, loyaltyRoutes);

// Admin routes - mounted once at /api/admin
const adminRoutes = require('./routes/adminRoutes');
app.use('/api/admin', adminRoutes);

// Device blocking routes
const deviceRoutes = require('./routes/deviceRoutes');
app.use('/api', deviceRoutes);

// Guest queue routes
const guestRoutes = require('./routes/guestRoutes');
app.use('/api/guest', guestRoutes);

// Clean public routes (no duplicates)
const publicServices = require('./routes/serviceRoutes');
app.use('/api/services', publicServices);

const publicBarbers = require('./routes/barberRoutes');
app.use('/api/barbers', publicBarbers);

const publicQueue = require('./routes/queueRoutes');
app.use('/api/queue/public', publicQueue);

const feedbackPublic = require('./routes/customerRoutes');
app.use('/api/feedback', feedbackPublic);

const get_customer_appointments = require('./routes/appointmentRoutes');
app.use('/api/appointments/my', get_customer_appointments);

const feedback = require('./routes/customerRoutes');
app.use('/api/feedback/create', feedback)

const get_feedback_barber = require('./routes/customerRoutes');
app.use('/api/feedback/barber', get_feedback_barber)

const missed_events = require('./routes/eventRoutes');
app.use('/api/missed-event', missed_events);

const submit_reports = require('./routes/reportsRoutes');
app.use('/api/reports/create', submit_reports);

const get_user_submitted_reports = require('./routes/reportsRoutes');
app.use('/api/reports/my', get_user_submitted_reports);

const get_barber_appointments = require('./routes/appointmentRoutes');
app.use('/api/appointments/barber', get_barber_appointments);

const process_appointments = require('./routes/appointmentRoutes');
app.use('/api/appointments/process', process_appointments);

// API ENDPOINTS END

const server = http.createServer(app);

// --- API Endpoints ---


[server.js] 


// --- Start the server ---

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Dash-Q Backend Server is running on port ${PORT}`);
});