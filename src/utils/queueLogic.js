const createQueueHelpers = ({ supabase }) => {
    const enforceQueueLogic = async (barberId) => {
        console.log(`[QueueLogic] Enforcing rules for Barber ${barberId}...`);

        try {
        // 1) Current Up Next
        const { data: currentUpNext, error: upNextErr } = await supabase
            .from('queue_entries')
            .select('*')
            .eq('barber_id', barberId)
            .eq('status', 'Up Next')
            .maybeSingle();

        if (upNextErr) throw upNextErr;

        // 2) Best Waiting Candidate
        const { data: waitingList, error: waitingErr } = await supabase
            .from('queue_entries')
            .select('*')
            .eq('barber_id', barberId)
            .eq('status', 'Waiting')
            .order('is_confirmed', { ascending: false })
            .order('is_vip', { ascending: false })
            .order('created_at', { ascending: true })
            .limit(1);

        if (waitingErr) throw waitingErr;

        const topCandidate = waitingList?.length ? waitingList[0] : null;

        // A) Candidate bumps Up Next
        if (currentUpNext && topCandidate) {
            const upNextScore =
            (currentUpNext.is_confirmed ? 2 : 0) + (currentUpNext.is_vip ? 1 : 0);
            const candidateScore =
            (topCandidate.is_confirmed ? 2 : 0) + (topCandidate.is_vip ? 1 : 0);

            if (candidateScore > upNextScore) {
            console.log(
                `[QueueLogic] 🚀 High Priority #${topCandidate.id} is bumping #${currentUpNext.id}!`
            );

            const { error: demoteErr } = await supabase
                .from('queue_entries')
                .update({ status: 'Waiting' })
                .eq('id', currentUpNext.id);

            if (demoteErr) throw demoteErr;

            const { data: newUpNext, error: promoteErr } = await supabase
                .from('queue_entries')
                .update({ status: 'Up Next' })
                .eq('id', topCandidate.id)
                .select()
                .single();

            if (promoteErr) throw promoteErr;

            return [newUpNext];
            }
        }

        // B) Empty chair autofill
        if (!currentUpNext && topCandidate) {
            console.log(`[QueueLogic] Up Next is empty. Promoting #${topCandidate.id}.`);

            const { data: newUpNext, error: promoteErr } = await supabase
            .from('queue_entries')
            .update({ status: 'Up Next' })
            .eq('id', topCandidate.id)
            .select()
            .single();

            if (promoteErr) throw promoteErr;

            return [newUpNext];
        }

        // C) No changes
        return currentUpNext ? [currentUpNext] : [];
        } catch (error) {
        console.error('[QueueLogic] Error enforcing rules:', error?.message || error);
        return [];
        }
    }

    return { enforceQueueLogic };
}

module.exports = { 
    createQueueHelpers 
};