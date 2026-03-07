const fetch = require('node-fetch');
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid"); // optional, for guest_id
// npm i uuid

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, supabase } = require("../database/supabase");

/**
 * ENDPOINT (NEW): Check if email exists (for Forgot Password)
 * This is secure because it uses the admin key and doesn't reveal
 * anything other than "found: true" or "found: false".
 */
exports.check_email = async (req, res) => {
    const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email is required.' });
        }
        console.log(`POST /api/check-email - Checking: ${email}`);
    
        try {
            // We use the admin API to securely check for the user
            const checkEmailResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY }
            });
    
            if (!checkEmailResponse.ok && checkEmailResponse.status !== 404) {
                const body = await checkEmailResponse.text();
                throw new Error(`Email check failed: ${checkEmailResponse.status} ${body}`);
            }
    
            if (checkEmailResponse.ok) {
                const data = await checkEmailResponse.json();
                // Check if any user in the response *exactly* matches the email
                if (data?.users?.some(u => u.email === email)) {
                    console.log(`Email ${email} found.`);
                    return res.status(200).json({ found: true });
                }
            }
    
            // If we're here, either a 404 was returned or no exact match was found
            console.log(`Email ${email} NOT found.`);
            return res.status(200).json({ found: false });
    
        } catch (error) {
            console.error("Error checking email:", error.message);
            res.status(500).json({ error: 'Server error checking email.' });
        }
};

/**
 * ENDPOINT (FIXED): Handle Signup
 */
exports.signup = async (req, res) => {
    const { email, password, username, fullName, role = 'customer', barberCode } = req.body;
    console.log(`POST /api/signup/username - Signup attempt: user=${username}, email=${email}, role=${role}`);
    if (!email || !password || !username || !fullName) return res.status(400).json({ error: 'All fields required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 characters.' });
    if (username.length < 3) return res.status(400).json({ error: 'Username min 3 characters.' });
    if (!/^[a-zA-Z0-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username format invalid.' });

    const CORRECT_BARBER_CODE = process.env.BARBER_SIGNUP_CODE;
    const isBarber = role === 'barber';
    if (isBarber && (!barberCode || barberCode !== CORRECT_BARBER_CODE)) return res.status(403).json({ error: 'Invalid Barber Code provided.' });

    let newUser = null;
    try {
        const { data: existingProfile, error: profileCheckError } = await supabase.from('profiles').select('id').ilike('username', username).maybeSingle();
        if (profileCheckError) throw profileCheckError;
        if (existingProfile) return res.status(409).json({ error: 'Username already taken.' });

        console.log(`Checking email uniqueness via API: ${email}`);
        const checkEmailResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, { method: 'GET', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY } });
        if (!checkEmailResponse.ok && checkEmailResponse.status !== 404) { const body = await checkEmailResponse.text(); throw new Error(`Email check failed: ${checkEmailResponse.status} ${body}`); }
        if (checkEmailResponse.ok) { const data = await checkEmailResponse.json(); if (data?.users?.some(u => u.email === email)) return res.status(409).json({ error: 'Email already registered.' }); }
        console.log(`Email ${email} available.`);

        console.log(`Creating user via API: ${email}`);
        const createUserResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } })
        });
        if (!createUserResponse.ok) { const body = await createUserResponse.json(); throw new Error(body.msg || body.message || 'Failed to create user.'); }
        newUser = await createUserResponse.json();
        if (!newUser || !newUser.id) throw new Error("API User creation failed: No ID returned.");
        console.log('User created via API:', newUser.id);

        console.log(`Inserting profile for user ${newUser.id}`);
        // FIX: Explicitly save the role ('barber' or 'customer') to the profiles table
        const { data: profileData, error: profileInsertError } = await supabase
            .from('profiles')
            .insert({
                id: newUser.id,
                username: username,
                full_name: fullName,
                role: role // <--- THIS WAS MISSING
            })
            .select()
            .single();
        if (profileInsertError) throw profileInsertError;
        console.log('Profile created:', profileData);

        if (isBarber) {
            console.log(`Attempting to insert BARBER profile for user ${newUser.id}`);
            const { data: barberProfileData, error: barberProfileError } = await supabase.from('barber_profiles').insert({ user_id: newUser.id, full_name: fullName, is_active: true, is_available: false }).select().single();
            if (barberProfileError) throw barberProfileError;
            console.log('Barber profile created:', barberProfileData);
        }

        console.log("Signup process completed successfully.");
        const successMessage = 'Account created! You can now log in.';
        res.status(201).json({ message: successMessage });

    } catch (error) {
        console.error('Username signup failed:', error.message);
        if (newUser && newUser.id) {
            console.warn(`Signup failed. Rolling back Auth user ${newUser.id}...`);
            try {
                const deleteResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${newUser.id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY }
                });
                if (!deleteResponse.ok) { const body = await deleteResponse.text(); console.error(`CRITICAL: Rollback failed ${deleteResponse.status}:`, body); }
                else { console.log(`Rolled back Auth user ${newUser.id}`); }
            } catch (rollbackError) { console.error(`CRITICAL: Exception during rollback:`, rollbackError); }
        }

        const isUsernameConflict = error.message.includes('profiles_username_key') || error.message.includes('profiles_username_idx');
        const isEmailConflict = error.message.includes('already registered');
        const clientMessage = isUsernameConflict ? 'Username taken.' : isEmailConflict ? 'Email registered.' : error.message;
        const statusCode = (isUsernameConflict || isEmailConflict) ? 409 : 500;
        res.status(statusCode).json({ error: clientMessage });
    }
}
/**
 * ENDPOINT (UPDATED): Handle Login with BAN CHECK
 */
exports.login = async (req, res) => {
    const { username, password, role, pin } = req.body;
    console.log(`POST /api/login/username - Login attempt: user=${username}, role=${role}`);
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    const selectedRole = role || 'customer';
    if (selectedRole === 'barber') {
        const CORRECT_BARBER_PIN = process.env.BARBER_LOGIN_PIN;
        if (!pin) return res.status(400).json({ error: 'Barber PIN required.' });
        if (pin !== CORRECT_BARBER_PIN) { console.log(`Incorrect PIN for barber: ${username}`); return res.status(401).json({ error: 'Incorrect username, password, or PIN.' }); }
    }
    try {
        // --- MODIFIED SECTION START ---
        // 1. Fetch ID AND is_banned status
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, is_banned, role') // <--- Added is_banned here
            .ilike('username', username)
            .maybeSingle();

        if (profileError) throw profileError;

        if (!profile) {
            console.log(`Username "${username}" not found.`);
            return res.status(401).json({ error: 'Incorrect username or password.' });
        }

        // 2. CHECK IF BANNED
        if (profile.is_banned) {
            console.warn(`Banned user ${username} attempted login.`);
            return res.status(403).json({ error: 'Your account has been suspended due to policy violations. Contact admin.' });
        }
        // --- MODIFIED SECTION END ---

        const userId = profile.id;

        const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { method: 'GET', headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_ANON_KEY } });
        if (!userResponse.ok) { const body = await userResponse.text(); throw new Error(`Could not retrieve user details: ${userResponse.status} ${body}`); }
        const userData = await userResponse.json();
        if (!userData?.email) throw new Error('User email not found.');
        const userEmail = userData.email;

        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email: userEmail, password: password });
        if (signInError) {
            if (signInError.message.includes('Invalid login credentials')) return res.status(401).json({ error: 'Incorrect username or password.' });
            if (signInError.message.includes('Email not confirmed')) return res.status(401).json({ error: 'Please verify your email address.' });
            throw signInError;
        }
        const loggedInUser = signInData.user;

        if (selectedRole === 'barber') {
            console.log(`Verifying if user ${loggedInUser.id} is a barber...`);
            const { data: barberProfile, error: barberCheckError } = await supabase.from('barber_profiles').select('id, current_session_id').eq('user_id', loggedInUser.id).maybeSingle();
            if (barberCheckError) { console.error("Error checking barber_profiles table:", barberCheckError); throw new Error("Server error during role check."); }
            if (!barberProfile) { console.warn(`User ${username} (${loggedInUser.id}) passed PIN but has no barber profile.`); return res.status(403).json({ error: 'Incorrect username, password, or PIN.' }); }
            if (barberProfile.current_session_id) { console.warn(`User ${username} attempted second login. Blocking!`); return res.status(409).json({ error: 'This barber account is already signed in on another device.' }); }

            // --- FIX: Update is_active to TRUE on successful login ---
            const { error: updateAvailabilityError } = await supabase.from('barber_profiles')
                .update({ is_active: true })
                .eq('user_id', loggedInUser.id);
            if (updateAvailabilityError) { console.error("Failed to set is_active flag:", updateAvailabilityError); }
            // --- END FIX ---

            const { error: updateError } = await supabase.from('profiles').update({ current_session_id: loggedInUser.id }).eq('id', loggedInUser.id);
            if (updateError) { console.error("Failed to set session ID flag:", updateError); return res.status(500).json({ error: 'Login failed setting active status.' }); }
            console.log(`User ${username} confirmed as a barber.`);
        } else if (selectedRole === 'customer') {
            // --- 1. BLOCK ADMINS ---
            if (profile.role === 'admin') {
                return res.status(403).json({ error: 'Admins must log in via the Admin Portal.' });
            }

            // --- 2. BLOCK BARBERS (Existing Logic) ---
            const { data: barberProfile } = await supabase.from('barber_profiles').select('id').eq('user_id', loggedInUser.id).maybeSingle();
            if (barberProfile) { 
                return res.status(403).json({ error: 'You must log in using the "Barber" role.' }); 
            }
            
            console.log(`User ${username} confirmed as a customer.`);

            // <--- ADD THIS BLOCK --->
        } else if (selectedRole === 'admin') {
            // 1. Fetch the user's profile to check the DB role
            const { data: adminProfile, error: adminCheckError } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', loggedInUser.id)
                .single();

            if (adminCheckError || adminProfile?.role !== 'admin') {
                console.warn(`User ${username} attempted ADMIN login but is '${adminProfile?.role || 'unknown'}'.`);
                return res.status(403).json({ error: 'Access Denied: You do not have Administrator privileges.' });
            }
            console.log(`User ${username} confirmed as ADMIN.`);
        }
        console.log(`Login successful for user: ${username}, ID: ${loggedInUser.id} as role: ${selectedRole}`);
        res.json({ user: loggedInUser });
    } catch (error) {
        console.error('Username login failed:', error);
        res.status(500).json({ error: 'Login failed due to a server error.' });
    }
}

exports.guest_login = (req, res) => {
  try {
    // Allow client to send an existing guestId to maintain session on refresh
    const { guestId: existingId } = req.body;
    const guestId = existingId || uuidv4();

    const payload = {
      sub: guestId,
      role: "guest",
      type: "guest"
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });

    return res.status(200).json({
      user: { id: guestId, role: "guest" },
      token
    });
  } catch (e) {
    console.error("guestLogin error:", e);
    return res.status(500).json({ error: "Failed to create guest session." });
  }
};