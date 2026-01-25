const { supabase } = require("../database/supabase");

async function isAdmin(userId) {
    if (!userId) return false;

    const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single();

    if (error) {
        console.error(error);
        return false;
    }

    return data?.role === 'admin';
}

module.exports = {
    isAdmin
};