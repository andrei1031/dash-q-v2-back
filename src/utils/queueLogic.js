// 🟢 FIXED: Directly import Supabase to prevent the 'undefined' crash
const { supabase } = require("../database/supabase");

const enforceQueueLogic = async (barberId) => {
    console.log(`[QueueLogic] Enforcing rules for Barber ${barberId}...`);

    try {
        const { data: currentUpNext, error: upNextErr } = await supabase
            .from('queue_entries')
            .select('*')
            .eq('barber_id', barberId)
            .eq('status', 'Up Next')
            .maybeSingle();

        const { data: waitingList, error: waitingErr } = await supabase
            .from('queue_entries')
            .select('*')
            .eq('barber_id', barberId)
            .eq('status', 'Waiting')
            .order('is_confirmed', { ascending: false })
            .order('is_vip', { ascending: false })
            .order('created_at', { ascending: true })
            .limit(1);

        const topCandidate = waitingList?.length ? waitingList[0] : null;

        if (currentUpNext && topCandidate) {
            const upNextScore = (currentUpNext.is_confirmed ? 2 : 0) + (currentUpNext.is_vip ? 1 : 0);
            const candidateScore = (topCandidate.is_confirmed ? 2 : 0) + (topCandidate.is_vip ? 1 : 0);

            if (candidateScore > upNextScore) {
                await supabase.from('queue_entries').update({ status: 'Waiting' }).eq('id', currentUpNext.id);
                const { data: newUpNext } = await supabase.from('queue_entries').update({ status: 'Up Next' }).eq('id', topCandidate.id).select().single();
                return [newUpNext];
            }
        }

        if (!currentUpNext && topCandidate) {
            const { data: newUpNext } = await supabase.from('queue_entries').update({ status: 'Up Next' }).eq('id', topCandidate.id).select().single();
            return [newUpNext];
        }

        return currentUpNext ? [currentUpNext] : [];
    } catch (error) {
        console.error('[QueueLogic] Error enforcing rules:', error?.message || error);
        return [];
    }
}

// Support both export styles so we don't break queueController.js
const createQueueHelpers = () => { return { enforceQueueLogic }; };
module.exports = { createQueueHelpers, enforceQueueLogic };