require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "service_role_key";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "anon_key";

const missing = [];
if (!SUPABASE_URL) missing.push('SUPABASE_URL');
if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');

if (missing.length) {
    throw new Error(`Missing DB Environment vars: ${missing.join(', ')}`);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

module.exports = {
    supabase,
    supabaseAdmin,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    SUPABASE_ANON_KEY
};